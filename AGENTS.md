# Instructions for AI assistants

This file is for AI coding assistants (Claude Code, Codex, Cursor and similar) working in this repository.
People should start with [README.md](README.md).

## What this is

A contest voting app for company parties. One Node process serves the pages: guests (`/`), admin (`/admin`), the big
screen (`/screen`), and the registration desk (`/checkin`, admin) with its claim page (`/claim`). State is kept in
memory and written to `data/db.json`.

| Path | What it holds |
|---|---|
| `server.js` | HTTP server, API, rules, rate limits, email queue |
| `smtp.js` | Small SMTP client for Gmail and company servers (no nodemailer) |
| `env.js` | Loads `.env`; values from the real environment win |
| `public/` | Pages and browser code. `js/common.js` has the shared live-update logic, `js/pow.js` the name-mode puzzle |
| `docs/checkin-guide.md` | Thai guide for registration-desk staff |
| `Dockerfile`, `compose.yaml` | Container run; data in the `/data` volume |
| `scripts/smoke-test.js` | End-to-end test, including 200 simultaneous voters and email via a local Brevo stand-in |
| `scripts/mail-test.js` | Gmail/SMTP tests against local stand-in mail servers (needs `openssl`) |
| `scripts/demo.js` | Sample data on port 3456, admin password `demo` |

## Commands

```bash
npm install
node scripts/smoke-test.js     # must print ALL PASSED
node scripts/mail-test.js      # must print ALL PASSED
ADMIN_PASSWORD=... npm start   # or put settings in .env
```

Run both tests before you finish any change, and say plainly if you could not run them.

## Conventions

- Node 18 or later. Do not use APIs that need a newer Node.
- Keep runtime dependencies to the current four (`express`, `qrcode`, `@fontsource/anuphan`, `jsqr` for reading a
  card picture on phones without a built-in QR reader). Ask before adding one.
- Text users see on screen, in emails and in error messages is **Thai**. Code comments, docs and commit messages are
  **English**.
- Settings come from environment variables or `.env`. Never commit `.env` or `data/`.
- Tests must not contain real or fixed passwords; generate them at run time.
- Update `README.md` when behaviour or settings change.

## Do not undo these

Each line below fixes a real problem found by a security check. Keep it working, and keep or extend its test.

- **The server enforces every rule.** Picks per topic, closed topics, the entry method and change-of-mind are checked
  in `server.js`, never only in the browser.
- **Hidden scores stay hidden.** In "hide scores" mode, nothing a voter or the big screen receives (`/api/state`,
  `/api/screen/state`, `/api/stream`, `/api/screen/stream`) may contain vote counts.
- **Admin routes need the admin session.** Everything under `/api/admin` goes through `requireAdmin`, and state-changing
  requests the browser marks as cross-site are refused.
- **Everyone at the venue shares one IP.** Do not add per-IP lockouts that can stop real guests. Code mode lets a
  card's signed QR bypass the typed-code limiter; name mode uses a proof-of-work puzzle that gets harder instead of a
  lockout. `TRUST_PROXY` stays off unless a proxy is really in front.
- **Vote codes are long and signed.** New codes are 8 characters; QR links carry an HMAC signature.
- **SMTP never sends a password or email without verified TLS.** Port 465 is TLS from the start; 587/25 must complete
  STARTTLS, or the client stops before `AUTH` and `MAIL`. Certificates are always verified (`rejectUnauthorized` is
  always true); company certificates are added with `SMTP_CA_FILE`, never by turning checks off.
- **Uploads are checked by content.** Photos must really be JPEG, PNG or WEBP; the declared type is not trusted.
- **User text is escaped** in pages and emails, line breaks are removed from email headers, and CSV cells that start
  with `=`, `+`, `-` or `@` are neutralised.
- **Desk tickets are one-time and never show a code.** The desk receives only a QR picture; a ticket is used up by the
  first claim (checked with 30 at once), expires after a minute, and is replaced by "เปลี่ยน QR".
- **Topics not yet open stay private except during the intro**, and then only the contestants already introduced
  are sent.
- **Cheers are only accepted during the intro, from joined guests, and are never written to disk.** Fixed emoji set,
  short single-line text, no links, blocked words, per-guest and room-wide limits, no sender identity sent anywhere.
- **Names given by the admin are fixed.** The server never accepts a name from a phone; a self-set name stays in that
  phone's storage.
- **Pages work without the live stream.** First state comes from a plain request and pages poll when the stream is
  blocked (Cloudflare Quick Tunnels carry no Server-Sent Events).

## Limits that are accepted, not bugs

State these to users instead of hiding them:

- "No entry details" mode cannot stop repeat voting. The admin and voter pages say so.
- Name mode stops names that are not on the list but cannot stop impersonation.
- "Sent" means the mail service accepted the email, not that it reached the inbox.
- Email addresses and names are personal data stored in plain text in `data/db.json`; delete them after the event.
- Someone filming the registration desk with a script could keep claiming cards; desk staff watch for it.
- The cheer word list cannot catch every spelling; an admin watches the cheer card during the intro.
- Docker Desktop shows every phone as one address, so per-address limits count the whole room together.
