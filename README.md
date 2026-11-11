# Contest voting for company parties

A small web app for costume and performance contests at events: guests join from their phones, cheer while each
contestant is introduced on the projector, then vote; an admin runs the event, and the projector shows live results and
a 3 → 2 → 1 reveal.

Pages, served by one Node process: guests (`/`), admin (`/admin`), the big screen (`/screen`), and optionally a
registration desk (`/checkin`) where guests scan to get their vote card (`/claim`).
No database to set up: data lives in `data/db.json` and contestant photos in `data/uploads/`.

The screens are in Thai. Buttons and labels below are quoted exactly as they appear, with an English translation.

**Security:** version 1.1.0 was checked with ai-secure-audit 0.0.4, 19 hand-made cheating attempts and tests for the
desk tickets, the intro and cheers. See
[SECURITY.md](SECURITY.md) for what passed, the accepted limits, and what is not tested yet.

## Run it locally

Needs Node 18 or later.

```bash
npm install
ADMIN_PASSWORD=choose-a-long-password npm start
```

To avoid typing settings on every start, put them in a `.env` file (see "Keep settings in a .env file") and run just
`npm start`.

On start the console prints the voter link, for example `http://192.168.1.20:3000/`, which is this machine's address
on the Wi-Fi. Phones must be on the same Wi-Fi. If `ADMIN_PASSWORD` is not set, a random one is generated and printed.

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | random each run (12 characters) | Admin page password. Use 10 characters or more. Changing it signs out every logged-in device. |
| `PORT` | `3000` | http port for voters and the big screen |
| `HTTPS_PORT` | off | Opens an https port for the admin page. See "At the venue over Wi-Fi". |
| `TLS_CERT` / `TLS_KEY` | – | Your own certificate files. Without them a self-signed one is created (needs `openssl`). |
| `TRUST_PROXY` | off | Set only when an https proxy or host sits in front, for example `1` (trust one proxy). Turning it on without a proxy lets people fake their IP and dodge the rate limits. |
| `DATA_DIR` | `./data` | Where `db.json` and photos are stored |
| `ENV_FILE` | `.env` next to `server.js` | Settings file, if you keep it elsewhere |
| `PUBLIC_URL` | this machine's Wi-Fi address | The address phones use, for QR codes and links. Needed in Docker (see "Run with Docker"). "ลิงก์ที่ QR พาไป" (link the QR opens) on the admin page overrides it. |
| `HOST_PORT` | `3000` | Docker only: the port on this machine. Use the same port in `PUBLIC_URL`. |
| `MAIL_PROVIDER` | guessed from what is set | How vote codes are emailed: `gmail`, `smtp` or `brevo`. See "Email vote codes". Leave this group out if you do not use email. |
| `MAIL_FROM` | the signed-in account (Gmail/SMTP) | Sender, for example `vote@company.com` or `'Party Team <vote@company.com>'`. Without a name, the event name is used. Required for Brevo. |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | – | Gmail account and its 16-character App Password. See "Using Gmail". |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | port `587` | Your company mail server. See "Using company SMTP". Also `SMTP_SECURE` and `SMTP_CA_FILE` (company-issued certificate). |
| `BREVO_API_KEY` | – | Brevo API key. See "Using Brevo". |
| `MAIL_DAILY_LIMIT` | Gmail 500 · Brevo 300 · SMTP unlimited | Emails per day, used to warn the admin before sending. `0` = no warning. |

### Keep settings in a .env file

```bash
cp .env.example .env     # then edit .env
npm start
```

- One `NAME=value` per line. Lines starting with `#` are comments. Wrap values containing spaces, `<`, `>` or `#` in
  `'...'`, for example `MAIL_FROM='Party Team <vote@company.com>'`.
