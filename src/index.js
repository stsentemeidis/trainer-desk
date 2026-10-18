import { connect } from "cloudflare:sockets";

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
  if (path.startsWith("gmail/")) return gmail(request, env, url, who, path.slice(6));

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
      .batch([
        db.prepare("CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, body TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)"),
        // Never returned by /api/state: holds the Gmail sending permission, encrypted.
        db.prepare("CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)"),
      ])
      .catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/* ---------- sending programs through Gmail ----------
   The trainer connects a Gmail account once (Google sign-in with the "send email" permission).
   The refresh token is kept encrypted in the secrets table, keyed on the Google client secret,
   which lives only in the Worker's secret settings. Sending uses the Gmail API from this Worker. */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";
let gmailToken = { at: "", exp: 0, email: "" };

const gmailReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && !/PASTE/.test(env.GOOGLE_CLIENT_ID));
// Simpler alternative with no Google Cloud project: a Gmail app password, sent over Gmail's SMTP server.
// Tolerates a name typed in lower case or with stray spaces in the Cloudflare dashboard.
const envKey = (env, name) => Object.keys(env).find((k) => k.trim().toUpperCase() === name);
const appPassword = (env) => { const k = envKey(env, "GMAIL_APP_PASSWORD"); return String((k && env[k]) || "").replace(/\s+/g, ""); };
const appReady = (env) => !!(appPassword(env) && env.GMAIL_ADDRESS && /@/.test(env.GMAIL_ADDRESS));
const tokenUrl = (env) => env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const sendUrl = (env) => env.GMAIL_SEND_URL || "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
const utf8 = (t) => new TextEncoder().encode(t);
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sealKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", utf8("enakoma-gmail:" + env.GOOGLE_CLIENT_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), utf8(JSON.stringify(obj))));
  return b64(iv) + "." + b64(ct);
}
async function unseal(env, text) {
  try {
    const [a, b] = text.split(".");
    const iv = Uint8Array.from(atob(a), (c) => c.charCodeAt(0)), ct = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await sealKey(env), ct)));
  } catch (e) { return null; }
}
async function readGmail(env) {
  const row = await env.DB.prepare("SELECT body FROM secrets WHERE key = 'gmail'").first();
  return row ? unseal(env, row.body) : null;
}
const redirectUri = (url) => url.origin + "/api/gmail/callback";

