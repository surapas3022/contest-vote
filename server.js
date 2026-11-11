'use strict';
/*
 * Contest vote server — one event at a time, in-memory state persisted to a JSON file.
 * Single Node process: every mutation is synchronous, so no race between concurrent votes
 * (and no race between a rate-limit check and its counter update).
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { loadEnvFile } = require('./env');
const { createSmtpPool } = require('./smtp');

// settings may live in a .env file next to server.js (or ENV_FILE); anything set on the command line wins
const ENV_INFO = loadEnvFile(path.resolve(process.env.ENV_FILE || path.join(__dirname, '.env')));
if (ENV_INFO) {
  const shown = path.relative(process.cwd(), ENV_INFO.file);
  console.log(`อ่านค่าตั้งจาก ${shown && !shown.startsWith('..') ? shown : ENV_INFO.file}: ${ENV_INFO.loaded.join(', ') || '(ไม่มีค่าใหม่)'}`
    + (ENV_INFO.skipped.length ? ` · ใช้ค่าที่พิมพ์หน้าคำสั่งแทน: ${ENV_INFO.skipped.join(', ')}` : ''));
  if (ENV_INFO.bad.length) console.log(`[!] ไฟล์ .env บรรทัด ${ENV_INFO.bad.join(', ')} อ่านไม่ออก ต้องเป็น ชื่อ=ค่า เช่น MAIL_PROVIDER=gmail`);
}

const PORT = Number(process.env.PORT) || 3000;
// the address phones use to reach this server (QR codes, links). Needed in Docker, where the server
// only sees the container's own address; on a plain machine the LAN address is found automatically.
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const IN_DOCKER = fs.existsSync('/.dockerenv');
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ACCESS_MODES = ['code', 'name', 'open'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;           // new codes; 6-letter codes printed earlier keep working
const ADMIN_SESSION_MS = 24 * 60 * 60 * 1000;
const ROSTER_MAX = 5000;

/** uniform random string (rejection sampling, no modulo bias) */
function randomString(len, alphabet) {
  const limit = 256 - (256 % alphabet.length);
  let s = '';
  while (s.length < len) {
    for (const b of crypto.randomBytes(len * 2)) if (b < limit && s.length < len) s += alphabet[b % alphabet.length];
  }
  return s;
}

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = randomString(12, CODE_ALPHABET.toLowerCase());
  console.log('\n[!] ไม่ได้ตั้ง ADMIN_PASSWORD — ใช้รหัสชั่วคราว: ' + ADMIN_PASSWORD + '\n');
} else if (ADMIN_PASSWORD.length < 10) {
  console.log('\n[!] ADMIN_PASSWORD สั้นกว่า 10 ตัว เดาง่าย ควรตั้งให้ยาวขึ้นก่อนใช้งานจริง\n');
}

function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a subnet list — passed to express as-is
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

/* ---------------- state ---------------- */

function emptyDb() {
  return {
    event: { name: 'งานเลี้ยงปีใหม่', accessMode: 'code', publicUrl: '' },
    screen: { topicId: null, mode: 'hidden', revealStep: 0, introIndex: 0 }, // mode: hidden | intro | live | reveal
    topics: [],
    voters: {},   // id -> { id, kind, key, label, createdAt }   (name mode: key = "r:<rosterId>")
    sessions: {}, // voter token -> voterId
    codes: {},    // CODE -> { createdAt, mail?, desk? }   (mail = sent by email, desk = handed out at the check-in desk; neither is printed)
    // cheers on the big screen: switches, the admin's extra blocked words, and muted voter ids.
    // The messages themselves are never written to disk (see "cheers" below).
    cheer: { emoji: true, text: true, words: '', muted: {} },
    desk: { ticket: null, handed: 0 }, // check-in desk: the one-time ticket on screen now { t, exp }, and how many were claimed
    mail: { recipients: [], lastError: '' }, // email delivery of codes, see "email" below
    roster: [],   // name mode allow-list: [{ id, code, name }]
    ballots: {},  // topicId -> { voterId: [contestantId] }
    adminSessions: {}, // sha256(token) -> { createdAt, expiresAt }
    secret: crypto.randomBytes(32).toString('hex'), // signs QR links on code cards
    adminPwFp: null,
    seq: 1,
  };
}

let db = emptyDb();
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { console.error('อ่าน db.json ไม่ได้:', e.message); process.exit(1); }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushSave, 250);
}
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushSave(); process.exit(0); });

const newId = (p) => p + (db.seq++).toString(36) + crypto.randomBytes(2).toString('hex');
const token = () => crypto.randomBytes(18).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

/* admin sessions: stored hashed, expire server-side, all dropped when the password changes */
const hashToken = (t) => sha256('admin:' + t).toString('base64url');
const pwFp = crypto.scryptSync(ADMIN_PASSWORD, 'cv-admin:' + db.secret, 32).toString('base64url');
if (db.adminPwFp !== pwFp) { db.adminSessions = {}; db.adminPwFp = pwFp; }
function pruneAdminSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.adminSessions)) if (!(s && s.expiresAt > now)) delete db.adminSessions[k];
}
pruneAdminSessions();
function adminSession(t) {
  if (!t) return null;
  const s = db.adminSessions[hashToken(t)];
  return s && s.expiresAt > Date.now() ? s : null;
}
flushSave(); // persist secret / migrations right away

function findTopic(id) { return db.topics.find((t) => t.id === id); }
function totalBallots() { return Object.values(db.ballots).reduce((n, b) => n + Object.keys(b).length, 0); }

function lanUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}
function voteUrl() { return (db.event.publicUrl || lanUrl()).replace(/\/+$/, '') + '/'; }

/* ---------------- codes ---------------- */

const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
/** signature printed in the QR of each card: lets QR scans in without going through the guess limiter */
const codeSig = (code) => crypto.createHmac('sha256', db.secret).update('code:' + code).digest('base64url').slice(0, 16);
/** printed cards = every code that was not handed out by email or at the check-in desk */
const isCardCode = (code) => !!db.codes[code] && !db.codes[code].mail && !db.codes[code].desk;
function newCode(extra = {}) {
  let code;
  do code = randomString(CODE_LENGTH, CODE_ALPHABET); while (db.codes[code]);
  db.codes[code] = { createdAt: new Date().toISOString(), ...extra };
  return code;
}
const codeLink = (base, code) => `${base}?c=${code}&s=${codeSig(code)}`;
const usedCodes = () => new Set(Object.values(db.voters).filter((v) => v.kind === 'code').map((v) => v.key));
const fmtCode = (c) => (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c);

/* ---------------- email: one code per address, sent through Brevo, Gmail or an SMTP server ----------------
 * Each recipient gets an ordinary vote code (db.codes, marked with the recipient id so it is left
 * off the printed cards). The email carries the same signed link as a card's QR. Sending runs in
 * the background from a queue; every status change shows up live on the admin page. */

const envStr = (k) => String(process.env[k] || '').trim();
const envYes = (k) => /^(1|true|yes|on)$/i.test(envStr(k));
const BREVO_API_KEY = envStr('BREVO_API_KEY');
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email'; // override only for tests
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']{1,64}@[^\s@<>()[\]\\,;:"'.]+(\.[^\s@<>()[\]\\,;:"'.]+)+$/;
function parseFrom(s) {
  const m = /^\s*(?:"?([^"<]*?)"?\s*<\s*([^<>\s]+)\s*>|([^<>\s]+))\s*$/.exec(String(s || ''));
  const email = m && (m[2] || m[3]);
  return email && EMAIL_RE.test(email) ? { name: (m[1] || '').trim(), email } : null;
}
const MAIL_FROM = parseFrom(process.env.MAIL_FROM);
if (process.env.MAIL_FROM && !MAIL_FROM) console.log('\n[!] MAIL_FROM ไม่ใช่อีเมลที่ถูกต้อง ใส่เป็น vote@example.com หรือ "ชื่อ <vote@example.com>"\n');

/**
 * The company's own CA certificate(s) for its mail server, from a .pem file named in env var k.
 * Trusted in addition to the usual public roots; checking is never turned off. A relative path is
 * taken from the folder of the .env file. A file that cannot be read stops email with the reason.
 */
function readCaFile(k, s) {
  const p = envStr(k);
  if (!p) return undefined;
  const file = path.resolve(path.dirname(ENV_INFO && ENV_INFO.file ? ENV_INFO.file : path.join(__dirname, '.env')), p);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    s.missing.push(`${k} (อ่านไฟล์ ${file} ไม่ได้: ${e.code || e.message})`);
    return undefined;
  }
  const certs = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!certs) { s.missing.push(`${k} (ไฟล์ ${file} ไม่ใช่ใบรับรองแบบ .pem ที่ขึ้นต้นด้วย -----BEGIN CERTIFICATE-----)`); return undefined; }
  return certs;
}

