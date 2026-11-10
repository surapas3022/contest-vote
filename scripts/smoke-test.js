'use strict';
// End-to-end smoke + load test: starts the server on a temp data dir, runs the full flow,
// then 200 voters voting at the same time, then the security checks.
// Usage: node scripts/smoke-test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');
const vm = require('vm');

// admin passwords are made up per run, never written in the code
const randomPw = () => 'pw-' + crypto.randomBytes(15).toString('base64url');
const ADMIN_PW = randomPw();
const ADMIN_PW_NEXT = randomPw();

// the browser's own puzzle solver (public/js/pow.js), run here for name-mode joins
const powCtx = vm.createContext({ self: {}, TextEncoder });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pow.js'), 'utf8'), powCtx);
const solve = (ch) => powCtx.powSearch(ch.c, ch.bits, 0, 1e9);

const PORT = Number(process.env.TEST_PORT) || 3457;
const BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));

// stand-in for Brevo's send-email API: records every request; mode switches its answer
const brevo = { mode: 'ok', sent: [], port: 0 };
const brevoSrv = require('http').createServer((rq, rs) => {
  let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => {
    const payload = JSON.parse(b);
    brevo.sent.push({ key: rq.headers['api-key'], payload });
    const to = payload.to[0].email;
    const reply = (status, body) => { rs.writeHead(status, { 'content-type': 'application/json' }); rs.end(JSON.stringify(body)); };
    if (brevo.mode === 'badkey') return reply(401, { code: 'unauthorized', message: 'Key not found' });
    if (to.startsWith('reject')) return reply(400, { code: 'invalid_parameter', message: 'email is not valid in to' });
    reply(201, { messageId: '<' + crypto.randomBytes(6).toString('hex') + '@smtp-relay.mailin.fr>' });
  });
});
const BREVO_KEY = 'xkeysib-test-' + crypto.randomBytes(8).toString('hex');

// settings file the server reads; values given on the command line (env below) must win over it
const ENV_FILE = path.join(DATA, 'test.env');
fs.writeFileSync(ENV_FILE, ['# test settings', 'MAIL_PROVIDER=brevo', 'MAIL_DAILY_LIMIT=1000 # comment after a value',
  "MAIL_FROM='ไม่ควรถูกใช้ <wrong@example.com>'"].join('\n'));

let srv;
function start(extraEnv = {}) {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: ADMIN_PW, TRUST_PROXY: '', HTTPS_PORT: '', ENV_FILE,
      MAIL_PROVIDER: undefined, MAIL_DAILY_LIMIT: undefined, GMAIL_USER: undefined, SMTP_HOST: undefined, // undefined = left out
      BREVO_API_KEY: BREVO_KEY, BREVO_API_URL: `http://127.0.0.1:${brevo.port}/v3/smtp/email`, MAIL_FROM: 'ทีมงานปีใหม่ <vote@example.com>',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
}
async function restart(extraEnv, whileStopped = () => {}) {
  await new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); });
  whileStopped();
  start(extraEnv); await waitUp();
}

let cookie = '';
async function req(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('admin=')) cookie = sc.split(';')[0];
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
async function nameJoin(name) {
  const ch = ok(await req('GET', '/api/join/challenge'));
  return req('POST', '/api/join', { name, pow: { c: ch.c, x: solve(ch) } });
}
const ok = (r) => { assert.ok(r.status < 300, JSON.stringify(r.data)); return r.data; };