function page(title, text, back) {
  const e = (t) => String(t).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + e(title) + '</title>' +
    '<body style="margin:0;background:#0A0A0B;color:#F4F4F5;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box">' +
    '<div style="max-width:440px"><h1 style="font-size:22px;margin:0 0 8px">' + e(title) + '</h1><p style="color:#B9B9C1;margin:0 0 20px">' + e(text) + '</p>' +
    '<a href="' + e(back) + '" style="display:inline-block;background:#3D7BFF;color:#0A0A0B;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none">Back to the app</a></div>',
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function accessToken(env) {
  if (gmailToken.at && gmailToken.exp > Date.now() + 60000) return gmailToken;
  const saved = await readGmail(env);
  if (!saved || !saved.refresh) return null;
  const res = await fetch(tokenUrl(env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: saved.refresh, grant_type: "refresh_token" }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") await env.DB.prepare("DELETE FROM secrets WHERE key = 'gmail'").run();
    return null;
  }
  gmailToken = { at: data.access_token, exp: Date.now() + (data.expires_in || 3000) * 1000, email: saved.email };
  return gmailToken;
}

function encodeWord(t) { return /^[\x20-\x7e]*$/.test(t) ? t : "=?UTF-8?B?" + b64(utf8(t)) + "?="; }
function wrap76(t) { return t.replace(/.{1,76}/g, (m) => m + "\r\n"); }

function mime({ from, to, subject, text, filename, pdf }) {
  const boundary = "enakoma-" + crypto.randomUUID();
  const safeName = encodeWord(filename.replace(/"/g, ""));
  const lines = [
    "From: " + from,
    "To: " + to.join(", "),
    "Subject: " + encodeWord(subject),
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(utf8(text))),
  ];
  if (pdf) lines.push(
    "--" + boundary,
    'Content-Type: application/pdf; name="' + safeName + '"',
    'Content-Disposition: attachment; filename="' + safeName + "\"; filename*=UTF-8''" + encodeURIComponent(filename),
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(pdf));
  lines.push("--" + boundary + "--", "");
  return lines.join("\r\n");
}

/* Minimal SMTP client: implicit TLS to smtp.gmail.com:465, AUTH PLAIN with the app password. */
async function smtpSend(env, { user, pass, rcpts, data }) {
  const host = env.SMTP_HOST || "smtp.gmail.com", port = Number(env.SMTP_PORT || 465);
  const sock = connect({ hostname: host, port }, { secureTransport: env.SMTP_TLS === "off" ? "off" : "on" });
  const writer = sock.writable.getWriter(), reader = sock.readable.getReader(), dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };
  async function reply() {
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { const out = lines.slice(0, i + 1); buf = lines.slice(i + 1).join("\r\n"); return { code: Number(lines[i].slice(0, 3)), text: out.join("\n") }; }
      }
      const { value, done } = await reader.read();
      if (done) fail("conn", "connection closed");
      buf += dec.decode(value, { stream: true });
    }
  }
  const send = (line) => writer.write(enc.encode(line + "\r\n"));
  async function step(line, ok, code) {
    if (line !== null) await send(line);
    const r = await reply();
    if (!ok.includes(r.code)) fail(code || "smtp", r.text.slice(0, 200));
    return r;
  }
  const timer = setTimeout(() => { try { sock.close(); } catch (e) {} }, 25000);
  try {
    await step(null, [220]);
    await step("EHLO enakoma", [250]);
    await step("AUTH PLAIN " + b64(utf8("\0" + user + "\0" + pass)), [235], "auth");
    await step("MAIL FROM:<" + user + ">", [250]);
    for (const r of rcpts) await step("RCPT TO:<" + r + ">", [250, 251], "rcpt");
    await step("DATA", [354]);
    const body = data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await writer.write(enc.encode(body + (body.endsWith("\r\n") ? "" : "\r\n") + ".\r\n"));
    await step(null, [250]);
    await send("QUIT").catch(() => {});
  } finally {
    clearTimeout(timer);
    try { await sock.close(); } catch (e) {}
  }
}