/* which service sends: MAIL_PROVIDER, or guessed from the settings present (Brevo first, as before) */
const MAIL_KINDS = {
  brevo: { label: 'Brevo', limit: 300, accepts: 'Brevo' },
  gmail: { label: 'Gmail', limit: 500, accepts: 'Gmail' },
  smtp: { label: 'SMTP ของบริษัท', limit: 0, accepts: 'เซิร์ฟเวอร์อีเมลของบริษัท' },
};
function mailSetupFromEnv() {
  const asked = envStr('MAIL_PROVIDER').toLowerCase();
  const kind = asked || (BREVO_API_KEY ? 'brevo' : envStr('GMAIL_USER') ? 'gmail' : envStr('SMTP_HOST') ? 'smtp' : '');
  const s = { kind, from: MAIL_FROM, account: '', smtp: null, missing: [], notes: [], problem: '' };
  if (!kind) {
    s.problem = 'ยังไม่ได้ตั้งค่าการส่งอีเมล เลือกได้ 3 แบบ: Brevo (BREVO_API_KEY), Gmail (GMAIL_USER กับ GMAIL_APP_PASSWORD) หรือ SMTP ของบริษัท (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) พร้อม MAIL_FROM';
    return s;
  }
  if (!MAIL_KINDS[kind]) {
    s.kind = '';
    s.problem = `MAIL_PROVIDER=${asked.slice(0, 30)} ไม่รู้จัก ใส่ได้แค่ brevo, gmail หรือ smtp`;
    return s;
  }
  if (kind === 'brevo') {
    if (!BREVO_API_KEY) s.missing.push('BREVO_API_KEY');
    if (!MAIL_FROM) s.missing.push('MAIL_FROM');
    s.account = MAIL_FROM ? MAIL_FROM.email : '';
  } else if (kind === 'gmail') {
    const user = envStr('GMAIL_USER');
    const pass = envStr('GMAIL_APP_PASSWORD').replace(/\s+/g, ''); // Google shows it as 4 groups of 4
    if (!EMAIL_RE.test(user)) s.missing.push('GMAIL_USER');
    if (!pass) s.missing.push('GMAIL_APP_PASSWORD');
    else if (pass.length !== 16) s.notes.push(`GMAIL_APP_PASSWORD ยาว ${pass.length} ตัว แต่ App Password ของ Google ยาว 16 ตัว (ไม่นับเว้นวรรค) ถ้าใส่รหัสผ่านที่ใช้ล็อกอิน Gmail จะส่งไม่ได้`);
    s.from = MAIL_FROM || (EMAIL_RE.test(user) ? { name: '', email: user } : null);
    if (MAIL_FROM && user && MAIL_FROM.email.toLowerCase() !== user.toLowerCase()) {
      s.notes.push(`Gmail จะเปลี่ยนผู้ส่งเป็น ${user} ถ้า ${MAIL_FROM.email} ไม่ได้ตั้งเป็น “Send mail as” ในบัญชี Gmail นี้`);
    }
    // override only for tests: a stand-in on STARTTLS whose certificate comes from GMAIL_SMTP_CA_FILE
    const testHost = envStr('GMAIL_SMTP_HOST');
    s.smtp = { host: testHost || 'smtp.gmail.com', port: Number(envStr('GMAIL_SMTP_PORT')) || 465, secure: !testHost, user, pass, maxConnections: 2 };
    if (testHost) s.smtp.ca = readCaFile('GMAIL_SMTP_CA_FILE', s);
    s.account = user;
  } else {
    const host = envStr('SMTP_HOST');
    const port = envStr('SMTP_PORT') ? Number(envStr('SMTP_PORT')) : 587;
    const user = envStr('SMTP_USER');
    if (!host) s.missing.push('SMTP_HOST');
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) s.missing.push('SMTP_PORT (ตัวเลข เช่น 587)');
    if (user && !process.env.SMTP_PASS) s.missing.push('SMTP_PASS');
    s.from = MAIL_FROM || (EMAIL_RE.test(user) ? { name: '', email: user } : null);
    if (!s.from) s.missing.push('MAIL_FROM');
    s.smtp = {
      host, port, user, pass: process.env.SMTP_PASS || '',
      secure: envStr('SMTP_SECURE') ? envYes('SMTP_SECURE') : port === 465,
      ca: readCaFile('SMTP_CA_FILE', s),
    };
    if (envStr('SMTP_ALLOW_SELF_SIGNED')) {
      s.notes.push('SMTP_ALLOW_SELF_SIGNED เลิกใช้แล้วและไม่มีผล ระบบตรวจใบรับรองของเซิร์ฟเวอร์อีเมลทุกครั้ง'
        + (s.smtp.ca ? ' (ตรวจกับไฟล์ใน SMTP_CA_FILE) ลบบรรทัดนี้ออกจาก .env ได้' : ' ถ้าเซิร์ฟเวอร์ใช้ใบรับรองที่บริษัทออกเอง ให้ขอไฟล์ใบรับรอง (.pem) จากฝ่ายไอทีแล้วใส่ที่อยู่ไฟล์ใน SMTP_CA_FILE แทน'));
    }
    s.account = `${host}:${port}${user ? ` (${user})` : ''}`;
  }
  const lim = envStr('MAIL_DAILY_LIMIT');
  s.limit = /^\d+$/.test(lim) ? Number(lim) : MAIL_KINDS[kind].limit;
  if (lim && !/^\d+$/.test(lim)) s.notes.push(`MAIL_DAILY_LIMIT=${lim.slice(0, 20)} ไม่ใช่ตัวเลข ใช้ค่าปกติของ ${MAIL_KINDS[kind].label} แทน`);
  if (s.missing.length) s.problem = `ตั้งค่าการส่งอีเมลแบบ ${MAIL_KINDS[kind].label} ยังไม่ครบ ต้องตั้ง ${s.missing.join(', ')}`;
  return s;
}
const MAIL_SETUP = mailSetupFromEnv();
const MAIL_KIND = MAIL_KINDS[MAIL_SETUP.kind] || null;
const SENDER = MAIL_SETUP.from; // who the email says it is from
const mailConfigured = () => !MAIL_SETUP.problem;
const notConfiguredMsg = () => `${MAIL_SETUP.problem} ในไฟล์ .env แล้วรันเซิร์ฟเวอร์ใหม่ (ดูหัวข้อ “ส่งรหัสทางอีเมล” ใน README)`;
const smtpPool = mailConfigured() && MAIL_SETUP.smtp ? createSmtpPool(MAIL_SETUP.smtp) : null;
let mailCheck = null; // result of logging in to Gmail / the SMTP server at startup: { ok, error }
const MAIL_CONCURRENCY = 4;
const MAIL_STATUSES = ['pending', 'queued', 'sending', 'sent', 'failed'];

let mailRev = 1; // bumped on every recipient change; the admin page refetches the list when it moves
function mailChanged() { mailRev++; changed(); }
const recipientById = (id) => db.mail.recipients.find((r) => r.id === id);

// server stopped mid-send: queued ones go back to where they were, in-flight ones are unknown
for (const r of db.mail.recipients) {
  if (r.status === 'queued') r.status = r.prev || 'pending';
  else if (r.status === 'sending') { r.status = 'failed'; r.error = 'เซิร์ฟเวอร์หยุดระหว่างส่ง ไม่แน่ใจว่าถึงหรือไม่ กดส่งซ้ำได้'; }
  delete r.prev;
}
save();

