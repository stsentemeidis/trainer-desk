# Enakoma

The working app behind Enakoma personal training ("ένα ακόμα", one more). A small web app for one personal trainer. For each client it keeps the training
program by day, a log of sessions, progress against goals, and charges and
payments. It exports the program as a PDF to send to the client.

A separate Classes tab holds the weekly program for the group classes he teaches
at a gym (HYROX, CrossFit and so on) and exports it as a plain PDF with no
Enakoma branding.

## How it is hosted

Cloudflare deploys this repository as a Worker. Every push to the `main` branch
publishes a new version.

- `public/` is the website.
- `src/index.js` is the storage service behind `/api/`.
- `wrangler.jsonc` holds the deployment settings.

## Where the data lives

Client records are saved in a Cloudflare D1 database as you work, so they are
the same on every device. Nothing private is stored in this repository.

The site sits behind a Cloudflare Access login. The storage service checks that
login again on every request, and it refuses to overwrite a record that was
changed on another device in the meantime.

If the connection drops, changes wait in the browser and are sent when it is
back. **Settings → Download a backup** saves everything to one file; keep that
file private and out of this repository (`.gitignore` blocks the default names).

## Settings in `wrangler.jsonc`

| Setting | Where to find it in Cloudflare |
| --- | --- |
| `database_id` | Storage & Databases → D1 → the `trainer-desk` database → Database ID |
| `ACCESS_TEAM_DOMAIN` | Zero Trust → Settings → Team name and domain |
| `ACCESS_AUD` | Zero Trust → Access controls → Applications → the application → Application Audience (AUD) Tag |

These are identifiers, not passwords, so they are safe in a public repository.

## Trying it without deploying

Open `public/index.html` straight from disk. In that mode records are kept only
in that browser, which is fine for a look around. Press **Load example clients**
to see it filled in.

## Files

| Path | What it is |
| --- | --- |
| `wrangler.jsonc` | Cloudflare deployment settings |
| `src/index.js` | Storage service: sign-in check and database access |
| `public/index.html` | The whole app: layout, styles and logic |
| `public/vendor/` | PDF generation (jsPDF 2.5.1, jsPDF-AutoTable 3.8.2, MIT), the logo and fonts embedded in PDFs (Manrope and Syne), and their licences |
| `public/data/examples.js` | Made-up example clients, loaded only on request |
| `brand/` | The Enakoma logo for dark and light backgrounds, and a square profile image |
