# Security

This app was built with an AI assistant, then checked, fixed and checked again. This page says what was checked, what
passed, which limits are accepted, and what has not been tested yet, so you can decide whether it fits your event.

## Version checked

| | |
|---|---|
| App version | 1.1.0 |
| Checked on | 11 November 2026 (1.0.0 on 10 November 2026); scanner run again with 0.0.8 on 12 November 2026 |
| Scanner | [ai-secure-audit](https://github.com/surapas3022/ai-secure-audit) 0.0.8: gitleaks 8.30.1 (keys and passwords in code and git history), osv-scanner 2.7.0 (libraries with known vulnerabilities, offline database), opengrep 1.33.1 with the kit's own rules (sign-in and join routes with no limit on repeats, vote routes that never check who is voting) |
| Scanner result | 0 findings |
| Dockerfile | hadolint: no errors (two warnings kept on purpose: `apk add openssl` is not pinned, so rebuilds get security fixes; the healthcheck uses shell form to read `$PORT`) |
| Hand checks | 19 cheating attempts against a local copy; 20 registration-desk ticket checks; intro, cheer and admin-given-name checks; email and SMTP checks against local stand-in servers |

Each new release is checked again before it is published. When ai-secure-audit adds a check, this page is updated with
the new version and result.

## Rules the server enforces (all passed)

| Check | Result |
|---|---|
| Picking more contestants than a topic allows | Refused |
| Picking a contestant from another topic | Refused |
| Voting after a topic is closed, by calling the API directly | Refused |
| 50 simultaneous requests with one code (race condition) | One vote kept |
| Changing your mind leaves the old vote counted | Old vote removed |
| Reading scores in "hide scores" mode from what pages receive | No scores sent |
| Admin API without logging in | Refused (401) |
| Admin actions from another website (CSRF) | Refused (403) |
| Guessing the admin password | Rate-limited; a real admin on another network can still log in |
| Guessing vote codes | Rate-limited; 8-character codes; at the global ceiling of about 2 guesses a second, one valid code would take tens of years on average |
| Scanning a card's QR while someone floods wrong codes | Still gets in (QR links are signed) |
| Wrong names flooding from the venue Wi-Fi in name mode | Listed staff still get in (no lockout; a proof-of-work puzzle slows guessing instead) |
| Uploading a non-image file as a photo | Refused (content is checked, not the declared type) |
| HTML in event, topic, contestant or voter names | Escaped in pages and emails |
| Making the app's QR generator point at another site | Ignored; QR always points at the event |
| Security headers | Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy present |

## Registration desk, intro and cheers (new in 1.1.0)

| Check | Result |
|---|---|
| Opening the desk without logging in, or from another website | Refused (401, 403) |
| What the desk page receives | A QR picture only: no vote code, and the ticket is not in the data as text |
| Empty, made-up or non-text tickets | Refused (410) |
| 30 phones pressing "รับบัตร" (get card) on one ticket at the same moment | One card |
| A used ticket, a ticket older than one minute, a ticket replaced with "เปลี่ยน QR" | Refused (410) |
| Desk or claim when the event is not in code mode | Refused (409) |
| Intro: what the big screen receives | Only contestants already introduced, no vote counts; a topic not yet open stays hidden from voters |
| Moving the intro without logging in | Refused (401) |
| Cheers without joining, outside the intro, or with an emoji outside the set of six | Refused (401, 409, 400) |
| Rude words (also with spaces or symbols between letters), links, messages over 60 characters | Refused |
| Line breaks and invisible direction characters in messages | Removed; HTML shows as plain text |
| Sending messages or emoji too fast | Limited per guest and for the whole room (429) |
| Sender identity on the big screen or in the admin list | Not sent |
| Hidden messages and blocked senders | Gone from the screen; a blocked sender is not told |
| Cheer messages written to `data/db.json` | Never |
| A name the admin gave (email list) | Returned only to that guest, and cannot be changed from the phone; public data has no names or addresses |
| Opening the voter page from a card picture | Read on the phone; nothing uploaded. The route serving the QR reader returns only that one file |

## Email

| Check | Result |
|---|---|
| Email routes without logging in | Refused (401) |
| HTML or line breaks in names added to emails or headers | Escaped; line breaks removed from headers; no extra recipients (re-checked over verified TLS on 11 November 2026) |
| Email addresses visible on public pages | Not sent to voters or the big screen |
| Deleting a wrong address | Its code stops working at once |
| The "send a test" email | Carries a sample code that cannot vote |
| SMTP server that does not offer STARTTLS (or has it stripped on the network) | Stops before sending the password or any email |
| SMTP server with an untrusted certificate, even with the old `SMTP_ALLOW_SELF_SIGNED=true` | Stops before sending the password |

Mail credentials are read from environment variables or `.env` only, never from code.

## Load and network

| Test | Result |
|---|---|
| 150 simulated phones on the same machine: open the page, scan, vote in two topics, a third change their mind | Every request succeeded, tally exact, all phones saw a closed topic within about 50 ms |
| 200 simulated phones behind a Cloudflare Quick Tunnel | Every request succeeded (no 429), pages update every 1–2 seconds by polling |
| https behind a proxy (`TRUST_PROXY=1`) | Admin cookie marked Secure; a faked `X-Forwarded-For` does not get around the rate limits |
| Docker (Compose on macOS) | Runs as uid 1000; can write `/data` but not the app code; data survives restarts; `docker stop` saves and exits cleanly |
| Per-address limits in Docker when the app sees each device's own address | A guesser is limited; the real admin from another address still logs in |
| Through a Cloudflare Quick Tunnel in a web browser (11 November 2026) | Getting a card at the desk and saving its picture, the voter page and voting, the intro with cheers, opening from a card picture: all worked |

## Accepted limits

These are known and shown in the app. They are not bugs.

- **"No entry details" mode cannot stop repeat voting.** Anyone with a script or several browsers can vote many times.
  Use it only for casual fun.
- **Name mode cannot stop impersonation.** Names not on the staff list are refused, but anyone who knows a colleague's
  name or staff ID can vote as them. Use vote codes when the result matters.
- **"Sent" means the mail service accepted the email**, not that it reached the inbox.
- **Admin over plain http on Wi-Fi sends the password unencrypted.** Use `HTTPS_PORT` or an https host (see the README).
- **Personal data:** email addresses and names are stored in plain text in `data/db.json`. Delete them after the event.
- **Someone filming the registration desk could keep taking cards.** A new ticket appears as soon as one is used, so a
  phone pointed at the desk with a script could claim a card every few seconds. Desk staff are told to watch for
  "card taken" with nobody at the desk. The alternative, staff pressing a button for every guest, was judged not worth
  the slower queue.
- **The cheer word list cannot catch every spelling.** Someone should watch the admin's cheer card during the intro and
  hide or block.
- **Docker Desktop (Mac, Windows) shows every phone as one address**, so per-address limits count the whole room
  together. Docker on Linux and `npm start` see each phone's own address.

## Not tested yet

- The share sheet on specific phones: "บันทึกรูปบัตร" (save card picture) on iPhone Safari and Android Chrome by name
  (the tunnel test above did not record which phone was used)
- Cheers with a full room (tested with 12 simulated guests)
- Docker on a Linux server with a published port
- Sending real email through Gmail, a company server or Brevo (only local stand-ins)
- The self-signed `HTTPS_PORT` mode with real phones

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: the **Security** tab of this repository →
**Report a vulnerability**. Say what you did, what happened, and which version. Only test against your own copy of the
app, never against someone else's event.