/** one person per line: "email", "name, email", "email<TAB>name", "Name <email>" … → { entries } | { error } */
function parseRecipients(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'ใส่อีเมลอย่างน้อย 1 บรรทัด' };
  if (lines.length + db.mail.recipients.length > ROSTER_MAX) return { error: `รายชื่ออีเมลรวมกันได้ไม่เกิน ${ROSTER_MAX.toLocaleString('en-US')} คน` };
  const have = new Set(db.mail.recipients.map((r) => r.email.toLowerCase()));
  const entries = []; const problems = []; let skipped = 0;
  for (const [i, line] of lines.entries()) {
    const found = line.match(/[^\s<>()[\]\\,;:"']+@[^\s<>()[\]\\,;:"']+/g) || [];
    if (found.length !== 1) { problems.push(`บรรทัด ${i + 1}: ${found.length ? 'มีอีเมลมากกว่าหนึ่งอัน' : 'ไม่พบอีเมล'}`); continue; }
    const email = found[0].replace(/\.+$/, '');
    if (email.length > 254 || !EMAIL_RE.test(email)) { problems.push(`บรรทัด ${i + 1}: อีเมล ${email.slice(0, 60)} ไม่ถูกต้อง`); continue; }
    const name = line.replace(found[0], ' ').replace(/[<>"'\t,;]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = email.toLowerCase();
    if (have.has(key)) { skipped++; continue; }
    have.add(key);
    entries.push({ email, name });
  }
  if (problems.length) return { error: problems.slice(0, 5).join(' · ') + (problems.length > 5 ? ` · และอีก ${problems.length - 5} จุด` : '') + ' — ยังไม่ได้เพิ่มใครเลย แก้แล้วกดเพิ่มอีกครั้ง' };
  return { entries, skipped };
}

function mailSummary() {
  const used = usedCodes(); const url = voteUrl();
  const n = Object.fromEntries(MAIL_STATUSES.map((s) => [s, 0]));
  let usedN = 0; let stale = 0;
  for (const r of db.mail.recipients) {
    n[r.status]++;
    if (used.has(r.code)) usedN++;
    if (r.status === 'sent' && r.sentUrl !== url) stale++;
  }
  return {
    configured: mailConfigured(),
    from: SENDER ? (SENDER.name ? `${SENDER.name} <${SENDER.email}>` : SENDER.email) : null,
    provider: MAIL_KIND && {
      kind: MAIL_SETUP.kind, label: MAIL_KIND.label, accepts: MAIL_KIND.accepts, account: MAIL_SETUP.account,
      limit: MAIL_SETUP.limit, sent24h: sentLast24h(),
    },
    problem: MAIL_SETUP.problem, notes: MAIL_SETUP.notes, check: mailCheck,
    total: db.mail.recipients.length, pending: n.pending, sending: n.queued + n.sending, sent: n.sent, failed: n.failed,
    used: usedN, stale, lastError: db.mail.lastError || '', rev: mailRev,
  };
}

/* emails sent in the last 24 hours, in hourly buckets (UTC "YYYY-MM-DDTHH"), so the admin can see
 * how much of a daily limit is left. Only counts what this server sent, test emails included. */
db.mail.hourly = db.mail.hourly || {};
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);
function sentLast24h() {
  const from = hourKey(Date.now() - 23 * 3600e3);
  return Object.entries(db.mail.hourly).reduce((n, [k, v]) => (k >= from ? n + v : n), 0);
}
function countSent() {
  const k = hourKey(Date.now());
  db.mail.hourly[k] = (db.mail.hourly[k] || 0) + 1;
  const old = hourKey(Date.now() - 48 * 3600e3);
  for (const key of Object.keys(db.mail.hourly)) if (key < old) delete db.mail.hourly[key];
}

/** email links work from anywhere only when the event link is public (https); a LAN link needs the venue Wi-Fi */
const publicLink = () => /^https:\/\//i.test(db.event.publicUrl || '');

async function buildMail(r, base, sample = false) {
  const link = sample ? base : codeLink(base, r.code);
  const png = await QRCode.toBuffer(link, { type: 'png', margin: 2, width: 400, errorCorrectionLevel: 'M' });
  // Brevo can't embed images (no cid:), so the QR goes along as an attachment, and is also shown
  // in the body from this server when the link is public (mail apps fetch images from the internet).
  // Gmail / SMTP send the message whole, so the QR rides inside it and always shows in the body.
  const inline = !!MAIL_SETUP.smtp;
  const img = inline ? 'cid:qr-vote@contest-vote' : !sample && publicLink() ? `${base}api/mail-qr/${r.code}.png?s=${codeSig(r.code)}` : null;
  const ev = db.event.name;
  const code = sample ? 'ABCD-EFGH (ตัวอย่าง)' : fmtCode(r.code);
  const hello = r.name ? `สวัสดีคุณ${r.name.replace(/^คุณ\s*/, '')}` : 'สวัสดีค่ะ';
  const wifi = publicLink() ? '' : 'ลิงก์นี้เปิดได้เมื่อมือถือต่อ Wi-Fi ของงานเท่านั้น';
  const e = esc;
  const font = "'Anuphan','Noto Sans Thai','Leelawadee UI',Tahoma,Arial,sans-serif";
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(ev)}</title></head>
<body style="margin:0;padding:0;background:#f7f4f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4f3"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4dcda;border-radius:14px;font-family:${font};color:#1f1715">
<tr><td style="padding:28px 28px 4px">
  <p style="margin:0 0 6px;font-size:14px;color:#6b5f5c">${e(ev)}</p>
  <h1 style="margin:0 0 12px;font-size:22px;line-height:1.5">${e(hello)}</h1>
  <p style="margin:0;font-size:16px;line-height:1.7">นี่คือรหัสโหวตของคุณ กดปุ่มด้านล่างแล้วเข้าโหวตได้เลย ไม่ต้องกรอกรหัส</p>
</td></tr>
<tr><td align="center" style="padding:20px 28px">
  <a href="${e(link)}" style="display:inline-block;background:#b42318;color:#ffffff;text-decoration:none;font-weight:700;font-size:18px;line-height:1.5;padding:14px 40px;border-radius:10px">เข้าโหวต</a>
  ${wifi ? `<p style="margin:10px 0 0;font-size:14px;color:#8a5300">${wifi}</p>` : ''}
</td></tr>
<tr><td align="center" style="padding:0 28px 8px;font-size:14px;line-height:1.7;color:#6b5f5c">
  ${img ? `<img src="${e(img)}" width="180" height="180" alt="QR สำหรับเข้าโหวต" style="display:block;margin:0 auto 6px;border:0">หรือสแกน QR นี้ด้วยมือถือ`
    : 'ถ้าเปิดอีเมลบนคอมพิวเตอร์ สแกน QR ในไฟล์แนบ (qr-vote.png) ด้วยมือถือได้เลย'}
</td></tr>
<tr><td align="center" style="padding:12px 28px 24px">
  <p style="margin:0;font-size:14px;color:#6b5f5c">รหัสโหวต</p>
  <p style="margin:2px 0 6px;font-size:28px;font-weight:700;letter-spacing:2px;font-family:Menlo,Consolas,monospace">${e(code)}</p>
  <p style="margin:0;font-size:14px;line-height:1.7;color:#6b5f5c">ถ้ากดลิงก์ไม่ได้ ให้เปิด ${e(base)} แล้วกรอกรหัสนี้</p>
</td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid #e4dcda;font-size:13px;line-height:1.7;color:#6b5f5c">รหัสนี้ใช้ได้หนึ่งคน อย่าส่งต่อให้คนอื่น เปลี่ยนใจได้จนกว่าหัวข้อจะปิดโหวต</td></tr>
</table></td></tr></table></body></html>`;
  const text = [ev, '', hello, 'นี่คือรหัสโหวตของคุณ เปิดลิงก์นี้แล้วเข้าโหวตได้เลย:', link, wifi, '',
    `รหัสโหวต: ${code}`, `ถ้าเปิดลิงก์ไม่ได้ ให้เปิด ${base} แล้วกรอกรหัสนี้`, '', 'รหัสนี้ใช้ได้หนึ่งคน อย่าส่งต่อให้คนอื่น'].filter((l, i, a) => l || a[i - 1]).join('\n');
  return {
    sender: SENDER.name ? SENDER : { name: ev.slice(0, 70), email: SENDER.email },
    to: [r.name ? { email: r.email, name: r.name } : { email: r.email }],
    subject: `รหัสโหวตของคุณ · ${ev}`,
    htmlContent: html, textContent: text,
    attachment: [{ name: 'qr-vote.png', content: png.toString('base64'), ...(inline ? { cid: 'qr-vote@contest-vote' } : {}) }],
    tags: ['vote-code'],
  };
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class MailError extends Error { constructor(msg, fatal) { super(msg); this.fatal = fatal; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** one email through Brevo, retrying rate limits and server hiccups. fatal = every other email would fail the same way */
async function sendBrevo(payload) {
  for (let attempt = 0; ; attempt++) {
    let res; let body = {};
    try {
      res = await fetch(BREVO_API_URL, {
        method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
        headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      });
      body = await res.json().catch(() => ({}));
    } catch {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw new MailError('ต่อระบบส่งอีเมล (Brevo) ไม่ได้ ตรวจว่าเครื่องนี้ต่ออินเทอร์เน็ตอยู่', true);
    }
    if (res.ok) return body;
    const detail = String(body.message || body.code || '').replace(/\s+/g, ' ').slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 3 * (attempt + 1)) * 1000);
      continue;
    }
    if (res.status === 401) throw new MailError(`Brevo ไม่รับ API key ตรวจค่า BREVO_API_KEY หรือถ้าเปิดจำกัด IP ใน Brevo ไว้ ต้องเพิ่ม IP ของเครื่องนี้ (${detail})`, true);
    if (res.status === 402) throw new MailError(`โควตาส่งอีเมลของ Brevo หมด (แผนฟรีส่งได้ 300 ฉบับต่อวัน) ส่งต่อพรุ่งนี้หรืออัปเกรดแผน (${detail})`, true);
    if (res.status === 403) throw new MailError(`Brevo ยังไม่อนุญาตให้บัญชีนี้ส่งอีเมล (${detail})`, true);
    if (res.status === 400 && /sender/i.test(detail)) throw new MailError(`อีเมลผู้ส่ง ${MAIL_FROM.email} ยังไม่ได้ยืนยันใน Brevo (Senders) (${detail})`, true);
    if (res.status === 429) throw new MailError(`Brevo ให้รอก่อนเพราะส่งถี่เกินไป กดส่งซ้ำอีกสักครู่ (${detail})`, true);
    throw new MailError(`Brevo ไม่รับอีเมลนี้ (${res.status}${detail ? ': ' + detail : ''})`, false);
  }
}

/** an SMTP failure in words the admin can act on. retry = worth trying again in a moment */
function smtpMailError(e) {
  const gmail = MAIL_SETUP.kind === 'gmail';
  const who = gmail ? 'Gmail' : 'เซิร์ฟเวอร์อีเมล';
  const { host, port } = MAIL_SETUP.smtp;
  const detail = String(e.response || e.message || '').replace(/\s+/g, ' ').slice(0, 200);
  const err = (msg, fatal, retry = false) => Object.assign(new MailError(`${msg} (${detail})`, fatal), { retry });
  const quota = /5\.4\.5|daily.{0,20}(limit|quota)|quota|limit exceeded|too many (messages|emails)/i.test(detail);
  const noPw = 'ระบบหยุดก่อนส่งรหัสผ่านหรืออีเมลใด ๆ';
  if (e.code === 'ENOTLS' || (e.stage === 'starttls' && e.code !== 'ETLS')) {
    return err(gmail ? `Gmail ไม่ยอมเริ่มการเชื่อมต่อแบบเข้ารหัส ${noPw} เครือข่ายนี้อาจดักการเชื่อมต่อไว้ ลองเครือข่ายอื่น`
      : `${host}:${port} ไม่ยอมเข้ารหัสด้วย STARTTLS ${noPw} เพราะส่งแบบไม่เข้ารหัสแล้วคนที่อยู่เครือข่ายเดียวกันดักรหัสผ่านได้ · `
        + 'ถ้าเซิร์ฟเวอร์ใช้พอร์ต 465 ให้ตั้ง SMTP_PORT=465 (หรือ SMTP_SECURE=true) · ถ้าเซิร์ฟเวอร์รองรับ STARTTLS อยู่แล้ว แปลว่ามีคนในเครือข่ายตัดการเข้ารหัสออก ลองเครือข่ายอื่น · '
        + 'ถ้าเซิร์ฟเวอร์ไม่รองรับการเข้ารหัสเลย ใช้กับระบบนี้ไม่ได้ ให้ฝ่ายไอทีเปิด STARTTLS หรือใช้ Gmail/Brevo แทน', true);
  }
  if (e.code === 'ETLS') {
    if (gmail) return err(`เชื่อมต่อ Gmail แบบเข้ารหัสไม่ได้ (ใบรับรองไม่ผ่านการตรวจ) ${noPw} เครือข่ายนี้อาจดักการเชื่อมต่อไว้ ลองเครือข่ายอื่น`, true);
    if (e.tls === 'cert') {
      return err(`ใบรับรองของ ${host}:${port} ไม่ผ่านการตรวจ ${noPw} · ถ้าเซิร์ฟเวอร์ใช้ใบรับรองที่บริษัทออกเอง ให้ขอไฟล์ใบรับรองของบริษัท (.pem) จากฝ่ายไอทีแล้วใส่ที่อยู่ไฟล์ใน SMTP_CA_FILE`
        + `${MAIL_SETUP.smtp.ca ? ' (ไฟล์ใน SMTP_CA_FILE ตอนนี้ไม่ใช่ใบที่ออกใบรับรองนี้ หรือใบรับรองหมดอายุ)' : ''} · ถ้าไม่ได้ใช้ใบรับรองของบริษัท อาจมีคนดักการเชื่อมต่ออยู่`, true);
    }
    if (e.tls === 'name') {
      return err(`ใบรับรองของเซิร์ฟเวอร์ไม่ได้ออกให้ชื่อ ${host} ${noPw} · ตั้ง SMTP_HOST ให้ตรงกับชื่อในใบรับรอง (ถามฝ่ายไอที เช่นใช้ชื่อเต็มแทน IP) · ถ้าชื่อถูกแล้ว อาจมีคนดักการเชื่อมต่ออยู่`, true);
    }
    return err(`เชื่อมต่อ ${host}:${port} แบบเข้ารหัสไม่ได้ ${noPw} · พอร์ต 465 ใช้ SMTP_SECURE=true ส่วน 587 หรือ 25 ใช้ SMTP_SECURE=false · ถ้าเซิร์ฟเวอร์ใช้ใบรับรองที่บริษัทออกเอง ใส่ไฟล์ใบรับรองใน SMTP_CA_FILE`, true);
  }
  if (e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' || !e.responseCode) {
    return err(`ต่อ ${who} (${host}:${port}) ไม่ได้ ตรวจว่าเครื่องนี้ต่ออินเทอร์เน็ตอยู่${gmail ? '' : ' ชื่อ host กับพอร์ตถูก'} และเครือข่ายไม่ได้บล็อกพอร์ต ${port}`, true, true);
  }
  if (quota) return err(`${who} แจ้งว่าส่งครบโควตาแล้ว${gmail ? ' (Gmail ส่งได้ราววันละ 500 ฉบับ บัญชี Google Workspace ราว 2,000)' : ''} รอให้ครบ 24 ชั่วโมงแล้วกด “ส่งอีกครั้งให้ที่ไม่สำเร็จ”`, true);
  if (e.stage === 'auth' || e.responseCode === 535 || e.responseCode === 534) {
    return err(gmail ? 'Gmail ไม่รับรหัสผ่าน ต้องใช้ App Password 16 ตัว ไม่ใช่รหัสผ่านที่ใช้ล็อกอิน และ GMAIL_USER ต้องเป็นบัญชีเดียวกับที่สร้าง App Password (ดู README)'
      : 'เซิร์ฟเวอร์อีเมลไม่รับชื่อผู้ใช้หรือรหัสผ่าน ตรวจ SMTP_USER และ SMTP_PASS', true);
  }
  if (e.responseCode === 530) return err(`${who} ให้ล็อกอินก่อนส่ง ตั้ง SMTP_USER และ SMTP_PASS`, true);
  if (e.responseCode >= 400 && e.responseCode < 500) return err(`${who} ให้รอก่อน (อาจส่งถี่เกินไป) กดส่งซ้ำอีกสักครู่`, true, true);
  if (/relay/i.test(detail)) return err(`${who} ไม่ยอมส่งออกไปนอกองค์กร (relay) ต้องล็อกอินด้วย SMTP_USER/SMTP_PASS หรือให้ฝ่ายไอทีอนุญาตเครื่องนี้`, true);
  if (e.stage === 'mail') return err(`${who} ไม่ให้ส่งในชื่อ ${SENDER.email} ตรวจ MAIL_FROM ว่าเป็นอีเมลที่บัญชีนี้ใช้ส่งได้`, true);
  if (e.stage === 'rcpt') return err(`${who} ไม่รับอีเมลผู้รับนี้`, false);
  return err(`${who} ไม่รับอีเมลนี้`, false);
}

/** one email through Gmail / SMTP, retrying dropped connections and "try again later" */
async function sendSmtp(p) {
  const msg = {
    from: p.sender, to: p.to[0], subject: p.subject, html: p.htmlContent, text: p.textContent,
    attachments: p.attachment.map((a) => ({ filename: a.name, content: Buffer.from(a.content, 'base64'), cid: a.cid })),
  };
  for (let attempt = 0; ; attempt++) {
    try { return await smtpPool.send(msg); } catch (e) {
      const me = smtpMailError(e);
      if (me.retry && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      throw me;
    }
  }
}
const sendMail = (payload) => (MAIL_SETUP.smtp ? sendSmtp(payload) : sendBrevo(payload));

const mailQueue = [];
let mailActive = 0;
function queueMail(list) {
  for (const r of list) { r.prev = r.status; r.status = 'queued'; mailQueue.push(r.id); }
  mailChanged();
  pumpMail();
}
function pumpMail() {
  while (mailActive < MAIL_CONCURRENCY && mailQueue.length) {
    const r = recipientById(mailQueue.shift());
    if (!r || r.status !== 'queued') continue;
    mailActive++;
    deliverMail(r).finally(() => { mailActive--; pumpMail(); });
  }
}
async function deliverMail(r) {
  r.status = 'sending'; mailChanged();
  const base = voteUrl();
  try {
    const res = await sendMail(await buildMail(r, base));
    Object.assign(r, { status: 'sent', error: '', sends: (r.sends || 0) + 1, sentAt: new Date().toISOString(), sentUrl: base, messageId: res.messageId || null });
    db.mail.lastError = '';
    countSent();
    if (mailCheck && !mailCheck.ok) mailCheck = { ok: true, error: '' };
  } catch (e) {
    Object.assign(r, { status: 'failed', error: e.message, failedAt: new Date().toISOString() });
    if (e.fatal) {
      // the same problem would hit everyone still waiting: stop here instead of trying each one
      db.mail.lastError = e.message;
      for (const id of mailQueue.splice(0)) {
        const q = recipientById(id);
        if (q && q.status === 'queued') Object.assign(q, { status: 'failed', error: 'ยังไม่ได้ส่ง: ' + e.message, failedAt: r.failedAt });
      }
      console.log('[!] ส่งอีเมลไม่ได้: ' + e.message);
    }
  }
  delete r.prev;
  mailChanged();
}

/* ---------------- roster (name mode) ---------------- */

// tolerant match key: Unicode-normalised, case-insensitive, all whitespace / zero-width chars removed
const normKey = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[\s​-‍⁠﻿]+/g, '');

let rosterIdx = null;
function rosterIndex() {
  if (rosterIdx) return rosterIdx;
  const byId = new Map(); const byCode = new Map(); const byName = new Map();
  for (const r of db.roster) {
    byId.set(r.id, r);
    if (r.code) byCode.set(normKey(r.code), r);
    const k = normKey(r.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  return (rosterIdx = { byId, byCode, byName });
}
/** → { entry } | { ambiguous: true } | {} */
function lookupRoster(input) {
  const k = normKey(input);
  if (!k) return {};
  const idx = rosterIndex();
  if (idx.byCode.has(k)) return { entry: idx.byCode.get(k) };
  const list = idx.byName.get(k) || [];
  if (list.length === 1) return { entry: list[0] };
  if (list.length > 1) return { ambiguous: true };
  return {};
}

function parseRoster(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > ROSTER_MAX) return { error: `ใส่รายชื่อได้ไม่เกิน ${ROSTER_MAX.toLocaleString('en-US')} คน` };
  const entries = [];
  const seenCode = new Map(); const nameCount = new Map();
  const problems = [];
  for (const [i, line] of lines.entries()) {
    const cut = line.search(/[\t,]/);
    let code = cut > 0 ? line.slice(0, cut).trim() : '';
    let name = (cut > 0 ? line.slice(cut + 1) : line).replace(/[\t,]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) { name = code; code = ''; }
    code = code.slice(0, 40); name = name.slice(0, 120);
    if (normKey(name).length < 2) { problems.push(`บรรทัด ${i + 1}: ชื่อสั้นเกินไป`); continue; }
    if (code) {
      const ck = normKey(code);
      if (seenCode.has(ck)) problems.push(`รหัสพนักงาน ${code} ซ้ำกัน (บรรทัด ${seenCode.get(ck)} และ ${i + 1})`);
      seenCode.set(ck, i + 1);
    }
    const nk = normKey(name);
    nameCount.set(nk, [...(nameCount.get(nk) || []), { line: i + 1, code }]);
    entries.push({ code, name });
  }
  for (const list of nameCount.values()) {
    if (list.length > 1 && list.some((x) => !x.code)) problems.push(`ชื่อซ้ำกันที่บรรทัด ${list.map((x) => x.line).join(', ')} — ใส่รหัสพนักงานหน้าชื่อเพื่อแยกคน`);
  }
  if (problems.length) return { error: problems.slice(0, 5).join(' · ') + (problems.length > 5 ? ` · และอีก ${problems.length - 5} จุด` : '') };
  // keep ids stable so people already linked to an entry stay linked
  const old = rosterIndex();
  const used = new Set();
  for (const e of entries) {
    let prev = e.code && old.byCode.get(normKey(e.code));
    if (!prev) { const same = old.byName.get(normKey(e.name)) || []; if (same.length === 1) prev = same[0]; }
    e.id = prev && !used.has(prev.id) ? prev.id : newId('r');
    used.add(e.id);
  }
  return { entries };
}
const rosterText = () => db.roster.map((r) => (r.code ? `${r.code}, ${r.name}` : r.name)).join('\n');

/** name-mode voters must still be on the roster; other kinds always count as listed */
function listedVoter(v) {
  if (v.kind !== 'name') return true;
  return typeof v.key === 'string' && v.key.startsWith('r:') && rosterIndex().byId.has(v.key.slice(2));
}
function unlistedVoterIds() {
  return Object.values(db.voters).filter((v) => v.kind === 'name' && !listedVoter(v)).map((v) => v.id);
}

/* ---------------- rate limits (token buckets, in memory) ---------------- */

function bucket(capacity, perSec) {
  const m = new Map();
  function get(key) {
    const now = Date.now();
    let b = m.get(key);
    if (!b) { b = { t: capacity, at: now }; m.set(key, b); }
    else { b.t = Math.min(capacity, b.t + ((now - b.at) / 1000) * perSec); b.at = now; }
    return b;
  }
  return {
    wait(key) { const b = get(key); return b.t >= 1 ? 0 : Math.ceil((1 - b.t) / perSec); }, // seconds
    take(key) { get(key).t -= 1; },
    sweep() { const now = Date.now(); for (const [k, b] of m) if (b.t + ((now - b.at) / 1000) * perSec >= capacity) m.delete(k); },
  };
}
const limits = {
  loginIp: bucket(5, 1 / 60),     // 5 wrong passwords, then 1 per minute per address
  loginAll: bucket(50, 1 / 3),    // and never more than ~20 per minute from everywhere together
  joinFailIp: bucket(20, 1 / 5),  // wrong codes / names: 20, then 12 per minute per address
  joinFailAll: bucket(200, 2),    // and ~120 per minute from everywhere together
  openJoinIp: bucket(300, 1),     // open mode: a crowd behind one router fits in the burst
};
setInterval(() => { for (const l of Object.values(limits)) l.sweep(); nameGuesses.sweep(); sweepPow(); pruneAdminSessions(); }, 60 * 1000).unref();
const fmtWait = (sec) => (sec < 60 ? `${sec} วินาที` : `${Math.ceil(sec / 60)} นาที`);

/* ---------------- name mode: proof-of-work instead of a lockout ----------------
 * Everyone at the event shares one Wi-Fi address, so "N wrong names per address → wait" lets
 * one prankster lock the whole room out. Name mode never refuses a name that is on the roster;
 * instead every attempt carries a small puzzle solved by the phone (pow.js), and the puzzle gets
 * harder while wrong names keep arriving from that address. Calm: ~1 ms. Under a flood: a few
 * seconds per attempt on a phone, which also caps how fast a script can try names. */

/** counter that fades out (e^-t/tau): roughly "events in the last tau seconds" */
function decaying(tauSec) {
  const m = new Map();
  const now = () => Date.now() / 1000;
  const val = (e, t) => (e ? e.v * Math.exp(-(t - e.at) / tauSec) : 0);
  return {
    get(key) { return val(m.get(key), now()); },
    add(key) { const t = now(); m.set(key, { v: val(m.get(key), t) + 1, at: t }); },
    sweep() { const t = now(); for (const [k, e] of m) if (val(e, t) < 0.05) m.delete(k); },
  };
}
const nameGuesses = decaying(60);
const POW_BASE = 10, POW_MAX = 21, POW_SLACK = 2, POW_TTL_MS = 5 * 60 * 1000;
function powBits(ip) {
  const p = Math.max(nameGuesses.get(ip), nameGuesses.get('*') / 4); // many addresses at once also count
  return Math.min(POW_MAX, POW_BASE + 2 * Math.floor(Math.log2(1 + p / 4)));
}
const powMac = (ip, body) => crypto.createHmac('sha256', db.secret).update('pow:' + ip + ':' + body).digest('base64url').slice(0, 22);
function issuePow(ip) {
  const bits = powBits(ip);
  const body = `${bits}.${Date.now() + POW_TTL_MS}.${crypto.randomBytes(9).toString('base64url')}`;
  return { c: `${body}.${powMac(ip, body)}`, bits };
}
const powUsed = new Map(); // challenge -> expiresAt (one attempt per solved puzzle)
function sweepPow() { const now = Date.now(); for (const [c, exp] of powUsed) if (exp <= now) powUsed.delete(c); }
function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}
/** → null when the puzzle is valid for this address now, else the reason (client just retries) */
function checkPow(pow, ip) {
  const c = String(pow?.c || ''); const x = String(pow?.x ?? '');
  const m = /^(\d{1,2})\.(\d{13})\.[\w-]{12}\.([\w-]{22})$/.exec(c);
  if (!m || !/^\d{1,15}$/.test(x) || !safeEqual(m[3], powMac(ip, c.slice(0, c.lastIndexOf('.'))))) return 'bad';
  const bits = Number(m[1]); const exp = Number(m[2]);
  if (exp <= Date.now()) return 'expired';
  if (powUsed.has(c)) return 'used';
  if (bits < powBits(ip) - POW_SLACK) return 'stale'; // puzzles solved before a flood don't stay cheap
  const h = sha256(crypto.createHash('sha256').update(c).digest('hex') + x);
  if (leadingZeroBits(h) < bits) return 'bad';
  powUsed.set(c, exp);
  return null;
}
let lastGuessWarn = 0;
function nameGuessFailed(ip) {
  nameGuesses.add(ip); nameGuesses.add('*');
  if (powBits(ip) >= 18 && Date.now() - lastGuessWarn > 60000) {
    lastGuessWarn = Date.now();
    console.log(`[!] มีการกรอกชื่อที่ไม่อยู่ในรายชื่อถี่ผิดปกติจาก ${ip} — ระบบเพิ่มความยากการกรอกชื่อแล้ว (คนในรายชื่อยังเข้าได้)`);
  }
}

/* ---------------- results ---------------- */

function tally(topic) {
  const counts = Object.fromEntries(topic.contestants.map((c) => [c.id, 0]));
  const ballots = db.ballots[topic.id] || {};
  for (const picks of Object.values(ballots)) for (const cid of picks) if (cid in counts) counts[cid]++;
  const rows = topic.contestants.map((c) => ({ ...c, votes: counts[c.id] }));
  // competition ranking (1,1,3) for tables/CSV
  const sorted = [...rows].sort((a, b) => b.votes - a.votes || a.number.localeCompare(b.number, 'th', { numeric: true }));
  sorted.forEach((r, i) => { r.rank = i > 0 && r.votes === sorted[i - 1].votes ? sorted[i - 1].rank : i + 1; });
  return { voters: Object.keys(ballots).length, rows, sorted };
}

// Podium: top 3 distinct vote levels (> 0 votes). Ties share a place.
function podium(topic) {
  const { sorted } = tally(topic);
  const levels = [...new Set(sorted.filter((r) => r.votes > 0).map((r) => r.votes))].slice(0, 3);
  return levels.map((v, i) => ({ place: i + 1, votes: v, winners: sorted.filter((r) => r.votes === v).map(pub) }));
}
const pub = (c) => ({ id: c.id, number: c.number, name: c.name, photo: c.photo || null });

/* ---------------- snapshots ---------------- */

function voterState() {
  return {
    event: { name: db.event.name, accessMode: db.event.accessMode },
    cheer: { open: cheerOpen(), emoji: db.cheer.emoji, text: db.cheer.text, set: CHEER_EMOJI },
    voteUrl: voteUrl(),
    topics: db.topics
      .filter((t) => t.status !== 'draft')
      .map((t) => ({ id: t.id, title: t.title, maxVotes: t.maxVotes, status: t.status, contestants: t.contestants.map(pub) })),
  };
}

function screenState() {
  const s = db.screen;
  const topic = s.topicId ? findTopic(s.topicId) : null;
  let screen = { topicId: topic ? topic.id : null, mode: s.mode, revealStep: s.revealStep };
  if (topic && s.mode === 'intro') {
    // the intro runs before voting opens, so the topic may still be a draft (drafts are otherwise never public).
    // Only contestants already presented are sent: the next ones stay a surprise even to someone reading this API.
    const n = topic.contestants.length;
    const i = Math.min(s.introIndex || 0, Math.max(n - 1, 0));
    screen.intro = { title: topic.title, total: n, index: i, shown: topic.contestants.slice(0, i + 1).map(pub) };
    return { ...voterState(), screen, cheers: cheerFeed() };
  }
  if (topic) {
    const t = tally(topic);
    screen.voters = t.voters;
    if (s.mode === 'live') screen.counts = Object.fromEntries(t.rows.map((r) => [r.id, r.votes]));
    if (s.mode === 'reveal' && topic.status === 'closed') {
      const p = podium(topic);
      // send only places already revealed (step 1 → 3rd place, step 3 → all)
      screen.podiumSize = p.length;
      screen.podium = p.filter((x) => x.place > 3 - s.revealStep);
    }
  }
  return { ...voterState(), screen, cheers: cheerFeed() };
}

function adminState() {
  const unlisted = new Set(unlistedVoterIds());
  const unlistedWithVotes = [...unlisted].filter((id) => Object.values(db.ballots).some((b) => b[id])).length;
  return {
    event: db.event,
    lanUrl: lanUrl(),
    voteUrl: voteUrl(),
    httpsPort: httpsReady ? HTTPS_PORT : null,
    screen: db.screen,
    cheer: {
      emoji: db.cheer.emoji, text: db.cheer.text, words: db.cheer.words, muted: Object.keys(db.cheer.muted).length,
      recent: cheerTexts.slice(-30).reverse().map((c) => ({ id: c.id, at: c.at, v: c.v, hidden: cheerHidden.has(c.id), muted: !!db.cheer.muted[c.voterId] })),
    },
    topics: db.topics.map((t) => {
      const r = tally(t);
      return { ...t, voters: r.voters, results: r.sorted };
    }),
    // printed-card codes only; emailed codes are counted under mail
    codes: { total: Object.keys(db.codes).filter(isCardCode).length, used: [...usedCodes()].filter(isCardCode).length },
    desk: { handed: db.desk.handed || 0 },
    mail: mailSummary(),
    publicLink: publicLink(),
    roster: { count: db.roster.length, unlistedWithVotes },
    voterCount: Object.keys(db.voters).length,
    ballotCount: totalBallots(),
  };
}

/* ---------------- cheers: text and emoji floating over the big screen ----------------
 * Never written to disk: messages live in memory for a few seconds (and the last 30 texts for
 * the admin's list) and are gone on restart. Only signed-in voters can send. Text shows at once,
 * so the guards are: fixed emoji set, short text, no links, a blocked-word list, per-voter and
 * room-wide rate limits, and the admin can hide a message, mute its sender or switch either off.
 * A muted sender is not told; their messages just never reach the screen. */
const CHEER_EMOJI = ['👏', '❤️', '😂', '🔥', '😮', '🎉'];
const CHEER_TEXT_MAX = 60;
const CHEER_FEED_MS = 8000; // how long a cheer stays in the polled snapshot (screen polls every ~2 s)
const CHEER_WORDS = ['เหี้ย', 'ควย', 'สัส', 'สัด', 'เย็ด', 'หี', 'ส้นตีน', 'ไอ้สัตว์', 'fuck', 'shit', 'bitch'];
const cheerLimits = {
  emoji: bucket(12, 3),     // per voter: a burst of 12, then 3 a second
  text: bucket(2, 1 / 10),  // per voter: 2, then 1 every 10 seconds
  emojiAll: bucket(80, 30), // the whole room: the screen can only show so much
  textAll: bucket(8, 1),
};
setInterval(() => { for (const l of Object.values(cheerLimits)) l.sweep(); }, 60 * 1000).unref();
let cheerSeq = 0;
const cheerRecent = []; // { id, at, k, v } everything shown in the last few seconds (for polling screens)
const cheerOut = [];    // waiting for the next stream push
const cheerTexts = [];  // last texts with their sender, for the admin list only
const cheerHidden = new Set();

// cheering is only open while the big screen is introducing contestants
const cheerOpen = () => db.screen.mode === 'intro' && !!(db.screen.topicId && findTopic(db.screen.topicId));
const cheerNorm = (s) => s.toLowerCase().normalize('NFC').replace(/[^a-z0-9\u0e00-\u0e7f]/g, '');
function cheerTextError(v) {
  if (!v) return 'พิมพ์ข้อความก่อน';
  if ([...v].length > CHEER_TEXT_MAX) return `ข้อความยาวได้ไม่เกิน ${CHEER_TEXT_MAX} ตัวอักษร`;
  if (/https?:|www\.|\.(com|net|org|co|th|io|ly|me|link)\b/i.test(v)) return 'ส่งลิงก์ขึ้นจอไม่ได้';
  const n = cheerNorm(v);
  const extra = db.cheer.words.split(/[\n,]/).map((w) => cheerNorm(w)).filter(Boolean);
  if ([...CHEER_WORDS, ...extra].some((w) => n.includes(cheerNorm(w)))) return 'ข้อความนี้ขึ้นจอไม่ได้ ลองใช้คำอื่น';
  return '';
}
function cheerFeed() {
  const cut = Date.now() - CHEER_FEED_MS;
  while (cheerRecent.length && cheerRecent[0].at < cut) cheerRecent.shift();
  return { items: cheerRecent.filter((c) => !cheerHidden.has(c.id)), hidden: [...cheerHidden].slice(-50) };
}
function pushCheer(k, v, voterId) {
  const c = { id: ++cheerSeq, at: Date.now(), k, v };
  cheerRecent.push(c); cheerOut.push(c);
  if (cheerOut.length > 200) cheerOut.splice(0, cheerOut.length - 200);
  if (k === 't') {
    cheerTexts.push({ ...c, voterId });
    if (cheerTexts.length > 100) cheerTexts.splice(0, cheerTexts.length - 100);
    dirty = true; gen++; // the admin list changes; nothing to save
  }
}

/* ---------------- realtime (SSE) + plain snapshots ----------------
 * Live updates go over SSE, but pages never depend on it: each page also reads the same snapshot
 * with a plain GET (/api/state, /api/screen/state, /api/admin/state) and keeps asking every few
 * seconds whenever the stream is silent. Some proxies hold SSE back until the response ends —
 * Cloudflare Quick Tunnels do not support SSE at all, and each one allows ~200 requests in flight,
 * so an open stream per phone would eat that budget. */

// voters: only when what they see changes (not on every vote) · screen + admin: throttled to 400 ms
const clients = { voter: new Set(), screen: new Set(), admin: new Set() };
let dirty = false;
let lastVoterJson = '';
let gen = 0; // bumped on every change; keys the snapshot cache below
function changed() { dirty = true; gen++; save(); }

/** the same JSON for every poller until something changes (2 s cap: voteUrl follows the network) */
const snapCache = {};
function snapshotJson(key, build) {
  const c = snapCache[key]; const now = Date.now();
  const v = key === 'screen' ? gen + ':' + cheerSeq : gen; // cheers change the screen without a db change
  if (c && c.gen === v && now - c.at < 2000) return c.json;
  const json = JSON.stringify(build());
  snapCache[key] = { gen: v, at: now, json };
  return json;
}
/** no-cache = always revalidate; express adds an ETag, so an unchanged snapshot is a 304 */
function sendSnapshot(res, json, priv = false) {
  res.set('Cache-Control', (priv ? 'private, ' : '') + 'no-cache').type('json').send(json);
}

// Quick Tunnel hostnames (documented: no SSE). The original Host header reaches the app.
const QUICK_TUNNEL_HOST = /\.trycloudflare\.com$/i;
function viaQuickTunnel(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/:\d+$/, '');
  return QUICK_TUNNEL_HOST.test(host);
}
setInterval(() => {
  if (cheerOut.length) {
    const batch = cheerOut.splice(0);
    if (clients.screen.size) { const msg = `event: cheers\ndata: ${JSON.stringify(batch)}\n\n`; for (const res of clients.screen) res.write(msg); }
  }
  if (!dirty) return;
  dirty = false;
  const vj = JSON.stringify(voterState());
  if (vj !== lastVoterJson) { lastVoterJson = vj; sendRaw(clients.voter, vj); }
  if (clients.screen.size) send(clients.screen, screenState());
  if (clients.admin.size) send(clients.admin, adminState());
}, 400);
setInterval(() => {
  // admin streams end when their session expires or logs out
  for (const res of clients.admin) if (!adminSession(res.adminToken)) { res.end(); clients.admin.delete(res); }
  // a named event (not a comment) so the page can tell "quiet but alive" from "stuck behind a proxy"
  for (const set of Object.values(clients)) for (const res of set) res.write('event: ping\ndata: 1\n\n');
}, 15000);
function send(set, data) { sendRaw(set, JSON.stringify(data)); }
function sendRaw(set, json) {
  const msg = `data: ${json}\n\n`;
  for (const res of set) res.write(msg);
}
function openStream(req, res, channel, data) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (viaQuickTunnel(req)) {
    // never hold a connection open through a Quick Tunnel: one snapshot, then end (the proxy only
    // delivers finished responses). Current pages don't come here; this covers an old cached page.
    res.end(`retry: 5000\ndata: ${JSON.stringify(data)}\n\n`);
    return;
  }
  res.write(`retry: 2000\ndata: ${JSON.stringify(data)}\n\n`);
  clients[channel].add(res);
  req.on('close', () => clients[channel].delete(res));
}

/* ---------------- app ---------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // style="" attributes in rendered markup
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  // HSTS only when TLS was terminated by a trusted proxy on a real domain (never on the
  // self-signed LAN port: HSTS ignores ports and would push voters' http:// page to https)
  if (req.secure && !req.socket.encrypted) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// admin pages and API must go over HTTPS when the HTTPS listener is on
const ADMIN_PAGE = /^\/(admin|print|checkin)(\.html)?$/;
app.use((req, res, next) => {
  if (!httpsReady || req.secure) return next();
  const isApi = req.path.startsWith('/api/admin');
  if (!isApi && !ADMIN_PAGE.test(req.path)) return next();
  if (isApi) return fail(res, 403, `หน้าแอดมินต้องเข้าทาง https://${req.hostname}:${HTTPS_PORT}/admin`);
  res.redirect(302, `https://${req.hostname}:${HTTPS_PORT}${req.originalUrl}`);
});