async function mailIdle() {
  for (let i = 0; i < 100; i++) {
    const s = ok(await req('GET', '/api/admin/state'));
    if (!s.mail.sending) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('email queue never finished');
}

async function main() {
  await new Promise((r) => brevoSrv.listen(0, '127.0.0.1', r));
  brevo.port = brevoSrv.address().port;
  start(); await waitUp();

  // admin auth
  assert.equal((await req('GET', '/api/admin/state')).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  ok(await req('POST', '/api/admin/login', { password: ADMIN_PW }));
  let st = ok(await req('GET', '/api/admin/state'));
  assert.equal(st.event.accessMode, 'code', 'new events start in code mode');
  ok(await req('PUT', '/api/admin/event', { name: 'งานเลี้ยงปีใหม่ 2570' }));

  // topics
  const t1 = ok(await req('POST', '/api/admin/topics', { title: 'ชุดสวยสุด', maxVotes: 1 }));
  const t2 = ok(await req('POST', '/api/admin/topics', { title: 'ชุดฮาสุด', maxVotes: 3 }));
  assert.equal((await req('PUT', `/api/admin/topics/${t1.id}`, { status: 'open' })).status, 400, 'cannot open with no contestants');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const c1 = [];
  for (let i = 1; i <= 5; i++) c1.push(ok(await req('POST', `/api/admin/topics/${t1.id}/contestants`, { number: String(i), name: 'ผู้เข้าประกวด ' + i, photo: i === 1 ? png : undefined })));
  assert.equal((await req('POST', `/api/admin/topics/${t1.id}/contestants`, { number: '1', name: 'ซ้ำ' })).status, 400);
  assert.ok(c1[0].photo.startsWith('/uploads/'));
  const photoRes = await fetch(BASE + c1[0].photo);
  assert.equal(photoRes.status, 200);
  assert.equal(photoRes.headers.get('content-type'), 'image/png');
  assert.equal(photoRes.headers.get('x-content-type-options'), 'nosniff');
  const c2 = [];
  for (let i = 1; i <= 6; i++) c2.push(ok(await req('POST', `/api/admin/topics/${t2.id}/contestants`, { number: String(i), name: 'ฮา ' + i })));
  ok(await req('PUT', `/api/admin/topics/${t1.id}`, { status: 'open' }));
  ok(await req('PUT', `/api/admin/topics/${t2.id}`, { status: 'open' }));

  // ---- open mode: one vote per device token, change of mind, limits
  ok(await req('PUT', '/api/admin/event', { accessMode: 'open' }));
  const aRes = await req('POST', '/api/join', {});
  const a = ok(aRes);
  const H = { 'X-Voter-Token': a.token };
  assert.equal((await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[0].id, c1[1].id] }, H)).status, 400, 'max 1');
  ok(await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[0].id] }, H));
  ok(await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[1].id] }, H)); // change mind
  assert.equal((await req('POST', '/api/vote', { topicId: t2.id, picks: c2.slice(0, 4).map((c) => c.id) }, H)).status, 400, 'max 3');
  ok(await req('POST', '/api/vote', { topicId: t2.id, picks: c2.slice(0, 3).map((c) => c.id) }, H));
  ok(await req('POST', '/api/vote', { topicId: t2.id, picks: [c2[0].id, c2[0].id] }, H)); // dup collapses
  const me = ok(await req('GET', '/api/me', undefined, H));
  assert.deepEqual(me.picks[t1.id], [c1[1].id]);
  assert.deepEqual(me.picks[t2.id], [c2[0].id]);
  assert.equal((await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[0].id] }, { 'X-Voter-Token': 'nope' })).status, 401);
  // same browser (device cookie) joining again gets the same voter back
  const dev = aRes.headers.get('set-cookie').split(';')[0];
  assert.equal(ok(await req('POST', '/api/join', {}, { cookie: dev })).token, a.token);

  // mode change blocked while ballots exist
  assert.equal((await req('PUT', '/api/admin/event', { accessMode: 'code' })).status, 409);
  ok(await req('POST', '/api/admin/reset-votes', { confirm: 'ล้างผล' }));

  // ---- name mode: only names on the roster
  ok(await req('PUT', '/api/admin/event', { accessMode: 'name' }));
  assert.equal((await req('GET', '/api/me', undefined, H)).status, 401, 'old open-mode token invalid');
  assert.equal((await nameJoin('สมชาย ใจดี')).status, 409, 'no roster yet → nobody can join');
  assert.equal((await req('PUT', '/api/admin/roster', { text: 'สมชาย ใจดี\nสมชาย ใจดี' })).status, 400, 'duplicate names need ids');
  st = ok(await req('PUT', '/api/admin/roster', { text: 'E001, สมชาย ใจดี\nE002\tสมหญิง รักงาน\nวิชัย ดีมาก\nE010, ชื่อซ้ำ กัน\nE011, ชื่อซ้ำ กัน' }));
  assert.equal(st.roster.count, 5);
  assert.equal((await nameJoin('คนนอก รายชื่อ')).status, 404, 'not on roster');
  assert.equal((await nameJoin('ชื่อซ้ำ กัน')).status, 409, 'ambiguous name → ask for id');
  ok(await nameJoin('e011'));
  const n1 = ok(await nameJoin('  สมชาย   ใจดี '));
  const n2 = ok(await nameJoin('สมชายใจดี')); // other phone, spacing differs
  const n3 = ok(await nameJoin('E001'));      // by employee id
  assert.equal(ok(await req('GET', '/api/me', undefined, { 'X-Voter-Token': n3.token })).label, 'สมชาย ใจดี');
  ok(await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[2].id] }, { 'X-Voter-Token': n1.token }));
  ok(await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[3].id] }, { 'X-Voter-Token': n2.token }));
  st = ok(await req('GET', '/api/admin/state'));
  assert.equal(st.topics[0].voters, 1, 'same person = one voter');
  // removing someone from the roster stops them voting and shows up for the admin
  st = ok(await req('PUT', '/api/admin/roster', { text: 'E002, สมหญิง รักงาน\nวิชัย ดีมาก' }));
  assert.equal(st.roster.unlistedWithVotes, 1);
  assert.equal((await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[0].id] }, { 'X-Voter-Token': n1.token })).status, 401);
  st = ok(await req('POST', '/api/admin/roster/purge-unlisted'));
  assert.equal(st.roster.unlistedWithVotes, 0);
  assert.equal(st.topics[0].voters, 0);
  assert.match(ok(await req('GET', '/api/admin/roster')).text, /E002, สมหญิง รักงาน/);

  // shared Wi-Fi: wrong names must never lock out people who are on the roster
  const noPow = await req('POST', '/api/join', { name: 'วิชัย ดีมาก' });
  assert.equal(noPow.status, 403, 'name join needs a solved puzzle');
  assert.ok(noPow.data.pow?.c, 'refusal hands out the next puzzle');
  const ch0 = ok(await req('GET', '/api/join/challenge'));
  assert.ok(ch0.bits <= 12, `calm network → easy puzzle (${ch0.bits} bits)`);
  const x0 = solve(ch0);
  ok(await req('POST', '/api/join', { name: 'วิชัย ดีมาก', pow: { c: ch0.c, x: x0 } }));
  assert.equal((await req('POST', '/api/join', { name: 'วิชัย ดีมาก', pow: { c: ch0.c, x: x0 } })).status, 403, 'a puzzle works once');
  const chW = ok(await req('GET', '/api/join/challenge'));
  assert.equal((await req('POST', '/api/join', { name: 'วิชัย ดีมาก', pow: { c: chW.c.replace(/^\d+/, '0'), x: '0' } })).status, 403, 'cannot lower the difficulty');
  assert.equal((await req('POST', '/api/join', { name: 'วิชัย ดีมาก', pow: { c: chW.c, x: 'abc' } })).status, 403, 'wrong answer refused');
  const preFlood = ok(await req('GET', '/api/join/challenge')); const preX = solve(preFlood);
  // a prankster on the same address floods wrong names; real people keep getting in every time
  const tf = Date.now();
  let legitOk = 0; let legitTries = 0; let maxBits = 0;
  for (let i = 0; i < 120; i++) {
    const r = await nameJoin('คนแกล้ง ' + i);
    assert.equal(r.status, 404, 'wrong name → 404, never 429');
    maxBits = Math.max(maxBits, r.data.pow.bits);
    if (i % 6 === 5) { legitTries++; if ((await nameJoin(i % 12 === 5 ? 'E002' : 'วิชัย ดีมาก')).status === 200) legitOk++; }
  }
  assert.equal(legitOk, legitTries, `people on the roster always get in during a flood (${legitOk}/${legitTries})`);
  assert.ok(maxBits >= 16, `guessing gets expensive (${maxBits} bits)`);
  assert.equal((await req('POST', '/api/join', { name: 'วิชัย ดีมาก', pow: { c: preFlood.c, x: preX } })).status, 403, 'puzzles solved before the flood are no longer accepted');
  console.log(`name flood: 120 wrong names + ${legitTries} real people in ${Date.now() - tf} ms, puzzle rose to ${maxBits} bits`);
  ok(await req('POST', '/api/admin/reset-votes', { confirm: 'ล้างผล' }));

  // ---- code mode
  ok(await req('PUT', '/api/admin/event', { accessMode: 'code' }));
  st = ok(await req('POST', '/api/admin/codes', { count: 220 }));
  assert.equal(st.codes.total, 220);
  const codes = ok(await req('GET', '/api/admin/codes?qr=1')).codes;
  assert.ok(codes[0].qr.startsWith('<svg'));
  assert.ok(codes.every((c) => /^[A-HJKMNP-Z2-9]{8}$/.test(c.code)), '8-letter codes');
  assert.equal((await req('POST', '/api/join', { code: 'ZZZZZZZZ' })).status, 404);
  const lower = ok(await req('POST', '/api/join', { code: codes[0].code.toLowerCase().replace(/^(....)/, '$1-') }));
  assert.ok(lower.token);

  // ---- 200 voters at the same time, each on both topics
  const t0 = Date.now();
  const expected1 = new Array(5).fill(0);
  const results = await Promise.all(codes.slice(0, 200).map(async (c, i) => {
    const j = ok(await req('POST', '/api/join', { code: c.code }));
    const h = { 'X-Voter-Token': j.token };
    const pick = i < 80 ? 0 : i < 140 ? 1 : i < 180 ? 2 : i < 195 ? 3 : 4; expected1[pick]++;
    const r1 = await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[pick].id] }, h);
    const r2 = await req('POST', '/api/vote', { topicId: t2.id, picks: [c2[i % 6].id, c2[(i + 1) % 6].id] }, h);
    return r1.status === 200 && r2.status === 200;
  }));
  const ms = Date.now() - t0;
  assert.ok(results.every(Boolean), 'all 200 voters succeeded');
  st = ok(await req('GET', '/api/admin/state'));
  const T1 = st.topics.find((t) => t.id === t1.id);
  assert.equal(T1.voters, 200);
  for (let k = 0; k < 5; k++) assert.equal(T1.results.find((r) => r.id === c1[k].id).votes, expected1[k]);
  assert.equal(st.topics.find((t) => t.id === t2.id).results.reduce((s, r) => s + r.votes, 0), 400);
  console.log(`200 voters × 2 topics (600 requests) in ${ms} ms`);

  // ---- codes by email (Brevo stand-in)
  assert.equal(st.mail.configured, true);
  assert.equal(st.mail.total, 0);
  assert.equal(st.mail.provider.kind, 'brevo');
  assert.equal(st.mail.provider.limit, 1000, 'MAIL_DAILY_LIMIT read from the .env file');
  assert.equal(st.mail.provider.sent24h, 0);
  assert.equal(st.mail.from, 'ทีมงานปีใหม่ <vote@example.com>', 'command-line MAIL_FROM wins over the .env file');
  const badAdd = await req('POST', '/api/admin/mail/recipients', { text: 'ok@example.com\nno email on this line' });
  assert.equal(badAdd.status, 400, 'line without an email refused');
  assert.match(badAdd.data.error, /บรรทัด 2/);
  assert.equal(ok(await req('GET', '/api/admin/state')).mail.total, 0, 'a refused batch adds nobody');
  st = ok(await req('POST', '/api/admin/mail/recipients', {
    text: 'a1@example.com\nสมหญิง รักงาน, a2@example.com\nb@example.com\tบี ดีใจ\nreject@example.com\n"คุณซี" <c@example.com>\nA1@Example.com',
  }));
  assert.equal(st.added, 5); assert.equal(st.skipped, 1, 'same address in another case is skipped');
  assert.equal(st.mail.pending, 5);
  assert.equal(st.codes.total, 220, 'emailed codes are not counted as cards');
  assert.equal(ok(await req('GET', '/api/admin/codes')).codes.length, 220, 'emailed codes are not printed');
  let ml = ok(await req('GET', '/api/admin/mail')).recipients;
  assert.deepEqual(ml.map((r) => [r.email, r.name]), [['a1@example.com', ''], ['a2@example.com', 'สมหญิง รักงาน'], ['b@example.com', 'บี ดีใจ'], ['reject@example.com', ''], ['c@example.com', 'คุณซี']]);
  assert.equal(new Set(ml.map((r) => r.code)).size, 5, 'one code each');

  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.sent, 4); assert.equal(st.mail.failed, 1); assert.equal(st.mail.pending, 0);
  assert.equal(st.mail.provider.sent24h, 4, 'only accepted emails count toward the daily limit');
  assert.equal(brevo.sent.length, 5);
  assert.ok(brevo.sent.every((s) => s.key === BREVO_KEY), 'api key sent');
  const mA2 = brevo.sent.find((s) => s.payload.to[0].email === 'a2@example.com').payload;
  assert.deepEqual(mA2.sender, { name: 'ทีมงานปีใหม่', email: 'vote@example.com' });
  assert.equal(mA2.to[0].name, 'สมหญิง รักงาน');
  assert.match(mA2.htmlContent, /สวัสดีคุณสมหญิง รักงาน/);
  assert.match(mA2.attachment[0].content, /^iVBORw0KGgo/, 'QR attached as PNG');
  assert.ok(!mA2.htmlContent.includes('/api/mail-qr/'), 'LAN link: no remote QR image');
  const linkM = /href="([^"]+)"/.exec(mA2.htmlContent)[1].replace(/&amp;/g, '&');
  assert.ok(mA2.textContent.includes(linkM), 'plain-text part has the same link');
  const lu = new URL(linkM);
  ml = ok(await req('GET', '/api/admin/mail')).recipients;
  const rA2 = ml.find((r) => r.email === 'a2@example.com');
  assert.equal(lu.searchParams.get('c'), rA2.code.replace('-', ''));
  assert.match(ml.find((r) => r.email === 'reject@example.com').error, /Brevo ไม่รับอีเมลนี้/);
  // the link in the email signs in like a card's QR, and the admin sees it was used
  const mj = ok(await req('POST', '/api/join', { code: lu.searchParams.get('c'), sig: lu.searchParams.get('s') }));
  ok(await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[4].id] }, { 'X-Voter-Token': mj.token }));
  st = ok(await req('GET', '/api/admin/state'));
  assert.equal(st.mail.used, 1); assert.equal(st.codes.used, 200, 'card usage count unchanged');
  // resend to one person (said they didn't get it): same code, counted twice
  ok(await req('POST', '/api/admin/mail/send', { which: 'one', id: rA2.id }));
  await mailIdle();
  ml = ok(await req('GET', '/api/admin/mail')).recipients;
  assert.equal(ml.find((r) => r.id === rA2.id).sends, 2);
  assert.equal(brevo.sent.length, 6);
  assert.equal(brevo.sent[5].payload.htmlContent.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&'), linkM, 'resend carries the same code');
  // added later → "send to the ones not sent yet" only sends to them
  st = ok(await req('POST', '/api/admin/mail/recipients', { text: 'late@example.com, มาทีหลัง' }));
  assert.equal(st.mail.pending, 1);
  assert.equal(ok(await req('POST', '/api/admin/mail/send', { which: 'pending' })).queued, 1);
  await mailIdle();
  assert.equal(brevo.sent.length, 7);
  assert.equal(brevo.sent[6].payload.to[0].email, 'late@example.com');
  assert.equal((await req('POST', '/api/admin/mail/send', { which: 'pending' })).status, 409, 'nothing left to send');
  // a bad API key stops the whole batch instead of trying everyone
  brevo.mode = 'badkey';
  ok(await req('POST', '/api/admin/mail/recipients', { text: Array.from({ length: 12 }, (_, i) => `bulk${i}@example.com`).join('\n') }));
  ok(await req('POST', '/api/admin/mail/send', { which: 'pending' }));
  st = await mailIdle();
  assert.equal(st.mail.failed, 13);
  assert.match(st.mail.lastError, /BREVO_API_KEY/);
  assert.ok(brevo.sent.length - 7 <= 4, `stopped after the first failures (${brevo.sent.length - 7} tried)`);
  brevo.mode = 'ok';
  // "send the first N now": only N of the failed ones go out, the rest stay failed
  assert.equal((await req('POST', '/api/admin/mail/send', { which: 'failed', max: 0 })).status, 400);
  assert.equal(ok(await req('POST', '/api/admin/mail/send', { which: 'failed', max: 5 })).queued, 5);
  st = await mailIdle();
  assert.equal(st.mail.failed, 9, '4 got through, reject@ (one of the first 5) is refused again');
  ok(await req('POST', '/api/admin/mail/send', { which: 'failed' }));
  st = await mailIdle();
  assert.equal(st.mail.failed, 1, 'only the address Brevo refuses is left');
  assert.equal(st.mail.lastError, '');
  assert.equal(st.mail.sent, 17);
  // event link changes after sending → admin sees who has the old link and can resend; public link → QR in body
  st = ok(await req('PUT', '/api/admin/event', { publicUrl: 'https://vote.example.com' }));
  assert.equal(st.mail.stale, 17);
  const before = brevo.sent.length;
  assert.equal(ok(await req('POST', '/api/admin/mail/send', { which: 'stale' })).queued, 17);
  st = await mailIdle();
  assert.equal(st.mail.stale, 0);
  const pub = brevo.sent[before].payload.htmlContent;
  assert.match(pub, /href="https:\/\/vote\.example\.com\/\?c=/);
  const img = /src="https:\/\/vote\.example\.com(\/api\/mail-qr\/[^"]+)"/.exec(pub)[1].replace(/&amp;/g, '&');
  const qrRes = await fetch(BASE + img);
  assert.equal(qrRes.status, 200); assert.equal(qrRes.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(BASE + img.replace(/s=.*/, 's=wrong'))).status, 404, 'QR image needs the signature');
  const cardSig = crypto.createHmac('sha256', JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).secret).update('code:' + codes[0].code).digest('base64url').slice(0, 16);
  assert.equal((await fetch(`${BASE}/api/mail-qr/${codes[0].code}.png?s=${cardSig}`)).status, 404, 'card codes have no email QR');
  ok(await req('PUT', '/api/admin/event', { publicUrl: '' }));
  // remove: someone who voted can't be removed; a wrong address can, and its code stops working
  assert.equal((await req('DELETE', `/api/admin/mail/recipients/${rA2.id}`)).status, 409);
  ml = ok(await req('GET', '/api/admin/mail')).recipients;
  const rB = ml.find((r) => r.email === 'b@example.com');
  ok(await req('DELETE', `/api/admin/mail/recipients/${rB.id}`));
  assert.equal((await req('POST', '/api/join', { code: rB.code })).status, 404, 'removed address: code no longer works');
  assert.equal(ok(await req('GET', '/api/admin/state')).mail.total, 17);
  // test email
  ok(await req('POST', '/api/admin/mail/test', { to: 'admin@example.com' }));
  assert.match(brevo.sent.at(-1).payload.subject, /^\[ทดสอบ\]/);
  assert.equal((await req('POST', '/api/admin/mail/test', { to: 'not-an-email' })).status, 400);
  // deleting the printed cards leaves emailed codes alone (blocked here anyway: cards were used)
  assert.equal((await req('DELETE', '/api/admin/codes')).status, 409);
  console.log(`email: ${brevo.sent.length} sends through the Brevo stand-in`);

  // close → voting blocked, reveal allowed
  assert.equal((await req('PUT', '/api/admin/screen', { topicId: t1.id, mode: 'reveal' })).status, 409, 'reveal needs closed');
  ok(await req('PUT', `/api/admin/topics/${t1.id}`, { status: 'closed' }));
  assert.equal((await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[0].id] }, { 'X-Voter-Token': lower.token })).status, 409);
  ok(await req('PUT', '/api/admin/screen', { topicId: t1.id }));
  ok(await req('PUT', '/api/admin/screen', { mode: 'reveal' }));
  ok(await req('PUT', '/api/admin/screen', { revealStep: 1 }));

  // screen stream: only 3rd place visible at step 1
  const ctrl = new AbortController();
  const sr = await fetch(BASE + '/api/screen/stream', { signal: ctrl.signal });
  const reader = sr.body.getReader();
  const { value } = await reader.read();
  ctrl.abort();
  const snap = JSON.parse(new TextDecoder().decode(value).split('data: ')[1]);
  assert.equal(snap.screen.mode, 'reveal');
  assert.deepEqual(snap.screen.podium.map((p) => p.place), [3]);
  assert.equal(snap.screen.counts, undefined);

  // plain snapshots carry exactly what each stream's first message carries
  const firstMsg = async (u, headers = {}) => {
    const c = new AbortController();
    const r = await fetch(BASE + u, { signal: c.signal, headers });
    const rd = r.body.getReader(); let txt = '';
    while (!txt.includes('\n\n')) { const { value: v, done } = await rd.read(); if (done) break; txt += new TextDecoder().decode(v); }
    c.abort();
    return txt.split('data: ')[1].split('\n')[0];
  };
  assert.equal(await (await fetch(BASE + '/api/screen/state')).text(), await firstMsg('/api/screen/stream'), 'screen snapshot = stream');
  assert.equal(await (await fetch(BASE + '/api/state')).text(), await firstMsg('/api/stream'), 'voter snapshot = stream');
  const vs = await fetch(BASE + '/api/state');
  assert.equal(vs.headers.get('cache-control'), 'no-cache');
  const vsBody = await vs.json();
  assert.ok(!JSON.stringify(vsBody).includes('"votes"') && !JSON.stringify(vsBody).includes('"counts"'), 'voter snapshot has no scores');
  // (raw http: fetch() adds "Cache-Control: no-cache" to hand-made conditional requests, browsers send max-age=0)
  const condStatus = await new Promise((resolve, reject) => require('http').get(BASE + '/api/state',
    { headers: { 'If-None-Match': vs.headers.get('etag'), 'Cache-Control': 'max-age=0' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
  assert.equal(condStatus, 304, 'unchanged snapshot → 304');
  ok(await req('PUT', '/api/admin/screen', { mode: 'hidden' }));
  assert.equal(JSON.parse(await (await fetch(BASE + '/api/screen/state')).text()).screen.counts, undefined, 'hidden mode: no scores in snapshot');
  ok(await req('PUT', '/api/admin/screen', { mode: 'live' }));
  assert.ok(JSON.parse(await (await fetch(BASE + '/api/screen/state')).text()).screen.counts, 'live mode: scores in snapshot');
  ok(await req('PUT', '/api/admin/screen', { mode: 'reveal' }));
  ok(await req('PUT', '/api/admin/screen', { revealStep: 1 }));
  assert.equal((await req('GET', '/api/admin/state')).headers.get('cache-control'), 'private, no-cache');
  // through a Quick Tunnel hostname the stream sends one snapshot and ends (no held connection)
  const qtText = await new Promise((resolve, reject) => {
    const r0 = require('http').get(BASE + '/api/stream', { headers: { Host: 'abc-def.trycloudflare.com' }, timeout: 3000 }, (r) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (d) => { t += d; }); r.on('end', () => resolve(t));
    });
    r0.on('timeout', () => { r0.destroy(); reject(new Error('quick tunnel stream stayed open')); }).on('error', reject);
  });
  assert.match(qtText, /^retry: 5000\ndata: \{/, 'quick tunnel: snapshot then end');

  // admin can't lower maxVotes below existing picks
  assert.equal((await req('PUT', `/api/admin/topics/${t2.id}`, { maxVotes: 1 })).status, 409);

  // CSV
  const csv = await fetch(BASE + '/api/admin/results.csv', { headers: { cookie } });
  const raw = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const body = raw.toString('utf8').slice(1);
  assert.ok(body.startsWith('"หัวข้อ"'));
  assert.equal(body.trim().split('\r\n').length, 1 + 5 + 6);
  console.log(body.split('\r\n').slice(0, 4).join('\n'));

  // persistence written
  await new Promise((r) => setTimeout(r, 400));
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  assert.equal(Object.keys(saved.ballots[t1.id]).length, 201); // 200 cards + 1 from an emailed link

  /* ================= security checks (one per finding) ================= */

  // #6 headers on pages and API
  for (const u of ['/', '/admin', '/api/stream']) {
    const r = await fetch(BASE + u, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!r) continue;
    assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/, u);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', u);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', u);
    r.body?.cancel().catch(() => {});
  }
  for (const f of ['index.html', 'admin.html', 'print.html', 'screen.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.ok(!/<script>(?!<\/script>)|\son[a-z]+=/i.test(html), `${f}: no inline script (CSP)`);
  }

  // #7 QR always points at the event's own link
  const qrA = await (await fetch(BASE + '/api/qr.svg')).text();
  const qrB = await (await fetch(BASE + '/api/qr.svg?text=' + encodeURIComponent('https://evil.example/phish'))).text();
  assert.equal(qrA, qrB, 'text= is ignored');

  // #8 HTML pretending to be PNG is refused
  const fakePng = 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  const up = await req('POST', `/api/admin/topics/${t2.id}/contestants`, { number: '99', name: 'ปลอม', photo: fakePng });
  assert.equal(up.status, 400, 'fake image refused');

  // big bodies are refused on public endpoints
  assert.equal((await req('POST', '/api/join', { code: 'x'.repeat(40000) })).status, 413);

  // CSRF: browser-marked cross-site state change refused
  assert.equal((await req('POST', '/api/admin/topics', { title: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);

  // #3 code guessing: wrong codes get throttled, a signed QR still gets in during the throttle
  let throttled = 0;
  for (let i = 0; i < 30; i++) if ((await req('POST', '/api/join', { code: 'WRONG' + (100 + i) })).status === 429) throttled++;
  assert.ok(throttled >= 9, `guessing throttled (${throttled}/30)`);
  const r429 = await req('POST', '/api/join', { code: codes[210].code });
  assert.equal(r429.status, 429, 'typed code also waits while throttled');
  assert.ok(Number(r429.headers.get('retry-after')) > 0);
  assert.equal((await req('POST', '/api/join', { code: codes[210].code, sig: 'wrong-signature' })).status, 429, 'bad signature does not bypass');
  // the card's QR carries ?c=CODE&s=SIG — that path is not blocked by the guess throttle
  const secret = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).secret;
  const sig = crypto.createHmac('sha256', secret).update('code:' + codes[210].code).digest('base64url').slice(0, 16);
  ok(await req('POST', '/api/join', { code: codes[210].code, sig }));

  // #9 trust proxy off by default: X-Forwarded-For can't dodge the limit
  assert.equal((await req('POST', '/api/join', { code: 'QQQQQQQQ' }, { 'X-Forwarded-For': '10.9.8.7' })).status, 429);

  // #4 admin login: brute force throttled
  let loginLimited = false;
  for (let i = 0; i < 8; i++) if ((await req('POST', '/api/admin/login', { password: 'guess' + i })).status === 429) loginLimited = true;
  assert.ok(loginLimited, 'login throttled');
  assert.equal((await req('POST', '/api/admin/login', { password: ADMIN_PW })).status, 429, 'even the right password waits while throttled');

  // #9 sessions are server-side and die when the password changes
  assert.equal((await req('GET', '/api/admin/state')).status, 200, 'existing admin session still works');
  const oldToken = cookie.split('=')[1];
  const dbFile = path.join(DATA, 'db.json');
  await restart({ ADMIN_PASSWORD: ADMIN_PW_NEXT, BREVO_API_KEY: '' }, () => {
    const d = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.ok(!JSON.stringify(d.adminSessions).includes(oldToken), 'session tokens stored hashed');
    d.codes.ABCDEF = { createdAt: new Date().toISOString() }; // a 6-letter card printed by the old version
    fs.writeFileSync(dbFile, JSON.stringify(d));
  });
  assert.equal((await req('GET', '/api/admin/state')).status, 401, 'old session dropped after password change');

  // old 6-letter cards keep working, typed or from their old ?c= QR
  ok(await req('POST', '/api/join', { code: 'abcdef' }));
  ok(await req('POST', '/api/admin/login', { password: ADMIN_PW_NEXT }));
  assert.ok(ok(await req('GET', '/api/admin/codes?qr=1')).codes[0].qr.startsWith('<svg'));

  // email settings removed: the list survives the restart, sending is refused with a clear reason
  st = ok(await req('GET', '/api/admin/state'));
  assert.equal(st.mail.configured, false); assert.equal(st.mail.total, 17);
  assert.match((await req('POST', '/api/admin/mail/send', { which: 'failed' })).data.error, /BREVO_API_KEY/);

  console.log('ALL PASSED');
}

main().then(() => { srv.kill(); process.exit(0); }, (e) => { console.error('FAILED:', e); srv.kill(); process.exit(1); });
