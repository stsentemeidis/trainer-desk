# Trainer Desk

A small web app for one personal trainer. For each client it keeps the training
program by day, a log of sessions, progress against goals, and charges and
payments. It exports the program as a PDF to send to the client.

## How it is hosted

The site is deployed by Cloudflare Workers from this repository. Every push to
the `main` branch publishes a new version. `wrangler.jsonc` tells Cloudflare to
serve the `public` folder as the website.

To try it without deploying, open `public/index.html` in a browser.

Press **Load example clients** on the first screen to see it filled in, then
**Remove the examples** when you are done looking.

## Where the data lives (current version)

All client data is stored **in the browser, on the device where it was entered**.
Nothing is uploaded, and this repository contains no client data.

- A different browser or device starts empty. Use **Settings → Download a backup**
  on one device and **Restore from a backup** on the other to move the data.
- Clearing the browser's site data deletes the records. Download a backup often.
- Backup files hold names, emails and payment records. Keep them private and do
  not add them to this repository. `.gitignore` already blocks the default file
  names.

Planned next: a Cloudflare D1 database behind a Cloudflare Access login, so the
records are saved online and available on any device.

## Files

| Path | What it is |
| --- | --- |
| `wrangler.jsonc` | Cloudflare deployment settings |
| `public/index.html` | The whole app: layout, styles and logic |
| `public/vendor/` | PDF generation (jsPDF 2.5.1, jsPDF-AutoTable 3.8.2, MIT), the fonts embedded in PDFs, and their licences |
| `public/data/examples.js` | Made-up example clients, loaded only on request |