// big bodies (photos) only for signed-in admin routes; public routes get a small limit
const jsonBig = express.json({ limit: '4mb' });
const jsonSmall = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path.startsWith('/api/admin/') && adminSession(cookies(req).admin) ? jsonBig : jsonSmall)(req, res, next));

app.use('/fonts/anuphan', express.static(path.join(__dirname, 'node_modules/@fontsource/anuphan'), { maxAge: '30d' }));
// QR reader for "open from a card picture" (iPhone Safari has no built-in one); loaded only when that button is used
const JSQR_FILE = path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js');
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(JSQR_FILE, { maxAge: '30d' }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '365d', immutable: true,
  setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; sandbox"),
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const fail = (res, status, message) => res.status(status).json({ error: message });
function limited(res, sec, message) {
  res.set('Retry-After', String(sec));
  fail(res, 429, message.replace('{s}', fmtWait(sec)));
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie: ignore */ }
  }
  return out;
}

/* ----- public ----- */

app.get('/api/stream', (req, res) => openStream(req, res, 'voter', voterState()));
app.get('/api/screen/stream', (req, res) => openStream(req, res, 'screen', screenState()));
// same data as the first message of each stream, for pages that can't (or no longer) stream
app.get('/api/state', (req, res) => sendSnapshot(res, snapshotJson('voter', voterState)));
app.get('/api/screen/state', (req, res) => sendSnapshot(res, snapshotJson('screen', screenState)));