async function gmail(request, env, url, who, action) {
  const m = request.method;
  if (action === "status" && m === "GET") {
    if (appReady(env)) return json({ configured: true, connected: true, email: env.GMAIL_ADDRESS, mode: "app" });
    if (!gmailReady(env)) return json({ configured: false, missing: [appPassword(env) ? "" : "GMAIL_APP_PASSWORD", env.GMAIL_ADDRESS ? "" : "GMAIL_ADDRESS"].filter(Boolean),
      // Names only, never values: which settings this running version of the site can see.
      seen: Object.keys(env).filter((k) => typeof env[k] === "string").sort() });
    const saved = await readGmail(env);
    return json({ configured: true, connected: !!(saved && saved.refresh), email: saved ? saved.email : "" });
  }
  if (!gmailReady(env) && !(appReady(env) && action === "send")) return json({ error: "gmail_not_configured" }, 503);

  if (action === "connect" && m === "GET") {
    const state = crypto.randomUUID();
    const go = new URL(GOOGLE_AUTH);
    go.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: "code", scope: GMAIL_SCOPE,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
    return new Response(null, { status: 302, headers: { location: go.toString(), "cache-control": "no-store",
      "set-cookie": "gm_state=" + state + "; Path=/api/gmail; Max-Age=600; HttpOnly; Secure; SameSite=Lax" } });
  }

  if (action === "callback" && m === "GET") {
    const cookie = (request.headers.get("cookie") || "").split(";").map((x) => x.trim()).find((x) => x.startsWith("gm_state="));
    const expected = cookie ? cookie.slice(9) : "";
    if (url.searchParams.get("error")) return page("Gmail was not connected", "Google sign-in was cancelled or refused. Nothing changed.", "/");
    if (!expected || url.searchParams.get("state") !== expected) return page("Gmail was not connected", "The sign-in link expired. Start again from the app.", "/");
    const res = await fetch(tokenUrl(env), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: "authorization_code" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.refresh_token) return page("Gmail was not connected", "Google did not give permission to send email. Try again and tick the box that allows sending.", "/");
    if (!String(data.scope || "").includes("gmail.send")) return page("Gmail was not connected", "The permission to send email was not ticked on Google's screen. Try again and allow it.", "/");
    let email = "";
    try { email = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))).email || ""; } catch (e) {}
    await env.DB.prepare("INSERT INTO secrets (key, body, updated_at) VALUES ('gmail', ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .bind(await seal(env, { refresh: data.refresh_token, email, by: who.email }), new Date().toISOString()).run();
    gmailToken = { at: data.access_token || "", exp: Date.now() + (data.expires_in || 0) * 1000, email };
    return new Response(null, { status: 302, headers: { location: "/#gmail-connected", "cache-control": "no-store",
      "set-cookie": "gm_state=; Path=/api/gmail; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
  }

  if (action === "disconnect" && m === "POST") {
    const saved = await readGmail(env);
    await env.DB.prepare("DELETE FROM secrets WHERE key = 'gmail'").run();
    gmailToken = { at: "", exp: 0, email: "" };
    if (saved && saved.refresh && !env.GOOGLE_TOKEN_URL) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(saved.refresh), { method: "POST" }).catch(() => {});
    return json({ ok: true });
  }

  if (action === "send" && m === "POST") {
    const text = await request.text();
    if (text.length > 15 * 1024 * 1024) return json({ error: "too_large" }, 413);
    let b; try { b = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400); }
    const to = String(b.to || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
    if (!to.length || to.length > 10 || !to.every((x) => EMAIL.test(x))) return json({ error: "bad_address" }, 400);
    const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").slice(0, 300);
    const body = String(b.text || "").slice(0, 100000);
    const pdf = b.pdf ? String(b.pdf).replace(/[^A-Za-z0-9+/=]/g, "") : "";
    const filename = String(b.filename || "Program.pdf").replace(/[\r\n"\\/]/g, " ").slice(0, 150);
    const name = String(b.fromName || "").replace(/[\r\n"<>]/g, "").slice(0, 80);
    if (appReady(env)) {
      const user = String(env.GMAIL_ADDRESS).trim();
      const from = name ? '"' + encodeWord(name) + '" <' + user + ">" : user;
      try {
        await smtpSend(env, { user, pass: appPassword(env), rcpts: to, data: mime({ from, to, subject, text: body, filename, pdf }) });
        return json({ ok: true, from: user, to });
      } catch (e) {
        console.error("smtp send failed", e && e.message);
        return json({ error: e && e.code === "auth" ? "gmail_login" : e && e.code === "rcpt" ? "bad_address" : "gmail_failed" }, e && e.code === "rcpt" ? 400 : 502);
      }
    }
    const tok = await accessToken(env);
    if (!tok) return json({ error: "gmail_reconnect" }, 409);
    const from = name ? '"' + encodeWord(name) + '" <' + tok.email + ">" : tok.email;
    const raw = b64url(utf8(mime({ from, to, subject, text: body, filename, pdf })));
    const res = await fetch(sendUrl(env), { method: "POST", headers: { authorization: "Bearer " + tok.at, "content-type": "application/json" }, body: JSON.stringify({ raw }) });
    if (res.status === 401) { gmailToken = { at: "", exp: 0, email: "" }; return json({ error: "gmail_reconnect" }, 409); }
    if (!res.ok) { console.error("gmail send failed", res.status, (await res.text()).slice(0, 500)); return json({ error: "gmail_failed", status: res.status }, 502); }
    return json({ ok: true, from: tok.email, to });
  }

  return json({ error: "not_found" }, 404);
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
