'use strict';
// Email through Gmail / a company SMTP server, against a stand-in SMTP server on this machine
// (no real email leaves). Also checks settings read from a .env file and the daily-limit count.
// Usage: node scripts/mail-test.js        (needs the openssl command for the STARTTLS part)
const { spawn, execFileSync } = require('child_process');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');

const PORT = Number(process.env.TEST_PORT) || 3458;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-mail-'));
const ADMIN_PW = 'pw-' + crypto.randomBytes(15).toString('base64url');
const SMTP_PW = 'smtp-' + crypto.randomBytes(9).toString('base64url');

/* ---------- stand-in SMTP server ---------- */
// a "company" CA, and the stand-in's certificate signed by it for localhost / 127.0.0.1
const f = (n) => path.join(TMP, n);
const ossl = (...a) => execFileSync('openssl', a, { stdio: 'ignore' });
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=Company Test CA',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', f('ca-key.pem'), '-out', f('ca.pem'));
ossl('req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost', '-keyout', f('key.pem'), '-out', f('srv.csr'));
fs.writeFileSync(f('ext.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
ossl('x509', '-req', '-in', f('srv.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca-key.pem'), '-CAcreateserial', '-days', '2', '-sha256',
  '-extfile', f('ext.cnf'), '-out', f('cert.pem'));
// another CA that did not sign it: pointing SMTP_CA_FILE here must not be enough
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=Other CA', '-keyout', f('other-key.pem'), '-out', f('other-ca.pem'));
fs.writeFileSync(f('not-a-cert.pem'), 'hello\n');
// same CA, but a certificate that names only "localhost": connecting to 127.0.0.1 must fail the name check
fs.writeFileSync(f('ext-dns.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
ossl('x509', '-req', '-in', f('srv.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca-key.pem'), '-CAcreateserial', '-days', '2', '-sha256',
  '-extfile', f('ext-dns.cnf'), '-out', f('cert-dns.pem'));
const CA_FILE = f('ca.pem');
const TLS_CTX = { key: fs.readFileSync(f('key.pem')), cert: fs.readFileSync(f('cert.pem')) };
const TLS_CTX_DNS_ONLY = { key: TLS_CTX.key, cert: fs.readFileSync(f('cert-dns.pem')) };

// mode: ok | badauth | quota | busyOnce | inject (plain text slipped in after the STARTTLS reply)
// starttls: offer STARTTLS · stripped: offer it on the wire, but a "man in the middle" removes the line
// mechs: AUTH mechanisms offered
const smtp = { mode: 'ok', starttls: false, stripped: false, mechs: 'LOGIN', sent: [], logins: [], connections: 0, ctx: null };
const smtpSrv = net.createServer((raw) => {
  smtp.connections++;
  let sock = raw; let buf = ''; let secure = false; let inData = false; let data = []; let env = {};
  let authStep = null; let user = '';
  const say = (s) => sock.write(s + '\r\n');
  const onLine = (line) => {
    if (inData) {
      if (line === '.') {
        inData = false;
        smtp.sent.push({ ...env, secure, data: data.join('\r\n') });
        return say('250 2.0.0 OK queued');
      }
      data.push(line.startsWith('..') ? line.slice(1) : line);
      return;
    }
    if (authStep === 'user') { user = Buffer.from(line, 'base64').toString(); authStep = 'pass'; return say('334 UGFzc3dvcmQ6'); }
    if (authStep === 'pass') { authStep = null; return login(user, Buffer.from(line, 'base64').toString(), 'LOGIN'); }
    const [verb, ...rest] = line.split(' '); const arg = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO':
        return say(['250-stand-in', ...(smtp.starttls && !smtp.stripped && !secure ? ['250-STARTTLS'] : []), `250-AUTH ${smtp.mechs}`, '250 8BITMIME'].join('\r\n'));
      case 'STARTTLS': {
        say('220 2.0.0 Ready to start TLS' + (smtp.mode === 'inject' ? '\r\n250 2.0.0 injected' : ''));
        raw.removeAllListeners('data');
        sock = new tls.TLSSocket(raw, { isServer: true, ...smtp.ctx });
        sock.on('data', onData); sock.on('error', () => {});
        secure = true; return;
      }
      case 'AUTH': {
        const [mech, init] = arg.split(' ');
        if (mech === 'LOGIN') { authStep = 'user'; return say('334 VXNlcm5hbWU6'); }
        const [, u, p] = Buffer.from(init || '', 'base64').toString().split('\0');
        return login(u, p, 'PLAIN');
      }
      case 'MAIL':
        if (smtp.mode === 'quota') return say('550 5.4.5 Daily user sending limit exceeded. For more information on Gmail sending limits');
        if (smtp.mode === 'busyOnce') { smtp.mode = 'ok'; say('421 4.7.0 Try again later, closing connection.'); return sock.end(); }
        env = { from: /<(.*)>/.exec(arg)[1] }; return say('250 2.1.0 OK');
      case 'RCPT': {
        const to = /<(.*)>/.exec(arg)[1];
        if (to.startsWith('reject')) return say('550 5.1.1 The email account that you tried to reach does not exist');
        env.to = to; return say('250 2.1.5 OK');
      }
      case 'DATA': inData = true; data = []; return say('354 Go ahead');
      case 'RSET': env = {}; return say('250 2.0.0 OK');
      case 'QUIT': say('221 2.0.0 Bye'); return sock.end();
      default: return say('502 5.5.1 Unrecognized command');
    }
  };
  function login(u, p, mech) {
    smtp.logins.push({ user: u, pass: p, mech, secure });
    if (smtp.mode === 'badauth' || p !== smtp.expectPass) return say('535 5.7.8 Username and Password not accepted');
    say('235 2.7.0 Accepted');
  }
  function onData(d) {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); }
  }
  raw.on('data', onData); raw.on('error', () => {});
  say('220 stand-in ESMTP ready');
});

/* ---------- reading the messages it received ---------- */
const decodeWords = (s) => s.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
function header(msg, name) {
  const m = new RegExp(`^${name}: (.*(?:\\r\\n .*)*)`, 'm').exec(msg.data);
  return m ? decodeWords(m[1]) : null;
}
function part(msg, type) {
  const i = msg.data.indexOf(`Content-Type: ${type}`);
  assert.ok(i >= 0, `${type} part present`);
  const body = msg.data.slice(msg.data.indexOf('\r\n\r\n', i) + 4);
  return Buffer.from(body.slice(0, body.indexOf('\r\n--')).replace(/\r\n/g, ''), 'base64').toString('utf8');
}

/* ---------- running the server ---------- */
let srv; let cookie = '';
const MAIL_VARS = ['BREVO_API_KEY', 'MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_DAILY_LIMIT', 'GMAIL_USER', 'GMAIL_APP_PASSWORD',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_ALLOW_SELF_SIGNED', 'SMTP_CA_FILE',
  'GMAIL_SMTP_HOST', 'GMAIL_SMTP_PORT', 'GMAIL_SMTP_CA_FILE'];
let log = '';
async function start({ env = {}, envFile = '' } = {}) {
  if (srv) await new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); });
  const data = fs.mkdtempSync(path.join(TMP, 'data-'));
  const file = path.join(data, 'test.env');
  fs.writeFileSync(file, envFile);
  const base = { ...process.env };
  for (const k of MAIL_VARS) delete base[k];
  log = '';
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...base, PORT, DATA_DIR: data, ADMIN_PASSWORD: ADMIN_PW, TRUST_PROXY: '', HTTPS_PORT: '', ENV_FILE: file, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  srv.stdout.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch { await sleep(100); } }
  cookie = '';
  ok(await req('POST', '/api/admin/login', { password: ADMIN_PW }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('admin=')) cookie = sc.split(';')[0];
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.data)); return r.data; };
const state = async () => ok(await req('GET', '/api/admin/state'));
async function until(fn, what) {
  for (let i = 0; i < 150; i++) { const s = await state(); if (fn(s)) return s; await sleep(100); }
  throw new Error('timed out waiting for ' + what);
}
const mailIdle = () => until((s) => !s.mail.sending, 'email queue');
const checked = () => until((s) => s.mail.check, 'login check');

