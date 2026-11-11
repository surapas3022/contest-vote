# Security

This app was built with an AI assistant, then checked, fixed and checked again. This page says what was checked, what
passed, which limits are accepted, and what has not been tested yet, so you can decide whether it fits your event.

## Version checked

| | |
|---|---|
| App version | 1.0.0 |
| Checked on | 10 November 2026 |
| Scanner | [ai-secure-audit](https://github.com/surapas3022/ai-secure-audit) 0.0.4 (run again on 11 November 2026; first run with 0.0.3): gitleaks 8.30.1 (keys and passwords in code and git history), osv-scanner 2.7.0 (libraries with known vulnerabilities, offline database) |
| Scanner result | 0 findings |
| Hand checks | 19 cheating attempts against a local copy, plus email and SMTP checks against local stand-in servers |

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

## Email

| Check | Result |
|---|---|
| Email routes without logging in | Refused (401) |
| HTML or line breaks in names added to emails or headers | Escaped; line breaks removed from headers; no extra recipients |
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

## Accepted limits

These are known and shown in the app. They are not bugs.

- **"No entry details" mode cannot stop repeat voting.** Anyone with a script or several browsers can vote many times.
  Use it only for casual fun.
- **Name mode cannot stop impersonation.** Names not on the staff list are refused, but anyone who knows a colleague's
  name or staff ID can vote as them. Use vote codes when the result matters.
- **"Sent" means the mail service accepted the email**, not that it reached the inbox.
- **Admin over plain http on Wi-Fi sends the password unencrypted.** Use `HTTPS_PORT` or an https host (see the README).
- **Personal data:** email addresses and names are stored in plain text in `data/db.json`. Delete them after the event.

## Not tested yet

- Real phones (all tests ran from one computer)
- Sending real email through Gmail, a company server or Brevo (only local stand-ins)
- Header injection over a TLS SMTP connection after the latest SMTP fix (it passed before that fix, and the code that
  removes line breaks did not change)
- The self-signed `HTTPS_PORT` mode with real phones

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: the **Security** tab of this repository →
**Report a vulnerability**. Say what you did, what happened, and which version. Only test against your own copy of the
app, never against someone else's event.