- Values given on the command line (or in a host's environment variables page) always win over the file. On start
  the server lists which values came from the file.
- Restart the server after editing the file.
- The file holds passwords. Do not share it or commit it (`.gitignore` already excludes it). `.env.example` is a
  template with no real secrets.

### At the venue over Wi-Fi: turn on https for the admin page

Over plain http, the admin password and cookie travel unencrypted, and anyone on the same Wi-Fi can capture them.
Before real use, run:

```bash
ADMIN_PASSWORD=a-long-password HTTPS_PORT=3443 npm start
```

- Voters and the big screen stay on `http://<ip>:3000` (nothing secret there). The admin and card-printing pages
  redirect to `https://<ip>:3443/admin`.
- The certificate is self-signed, so browsers warn the first time: choose "Advanced → Proceed". To be sure, compare
  the certificate fingerprint with the one printed in the server console.
- Admin login is rate-limited. If someone floods password guesses from the same network, the admin may be unable to
  log in **again** for a while, so log in on the control device before the event starts (sessions last 24 hours).

### Run with Docker

Needs Docker with Compose v2 (`docker compose`, not the old `docker-compose`).

```bash
cp .env.example .env      # set ADMIN_PASSWORD, and PUBLIC_URL (below)
docker compose up -d --build
docker compose logs -f    # the same startup messages as npm start
```

- **Set `PUBLIC_URL`** in `.env` to the address phones use, for example `PUBLIC_URL=http://192.168.1.20:3000`.
  Inside a container the server only sees the container's own address, so without it the QR codes point somewhere
  phones cannot reach. The console warns when it is missing. If port 3000 is taken on this machine, set
  `HOST_PORT=3100` and use that port in `PUBLIC_URL`. "ลิงก์ที่ QR พาไป" (link the QR opens) in the "ตั้งค่างาน"
  tab overrides it.
- Data (votes, photos, the https certificate) lives in the `vote-data` volume and survives `docker compose down`
  and rebuilds. Back it up with
  `docker run --rm -v contest-vote_vote-data:/data -v "$PWD":/out alpine tar czf /out/vote-data.tgz -C /data .`
  (the volume name is the folder name plus `_vote-data`; see `docker volume ls`). Delete it after the event with
  `docker compose down -v`.
- For https on the admin page, add `HTTPS_PORT=3443` to `.env` and uncomment the `3443:3443` line in
  `compose.yaml`. Publish it **on the same number** inside and outside, because the admin page redirects to that port.
- Use `docker compose`, which reads `.env` the same way the app does. `docker run --env-file .env` does not: it keeps
  the quotes, so a value written `'abcd efgh'` arrives with the `'` marks and the password no longer matches.
- `SMTP_CA_FILE` must be a path inside the container: mount the file (for example
  `- ./company-ca.pem:/app/company-ca.pem:ro` under `volumes`) and set `SMTP_CA_FILE=/app/company-ca.pem`.
- The server runs as the unprivileged `node` user and stops cleanly on `docker compose stop` (data is saved first).
  Run one container only: data lives in the process's memory.
- **Docker Desktop (Mac, Windows) shows every phone to the app as one address.** Limits counted per address (wrong
  admin passwords, wrong vote codes) then count the whole room together, so one person guessing can make everyone
  wait. Docker on a Linux server keeps each phone's own address. For a real event, prefer Docker on Linux or run
  `npm start` directly.

Try it with sample data: `node scripts/demo.js`, then open http://localhost:3456/admin (password `demo`).
Full test, including 200 simultaneous voters: `node scripts/smoke-test.js` (email is tested against a local stand-in
for Brevo; nothing is sent).
Gmail/SMTP sending against local stand-in mail servers: `node scripts/mail-test.js` (needs `openssl`).

## On the day

The first time the admin page opens, a checklist at the top walks through steps 1–3 and ticks them off by itself.

1. **Event settings**: set the event name and choose how people get in (new events start on vote codes, "รหัสโหวต").
   Then give out codes in any mix of these ways:
   - Print cards: create about 10% more codes than guests, then press "พิมพ์บัตรรหัส" (print code cards). A4 fits 21
     cards; each card has a QR code with its code built in, so scanning gets the guest straight in.
   - Email codes. See "Email vote codes".
   - A registration desk where guests scan a screen to get a card on their phone. See "Registration desk".

   If you choose names ("กรอกชื่อ"), paste the staff list first.
2. **Contest topics**: create topics, set how many contestants each guest may pick, and add contestants with photos.
3. **Rehearse**: vote from real phones, then go to "ตั้งค่างาน" (event settings) → "ล้างผลโหวตทั้งหมด" (clear all
   votes).
4. **Big screen**: open `/screen` on the projector computer and press F for full screen. Control it from the
   "จอใหญ่" (big screen) tab on the admin page, from a phone if you like.
   - Show the lobby (QR and event name) or a specific topic.
   - "แนะนำตัว" (introduce) shows one contestant at a time, large photo, number and name, while they walk on
     stage. Guests can cheer from their phones during this part. See "Contestant intro and cheers". This is the only
     mode that shows a topic that is not open for voting yet; the other modes need the topic open.
   - "ซ่อนคะแนน" (hide scores) shows only how many people have voted; "โชว์คะแนนสด" (show live scores) shows a bar
     chart.
   - "ประกาศผล" (announce results) works once voting is closed. Then reveal 3rd → 2nd → 1st one step at a time
     with the host. Confetti on 1st place.
5. **Results**: visible at any time, and downloadable as CSV that opens in Excel with Thai text intact.

A typical evening: guests get in as they arrive (cards, email or the desk) → introduce each contestant on the big
screen while guests cheer → performances (outside this app) → open voting → close → announce.

## What guests see

- The entry form is open from the start, before any topic opens, so guests can join during the introductions. It
  says the code is used all evening: cheering during the intro, then voting.
- **"เปิดจากรูปบัตรที่บันทึกไว้"** (open from a saved card picture): pick a picture of the card, a screenshot or a
  photo of a paper card. The phone reads the QR itself (the browser's own reader, or the bundled jsQR when there is
  none, as on iPhone Safari); the picture is not uploaded. It uses the card's signed link, so it works like scanning.
- At the top of the list: the vote code is hidden as `••••-••••` until the eye button is pressed. Guests with a card
  that has no name (printed or from the desk) can set a name for themselves; it stays on that phone only and is never
  sent. A name the admin gave (the email list, or the staff list in name mode) is shown as is and cannot be changed.
- Topics come in three groups: waiting for your vote, voted, closed. Contestant photos open full size. After saving,
  the chosen numbers are shown large.

## Registration desk

For guests who register on arrival. In code mode, open "ตั้งค่างาน" (event settings) → "จุดลงทะเบียนหน้างาน"
(registration desk) → "เปิดหน้าจุดลงทะเบียน" on a tablet or laptop at the desk, signed in as admin. It is a separate
screen from the big screen.

- The desk shows a QR for a **one-time ticket**, never a vote code, so a photo of the desk is worth nothing on its own.
- The guest scans it on their phone and presses **"รับบัตร"** (get card). Only then is a vote code made, and only that
  phone sees it. The desk says "รับบัตรแล้ว · เชิญคนถัดไป" (card taken, next please) and shows a new QR.
- An unclaimed ticket expires after one minute; "เปลี่ยน QR" (new QR) replaces it at once. Of 30 phones pressing
  "รับบัตร" on one ticket at the same moment, one gets the card.
- The phone shows the card with **"บันทึกรูปบัตร"** (save card picture). The picture's QR opens the voter page again
  on any phone. "เข้าร่วมกิจกรรม" (join) goes straight in, no code to type.
- Keep a few printed cards for guests who cannot scan. Desk codes are not counted as printed cards.
- **Staff must watch the desk.** A new QR appears as soon as a card is taken, so someone filming the desk with a
  script could keep taking cards. Staff will see "card taken" with nobody there and the count jumping.

A step-by-step guide for desk staff, in Thai, with pictures: [docs/checkin-guide.md](docs/checkin-guide.md).

## Contestant intro and cheers

On the "จอใหญ่" (big screen) tab, pick a topic and press "แนะนำตัว" (introduce). The big screen shows the first
contestant; the main button reads "ถัดไป: 3 Name" (next: …), so the host knows who is next, with "ก่อนหน้า" (back).
At the last contestant a "เปิดโหวต" (open voting) button appears; opening voting moves the big screen on to the vote
counter and QR. Only contestants already introduced are sent to the big screen, so nobody can read ahead in the data.

While the intro is on, guests get a **"เชียร์ขึ้นจอ"** (cheer on screen) button: six emoji (👏 ❤️ 😂 🔥 😮 🎉) that
rise on the right of the big screen, and short messages (up to 60 characters) that slide across it. Leaving the intro
clears the screen and the button disappears.

- Messages show at once with no sender name. On the "เชียร์จากมือถือ" (cheers from phones) card the admin can turn
  emoji or messages off, "ล้างจอ" (clear screen), hide one message, or block its sender (the sender is not told; their
  messages just stop appearing). Admins can add their own blocked words; a basic list of rude words and all links are
  blocked already.
- Limits: 2 messages, then one every 10 seconds per guest; 12 emoji, then 3 a second; and a ceiling for the whole
  room so the screen stays readable.
- **Not kept.** Messages live in memory for a few seconds (the admin list holds the last 30) and are gone on restart.
  Only the switches, the blocked words and blocked guests are saved.
- A word list cannot catch every creative spelling. Someone should keep an eye on the admin card during the intro.

## Rules the server enforces

- Each guest picks no more than the topic allows. They can change their mind (only the latest picks count) until the
  topic closes.
- Closed topics take no votes. Reopening a topic allows voting again.
- Once anyone has voted, the entry method cannot change until votes are cleared.
- Cheers are accepted only while the big screen is introducing contestants, and only from guests who have joined.
- Ties share a place and appear together on screen with "คะแนนเท่ากัน" (tie). Places 1–3 on screen are the top three
  distinct vote counts; contestants with 0 votes are not placed.

### How well each entry method stops repeat voting

| Method | Stops repeat voting | Limits |
|---|---|---|
| Vote codes (recommended) | Best: one card, one vote | Cards must be printed and handed out. New codes are 8 characters (6-character cards printed earlier still work). Repeated wrong codes pause typed entry for a while, but scanning a new card's QR always gets in. |
| Name or staff ID | Only names on the list the admin pasted | **People can still impersonate each other**: anyone who knows a colleague's name or staff ID can vote as them or change their vote. Guessing is slowed by a small puzzle the phone solves before each entry (normally unnoticeable); if wrong names keep arriving, the puzzle gets harder and may take a few seconds, but there is **no lockout**, so people on the list always get in, even on the same Wi-Fi as a prankster. If the server console says wrong names are arriving unusually often, someone is guessing. |
| No entry details | **Does not** | For casual fun only. Anyone with a script or several browsers can vote any number of times (the server only slows this down and stops simple "clear the browser and vote again"). |

Staff list: one person per line, as `staff ID, full name` (two columns pasted from Excel work) or just a name. Voters
can type either the ID or the name; spacing and letter case do not matter. Duplicate names need separate staff IDs.

## Email vote codes

Available when the entry method is vote codes. Found on the "ตั้งค่างาน" (event settings) tab, under the vote code
box.

- Paste one address per line, with or without a name, for example `somchai@example.com`,
  `Somying Rakngan, somying@example.com`, `"Pump" <pump@example.com>`, or two columns from Excel. If any line has no
  address or a malformed one, nothing is added and the line numbers are listed. Addresses already in the list (case
  ignored) are skipped.
- Each address gets its own code. These codes are **not printed on cards** and do not count toward the card total.
  Printed cards keep working.
- The email has a "เข้าโหวต" (vote now) button with the same link as a card's QR (one tap, no code to type), a QR
  attached as `qr-vote.png` for when the email is opened on a computer, and the code and site address written out.
- **"ส่งให้คนที่ยังไม่ได้ส่ง"** (send to everyone not sent yet) sends only to addresses that have never been sent
  to. Add more addresses later and press it again; nobody gets a second copy. Sending runs on the server, so you can
  close the admin page meanwhile.
- Each person shows a status: not sent / sending / sent (how many times, when) / failed (with the reason), plus "voted"
  once the code has been used. Search by address, name or code, and filter, for example "not voted yet".
- Someone says they did not get it: search their name and press **"ส่งซ้ำ"** (resend) for the same code. Retry
  everyone who failed with "ส่งอีกครั้งให้ที่ไม่สำเร็จ" (retry failed).
- Typo in an address: delete it (its code stops working at once, so whoever received the wrong email cannot use it)
  and add the correct address as a new entry. People who have already voted cannot be deleted.
- "Sent" means the sending service (Gmail, your company server or Brevo) accepted the email. The app cannot tell if
  it bounced or went to spam. Gmail/SMTP: bounces return to the sending account's inbox. Brevo: see Transactional →
  Logs.
- If the event link changes after sending (the "ลิงก์ที่ QR พาไป" field, "link the QR opens", or the machine's Wi-Fi
  address), the admin page shows how many people have the old link and offers to resend to just them. Codes stay the
  same.

**Where the email link works**: until an https address is entered in "ลิงก์ที่ QR พาไป", the link is the Wi-Fi
address, for example `http://192.168.1.20:3000/`, which only opens on the event Wi-Fi (the email tells recipients).
To send ahead of time so people can open it anywhere, put the app online first (see the next section). With an https
link, the QR also shows inside the email, not just as an attachment. (Via Gmail or SMTP the QR is always inside the
email.)

### Choosing how to send

| Method | Good for | Per day | You need |
|---|---|---|---|
| **Gmail** (`MAIL_PROVIDER=gmail`) | Quickest start with an existing Gmail account | about 500 (Google Workspace about 2,000) | A Gmail account with 2-Step Verification and an App Password |
| **Company SMTP** (`MAIL_PROVIDER=smtp`) | Mail from your company domain, better inbox placement | as your company allows | Host, port, username and password from IT |
| **Brevo** (`MAIL_PROVIDER=brevo`) | Neither of the above, or a host that blocks SMTP ports | 300 (free plan) | A Brevo account, an API key and a verified sender |

- Put the values in `.env` (see `.env.example`) and restart. You can switch methods any time by changing
  `MAIL_PROVIDER`; the recipient list and statuses stay.
- Without `MAIL_PROVIDER`, the method is picked from what is set: `BREVO_API_KEY` means Brevo (as in earlier
  versions), otherwise `GMAIL_USER`, then `SMTP_HOST`.
- The admin page's email box shows the method, account and sender name, and has **"ส่งฉบับทดสอบ"** (send a test) so
  you can email yourself first.
- Gmail and SMTP: on start the server tries one login. "ล็อกอิน … ได้ พร้อมส่ง" (logged in, ready) means the settings
  work; if login fails, the admin page shows the reason in red before you press send.

### Daily sending limits

Gmail and Brevo's free plan limit emails per day, so the admin page always shows "about N per day · sent in the last
24 hours · about N left".

- If more people are waiting than can still be sent, a yellow warning appears, and pressing send asks first, offering
  **"ส่ง … ฉบับก่อน"** (send N now). The rest stay in the list; press the same button after 24 hours. Nobody gets a
  second copy.
- The count covers only email sent by this app (test emails included). If the account sends other mail too, the real
  remaining quota is lower.
- Change it with `MAIL_DAILY_LIMIT`, for example `2000` for Google Workspace, your plan's number for paid Brevo, or
  what IT says for a company server. `0` = no warning.
- If the guest list is bigger than one day's limit, start sending several days ahead.

### Using Gmail (once, about 5 minutes)

Create a separate Gmail account for this rather than using a personal one: if you go over the daily limit, Google
suspends sending for the **whole account** for about 24 hours (even from the Gmail website), and every email the app
sends lands in that account's Sent folder.

1. **Turn on 2-Step Verification** (required before you can create an App Password)
   - Sign in to the account and open <https://myaccount.google.com/security>.
   - Under **How you sign in to Google**, choose **2-Step Verification**.
   - Choose **Turn on 2-Step Verification** and follow the steps, usually a phone number and an SMS code.
2. **Create an App Password**
   - Open <https://myaccount.google.com/apppasswords> (or search "App passwords" on the Google Account page). Google
     may ask for your password again.
   - Under **App name**, type anything you will recognise, for example `contest vote`, and press **Create**.
   - A 16-character password appears in a yellow box, for example `abcd efgh ijkl mnop`. **Copy it now**; it is not
     shown again (you can always create a new one). Press **Done**.
3. **Put it in `.env`**

   ```bash
   MAIL_PROVIDER=gmail
   GMAIL_USER=yourname@gmail.com
   GMAIL_APP_PASSWORD='abcd efgh ijkl mnop'
   MAIL_FROM='Party Team <yourname@gmail.com>'
   ```

   - `GMAIL_APP_PASSWORD` is the 16-character password from step 2, **not your Gmail login password**. Spaces are
     optional.
   - `MAIL_FROM` is optional but lets you set the sender name. Its address must match `GMAIL_USER` (Gmail rewrites
     other addresses back to `GMAIL_USER` unless you added them under Gmail → Settings → Accounts and Import →
     "Send mail as").
4. Run `npm start` and check the console shows that Gmail login worked ("ล็อกอิน Gmail ได้ พร้อมส่ง"), then press
   **"ส่งฉบับทดสอบ"** (send a test) on the admin page.

| Problem | Fix |
|---|---|
| The App passwords page says the setting is not available for your account | 2-Step Verification is not on (step 1), or it is a company Google Workspace account where the admin turned it off (ask IT, or use SMTP/Brevo), or the account uses Advanced Protection. |
| Gmail rejects the password and asks for a 16-character App Password | You entered the login password instead of an App Password, or `GMAIL_USER` is not the account that created it. **Changing your Google password invalidates existing App Passwords**; create a new one. |
| Gmail says the quota is used up | Over the daily limit. Wait 24 hours, then press "ส่งอีกครั้งให้ที่ไม่สำเร็จ" (retry failed). |
| Cannot connect to Gmail (smtp.gmail.com:465) | No internet, or the network or host blocks port 465 (some cloud hosts block mail ports). Try another network or use Brevo. |

### Using company SMTP

Ask IT for: server name (host), port, encryption type, username and password (ideally a separate account for system
mail, such as `vote@company.com`), whether it may send outside the company, and how many emails per day.

```bash
MAIL_PROVIDER=smtp
SMTP_HOST=mail.company.com
SMTP_PORT=587
SMTP_USER=vote@company.com
SMTP_PASS='password'
MAIL_FROM='Party Team <vote@company.com>'
# MAIL_DAILY_LIMIT=1000      if IT gives you a number
```

| Setting | How to fill it in |
|---|---|
| `SMTP_PORT` | Usually `587` (starts plain, then encrypts with STARTTLS) or `465` (encrypted from the start). `25` is common internally (it must support STARTTLS too, see below). Default `587`. |
| `SMTP_SECURE` | Leave it out; it follows the port (465 = `true`, otherwise `false`). Set it for unusual ports. `false` = STARTTLS must succeed first or nothing is sent. |
| `SMTP_USER` / `SMTP_PASS` | Leave empty if the internal server relays without login (IT allows this machine's IP). If `SMTP_USER` is an email address, `MAIL_FROM` is optional. |
| `SMTP_CA_FILE` | Only when the server uses a company-issued certificate: get the certificate file from IT (the CA or the server's own certificate, as `.pem` starting with `-----BEGIN CERTIFICATE-----`) and give its path, for example `SMTP_CA_FILE=./company-ca.pem` (relative paths start from the `.env` folder). Certificates issued by this file are trusted in addition to the usual public ones, but are still checked every time, including that the server name matches `SMTP_HOST`. |

**Encryption is always checked and cannot be turned off.** Passwords and email are sent only after the connection is
encrypted and the server's certificate passes: issued by a trusted authority or by the file in `SMTP_CA_FILE`, not
expired, and issued for the same name as `SMTP_HOST`. If any check fails, the app stops before sending the password
and shows the reason on the admin page. Sending unencrypted would let anyone on the same Wi-Fi capture the password,
or strip the word STARTTLS from the server's reply to trick the app into sending in the clear. As a result, **internal
servers with no encryption at all cannot be used** (even without login, because each email carries a personal voting
link). Ask IT to enable STARTTLS, or use Gmail/Brevo.

> `SMTP_ALLOW_SELF_SIGNED` from earlier versions is retired and has no effect (the admin page warns). If you set it,
> switch to `SMTP_CA_FILE` as described above.

- Companies on Google Workspace can use the Gmail method above with a company account (if the admin allows App
  Passwords) and set `MAIL_DAILY_LIMIT=2000`.
- Microsoft 365 / Outlook: host `smtp.office365.com`, port `587`, but the admin must enable "Authenticated SMTP" for
  that mailbox, and Microsoft is phasing out SMTP login with plain passwords. If IT says it does not work, use Gmail or
  Brevo.

| Message (shown in Thai) | Fix |
|---|---|
| Cannot connect to the mail server (host:port) | Wrong host or port, or the network blocks that port (outside networks often cannot reach internal servers). |
| Cannot establish an encrypted connection | Port and `SMTP_SECURE` do not match (465 = `true`, 587/25 = `false`). |
| Server will not encrypt with STARTTLS | The server does not offer STARTTLS. If it uses port 465, set `SMTP_PORT=465`. If IT confirms STARTTLS is supported, something on the network is stripping it (possible interception); try another network. If it really is not supported, it cannot be used with this app. |
| The certificate of … failed verification | Company-issued certificate → put the certificate file in `SMTP_CA_FILE`. Still failing = the file did not issue this certificate, or it has expired. If the server uses a normal public certificate, someone may be intercepting the connection; do not send yet. |
| The server's certificate is not issued for … | `SMTP_HOST` must be the name in the certificate, for example `mail.company.com` instead of an IP (ask IT). |
| `SMTP_CA_FILE` cannot be read / is not a `.pem` certificate | Check the path. The file must be text starting with `-----BEGIN CERTIFICATE-----` (if you got a binary `.cer`/`.crt`, ask IT to convert it to PEM). |
| Username or password rejected | Check `SMTP_USER` / `SMTP_PASS`; some servers need the full email address as username. |
| Will not relay outside the organisation | Log in, or ask IT to allow this machine to send externally. |
| Not allowed to send as … | `MAIL_FROM` must be an address this account may send as, usually the same as `SMTP_USER`. |

### Using Brevo (once, about 10 minutes)

[Brevo](https://www.brevo.com)'s free plan sends **300 emails a day**, needs no credit card and no domain of your own.
The app calls Brevo's API over https directly, so hosts that block SMTP ports are not a problem.

1. Sign up at brevo.com and verify the account as asked.
2. Verify a sender: **Senders, Domains & Dedicated IPs → Senders → Add a sender**, enter the address you will send
   from, and click the link in Brevo's confirmation email.
   - A company address is best, and verifying the domain too (the **Domains** tab, then add the DNS records shown)
     improves inbox placement. Free addresses such as @gmail.com work as a sender but are more likely to land in spam.
3. Create an API key: top-right menu → **SMTP & API → API Keys → Generate a new API key**. Copy the value starting
   with `xkeysib-` (an API key, not an SMTP key).
4. Put it in `.env` and run `npm start` (the old command-line form still works:
   `BREVO_API_KEY=... MAIL_FROM='...' npm start`).

   ```bash
   MAIL_PROVIDER=brevo
   BREVO_API_KEY=xkeysib-xxxxxxxx
   MAIL_FROM='Party Team <vote@company.com>'
   ```

   Keep the API key secret: anyone who has it can send email in your company's name. On hosts such as Railway or
   Render, set it in the environment variables page.
5. On the admin page press **"ส่งฉบับทดสอบ"** (send a test) to yourself first. The test email uses a sample code that
   cannot vote. Check it reaches the inbox, not spam, then send for real.

Every method: if sending fails, the admin page shows the reason. Problems that would make every email fail (wrong
password or API key, sender not allowed, quota used up, cannot reach the server) stop the whole batch at once; fix the
cause and press "ส่งอีกครั้งให้ที่ไม่สำเร็จ" (retry failed).

| Message | Fix |
|---|---|
| Brevo rejects the API key | Check `BREVO_API_KEY`. If **Authorized IPs** is on in Brevo, add the server machine's IP (or turn the restriction off). |
| Sender not verified | Finish step 2, and `MAIL_FROM` must match the verified address. |
| Quota used up | The free plan sends 300 a day. Wait for the next day and press "ส่งอีกครั้งให้ที่ไม่สำเร็จ" (retry failed), or buy a larger plan. Events over 300 people should start sending several days ahead. |
| The admin page says email is not set up, or a setting is incomplete (any method) | The message names the missing setting. Add it to `.env` and restart. If it still shows, check the console printed that it read settings from `.env`, and whether `MAIL_FROM` is malformed (there will be a warning). |

Addresses, names and send status are stored in `data/db.json` with everything else. If the server stops mid-send,
people not yet sent go back to "not sent", and the email being sent at that moment is marked "failed" (because it is
unknown whether it arrived); just send again.

## Putting it online later

The app is a long-running Node server that writes files, so it **does not work on serverless Vercel or Netlify**.
Options include a VPS, Railway, Render or Fly.io, with a persistent volume for `DATA_DIR`.

1. Set `ADMIN_PASSWORD`, point `DATA_DIR` at the persistent volume, and set `TRUST_PROXY=1` because these hosts
   terminate https in front (do not set `HTTPS_PORT`).
2. The start command is `npm start` (most hosts provide `PORT`).
3. Enter the real address, for example `https://vote.example.com`, in "ลิงก์ที่ QR พาไป" (link the QR opens) on the
   "ตั้งค่างาน" (event settings) tab. Cards printed before then must be reprinted, because their QR points at the old
   link; already emailed people can be resent from the email box.
4. Run **one instance only**: data lives in that process's memory.
5. If nginx is in front, turn off buffering for `/api/stream`, `/api/screen/stream` and `/api/admin/stream`, which are
   Server-Sent Events (the server already sends `X-Accel-Buffering: no`). If buffering stays on, pages still work but
   update every 2–3 seconds instead (see the next section).

### Live updates, and running behind a proxy or tunnel

The voter page, big screen and admin page load their first state with a plain request (`/api/state`,
`/api/screen/state`, `/api/admin/state`), so they always open, and then receive updates over a stream.
If the stream delivers nothing within 6 seconds (a proxy is holding it back), the page drops the stream so it does not
hold a connection open, and polls every ~3 seconds instead (the big screen every ~2 seconds). That device does not try
the stream again for 6 hours.
If a stream that was working goes quiet for over 40 seconds, the page polls too, and retries the stream every 30
seconds.

**Cloudflare Quick Tunnel** (`cloudflared tunnel --url ...`, giving a `*.trycloudflare.com` link) does not support SSE
and allows about 200 in-flight requests per tunnel.
When opened through a `trycloudflare.com` link, pages never open a stream and only poll, and the server does not hold
streams for requests arriving through that link (it sends the state once and closes).
Tested with 200 simulated phones keeping the page open, then scanning QR codes and voting at the same time through the
tunnel: every request succeeded (no 429).
Quick Tunnels have no uptime guarantee and the link changes on every run. For a real event, use a named tunnel or a
real domain.

### Why Server-Sent Events and polling, not WebSocket

If you fork this app, here is why it updates pages this way, so you can tell whether the reasons still hold for you.

- **Server-Sent Events (SSE) for live updates.** What must reach phones live travels one way: the server tells them
  a topic opened or closed, and tells the big screen and admin page that counts changed. SSE is plain HTTP that
  Express can serve without a library, browsers have `EventSource` built in, and it reconnects by itself when a phone
  switches between Wi-Fi and mobile data or wakes from a locked screen.
- **Votes stay ordinary `POST` requests.** A guest votes a few times per event and needs an answer each time ("saved"
  or "this topic is closed"). Keeping votes on normal routes means they go through the same session cookie, rate
  limits, cross-site request check and admin check that the security tests already cover (see
  [SECURITY.md](SECURITY.md)).
- **Polling as the fallback.** Some proxies, company networks and Cloudflare Quick Tunnels hold streams back. Any
  live channel can be blocked like this, so polling has to exist whichever one is used. Polling here is cheap: every
  device gets the same cached copy of the state, the server answers `304 Not Modified` when nothing changed, phones
  spread their requests with a random ±20% delay, and hidden tabs stop polling.
- **Why not WebSocket.** WebSocket is the better tool when data flows often in both directions, such as chat,
  multiplayer games or live cursors. This app has no such flow, and switching would mean:
  - another dependency (`ws` or `socket.io`) to keep patched;
  - rebuilding the session, rate-limit and admin checks for a second channel;
  - its own attack to defend against. Cross-Site WebSocket Hijacking: browsers apply no CORS check to WebSocket and
    send the user's cookies with it, so the server has to check `Origin` itself;
  - writing reconnect code by hand.

  Live updates would probably also work through a Quick Tunnel (not tested). That only matters while testing; on a
  real server with buffering turned off, SSE is just as fast. Both hold one open connection per device, so server
  load is similar at a few hundred phones.

Back up by copying the whole `data/` folder.

## License

MIT. See [LICENSE](LICENSE).