async function main() {
  await new Promise((r) => smtpSrv.listen(0, '127.0.0.1', r));
  const SP = smtpSrv.address().port;

  // ---- company SMTP, all settings from a .env file: STARTTLS with a certificate from the company's own CA, AUTH LOGIN only
  smtp.starttls = true; smtp.mechs = 'LOGIN'; smtp.expectPass = SMTP_PW; smtp.ctx = TLS_CTX;
  const caLine = `SMTP_CA_FILE='${CA_FILE}'`;
  const smtpEnv = ['# company mail server', 'MAIL_PROVIDER=smtp', 'SMTP_HOST=127.0.0.1', `SMTP_PORT=${SP}`, 'SMTP_USER=vote-bot',
    `SMTP_PASS="${SMTP_PW}"`, caLine, "MAIL_FROM='vote@company.example'", 'MAIL_DAILY_LIMIT=3'].join('\n');
  await start({ envFile: smtpEnv });
  assert.match(log, /อ่านค่าตั้งจาก/);
  let st = await checked();
  assert.equal(st.mail.configured, true);
  assert.deepEqual(st.mail.check, { ok: true, error: '' }, 'logged in at startup');
  assert.deepEqual(st.mail.notes, []);
  assert.equal(st.mail.provider.kind, 'smtp');
  assert.equal(st.mail.provider.account, `127.0.0.1:${SP} (vote-bot)`);
  assert.equal(st.mail.provider.limit, 3);
  assert.equal(st.mail.from, 'vote@company.example');
  assert.deepEqual(smtp.logins.at(-1), { user: 'vote-bot', pass: SMTP_PW, mech: 'LOGIN', secure: true }, 'password only after STARTTLS');

  ok(await req('POST', '/api/admin/mail/recipients', { text: 'สมชาย ใจดี, a@example.com\nreject@example.com\nb@example.com' }));
  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.sent, 2); assert.equal(st.mail.failed, 1);
  assert.equal(st.mail.lastError, '', 'a refused address does not stop the batch');
  assert.equal(st.mail.provider.sent24h, 2);
  const ml = ok(await req('GET', '/api/admin/mail')).recipients;
  assert.match(ml.find((r) => r.email === 'reject@example.com').error, /ไม่รับอีเมลผู้รับนี้.*550 5\.1\.1/);
  const m = smtp.sent.find((x) => x.to === 'a@example.com');
  assert.equal(m.secure, true);
  assert.equal(m.from, 'vote@company.example');
  assert.equal(header(m, 'Subject'), 'รหัสโหวตของคุณ · งานเลี้ยงปีใหม่');
  assert.equal(header(m, 'From'), 'งานเลี้ยงปีใหม่ <vote@company.example>', 'no name in MAIL_FROM: the event name is used');
  assert.equal(header(m, 'To'), 'สมชาย ใจดี <a@example.com>');
  const html = part(m, 'text/html');
  const code = ml.find((r) => r.email === 'a@example.com').code.replace('-', '');
  assert.match(html, new RegExp(`href="http://[^"]+/\\?c=${code}&amp;s=`));
  assert.match(html, /src="cid:qr-vote@contest-vote"/, 'QR shown in the body');
  assert.match(m.data, /Content-Type: multipart\/related/);
  assert.match(m.data, /Content-ID: <qr-vote@contest-vote>/);
  assert.match(part(m, 'text/plain'), /สวัสดีคุณสมชาย ใจดี/);
  const png = m.data.slice(m.data.indexOf('\r\n\r\n', m.data.indexOf('Content-Type: image/png')) + 4);
  assert.equal(Buffer.from(png.slice(0, png.indexOf('\r\n--')).replace(/\r\n/g, ''), 'base64').subarray(1, 4).toString(), 'PNG');
  // test email, and over the daily limit: the count is there for the admin page to warn with
  ok(await req('POST', '/api/admin/mail/test', { to: 'admin@example.com' }));
  assert.match(header(smtp.sent.at(-1), 'Subject'), /^\[ทดสอบ\] /);
  st = await state();
  assert.equal(st.mail.provider.sent24h, 3);
  assert.ok(smtp.logins.length <= 4, `connections are reused (${smtp.logins.length} logins for 4 emails + startup check)`);

  // ---- nothing may go out unless the connection is encrypted and the certificate checked out.
  // Each case: refused at startup with a reason, no login reached the server, a send attempt fails too.
  const refused = async (what, envFile, reason, opts = {}) => {
    const logins = smtp.logins.length; const sent = smtp.sent.length;
    await start({ envFile });
    st = await checked();
    assert.equal(st.mail.check.ok, false, `${what}: refused`);
    assert.match(st.mail.check.error, reason, `${what}: reason`);
    if (!opts.noSend) {
      assert.match((await req('POST', '/api/admin/mail/test', { to: 'admin@example.com' })).data.error, reason, `${what}: test email refused`);
    }
    assert.equal(smtp.logins.length, logins, `${what}: no password sent`);
    assert.equal(smtp.sent.length, sent, `${what}: no email sent`);
    return st;
  };
  // company certificate, but SMTP_CA_FILE not set
  await refused('no CA file', smtpEnv.replace(caLine, ''), /SMTP_CA_FILE/);
  // the old switch no longer turns checking off; the admin is told to use SMTP_CA_FILE
  st = await refused('old SMTP_ALLOW_SELF_SIGNED', smtpEnv.replace(caLine, 'SMTP_ALLOW_SELF_SIGNED=true'), /SMTP_CA_FILE/);
  assert.match(st.mail.notes.join(' '), /SMTP_ALLOW_SELF_SIGNED เลิกใช้แล้ว.*SMTP_CA_FILE/);
  // a CA file, but not the CA that signed the server's certificate (someone in the middle with their own)
  await refused('wrong CA', smtpEnv.replace(caLine, `SMTP_CA_FILE='${f('other-ca.pem')}'`), /ใบรับรอง.*ไม่ผ่านการตรวจ.*SMTP_CA_FILE/);
  // trusted CA, but the certificate is for another name than SMTP_HOST (the check uses the real host, also after STARTTLS)
  smtp.ctx = TLS_CTX_DNS_ONLY;
  await refused('wrong name', smtpEnv, /ไม่ได้ออกให้ชื่อ 127\.0\.0\.1/);
  smtp.ctx = TLS_CTX;
  // server does not offer STARTTLS (or it was stripped on the way): stop before AUTH, never log in in the clear
  smtp.stripped = true; smtp.mechs = 'PLAIN LOGIN';
  await refused('STARTTLS stripped', smtpEnv, /ไม่ยอมเข้ารหัสด้วย STARTTLS.*ระบบหยุดก่อนส่งรหัสผ่าน/);
  // same with a relay that needs no login: no email in the clear either
  await refused('no STARTTLS, no login', smtpEnv.replace('SMTP_USER=vote-bot', '').replace(/SMTP_PASS=.*/, ''), /STARTTLS/);
  smtp.stripped = false; smtp.mechs = 'LOGIN';
  // plain-text reply smuggled in right after "220 Ready to start TLS"
  smtp.mode = 'inject';
  await refused('STARTTLS injection', smtpEnv, /STARTTLS/);
  smtp.mode = 'ok';
  // a CA file that is not a certificate: email is not set up, with the reason
  await start({ envFile: smtpEnv.replace(caLine, `SMTP_CA_FILE='${f('not-a-cert.pem')}'`) });
  st = await state();
  assert.equal(st.mail.configured, false); assert.match(st.mail.problem, /SMTP_CA_FILE.*BEGIN CERTIFICATE/);
  await start({ envFile: smtpEnv.replace(caLine, `SMTP_CA_FILE='${f('missing.pem')}'`) });
  assert.match((await state()).mail.problem, /SMTP_CA_FILE.*อ่านไฟล์.*ไม่ได้/);
  // relative path: taken from the folder of the .env file
  await start({ envFile: smtpEnv.replace(caLine, `SMTP_CA_FILE=${path.relative(path.join(TMP, 'data-x'), CA_FILE)}`) });
  assert.deepEqual((await checked()).mail.check, { ok: true, error: '' }, 'relative SMTP_CA_FILE');

  // wrong password: shown at startup, and a batch stops at the first failure instead of trying everyone
  smtp.mechs = 'PLAIN LOGIN';
  await start({ env: { MAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SP), SMTP_USER: 'vote-bot', SMTP_PASS: 'wrong', SMTP_CA_FILE: CA_FILE, MAIL_FROM: 'vote@company.example' } });
  st = await checked();
  assert.equal(st.mail.check.ok, false);
  assert.match(st.mail.check.error, /SMTP_USER และ SMTP_PASS/);
  assert.equal(st.mail.provider.limit, 0, 'company SMTP has no daily limit unless set');
  ok(await req('POST', '/api/admin/mail/recipients', { text: Array.from({ length: 10 }, (_, i) => `bulk${i}@example.com`).join('\n') }));
  const before = smtp.logins.length;
  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.failed, 10);
  assert.match(st.mail.lastError, /SMTP_USER และ SMTP_PASS/);
  assert.ok(smtp.logins.length - before <= 4, `stopped early (${smtp.logins.length - before} tries)`);

  // ---- Gmail with an App Password (stand-in server on STARTTLS; the real one is smtp.gmail.com:465 with a public certificate)
  smtp.expectPass = 'abcdefghijklmnop';
  const gmailEnv = { MAIL_PROVIDER: 'gmail', GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    GMAIL_SMTP_HOST: '127.0.0.1', GMAIL_SMTP_PORT: String(SP), GMAIL_SMTP_CA_FILE: CA_FILE };
  await start({ env: gmailEnv });
  st = await checked();
  assert.equal(st.mail.check.ok, true, JSON.stringify(st.mail.check));
  assert.equal(smtp.logins.at(-1).pass, 'abcdefghijklmnop', 'spaces in the App Password are dropped');
  assert.equal(st.mail.provider.label, 'Gmail'); assert.equal(st.mail.provider.limit, 500);
  assert.equal(st.mail.from, 'me@gmail.com', 'sender defaults to the Gmail account');
  assert.deepEqual(st.mail.notes, []);
  ok(await req('POST', '/api/admin/mail/recipients', { text: 'g1@example.com' }));
  smtp.mode = 'busyOnce'; // Gmail says "try again later" once: retried, then sent
  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.sent, 1, 'retried after 421');
  assert.equal(smtp.sent.at(-1).from, 'me@gmail.com');
  smtp.mode = 'quota';
  ok(await req('POST', '/api/admin/mail/recipients', { text: 'g2@example.com\ng3@example.com' }));
  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.failed, 2);
  assert.match(st.mail.lastError, /โควตา.*500/);
  smtp.mode = 'ok';

  // Gmail with the normal login password (refused) and a different From: warned before sending, told why after
  await start({ env: { ...gmailEnv, GMAIL_APP_PASSWORD: 'my-login-password', MAIL_FROM: 'ทีมงาน <hr@company.example>' } });
  st = await checked();
  assert.equal(st.mail.check.ok, false);
  assert.match(st.mail.check.error, /App Password 16 ตัว/);
  assert.match((await req('POST', '/api/admin/mail/test', { to: 'admin@example.com' })).data.error, /App Password 16 ตัว/);
  assert.equal(st.mail.notes.length, 2);
  assert.match(st.mail.notes.join(' '), /16 ตัว/); assert.match(st.mail.notes.join(' '), /Send mail as/);

  // ---- settings missing or wrong: the admin sees what to set, sending is refused with that reason
  await start({ envFile: 'MAIL_PROVIDER=smtp\nMAIL_FROM=vote@company.example' });
  st = await state();
  assert.equal(st.mail.configured, false); assert.match(st.mail.problem, /SMTP_HOST/);
  ok(await req('POST', '/api/admin/mail/recipients', { text: 'x@example.com' }));
  assert.match((await req('POST', '/api/admin/mail/send', { which: 'pending' })).data.error, /SMTP_HOST.*\.env/);
  await start({ env: { MAIL_PROVIDER: 'outlook' } });
  assert.match((await state()).mail.problem, /ไม่รู้จัก/);
  await start({ env: { MAIL_PROVIDER: 'gmail', GMAIL_USER: 'me@gmail.com' } });
  assert.match((await state()).mail.problem, /GMAIL_APP_PASSWORD/);
  await start();
  st = await state();
  assert.equal(st.mail.configured, false); assert.match(st.mail.problem, /Brevo.*Gmail.*SMTP/);

  // Gmail stand-in without STARTTLS: the App Password is not sent either
  smtp.stripped = true;
  const gl = smtp.logins.length;
  await start({ env: gmailEnv });
  st = await checked();
  assert.equal(st.mail.check.ok, false); assert.match(st.mail.check.error, /Gmail ไม่ยอมเริ่มการเชื่อมต่อแบบเข้ารหัส/);
  assert.equal(smtp.logins.length, gl, 'Gmail: no password without TLS');
  smtp.stripped = false;

  assert.ok(smtp.logins.every((l) => l.secure), 'every login the stand-in ever saw came over TLS');
  assert.ok(smtp.sent.every((x) => x.secure), 'every email the stand-in ever got came over TLS');

  console.log(`email via SMTP: ${smtp.sent.length} messages, ${smtp.connections} connections to the stand-in`);
  console.log('ALL PASSED');
}

main().then(() => { srv.kill(); process.exit(0); }, (e) => { console.error('FAILED:', e); if (srv) srv.kill(); console.error(log); process.exit(1); });