// always the event's own vote link — any query string is ignored (no QR for arbitrary links)
app.get('/api/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(voteUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
});

// QR picture inside a code email (mail apps load it from here). Signed like the link in the
// same email, so it shows nothing to anyone who doesn't already have that email.
app.get('/api/mail-qr/:code.png', async (req, res) => {
  const code = normCode(req.params.code);
  const sig = String(req.query.s || '');
  if (!db.codes[code]?.mail || !sig || !safeEqual(sig, codeSig(code))) return fail(res, 404, 'ไม่พบรูปนี้');
  const png = await QRCode.toBuffer(codeLink(voteUrl(), code), { type: 'png', margin: 2, width: 400, errorCorrectionLevel: 'M' });
  res.type('png').set('Cache-Control', 'private, max-age=86400').send(png);
});

function voterFromReq(req) {
  const t = req.get('x-voter-token');
  const id = t && db.sessions[t];
  const v = id ? db.voters[id] : null;
  return v && v.kind === db.event.accessMode && listedVoter(v) ? v : null;
}

function getOrCreateVoter(kind, key, label) {
  let v = Object.values(db.voters).find((x) => x.kind === kind && x.key === key);
  if (!v) {
    v = { id: newId('v'), kind, key, label, createdAt: new Date().toISOString() };
    db.voters[v.id] = v;
  }
  return v;
}

