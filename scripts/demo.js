'use strict';
// Starts the server on a temp data dir with sample data, for trying the UI.
// Usage: node scripts/demo.js  → admin password: demo
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.PORT) || 3456;
const BASE = `http://localhost:${PORT}`;
const DEMO_PW = process.env.ADMIN_PASSWORD || 'demo'; // README: password demo unless you set one
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-demo-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: DEMO_PW }, stdio: 'inherit',
});
process.on('SIGINT', () => { srv.kill('SIGINT'); process.exit(0); });

let cookie = '';
async function req(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('admin=')) cookie = sc.split(';')[0];
  return r.json();
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  await req('POST', '/api/admin/login', { password: DEMO_PW });
  // demo data uses the no-login mode so sample votes need no codes (new events start in code mode)
  await req('PUT', '/api/admin/event', { name: 'งานเลี้ยงปีใหม่ 2570 · ฝ่ายไอทีและฝ่ายบัญชีร่วมกันจัด', accessMode: 'open' });
  const names = ['สมชาย ใจดี', 'ณัฐณิชา ศรีสวัสดิ์วงศ์ษาประเสริฐ (น้ำ ฝ่ายบัญชี)', 'ปั๊ม ญี่ปุ่น', 'กิ่งกาญจน์ ฤๅษีรักษ์', 'ทีม IT Support ทั้งแผนก', 'ฐิติพร ปู่ทอง'];
  const t1 = await req('POST', '/api/admin/topics', { title: 'ชุดสวยสุด', maxVotes: 1 });
  const t2 = await req('POST', '/api/admin/topics', { title: 'ชุดฮาสุดแห่งปี ที่ทำให้ทั้งงานหัวเราะจนน้ำตาไหล', maxVotes: 3 });
  await req('POST', '/api/admin/topics', { title: 'การแสดงยอดเยี่ยม', maxVotes: 1 });
  const c1 = []; const c2 = [];
  for (let i = 0; i < 6; i++) c1.push(await req('POST', `/api/admin/topics/${t1.id}/contestants`, { number: String(i + 1), name: names[i] }));
  for (let i = 0; i < 8; i++) c2.push(await req('POST', `/api/admin/topics/${t2.id}/contestants`, { number: String(i + 1), name: names[i % 6] + (i >= 6 ? ' ชุดสอง' : '') }));
  await req('PUT', `/api/admin/topics/${t1.id}`, { status: 'open' });
  await req('PUT', `/api/admin/topics/${t2.id}`, { status: 'open' });
  for (let i = 0; i < 57; i++) {
    const { token } = await req('POST', '/api/join', {});
    const h = { 'X-Voter-Token': token };
    await req('POST', '/api/vote', { topicId: t1.id, picks: [c1[[0, 0, 0, 1, 1, 2, 3, 4][i % 8]].id] }, h);
    if (i % 2) await req('POST', '/api/vote', { topicId: t2.id, picks: [c2[i % 8].id, c2[(i + 3) % 8].id] }, h);
  }
  console.log(`\nDEMO READY · admin password: ${process.env.ADMIN_PASSWORD ? "(the one in ADMIN_PASSWORD)" : "demo"} · data: ${DATA}`);
})();
