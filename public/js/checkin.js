'use strict';
// Registration desk: shows a one-time ticket QR (never a vote code). The guest presses "รับบัตร" on their own
// phone; the server then makes their code and the ticket dies, so the next poll shows a new QR.
// An unclaimed ticket expires on the server and is replaced the same way.
const POLL_MS = 1500;
const DONE_MS = 1800; // how long "รับบัตรแล้ว" stays before the next QR
let last = null; let busyPoll = false; let showingDone = false;

async function poll(skip = false) {
  if (busyPoll && !skip) return;
  busyPoll = true;
  try {
    const d = await api('POST', '/api/admin/desk', skip ? { skip: true } : {});
    if (last && d.handed > last.handed) showDone(d);
    else if (!showingDone) draw(d);
    last = d;
  } catch (e) {
    $('#app').innerHTML = `<div class="d-in"><div class="banner">${icon('alert')}<span>${esc(e.status === 401
      ? 'ต้องเข้าสู่ระบบแอดมินก่อน เปิดหน้าแอดมินในเครื่องนี้ แล้วกลับมาที่หน้านี้'
      : e.message)}</span></div><a class="btn" href="/admin">ไปหน้าแอดมิน</a></div>`;
    last = null;
  } finally { busyPoll = false; }
}

function draw(d) {
  $('#app').innerHTML = `<div class="d-in">
    <p class="d-event">${esc(d.eventName)}</p>
    <h1 class="d-title">สแกนเพื่อรับบัตรโหวต</h1>
    <div class="d-qr" role="img" aria-label="QR รับบัตรโหวต">${d.qr}</div>
    <p class="d-code">สแกนแล้วกด <b>รับบัตร</b> บนมือถือ · คนละ 1 ใบ</p>
    <div class="d-staff"><span>สำหรับเจ้าหน้าที่ · รับบัตรไปแล้ว ${d.handed.toLocaleString('th-TH')} คน · QR เปลี่ยนเองทุกนาทีถ้าไม่มีคนรับ · สแกนไม่ได้ให้ใช้บัตรกระดาษสำรอง</span>
      <button class="btn btn-sm" id="skip">${icon('refresh')}เปลี่ยน QR</button></div></div>`;
  $('#skip').addEventListener('click', (e) => busy(e.currentTarget, () => poll(true)));
}

function showDone(next) {
  showingDone = true;
  $('#app').innerHTML = `<div class="d-in d-done" role="status"><span class="big">${icon('check')}</span>
    <h1 class="d-title">รับบัตรแล้ว</h1><p class="d-event">เชิญคนถัดไป</p></div>`;
  setTimeout(() => { showingDone = false; draw(next); }, DONE_MS);
}

// keep a tablet's screen on while the desk is open
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); poll(); } });
keepAwake();
poll();
setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