function joinFailWait(ip) { return Math.max(limits.joinFailIp.wait(ip), limits.joinFailAll.wait('*')); }
function joinFailed(ip) { limits.joinFailIp.take(ip); limits.joinFailAll.take('*'); }
const cookieSecure = (req) => (req.secure ? '; Secure' : '');

app.get('/api/join/challenge', (req, res) => {
  res.set('Cache-Control', 'no-store').json(issuePow(req.ip));
});

app.post('/api/join', (req, res) => {
  const mode = db.event.accessMode;
  const body = req.body || {};
  const ip = req.ip;
  let voter;
  if (mode === 'code') {
    const code = normCode(body.code);
    if (!code) return fail(res, 400, 'กรุณากรอกรหัสโหวต');
    const sig = String(body.sig || '');
    if (sig && db.codes[code] && safeEqual(sig, codeSig(code))) {
      voter = getOrCreateVoter('code', code, code); // scanned the card's QR
    } else {
      const wait = joinFailWait(ip);
      if (wait) return limited(res, wait, 'กรอกรหัสผิดหลายครั้งเกินไป ระบบพักการกรอกรหัสไว้ {s} ถ้ามีบัตรให้สแกน QR บนบัตรแทน');
      if (!db.codes[code]) { joinFailed(ip); return fail(res, 404, 'ไม่พบรหัสนี้ ตรวจตัวอักษรบนบัตรอีกครั้ง'); }
      voter = getOrCreateVoter('code', code, code);
    }
  } else if (mode === 'name') {
    const input = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (normKey(input).length < 2) return fail(res, 400, 'กรุณากรอกชื่อ-นามสกุล หรือรหัสพนักงาน');
    if (!db.roster.length) return fail(res, 409, 'ผู้จัดยังไม่ได้ใส่รายชื่อพนักงาน รอสักครู่แล้วลองใหม่');
    // no lockout here (see proof-of-work above); every reply hands out the next puzzle
    const nameFail = (status, message) => res.status(status).json({ error: message, pow: issuePow(ip) });
    const bad = checkPow(body.pow, ip);
    if (bad) return nameFail(403, 'ระบบต้องตรวจเครื่องอีกครั้ง กดเข้าโหวตใหม่');
    const r = lookupRoster(input);
    if (r.ambiguous) return nameFail(409, 'มีชื่อนี้มากกว่าหนึ่งคน กรุณากรอกรหัสพนักงานแทน');
    if (!r.entry) { nameGuessFailed(ip); return nameFail(404, 'ไม่พบชื่อนี้ในรายชื่อ ลองพิมพ์ชื่อ-นามสกุลเต็ม หรือรหัสพนักงาน'); }
    voter = getOrCreateVoter('name', 'r:' + r.entry.id, r.entry.name);
  } else {
    // open mode cannot stop repeat voting; the cookie only stops casual "clear and vote again"
    const dev = cookies(req).cv_dev;
    const prev = dev && db.voters[db.sessions[dev]];
    if (prev && prev.kind === 'open') return res.json({ token: dev, mode });
    const wait = limits.openJoinIp.wait(ip);
    if (wait) return limited(res, wait, 'มีการเข้าโหวตจากเครือข่ายนี้ถี่เกินไป รออีก {s} แล้วลองใหม่');
    limits.openJoinIp.take(ip);
    voter = { id: newId('v'), kind: 'open', key: null, label: 'ไม่ระบุชื่อ', createdAt: new Date().toISOString() };
    db.voters[voter.id] = voter;
  }
  const t = token();
  db.sessions[t] = voter.id;
  if (mode === 'open') res.set('Set-Cookie', `cv_dev=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${cookieSecure(req)}`);
  changed();
  res.json({ token: t, mode });
});

app.get('/api/me', (req, res) => {
  const v = voterFromReq(req);
  if (!v) return fail(res, 401, 'กรุณาเข้าสู่ระบบโหวตใหม่');
  const picks = {};
  for (const [tid, b] of Object.entries(db.ballots)) if (b[v.id]) picks[tid] = b[v.id];
  const label = v.kind === 'open' ? null : v.kind === 'name' ? rosterIndex().byId.get(v.key.slice(2)).name : v.label;
  // a name the admin gave this person (roster, or the email list) is fixed: the phone shows it and offers no edit
  const r = v.kind === 'code' && db.codes[v.key]?.mail ? recipientById(db.codes[v.key].mail) : null;
  const fixedName = v.kind === 'name' ? label : r ? (r.name || r.email) : null;
  res.json({ label, fixedName, picks });
});

app.post('/api/vote', (req, res) => {
  const v = voterFromReq(req);
  if (!v) return fail(res, 401, 'กรุณาเข้าสู่ระบบโหวตใหม่');
  const topic = findTopic(String(req.body.topicId || ''));
  if (!topic || topic.status === 'draft') return fail(res, 404, 'ไม่พบหัวข้อนี้');
  if (topic.status !== 'open') return fail(res, 409, 'หัวข้อนี้ปิดโหวตแล้ว');
  const picks = [...new Set(Array.isArray(req.body.picks) ? req.body.picks.map(String) : [])];
  if (picks.some((id) => !topic.contestants.some((c) => c.id === id))) return fail(res, 400, 'มีผู้เข้าประกวดที่ไม่อยู่ในหัวข้อนี้ ลองโหลดหน้าใหม่');
  if (picks.length > topic.maxVotes) return fail(res, 400, `หัวข้อนี้เลือกได้ไม่เกิน ${topic.maxVotes} คน`);
  const ballots = (db.ballots[topic.id] ||= {});
  if (picks.length === 0) delete ballots[v.id];
  else ballots[v.id] = picks;
  changed();
  res.json({ ok: true, picks });
});

