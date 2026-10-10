/**
 * Trainer Desk storage API.
 *
 * Everything under /api/ is handled here; every other address is a static file
 * from ./public. Records are JSON documents in one D1 table:
 *   settings, exercises, one "client:<id>" document per client,
 *   and one "week:<monday date>" document per week of classes.
 *
 * Every request must carry a valid Cloudflare Access sign-in. Access already
 * blocks strangers before they reach this code; the check below verifies the
 * signed token again, so the data stays locked even if an Access setting is
 * changed by mistake.
 */

const KEY_RE = /^(settings|exercises|client:[A-Za-z0-9_-]{1,40}|week:\d{4}-\d{2}-\d{2})$/;
const MAX_DOC_BYTES = 900 * 1024;
const MAX_RESTORE_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 700 * 1024;

let schemaReady = null;
let certCache = { url: "", at: 0, keys: [] };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (err) {
      console.error("api error", err && err.stack ? err.stack : err);
      return json({ error: "server_error" }, 500);
    }
  },
};

async function api(request, env, url) {
  if (!env.DB || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || /PASTE/.test(env.ACCESS_TEAM_DOMAIN + env.ACCESS_AUD)) {
    return json({ error: "not_configured" }, 503);
  }
  const who = await authenticate(request, env);
  if (!who.email) return json({ error: "not_signed_in", reason: who.reason }, 401);

  const method = request.method;
  // Changes must come from the app itself: a custom header cannot be sent by a form on another site.
  if (method !== "GET" && request.headers.get("x-trainer-desk") !== "1") return json({ error: "bad_request" }, 400);

  await ensureSchema(env.DB);
  const path = url.pathname.slice(5);

  if (path === "state" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, rev, body FROM docs").all();
    const docs = {};
    for (const row of results) docs[row.key] = { rev: row.rev, body: JSON.parse(row.body) };
    return json({ user: { email: who.email }, docs });
  }

  if (path.startsWith("doc/")) {
    const key = decodeURIComponent(path.slice(4));
    if (!KEY_RE.test(key)) return json({ error: "bad_key" }, 400);

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM docs WHERE key = ?").bind(key).run();
      return json({ ok: true });
    }

    if (method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_DOC_BYTES) return json({ error: "too_large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_json" }, 400);

      // The app sends the version it last saw. If someone saved in between, nothing is overwritten.
      const rev = Number(request.headers.get("if-match")) || 0;
      const now = new Date().toISOString();
      const res = rev === 0
        ? await env.DB.prepare("INSERT INTO docs (key, body, rev, updated_at, updated_by) VALUES (?, ?, 1, ?, ?) ON CONFLICT(key) DO NOTHING").bind(key, text, now, who.email).run()
        : await env.DB.prepare("UPDATE docs SET body = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE key = ? AND rev = ?").bind(text, now, who.email, key, rev).run();
      if (res.meta.changes === 1) return json({ rev: rev + 1 });

      const row = await env.DB.prepare("SELECT rev, body FROM docs WHERE key = ?").bind(key).first();
      return json({ error: "conflict", rev: row ? row.rev : 0, body: row ? JSON.parse(row.body) : null }, 409);
    }
  }

  if (path === "restore" && method === "POST") {
    const text = await request.text();
    if (text.length > MAX_RESTORE_BYTES) return json({ error: "too_large" }, 413);
    let docs;
    try { docs = JSON.parse(text).docs; } catch (e) { return json({ error: "bad_json" }, 400); }
    if (!docs || typeof docs !== "object") return json({ error: "bad_json" }, 400);

    const entries = [];
    for (const key of Object.keys(docs)) {
      const body = docs[key];
      if (!KEY_RE.test(key) || !body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_key", key }, 400);
      const str = JSON.stringify(body);
      if (str.length > MAX_DOC_BYTES) return json({ error: "too_large", key }, 413);
      entries.push([key, str]);
    }

    // New versions start above every existing one, so a device holding old data cannot overwrite the restore.
    const top = await env.DB.prepare("SELECT COALESCE(MAX(rev), 0) AS top FROM docs").first();
    const rev = (top ? top.top : 0) + 1;
    const now = new Date().toISOString();
    const statements = [env.DB.prepare("DELETE FROM docs")];
    let chunk = {}, size = 0;
    const flush = () => {
      if (!size) return;
      statements.push(env.DB.prepare("INSERT INTO docs (key, body, rev, updated_at, updated_by) SELECT j.key, j.value, ?, ?, ? FROM json_each(?) AS j").bind(rev, now, who.email, JSON.stringify(chunk)));
      chunk = {}; size = 0;
    };
    for (const [key, str] of entries) {
      if (size + str.length > CHUNK_BYTES) flush();
      chunk[key] = str; size += str.length;
    }
    flush();
    await env.DB.batch(statements); // all or nothing
    return json({ ok: true, count: entries.length });
  }

  return json({ error: "not_found" }, 404);
}

function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .prepare("CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, body TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)")
      .run()
      .catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/* ---------- sign-in check ---------- */

function teamHost(value) {
  const host = String(value).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host.includes(".") ? host : host + ".cloudflareaccess.com";
}

function b64urlBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

async function signingKey(env, host, kid) {
  const url = env.ACCESS_CERTS_URL || "https://" + host + "/cdn-cgi/access/certs";
  const fresh = certCache.url === url && Date.now() - certCache.at < 60 * 60 * 1000;
  let jwk = fresh ? certCache.keys.find((k) => k.kid === kid) : null;
  // Cloudflare rotates its signing keys, so an unknown key id triggers one fresh download.
  if (!jwk && !(fresh && Date.now() - certCache.at < 60 * 1000)) {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    certCache = { url, at: Date.now(), keys: Array.isArray(data.keys) ? data.keys : [] };
    jwk = certCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) return null;
  return crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function authenticate(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion") || readCookie(request, "CF_Authorization");
  if (!token) return { reason: "no_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { reason: "bad_token" };

  let header, claims;
  try {
    const dec = new TextDecoder();
    header = JSON.parse(dec.decode(b64urlBytes(parts[0])));
    claims = JSON.parse(dec.decode(b64urlBytes(parts[1])));
  } catch (e) {
    return { reason: "bad_token" };
  }
  if (header.alg !== "RS256" || !header.kid) return { reason: "bad_token" };

  const host = teamHost(env.ACCESS_TEAM_DOMAIN);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "https://" + host) return { reason: "wrong_team" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { reason: "wrong_application" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return { reason: "bad_token" };

  let key;
  try { key = await signingKey(env, host, header.kid); } catch (e) { key = null; }
  if (!key) return { reason: "unknown_key" };
  let valid = false;
  try { valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])); } catch (e) { valid = false; }
  if (!valid) return { reason: "bad_signature" };
  if (!claims.email) return { reason: "no_email" };
  return { email: String(claims.email).toLowerCase() };
}