app.post('/api/cheer', (req, res) => {
  const v = voterFromReq(req);
  if (!v) return fail(res, 401, 'กรุณาเข้าสู่ระบบโหวตใหม่');
  if (!cheerOpen()) return fail(res, 409, 'เชียร์ได้ตอนแนะนำผู้เข้าประกวดบนจอใหญ่');
  const b = req.body || {};
  if (b.emoji !== undefined) {
    if (!db.cheer.emoji) return fail(res, 409, 'แอดมินปิดการส่ง emoji อยู่');
    const e = String(b.emoji);
    if (!CHEER_EMOJI.includes(e)) return fail(res, 400, 'emoji นี้ส่งไม่ได้');
    if (cheerLimits.emoji.wait(v.id)) return limited(res, cheerLimits.emoji.wait(v.id), 'ส่งถี่ไป รอ {s}');
    cheerLimits.emoji.take(v.id);
    if (db.cheer.muted[v.id] || cheerLimits.emojiAll.wait('*')) return res.json({ ok: true }); // room is full: drop quietly
    cheerLimits.emojiAll.take('*');
    pushCheer('e', e, v.id);
    return res.json({ ok: true });
  }
  if (!db.cheer.text) return fail(res, 409, 'แอดมินปิดการส่งข้อความอยู่');
  // one line: no control characters or line breaks, spaces collapsed
  const text = String(b.text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const err = cheerTextError(text);
  if (err) return fail(res, 400, err);
  if (cheerLimits.text.wait(v.id)) return limited(res, cheerLimits.text.wait(v.id), 'ส่งข้อความได้อีกครั้งใน {s}');
  if (cheerLimits.textAll.wait('*')) return limited(res, cheerLimits.textAll.wait('*'), 'บนจอมีข้อความเยอะอยู่ ลองใหม่ใน {s}');
  cheerLimits.text.take(v.id);
  if (!db.cheer.muted[v.id]) { cheerLimits.textAll.take('*'); pushCheer('t', text, v.id); }
  res.json({ ok: true });
});

/* ----- admin ----- */

function requireAdmin(req, res, next) {
  const t = cookies(req).admin;
  if (!adminSession(t)) return fail(res, 401, 'กรุณาเข้าสู่ระบบแอดมิน');
  // CSRF: refuse state changes a browser marks as coming from another site/origin
  const site = req.get('sec-fetch-site');
  if (!['GET', 'HEAD'].includes(req.method) && site && site !== 'same-origin' && site !== 'none') return fail(res, 403, 'คำขอนี้ไม่ได้มาจากหน้าแอดมิน');
  req.adminToken = t;
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const wait = Math.max(limits.loginIp.wait(ip), limits.loginAll.wait('*'));
  if (wait) return limited(res, wait, 'ใส่รหัสผ่านผิดหลายครั้งเกินไป รออีก {s} แล้วลองใหม่');
  if (!safeEqual(String((req.body || {}).password || ''), ADMIN_PASSWORD)) {
    limits.loginIp.take(ip); limits.loginAll.take('*');
    return setTimeout(() => fail(res, 401, 'รหัสผ่านไม่ถูกต้อง'), 600);
  }
  const t = token();
  const now = Date.now();
  db.adminSessions[hashToken(t)] = { createdAt: new Date(now).toISOString(), expiresAt: now + ADMIN_SESSION_MS };
  save();
  res.set('Set-Cookie', `admin=${t}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}${cookieSecure(req)}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const t = cookies(req).admin;
  if (t) delete db.adminSessions[hashToken(t)];
  save();
  res.set('Set-Cookie', `admin=; Path=/; Max-Age=0${cookieSecure(req)}`).json({ ok: true });
});

app.use('/api/admin', requireAdmin);
app.get('/api/admin/state', (req, res) => sendSnapshot(res, JSON.stringify(adminState()), true));
app.get('/api/admin/stream', (req, res) => { res.adminToken = req.adminToken; openStream(req, res, 'admin', adminState()); });

app.put('/api/admin/event', (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim().slice(0, 120);
    if (!name) return fail(res, 400, 'กรุณาตั้งชื่องาน');
    db.event.name = name;
  }
  if (b.publicUrl !== undefined) {
    const u = String(b.publicUrl).trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return fail(res, 400, 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://');
    db.event.publicUrl = u;
  }
  if (b.accessMode !== undefined && b.accessMode !== db.event.accessMode) {
    if (!ACCESS_MODES.includes(b.accessMode)) return fail(res, 400, 'รูปแบบการเข้าโหวตไม่ถูกต้อง');
    if (totalBallots() > 0) return fail(res, 409, 'มีคนโหวตแล้ว เปลี่ยนรูปแบบการเข้าไม่ได้ ต้องล้างผลโหวตทั้งหมดก่อน');
    db.event.accessMode = b.accessMode;
    db.sessions = {};
  }
  changed();
  res.json(adminState());
});

/* roster */
app.get('/api/admin/roster', (req, res) => res.json({ text: rosterText(), count: db.roster.length }));

app.put('/api/admin/roster', (req, res) => {
  const r = parseRoster((req.body || {}).text);
  if (r.error) return fail(res, 400, r.error);
  db.roster = r.entries;
  rosterIdx = null;
  // people who joined by name before the roster existed: link them if their name is on it
  const taken = new Set(Object.values(db.voters).filter((v) => v.kind === 'name' && listedVoter(v)).map((v) => v.key));
  for (const v of Object.values(db.voters)) {
    if (v.kind !== 'name' || listedVoter(v)) continue;
    const hit = lookupRoster(v.label);
    if (hit.entry && !taken.has('r:' + hit.entry.id)) { v.key = 'r:' + hit.entry.id; taken.add(v.key); }
  }
  changed();
  res.json({ ...adminState(), rosterText: rosterText() });
});

app.post('/api/admin/roster/purge-unlisted', (req, res) => {
  const ids = new Set(unlistedVoterIds());
  for (const b of Object.values(db.ballots)) for (const id of ids) delete b[id];
  for (const [t, vid] of Object.entries(db.sessions)) if (ids.has(vid)) delete db.sessions[t];
  for (const id of ids) delete db.voters[id];
  changed();
  res.json(adminState());
});

function cleanTopicInput(b, topic) {
  const title = String(b.title ?? topic?.title ?? '').trim().slice(0, 120);
  if (!title) return { error: 'กรุณาตั้งชื่อหัวข้อ' };
  const maxVotes = Math.floor(Number(b.maxVotes ?? topic?.maxVotes ?? 1));
  if (!(maxVotes >= 1 && maxVotes <= 50)) return { error: 'จำนวนที่เลือกได้ต้องอยู่ระหว่าง 1–50' };
  return { title, maxVotes };
}

app.post('/api/admin/topics', (req, res) => {
  const v = cleanTopicInput(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  const topic = { id: newId('t'), ...v, status: 'draft', contestants: [] };
  db.topics.push(topic);
  changed();
  res.json(topic);
});

app.put('/api/admin/topics/:id', (req, res) => {
  const topic = findTopic(req.params.id);
  if (!topic) return fail(res, 404, 'ไม่พบหัวข้อนี้');
  const b = req.body || {};
  const v = cleanTopicInput(b, topic);
  if (v.error) return fail(res, 400, v.error);
  if (v.maxVotes < topic.maxVotes) {
    const over = Object.values(db.ballots[topic.id] || {}).some((p) => p.length > v.maxVotes);
    if (over) return fail(res, 409, `มีคนเลือกไว้เกิน ${v.maxVotes} คนแล้ว ลดจำนวนไม่ได้`);
  }
  Object.assign(topic, v);
  if (b.status !== undefined) {
    if (!['draft', 'open', 'closed'].includes(b.status)) return fail(res, 400, 'สถานะไม่ถูกต้อง');
    if (b.status === 'open' && topic.contestants.length === 0) return fail(res, 400, 'เพิ่มผู้เข้าประกวดก่อนเปิดโหวต');
    topic.status = b.status;
    // voting opens right after the intro: the screen moves on to the counter and the QR
    if (b.status === 'open' && db.screen.topicId === topic.id && db.screen.mode === 'intro') db.screen.mode = 'hidden';
    if (b.status !== 'closed' && db.screen.topicId === topic.id && db.screen.mode === 'reveal') {
      db.screen.mode = 'hidden'; db.screen.revealStep = 0;
    }
  }
  changed();
  res.json(topic);
});

app.post('/api/admin/topics/:id/move', (req, res) => {
  const i = db.topics.findIndex((t) => t.id === req.params.id);
  const j = i + ((req.body || {}).dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= db.topics.length) return res.json({ ok: true });
  [db.topics[i], db.topics[j]] = [db.topics[j], db.topics[i]];
  changed();
  res.json({ ok: true });
});

app.delete('/api/admin/topics/:id', (req, res) => {
  const topic = findTopic(req.params.id);
  if (!topic) return fail(res, 404, 'ไม่พบหัวข้อนี้');
  for (const c of topic.contestants) removePhoto(c.photo);
  db.topics = db.topics.filter((t) => t !== topic);
  delete db.ballots[topic.id];
  if (db.screen.topicId === topic.id) db.screen = { topicId: null, mode: 'hidden', revealStep: 0, introIndex: 0 };
  changed();
  res.json({ ok: true });
});

/** real file type from the first bytes — the data: URL's declared type is not trusted */
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'ไฟล์รูปไม่ถูกต้อง ใช้ JPG, PNG หรือ WEBP' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return { error: 'รูปใหญ่เกิน 3 MB' };
  const ext = sniffImage(buf);
  if (!ext) return { error: 'ไฟล์นี้ไม่ใช่รูป JPG, PNG หรือ WEBP จริง ลองเลือกรูปอื่น' };
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: '/uploads/' + name };
}
function removePhoto(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true }, () => {});
}

function cleanContestant(b, topic, existing) {
  const number = String(b.number ?? existing?.number ?? '').trim().slice(0, 10);
  const name = String(b.name ?? existing?.name ?? '').trim().slice(0, 120);
  if (!number) return { error: 'กรุณาใส่หมายเลข' };
  if (!name) return { error: 'กรุณาใส่ชื่อ' };
  if (topic.contestants.some((c) => c !== existing && c.number === number)) return { error: `หมายเลข ${number} มีอยู่แล้วในหัวข้อนี้` };
  return { number, name };
}

app.post('/api/admin/topics/:id/contestants', (req, res) => {
  const topic = findTopic(req.params.id);
  if (!topic) return fail(res, 404, 'ไม่พบหัวข้อนี้');
  const v = cleanContestant(req.body || {}, topic);
  if (v.error) return fail(res, 400, v.error);
  const c = { id: newId('c'), ...v, photo: null };
  if (req.body.photo) {
    const p = savePhoto(req.body.photo);
    if (p.error) return fail(res, 400, p.error);
    c.photo = p.url;
  }
  topic.contestants.push(c);
  topic.contestants.sort((a, b) => a.number.localeCompare(b.number, 'th', { numeric: true }));
  changed();
  res.json(c);
});

app.put('/api/admin/topics/:id/contestants/:cid', (req, res) => {
  const topic = findTopic(req.params.id);
  const c = topic && topic.contestants.find((x) => x.id === req.params.cid);
  if (!c) return fail(res, 404, 'ไม่พบผู้เข้าประกวดนี้');
  const v = cleanContestant(req.body || {}, topic, c);
  if (v.error) return fail(res, 400, v.error);
  if (req.body.photo) {
    const p = savePhoto(req.body.photo);
    if (p.error) return fail(res, 400, p.error);
    removePhoto(c.photo);
    c.photo = p.url;
  } else if (req.body.photo === null) {
    removePhoto(c.photo);
    c.photo = null;
  }
  Object.assign(c, v);
  topic.contestants.sort((a, b) => a.number.localeCompare(b.number, 'th', { numeric: true }));
  changed();
  res.json(c);
});

app.delete('/api/admin/topics/:id/contestants/:cid', (req, res) => {
  const topic = findTopic(req.params.id);
  const c = topic && topic.contestants.find((x) => x.id === req.params.cid);
  if (!c) return fail(res, 404, 'ไม่พบผู้เข้าประกวดนี้');
  topic.contestants = topic.contestants.filter((x) => x !== c);
  removePhoto(c.photo);
  const ballots = db.ballots[topic.id] || {};
  for (const [vid, picks] of Object.entries(ballots)) {
    const left = picks.filter((id) => id !== c.id);
    if (left.length) ballots[vid] = left; else delete ballots[vid];
  }
  changed();
  res.json({ ok: true });
});

/* codes */
app.post('/api/admin/codes', (req, res) => {
  const n = Math.floor(Number((req.body || {}).count));
  if (!(n >= 1 && n <= 2000)) return fail(res, 400, 'สร้างได้ครั้งละ 1–2,000 รหัส');
  const now = new Date().toISOString();
  let made = 0;
  while (made < n) {
    const code = randomString(CODE_LENGTH, CODE_ALPHABET);
    if (db.codes[code]) continue;
    db.codes[code] = { createdAt: now };
    made++;
  }
  changed();
  res.json(adminState());
});

// printed cards: codes that were not sent by email (an emailed code must not also go out on paper)
app.get('/api/admin/codes', async (req, res) => {
  const used = usedCodes();
  const base = voteUrl();
  const list = await Promise.all(
    Object.keys(db.codes).filter(isCardCode).map(async (code) => ({
      code,
      used: used.has(code),
      qr: req.query.qr ? await QRCode.toString(codeLink(base, code), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) : undefined,
    })),
  );
  res.json({ eventName: db.event.name, voteUrl: base, codes: list });
});

app.delete('/api/admin/codes', (req, res) => {
  const hasCodeVotes = Object.values(db.ballots).some((b) => Object.keys(b).some((vid) => db.voters[vid]?.kind === 'code' && isCardCode(db.voters[vid].key)));
  if (hasCodeVotes) return fail(res, 409, 'มีคนใช้รหัสโหวตแล้ว ลบรหัสไม่ได้ ต้องล้างผลโหวตทั้งหมดก่อน');
  for (const code of Object.keys(db.codes)) if (isCardCode(code)) delete db.codes[code]; // emailed codes stay
  changed();
  res.json(adminState());
});

/* check-in desk: a screen at the registration table shows a QR that is a one-time ticket, not a vote code.
   The guest's phone opens /claim and only when they press "รับบัตร" does the server make a vote code for
   them (its own pool, never printed). The ticket then dies and the desk shows the next one. A ticket nobody
   claims expires, so a photo of the desk screen is worth nothing; the vote code itself is never on that screen.
   Pressing a button (not just opening the link) also keeps link previews in camera or chat apps from using it. */
const TICKET_MS = 60 * 1000;
const deskTicketLink = (t) => `${voteUrl()}claim?t=${t}`;
function deskTicket() {
  const k = db.desk.ticket;
  if (k && k.exp > Date.now()) return k;
  db.desk.ticket = { t: token(), exp: Date.now() + TICKET_MS };
  save();
  return db.desk.ticket;
}

app.post('/api/admin/desk', async (req, res) => {
  if (db.event.accessMode !== 'code') return fail(res, 409, 'จุดลงทะเบียนใช้ได้เฉพาะวิธีเข้าโหวตแบบ "รหัสโหวต" เปลี่ยนได้ที่แท็บตั้งค่างาน');
  if ((req.body || {}).skip) db.desk.ticket = null;
  const k = deskTicket();
  res.json({
    eventName: db.event.name,
    handed: db.desk.handed || 0,
    expiresIn: Math.max(0, k.exp - Date.now()),
    // the ticket itself is never sent back to the page as text: only inside the QR
    qr: await QRCode.toString(deskTicketLink(k.t), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
  });
});

app.post('/api/desk/claim', async (req, res) => {
  if (db.event.accessMode !== 'code') return fail(res, 409, 'ตอนนี้ไม่ได้ใช้บัตรรหัสโหวต ติดต่อเจ้าหน้าที่ที่จุดลงทะเบียน');
  const k = db.desk.ticket;
  const t = String((req.body || {}).t || '');
  if (!k || !t || !safeEqual(t, k.t)) return fail(res, 410, 'QR นี้ใช้ไปแล้วหรือหมดอายุ สแกน QR ใหม่ที่จุดลงทะเบียน');
  if (k.exp <= Date.now()) { db.desk.ticket = null; return fail(res, 410, 'QR นี้หมดอายุแล้ว สแกน QR ใหม่ที่จุดลงทะเบียน'); }
  db.desk.ticket = null; // one claim per ticket
  db.desk.handed = (db.desk.handed || 0) + 1;
  const code = newCode({ desk: true });
  const voter = getOrCreateVoter('code', code, code);
  const vt = token();
  db.sessions[vt] = voter.id;
  changed();
  const link = codeLink(voteUrl(), code);
  res.json({
    token: vt, eventName: db.event.name, code: fmtCode(code), link, no: db.desk.handed,
    qr: await QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
  });
});

/* email */
app.get('/api/admin/mail', (req, res) => {
  const used = usedCodes(); const url = voteUrl();
  res.set('Cache-Control', 'private, no-store').json({
    rev: mailRev,
    recipients: db.mail.recipients.map((r) => ({
      id: r.id, email: r.email, name: r.name, code: fmtCode(r.code), status: r.status, error: r.error || '',
      sends: r.sends || 0, sentAt: r.sentAt || null, failedAt: r.failedAt || null,
      used: used.has(r.code), stale: r.status === 'sent' && r.sentUrl !== url,
    })),
  });
});

app.post('/api/admin/mail/recipients', (req, res) => {
  const p = parseRecipients((req.body || {}).text);
  if (p.error) return fail(res, 400, p.error);
  const now = new Date().toISOString();
  for (const e of p.entries) {
    const id = newId('m');
    db.mail.recipients.push({ id, email: e.email, name: e.name, code: newCode({ mail: id }), status: 'pending', error: '', sends: 0, sentAt: null, createdAt: now });
  }
  mailChanged();
  res.json({ ...adminState(), added: p.entries.length, skipped: p.skipped });
});

app.delete('/api/admin/mail/recipients/:id', (req, res) => {
  const r = recipientById(req.params.id);
  if (!r) return fail(res, 404, 'ไม่พบอีเมลนี้');
  if (r.status === 'queued' || r.status === 'sending') return fail(res, 409, 'กำลังส่งอีเมลนี้อยู่ รอให้ส่งเสร็จก่อนแล้วค่อยลบ');
  const voterIds = Object.values(db.voters).filter((v) => v.kind === 'code' && v.key === r.code).map((v) => v.id);
  if (voterIds.some((vid) => Object.values(db.ballots).some((b) => b[vid]))) return fail(res, 409, 'คนนี้ใช้รหัสโหวตไปแล้ว ลบไม่ได้ ต้องล้างผลโหวตทั้งหมดก่อน');
  // the code goes too, so a wrong address that already got the email can't use it
  for (const vid of voterIds) delete db.voters[vid];
  for (const [t, vid] of Object.entries(db.sessions)) if (voterIds.includes(vid)) delete db.sessions[t];
  delete db.codes[r.code];
  db.mail.recipients = db.mail.recipients.filter((x) => x !== r);
  mailChanged();
  res.json(adminState());
});

app.post('/api/admin/mail/send', (req, res) => {
  if (!mailConfigured()) return fail(res, 409, notConfiguredMsg());
  const b = req.body || {};
  const url = voteUrl();
  const pick = {
    pending: (r) => r.status === 'pending',
    failed: (r) => r.status === 'failed',
    stale: (r) => r.status === 'sent' && r.sentUrl !== url,
    one: (r) => r.id === b.id,
  }[b.which];
  if (!pick) return fail(res, 400, 'ไม่รู้ว่าจะส่งให้ใคร');
  let list = db.mail.recipients.filter(pick);
  if (b.which === 'one' && !list.length) return fail(res, 404, 'ไม่พบอีเมลนี้');
  // "send the first N now, the rest later" — offered when a batch is bigger than what is left of a daily limit
  if (b.max !== undefined) {
    if (!(Number.isInteger(b.max) && b.max > 0)) return fail(res, 400, 'จำนวนที่จะส่งไม่ถูกต้อง');
    list = list.slice(0, b.max);
  }
  if (list.some((r) => r.status === 'queued' || r.status === 'sending')) return fail(res, 409, 'กำลังส่งอีเมลนี้อยู่แล้ว');
  if (!list.length) return fail(res, 409, 'ไม่มีอีเมลที่ต้องส่ง');
  db.mail.lastError = '';
  queueMail(list);
  res.json({ ...adminState(), queued: list.length });
});

app.post('/api/admin/mail/test', async (req, res) => {
  if (!mailConfigured()) return fail(res, 409, notConfiguredMsg());
  const to = String((req.body || {}).to || '').trim();
  if (!EMAIL_RE.test(to) || to.length > 254) return fail(res, 400, 'ใส่อีเมลที่จะรับฉบับทดสอบให้ถูกต้อง');
  try {
    const mail = await buildMail({ email: to, name: '' }, voteUrl(), true);
    mail.subject = '[ทดสอบ] ' + mail.subject;
    await sendMail(mail);
    countSent(); mailCheck = { ok: true, error: '' }; changed();
    res.json({ ok: true });
  } catch (e) {
    fail(res, 502, e.message);
  }
});

/* screen */
app.put('/api/admin/screen', (req, res) => {
  const b = req.body || {};
  const s = { ...db.screen };
  if (b.topicId !== undefined) {
    if (b.topicId !== null && !findTopic(b.topicId)) return fail(res, 404, 'ไม่พบหัวข้อนี้');
    if (b.topicId !== s.topicId) { s.topicId = b.topicId; s.mode = 'hidden'; s.revealStep = 0; s.introIndex = 0; }
  }
  if (b.mode !== undefined) {
    if (!['hidden', 'intro', 'live', 'reveal'].includes(b.mode)) return fail(res, 400, 'โหมดจอไม่ถูกต้อง');
    if (b.mode === 'intro') {
      const t = s.topicId && findTopic(s.topicId);
      if (!t || !t.contestants.length) return fail(res, 409, 'เพิ่มผู้เข้าประกวดก่อนเริ่มแนะนำตัว');
    }
    if (b.mode === 'reveal') {
      const t = s.topicId && findTopic(s.topicId);
      if (!t || t.status !== 'closed') return fail(res, 409, 'ต้องปิดโหวตหัวข้อนี้ก่อนประกาศผล');
      if (s.mode !== 'reveal') s.revealStep = 0;
    } else s.revealStep = 0;
    s.mode = b.mode;
  }
  if (b.revealStep !== undefined) {
    if (s.mode !== 'reveal') return fail(res, 409, 'กดประกาศผลก่อน');
    s.revealStep = Math.max(0, Math.min(3, Math.floor(Number(b.revealStep)) || 0));
  }
  if (b.introIndex !== undefined) {
    if (s.mode !== 'intro') return fail(res, 409, 'กดแนะนำตัวก่อน');
    const n = findTopic(s.topicId).contestants.length;
    s.introIndex = Math.max(0, Math.min(n - 1, Math.floor(Number(b.introIndex)) || 0));
  }
  db.screen = s;
  changed();
  res.json(db.screen);
});

/* cheers */
app.put('/api/admin/cheers', (req, res) => {
  const b = req.body || {};
  if (b.emoji !== undefined) db.cheer.emoji = !!b.emoji;
  if (b.text !== undefined) db.cheer.text = !!b.text;
  if (b.words !== undefined) db.cheer.words = String(b.words).slice(0, 2000);
  changed();
  res.json({ ok: true });
});
app.post('/api/admin/cheers/hide', (req, res) => {
  const b = req.body || {};
  // "all" also clears emoji in flight, so the screen is clean at once
  const ids = b.all ? cheerRecent.map((c) => c.id).concat(cheerTexts.map((c) => c.id)) : [Number(b.id)];
  for (const id of ids) cheerHidden.add(id);
  while (cheerHidden.size > 500) cheerHidden.delete(cheerHidden.values().next().value);
  changed();
  res.json({ ok: true });
});
app.post('/api/admin/cheers/mute', (req, res) => {
  const c = cheerTexts.find((x) => x.id === Number((req.body || {}).id));
  if (!c) return fail(res, 404, 'ไม่พบข้อความนี้ (ข้อความเก่าถูกลบจากหน่วยความจำแล้ว)');
  db.cheer.muted[c.voterId] = true;
  for (const x of cheerTexts) if (x.voterId === c.voterId) cheerHidden.add(x.id);
  changed();
  res.json({ ok: true });
});
app.delete('/api/admin/cheers/mute', (req, res) => {
  db.cheer.muted = {};
  changed();
  res.json({ ok: true });
});

/* reset */
app.post('/api/admin/reset-votes', (req, res) => {
  if ((req.body || {}).confirm !== 'ล้างผล') return fail(res, 400, 'พิมพ์คำว่า "ล้างผล" เพื่อยืนยัน');
  db.ballots = {};
  db.voters = {};
  db.sessions = {};
  db.screen.mode = 'hidden'; db.screen.revealStep = 0;
  changed();
  res.json(adminState());
});

/* CSV */
app.get('/api/admin/results.csv', (req, res) => {
  // leading = + - @ would run as a formula in Excel
  const esc = (v) => `"${String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"`;
  const lines = [['หัวข้อ', 'สถานะ', 'อันดับ', 'หมายเลข', 'ชื่อ', 'คะแนน', 'จำนวนคนโหวตในหัวข้อ'].map(esc).join(',')];
  const statusTh = { draft: 'ยังไม่เปิด', open: 'เปิดโหวต', closed: 'ปิดโหวตแล้ว' };
  for (const t of db.topics) {
    const r = tally(t);
    for (const row of r.sorted) lines.push([t.title, statusTh[t.status], row.rank, row.number, row.name, row.votes, r.voters].map(esc).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="vote-results-${stamp}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

app.use('/api', (req, res) => fail(res, 404, 'ไม่พบ API นี้'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'ไฟล์ใหญ่เกินไป');
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
  console.error(err);
  fail(res, 500, 'ระบบขัดข้อง ลองอีกครั้ง');
});

/* ---------------- listen ---------------- */

/** TLS for the admin side on a LAN: TLS_CERT/TLS_KEY if given, else a self-signed cert made once with openssl */
function loadTls() {
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    return { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) };
  }
  const dir = path.join(DATA_DIR, 'tls');
  const certFile = path.join(dir, 'cert.pem'); const keyFile = path.join(dir, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-subj', '/CN=contest-vote', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    fs.chmodSync(keyFile, 0o600);
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

let httpsReady = false;
function startHttps() {
  if (!HTTPS_PORT) return;
  let tls;
  try { tls = loadTls(); } catch (e) {
    console.error(`[!] เปิด HTTPS ไม่ได้ (${e.message}) — ต้องมีคำสั่ง openssl หรือตั้ง TLS_CERT/TLS_KEY · ตอนนี้แอดมินยังใช้ผ่าน http ได้ตามเดิม`);
    return;
  }
  const server = https.createServer(tls, app);
  server.on('error', (e) => { httpsReady = false; console.error(`[!] เปิด HTTPS พอร์ต ${HTTPS_PORT} ไม่ได้: ${e.message}`); });
  server.listen(HTTPS_PORT, () => {
    httpsReady = true;
    const fp = new crypto.X509Certificate(tls.cert).fingerprint256;
    console.log(`  แอดมิน (เข้ารหัส): ${lanUrl().replace(/^http:/, 'https:').replace(/:\d+$/, ':' + HTTPS_PORT)}/admin
  ลายนิ้วมือใบรับรอง: ${fp}`);
  });
}

app.listen(PORT, () => {
  console.log(`เว็บโหวตพร้อมแล้ว
  คนโหวต : ${voteUrl()}
  แอดมิน : ${PUBLIC_URL || 'http://localhost:' + PORT}/admin
  จอใหญ่  : ${PUBLIC_URL || 'http://localhost:' + PORT}/screen`);
  if (!HTTPS_PORT && !TRUST_PROXY) {
    console.log('\n[!] หน้าแอดมินยังวิ่งแบบ http ไม่เข้ารหัส ใครอยู่ Wi-Fi วงเดียวกันดักรหัสแอดมินได้'
      + '\n    ตั้ง HTTPS_PORT=3443 เพื่อให้แอดมินเข้าผ่าน https (ดู README)\n');
  }
  if (IN_DOCKER && !PUBLIC_URL && !db.event.publicUrl) {
    console.log('\n[!] รันใน Docker แต่ยังไม่ได้ตั้ง PUBLIC_URL: QR จะพาไปที่อยู่ภายใน container ซึ่งมือถือเข้าไม่ได้'
      + '\n    ตั้ง PUBLIC_URL=http://<IP ของเครื่องนี้>:' + PORT + ' ใน .env หรือใส่ "ลิงก์ที่ QR พาไป" ในแท็บตั้งค่างาน\n');
  }
  startHttps();
  reportMailSetup();
});

/** say on the console how email goes out; for Gmail / SMTP also try logging in once so a wrong password shows up now, not mid-batch */
function reportMailSetup() {
  const s = MAIL_SETUP;
  if (!s.kind && !s.problem.startsWith('MAIL_PROVIDER') && !process.env.MAIL_FROM) return; // email not in use
  if (s.problem) { console.log(`\n[!] อีเมล: ${s.problem}\n`); return; }
  console.log(`  อีเมล  : ส่งด้วย ${MAIL_KIND.label} · ${s.account}${s.limit ? ` · ส่งได้ราววันละ ${s.limit.toLocaleString('en-US')} ฉบับ` : ''}`);
  for (const n of s.notes) console.log(`[!] อีเมล: ${n}`);
  if (!smtpPool) return;
  smtpPool.verify().then(() => {
    mailCheck = { ok: true, error: '' };
    console.log(`  อีเมล  : ล็อกอิน ${MAIL_KIND.label} ได้ พร้อมส่ง`);
  }, (e) => {
    mailCheck = { ok: false, error: smtpMailError(e).message };
    console.log(`\n[!] อีเมล: ล็อกอินไม่ได้ — ${mailCheck.error}\n`);
  }).finally(changed);
}
