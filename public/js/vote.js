'use strict';
// Voter page: join (per access mode) → topic list → pick contestants → save. Changes allowed until topic closes.

const TOKEN_KEY = 'cv_token';
const S = {
  pub: null,          // public snapshot from server
  token: localStorage.getItem(TOKEN_KEY),
  me: null,           // { label, picks: {topicId: [cid]} }
  view: { name: 'loading' }, // loading | join | list | topic
  drafts: {},         // topicId -> [cid] (unsaved selection)
  joinError: '',
  topicMsg: null,     // { kind, text } shown on topic view
  saving: false,
};
const urlCode = new URLSearchParams(location.search).get('c');
const urlSig = new URLSearchParams(location.search).get('s'); // signed QR on newer cards

$('#offline-icon').innerHTML = icon('wifiOff');
$('#back').innerHTML = icon('chevronLeft') + '<span>หัวข้อทั้งหมด</span>';
$('#back').addEventListener('click', () => go({ name: 'list' }));
window.addEventListener('popstate', () => { S.view = history.state?.view || { name: 'list' }; render(); });

function go(view, push = true) {
  S.view = view; S.topicMsg = null;
  if (push) history.pushState({ view }, '');
  render(); window.scrollTo(0, 0);
}

/* ---------- session ---------- */

async function loadMe() {
  if (!S.token) return false;
  try {
    S.me = await api('GET', '/api/me', undefined, { 'X-Voter-Token': S.token });
    return true;
  } catch (e) {
    if (e.status === 401) { localStorage.removeItem(TOKEN_KEY); S.token = null; S.me = null; return false; }
    throw e;
  }
}

async function join(body) {
  const r = await api('POST', '/api/join', body);
  S.token = r.token; localStorage.setItem(TOKEN_KEY, r.token);
  await loadMe();
  if (urlCode) history.replaceState(null, '', location.pathname);
}

// name mode: each attempt carries a solved puzzle (server: anti name-guessing without locking out
// a shared Wi-Fi). Started while the person types, and again from the puzzle in each error reply.
let powJob = null; // { c, bits, x: Promise<string> }
function startPow(ch) { powJob = ch && ch.c ? { c: ch.c, bits: ch.bits, x: solvePow(ch.c, ch.bits) } : null; }
function prefetchPow() { if (!powJob) api('GET', '/api/join/challenge').then(startPow, () => {}); }
async function joinByName(name, onSlow) {
  for (let round = 0; ; round++) {
    if (!powJob) startPow(await api('GET', '/api/join/challenge'));
    const job = powJob; powJob = null;
    const slow = setTimeout(onSlow, 1200);
    let x;
    try { x = await job.x; } finally { clearTimeout(slow); }
    try { return await join({ name, pow: { c: job.c, x } }); } catch (e) {
      startPow(e.data?.pow);
      if (e.status === 403 && e.data?.pow && round < 3) continue; // puzzle expired / got harder: solve the new one
      throw e;
    }
  }
}

async function ensureSession() {
  if (await loadMe()) { S.view = { name: 'list' }; return render(); }
  const mode = S.pub.event.accessMode;
  if (mode === 'open') { await join({}); S.view = { name: 'list' }; return render(); }
  if (mode === 'code' && urlCode) {
    try { await join({ code: urlCode, sig: urlSig || undefined }); S.view = { name: 'list' }; return render(); }
    catch (e) { S.joinError = e.message; }
  }
  S.view = { name: 'join' }; render();
}

/* ---------- boot + live updates ---------- */

let lastMode = null;
const FRESH_MS = 90000;    // how long a newly opened topic keeps its "เพิ่งเปิด" badge
const fresh = {};          // topicId -> time it opened while this page was open
let openBefore = null;     // ids open in the previous snapshot (null before the first one)
function noteOpened(data) {
  const now = Date.now(); const openNow = new Set(data.topics.filter((t) => t.status === 'open').map((t) => t.id));
  if (openBefore) for (const id of openNow) if (!openBefore.has(id)) {
    fresh[id] = now;
    const t = data.topics.find((x) => x.id === id);
    if (S.view.name !== 'topic' || S.view.id !== id) toast('เปิดโหวตแล้ว: ' + t.title);
    setTimeout(() => { if (S.view.name === 'list') render(); }, FRESH_MS + 100);
  }
  openBefore = openNow;
}
const isFresh = (t) => t.status === 'open' && fresh[t.id] && Date.now() - fresh[t.id] < FRESH_MS;

liveStream('/api/stream', async (data) => {
  const first = !S.pub;
  noteOpened(data);
  S.pub = data;
  document.title = 'โหวต · ' + data.event.name;
  if (first || data.event.accessMode !== lastMode) {
    lastMode = data.event.accessMode;
    try { await ensureSession(); } catch (e) { renderFatal(e.message); }
  } else render();
}, (ok) => { $('#offline').hidden = ok; });

/* ---------- render ---------- */

function topicById(id) { return S.pub.topics.find((t) => t.id === id); }
function savedPicks(t) { return (S.me?.picks[t.id] || []).filter((id) => t.contestants.some((c) => c.id === id)); }
function draftPicks(t) { return (S.drafts[t.id] ?? savedPicks(t)).filter((id) => t.contestants.some((c) => c.id === id)); }
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function render() {
  if (!S.pub) return;
  $('#event-name').textContent = S.pub.event.name;
  const v = S.view;
  $('#back').hidden = v.name !== 'topic';
  $('#event-name').hidden = v.name === 'topic';
  $('#bar').hidden = true;
  renderCheerFab();
  if (v.name === 'join') return renderJoin();
  if (v.name === 'list') return renderList();
  if (v.name === 'topic') {
    const t = topicById(v.id);
    if (!t) { S.view = { name: 'list' }; return renderList(); }
    return renderTopic(t);
  }
}

function renderFatal(msg) {
  $('#app').innerHTML = `<div class="center-state"><div class="banner banner-error">${icon('alert')}<span>${esc(msg)}</span></div>
    <button class="btn btn-primary" id="reload">${icon('refresh')}โหลดหน้าใหม่</button></div>`;
  $('#reload').addEventListener('click', () => location.reload());
}

function renderJoin() {
  const mode = S.pub.event.accessMode;
  // always open: the event starts with the contestant intro (cheering) before any topic opens for voting
  const err = S.joinError ? `<p class="field-error" id="join-err">${icon('alert')}<span>${esc(S.joinError)}</span></p>` : '';
  const field = mode === 'code'
    ? `<div class="field"><label for="j-in">รหัสบนบัตร</label>
        <input id="j-in" class="input code-input" inputmode="text" autocapitalize="characters" autocomplete="off" maxlength="12" value="${esc(urlCode || '')}" ${S.joinError ? 'aria-invalid="true" aria-describedby="join-err"' : ''}>
        <p class="hint">ดูรหัสบนบัตรที่ได้รับ หรือสแกน QR บนบัตรเพื่อเข้าได้เลย</p>${err}</div>`
    : `<div class="field"><label for="j-in">ชื่อ-นามสกุล หรือรหัสพนักงาน</label>
        <input id="j-in" class="input" autocomplete="name" maxlength="80" ${S.joinError ? 'aria-invalid="true" aria-describedby="join-err"' : ''}>
        <p class="hint">พิมพ์ตามรายชื่อพนักงานของงานนี้ ถ้าเปลี่ยนเครื่องให้ใช้ชื่อหรือรหัสเดิม จะเห็นโหวตเดิมของคุณ</p>${err}</div>`;
  $('#app').innerHTML = `
    <form class="card join" id="join-form" novalidate>
      <h2>${mode === 'code' ? 'กรอกรหัสเพื่อเข้าร่วมกิจกรรม' : 'บอกเราว่าคุณคือใคร'}</h2>
      <p class="hint">ใช้ตลอดงาน: ส่งเชียร์ขึ้นจอตอนแนะนำผู้เข้าประกวด และโหวตเมื่อผู้จัดเปิดโหวต</p>
      ${field}
      <button class="btn btn-primary btn-block" type="submit">เข้าร่วม</button>
      ${mode === 'code' ? `<div class="or-pic"><span class="or">หรือ</span>
        <label class="btn btn-block pic-btn" for="j-pic">${icon('image')}เปิดจากรูปบัตรที่บันทึกไว้</label>
        <input id="j-pic" type="file" accept="image/*" class="visually-hidden">
        <p class="hint">เลือกรูปบัตร รูปแคปหน้าจอ หรือรูปถ่ายบัตรกระดาษ ระบบอ่าน QR ในเครื่องนี้ ไม่ได้ส่งรูปออกไปไหน</p></div>` : ''}
    </form>`;
  const input = $('#j-in');
  if (!urlCode && !matchMedia('(pointer: coarse)').matches) input.focus(); // phones: no keyboard popping over the picture button
  const pic = $('#j-pic');
  if (pic) pic.addEventListener('change', () => {
    const f = pic.files[0]; pic.value = '';
    if (!f) return;
    const lbl = $('.pic-btn');
    busy(lbl, async () => {
      const old = lbl.innerHTML; lbl.innerHTML = 'กำลังอ่าน QR…';
      try {
        const card = await readCardPicture(f);
        await join(card);
        S.joinError = ''; go({ name: 'list' }, false);
      } catch (err2) { S.joinError = err2.message; renderJoin(); }
      finally { if (lbl.isConnected) lbl.innerHTML = old; }
    });
  });
  if (mode === 'name') prefetchPow();
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#join-form button');
    busy(btn, async () => {
      try {
        if (mode === 'code') await join({ code: input.value });
        else await joinByName(input.value, () => { btn.textContent = 'กำลังตรวจสอบ… อาจใช้เวลาสักครู่'; });
        S.joinError = ''; go({ name: 'list' }, false);
      } catch (err2) {
        S.joinError = err2.message; const val = input.value; renderJoin(); $('#j-in').value = val; $('#j-in').focus();
      }
    });
  });
}

function statusBadge(t) {
  return t.status === 'open'
    ? `<span class="badge badge-open">เปิดโหวต</span>`
    : `<span class="badge badge-closed">${icon('lock')}ปิดโหวตแล้ว</span>`;
}
const ruleText = (t) => (t.maxVotes === 1 ? 'เลือก 1 คน' : `เลือกได้ ${t.maxVotes} คน`);
const openTodo = () => S.pub.topics.filter((t) => t.status === 'open' && !savedPicks(t).length);

const topicNo = (t) => `หัวข้อที่ ${S.pub.topics.indexOf(t) + 1} จาก ${S.pub.topics.length}`;
const thumb = (c, cls = '') => `<span class="ph ${cls}">${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy">` : esc(c.number)}${c.photo ? `<b>${esc(c.number)}</b>` : ''}</span>`;
const stripHtml = (t, max = 5) => {
  const more = t.contestants.length - max;
  // the last cell carries "+N" over its photo, so the strip never runs off the card
  const cells = t.contestants.slice(0, max).map((c, i) => (i === max - 1 && more > 0
    ? thumb(c).replace(/<\/span>$/, `<span class="more">+${more + 1}</span></span>`) : thumb(c)));
  return `<span class="strip" aria-hidden="true">${cells.join('')}</span>`;
};
const mineHtml = (t, picks) => `<span class="mine">${t.contestants.filter((c) => picks.includes(c.id))
  .map((c) => `<span class="p"><span class="tick" aria-hidden="true">${icon('check')}</span>${c.photo ? thumb(c) : ''}<span class="num"><span class="sr">หมายเลข </span>${esc(c.number)}</span><span class="nm">${esc(c.name)}</span></span>`).join('')}</span>`;

// Shown before the first topic opens and between topics.
// while the big screen introduces contestants, point at the cheer button instead of "just wait"
const waitText = (rest) => (S.pub.cheer.open && (S.pub.cheer.emoji || S.pub.cheer.text)
  ? 'กดปุ่ม "เชียร์ขึ้นจอ" ด้านล่าง ส่ง emoji หรือข้อความให้กำลังใจขึ้นจอใหญ่ได้เลย · ' + rest
  : 'ช่วงแนะนำผู้เข้าประกวดจะมีปุ่มเชียร์ขึ้นมาให้กด · ' + rest);
const waitingHtml = (title, text) => `<div class="waiting" role="status"><h2>${title}</h2><p>${text}</p>
  <span class="live">หน้านี้อัปเดตเอง ไม่ต้องโหลดใหม่</span></div>`;

function tallyHtml() {
  const open = S.pub.topics.filter((t) => t.status === 'open');
  if (!open.length) return '';
  const done = open.filter((t) => savedPicks(t).length).length;
  const todo = openTodo();
  const segs = open.map((t) => `<span class="${savedPicks(t).length ? 'on' : ''}"></span>`).join('');
  return `<section class="tally" aria-label="ความคืบหน้า">
    <div class="row1"><b>โหวตแล้ว ${done} จาก ${open.length} หัวข้อ</b><span>${todo.length ? `เหลืออีก ${todo.length}` : 'ครบแล้ว'}</span></div>
    <div class="segs" aria-hidden="true">${segs}</div>
    ${todo.length ? `<button class="btn btn-primary next-btn" data-go="${todo[0].id}"><span>โหวตหัวข้อถัดไป: ${esc(todo[0].title)}</span>${icon('chevronRight')}</button>`
      : '<p class="done">เปลี่ยนใจได้จนกว่าหัวข้อจะปิด · รอลุ้นประกาศผลบนจอใหญ่</p>'}</section>`;
}

function cardHtml(t) {
  const picks = savedPicks(t);
  const kind = t.status !== 'open' ? 'closed' : picks.length ? 'voted' : 'todo';
  const state = kind === 'closed' ? '<span>ปิดรับโหวตแล้ว</span>' : isFresh(t) ? '<span class="new-chip">เพิ่งเปิด</span>' : '<span class="live">เปิดโหวตอยู่</span>';
  const body = picks.length ? mineHtml(t, picks) : stripHtml(t);
  const foot = kind === 'closed' && !picks.length ? 'คุณไม่ได้โหวตหัวข้อนี้' : `${ruleText(t)} · ${t.contestants.length} คนเข้าประกวด`;
  const go = kind === 'todo' ? `<span class="go">โหวต${icon('chevronRight')}</span>` : kind === 'voted' ? `<span class="go">เปลี่ยนใจ${icon('chevronRight')}</span>` : icon('chevronRight');
  return `<li><button class="t-card ${kind}" data-id="${t.id}">
    <span class="t-top"><span>${topicNo(t)}</span>${state}</span>
    <span class="t-title">${esc(t.title)}</span>${body}
    <span class="t-foot"><span>${foot}</span>${go}</span></button></li>`;
}

function renderList() {
  const topics = S.pub.topics;
  const me = meHtml()
    + (S.pub.event.accessMode === 'open' ? `<div class="banner banner-info" style="margin-bottom:var(--sp-4)">${icon('alert')}<span>รอบนี้โหวตได้โดยไม่ต้องยืนยันตัวตน จึงกันการโหวตซ้ำไม่ได้ ผลโหวตใช้เพื่อความสนุกเท่านั้น</span></div>` : '');
  if (!topics.length) {
    $('#app').innerHTML = me + waitingHtml(S.pub.cheer.open ? 'กำลังแนะนำผู้เข้าประกวด' : 'รอเริ่มกิจกรรม', waitText('เมื่อผู้จัดเปิดโหวต รายชื่อและรูปผู้เข้าประกวดจะขึ้นตรงนี้ทันที'));
  } else {
    const todo = openTodo();
    const voted = topics.filter((t) => t.status === 'open' && savedPicks(t).length);
    const closed = topics.filter((t) => t.status === 'closed');
    const section = (title, list) => (list.length ? `<h2 class="section-title">${title} (${list.length})</h2><ul class="t-list">${list.map(cardHtml).join('')}</ul>` : '');
    $('#app').innerHTML = me + tallyHtml()
      + (todo.length || voted.length ? '' : waitingHtml(S.pub.cheer.open ? 'กำลังแนะนำผู้เข้าประกวด' : 'รอหัวข้อถัดไป', waitText('ตอนนี้ไม่มีหัวข้อที่เปิดโหวต เมื่อผู้จัดเปิดหัวข้อใหม่จะขึ้นตรงนี้ทันที')))
      + section('รอคุณโหวต', todo) + section('โหวตแล้ว', voted) + section('ปิดรับโหวตแล้ว', closed);
  }
  $('#app').querySelectorAll('.t-card[data-id]').forEach((b) => b.addEventListener('click', () => go({ name: 'topic', id: b.dataset.id })));
  $('#app').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go({ name: 'topic', id: b.dataset.go })));
  const sw = $('#switch');
  if (sw) sw.addEventListener('click', () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(NICK_KEY); S.token = null; S.me = null; S.drafts = {}; S.joinError = ''; go({ name: 'join' }, false); });
  bindMe();
}

// After saving: the chosen numbers, large, with the name small underneath. No photo needed here.
const pickedBig = (t, picks) => `<p class="picked-big"><span class="lbl">คุณเลือกหมายเลข</span>${t.contestants.filter((c) => picks.includes(c.id))
  .map((c) => `<span class="pk"><b>${esc(c.number)}</b><span>${esc(c.name)}</span></span>`).join('')}</p>`;

// Full-size photo: the grid crops to 4:5, but a costume is judged as a whole.
function showPhoto(c, from) {
  const dlg = document.createElement('dialog');
  dlg.className = 'viewer';
  dlg.innerHTML = `<div class="viewer-in"><img src="${esc(c.photo)}" alt="หมายเลข ${esc(c.number)} ${esc(c.name)}">
    <p><b>หมายเลข ${esc(c.number)}</b> ${esc(c.name)}</p><button class="btn" data-close>${icon('x')}ปิดรูป</button></div>`;
  document.body.append(dlg);
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => { dlg.remove(); from?.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) close(); });
  dlg.showModal();
}

function renderTopic(t) {
  const open = t.status === 'open';
  const saved = savedPicks(t);
  const draft = draftPicks(t);
  const single = t.maxVotes === 1;
  const withPhotos = t.contestants.some((c) => c.photo);
  const rule = single ? 'เลือกได้ 1 คน' : `เลือกได้สูงสุด ${t.maxVotes} คน`;
  let msg = S.topicMsg;
  if (!open) msg = { kind: 'info', text: saved.length ? 'หัวข้อนี้ปิดโหวตแล้ว ด้านล่างคือที่คุณเลือกไว้' : 'หัวข้อนี้ปิดโหวตแล้ว คุณไม่ได้โหวตหัวข้อนี้' };
  let msgHtml = msg ? `<div class="banner banner-${msg.kind}" style="margin-bottom:var(--sp-4)">${icon(msg.kind === 'success' ? 'check' : msg.kind === 'info' ? 'lock' : 'alert')}<span>${esc(msg.text)}</span></div>` : '';
  if (msg && msg.kind === 'success' && msg.saved) {
    const next = openTodo().find((x) => x.id !== t.id);
    msgHtml = `<div class="saved" role="status"><span class="big">${icon('check')}</span><h2>${esc(msg.text)}</h2>${pickedBig(t, saved)}
      ${next ? `<button class="btn btn-primary" data-go="${next.id}"><span>โหวตหัวข้อถัดไป: ${esc(next.title)}</span>${icon('chevronRight')}</button>`
        : `<p>ครบทุกหัวข้อที่เปิดแล้ว · รอลุ้นประกาศผลบนจอใหญ่</p><button class="btn" data-go="">${icon('chevronLeft')}<span>กลับไปหน้ารวม</span></button>`}</div>`;
  }
  $('#app').innerHTML = `
    <div class="topic-head"><p class="kicker"><span>${topicNo(t)}</span>${open ? '<span class="live">เปิดโหวตอยู่</span>' : '<span>ปิดรับโหวตแล้ว</span>'}</p><h2>${esc(t.title)}</h2>
      <p class="muted">${rule} · ${withPhotos ? 'แตะรูปเพื่อเลือก ปุ่มมุมรูปใช้ดูรูปใหญ่' : 'แตะชื่อเพื่อเลือก'}</p></div>
    ${msgHtml}
    <ul class="choices${withPhotos ? ' grid' : ''}" role="group" aria-label="${esc(t.title)}">
      ${t.contestants.map((c) => (withPhotos ? `<li><button class="choice" data-id="${c.id}" aria-pressed="${draft.includes(c.id)}" ${open ? '' : 'disabled'}>
        <span class="pic">${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy">` : `<span class="none">ไม่มีรูป</span>`}
          <span class="bno"><span class="sr">หมายเลข </span>${esc(c.number)}</span></span>
        <span class="cap"><span class="name">${esc(c.name)}</span><span class="mark">${icon('check')}</span></span></button>
        ${c.photo ? `<button class="zoom" data-zoom="${c.id}" aria-label="ดูรูปใหญ่ หมายเลข ${esc(c.number)} ${esc(c.name)}">${icon('expand')}</button>` : ''}</li>`
      : `<li><button class="choice" data-id="${c.id}" aria-pressed="${draft.includes(c.id)}" ${open ? '' : 'disabled'}>
        <span class="bno"><span class="sr">หมายเลข </span>${esc(c.number)}</span>
        <span class="grow"><span class="name">${esc(c.name)}</span></span>
        <span class="mark">${icon('check')}</span></button></li>`)).join('')}
    </ul>`;

  $('#app').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go ? { name: 'topic', id: b.dataset.go } : { name: 'list' })));
  $('#app').querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const c = t.contestants.find((x) => x.id === b.dataset.zoom);
    if (c) showPhoto(c, b);
  }));
  $('#app').querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    let next = draftPicks(t);
    if (next.includes(id)) next = next.filter((x) => x !== id);
    else if (single) next = [id];
    else if (next.length >= t.maxVotes) {
      S.topicMsg = { kind: 'warning', text: `เลือกครบ ${t.maxVotes} คนแล้ว แตะคนที่เลือกไว้เพื่อเอาออกก่อน` };
      return renderTopic(t);
    } else next = [...next, id];
    S.drafts[t.id] = next; S.topicMsg = null;
    renderTopic(t);
  }));

  if (!open) return;
  const changedSel = !same(draft, saved);
  let label = saved.length ? 'บันทึกการเปลี่ยนแปลง' : 'ส่งโหวต';
  if (changedSel && draft.length === 0) label = 'ถอนโหวตหัวข้อนี้';
  const status = !changedSel
    ? (saved.length ? 'โหวตแล้ว เปลี่ยนใจได้จนกว่าหัวข้อจะปิด' : `ยังไม่ได้เลือก · ${rule}`)
    : `เลือกแล้ว ${draft.length}${single ? '' : `/${t.maxVotes}`} คน · ยังไม่ได้บันทึก`;
  const bar = $('#bar');
  bar.hidden = false;
  bar.innerHTML = `<div class="wrap"><p class="status">${status}</p>
    <button class="btn btn-primary btn-block" id="save" ${changedSel ? '' : 'disabled'}>${label}</button></div>`;
  $('#save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const r = await api('POST', '/api/vote', { topicId: t.id, picks: draft }, { 'X-Voter-Token': S.token });
      S.me.picks[t.id] = r.picks; delete S.drafts[t.id];
      S.topicMsg = r.picks.length ? { kind: 'success', saved: true, text: 'บันทึกโหวตแล้ว' } : { kind: 'success', text: 'ถอนโหวตหัวข้อนี้แล้ว' };
    } catch (err) {
      if (err.status === 401) { S.token = null; localStorage.removeItem(TOKEN_KEY); return ensureSession(); }
      S.topicMsg = { kind: 'error', text: err.message + ' — ที่เลือกไว้ยังอยู่ กดบันทึกอีกครั้งได้' };
    }
    const cur = topicById(t.id);
    if (cur && S.view.name === 'topic') { renderTopic(cur); if (S.topicMsg?.saved) window.scrollTo(0, 0); }
  }));
}

/* ---------- cheers: emoji and short text that float over the big screen (not kept) ---------- */

const cheerOn = () => S.pub && S.token && S.view.name !== 'join' && S.pub.cheer.open && (S.pub.cheer.emoji || S.pub.cheer.text);
function renderCheerFab() {
  const fab = $('#cheer-fab');
  fab.hidden = !cheerOn();
  fab.innerHTML = icon('megaphone') + '<span>เชียร์ขึ้นจอ</span>';
  const dlg = $('#cheer');
  if (dlg.open) { if (!cheerOn()) dlg.close(); else syncCheerSheet(); }
}
$('#cheer-fab').addEventListener('click', openCheer);

function openCheer() {
  const c = S.pub.cheer;
  const dlg = $('#cheer');
  dlg.innerHTML = `<div class="cs-in">
    <div class="cs-head"><h2 id="cheer-h">เชียร์ขึ้นจอใหญ่</h2>
      <button class="btn btn-ghost btn-sm" id="cs-close" aria-label="ปิด">${icon('x')}</button></div>
    <div class="cs-emoji" id="cs-emoji">${c.set.map((e) => `<button class="cs-e" data-e="${esc(e)}" aria-label="ส่ง ${esc(e)} ขึ้นจอ">${esc(e)}</button>`).join('')}</div>
    <p class="cs-off small muted" id="cs-emoji-off" hidden>แอดมินปิดการส่ง emoji อยู่</p>
    <form class="cs-text" id="cs-form" novalidate>
      <label for="cs-input">ข้อความขึ้นจอ</label>
      <div class="cs-row"><input id="cs-input" class="input" maxlength="60" autocomplete="off" enterkeyhint="send" placeholder="เช่น สู้ ๆ เบอร์ 3">
        <button class="btn btn-primary" id="cs-send">${icon('send')}ส่ง</button></div>
      <p class="hint"><span id="cs-count">0</span>/60 · ขึ้นจอทันทีโดยไม่แสดงชื่อ แอดมินลบได้</p>
    </form>
    <p class="cs-off small muted" id="cs-text-off" hidden>แอดมินปิดการส่งข้อความอยู่</p>
    <div class="banner banner-error" id="cs-err" role="alert" hidden></div>
    <p class="cs-ok small" id="cs-ok" role="status"></p>
  </div>`;
  $('#cs-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.querySelectorAll('.cs-e').forEach((b) => b.addEventListener('click', () => sendEmoji(b)));
  const inp = $('#cs-input');
  inp.addEventListener('input', () => { $('#cs-count').textContent = [...inp.value].length; });
  $('#cs-form').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
  syncCheerSheet();
  dlg.showModal();
}
function syncCheerSheet() {
  const c = S.pub.cheer;
  $('#cs-emoji').hidden = !c.emoji; $('#cs-emoji-off').hidden = c.emoji;
  $('#cs-form').hidden = !c.text; $('#cs-text-off').hidden = c.text;
}
function cheerError(msg) {
  const box = $('#cs-err');
  if (!msg) { box.hidden = true; return; }
  box.innerHTML = `${icon('alert')}<span>${esc(msg)}</span>`; box.hidden = false;
}
async function postCheer(body) {
  try { await api('POST', '/api/cheer', body, { 'X-Voter-Token': S.token }); cheerError(''); return true; }
  catch (e) {
    if (e.status === 401) { $('#cheer').close(); S.token = null; localStorage.removeItem(TOKEN_KEY); ensureSession(); return false; }
    cheerError(e.message); return false;
  }
}
async function sendEmoji(b) {
  // a little burst on the phone right away, so tapping feels alive even before the screen shows it
  const p = document.createElement('span');
  p.className = 'cs-pop'; p.textContent = b.dataset.e;
  p.addEventListener('animationend', () => p.remove());
  b.append(p);
  await postCheer({ emoji: b.dataset.e });
}
async function sendText() {
  const inp = $('#cs-input');
  const v = inp.value.trim();
  if (!v) { cheerError('พิมพ์ข้อความก่อน'); inp.focus(); return; }
  await busy($('#cs-send'), async () => {
    if (await postCheer({ text: v })) {
      inp.value = ''; $('#cs-count').textContent = '0';
      const ok = $('#cs-ok'); ok.textContent = 'ส่งขึ้นจอแล้ว'; setTimeout(() => { ok.textContent = ''; }, 2500);
    }
  });
}

/* ---------- open from a picture of the card ---------- */
// Reads the QR on this phone (BarcodeDetector where the browser has one, else jsQR loaded on demand).
// Accepts the card link (?c=CODE&s=SIG, any host: the card may carry the LAN or the public address) or a bare code.

let jsqrLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return (jsqrLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsqrLoading = null; reject(new Error('โหลดตัวอ่าน QR ไม่ได้ ตรวจสัญญาณแล้วลองใหม่ หรือพิมพ์รหัสบนบัตรแทน')); };
    document.head.append(s);
  }));
}

async function decodeQr(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('เปิดรูปนี้ไม่ได้ ลองเลือกรูปอื่น');
  if ('BarcodeDetector' in window) {
    try {
      const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQR();
  // a few sizes: big photos are slow at full size, small QR codes vanish when shrunk too far
  for (const max of [1200, 2000, 800]) {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;
  }
  throw new Error('ไม่พบ QR ในรูปนี้ ลองรูปที่เห็น QR ชัด ๆ เต็มกรอบ หรือพิมพ์รหัสบนบัตรแทน');
}

async function readCardPicture(file) {
  const text = (await decodeQr(file)).trim();
  let code = null, sig;
  try {
    const u = new URL(text);
    code = u.searchParams.get('c'); sig = u.searchParams.get('s') || undefined;
  } catch { if (/^[A-Za-z0-9-]{6,14}$/.test(text)) code = text; }
  if (!code) throw new Error('QR ในรูปนี้ไม่ใช่บัตรของงานนี้ ใช้รูปบัตรโหวตที่ได้รับ');
  return { code, sig };
}

/* ---------- who am I (top of the list) ----------
 * Code mode: the code is hidden by default (people look over shoulders at a party) and an eye button shows it.
 * Anyone can set a name for themselves; it stays on this phone only (never sent, never on the big screen). */
const NICK_KEY = 'cv_nick';
const SHOWCODE_KEY = 'cv_showcode';
const fmtCode = (c) => (/^[A-Z0-9]{8}$/.test(c) ? c.slice(0, 4) + '-' + c.slice(4) : c);
let editingNick = false;
let meTyping = false;

function meHtml() {
  if (!S.me) return '';
  const mode = S.pub.event.accessMode;
  if (mode === 'name') {
    return `<div class="me"><span>โหวตในชื่อ <b>${esc(S.me.label)}</b></span>
      <button class="btn btn-ghost btn-sm" id="switch">ไม่ใช่คุณ?</button></div>`;
  }
  const nick = localStorage.getItem(NICK_KEY) || '';
  const show = localStorage.getItem(SHOWCODE_KEY) === '1';
  const name = S.me.fixedName
    ? `<p class="me-name fixed">สวัสดี <b>${esc(S.me.fixedName)}</b></p>` // set by the admin (email list): not editable
    : editingNick
    ? `<form class="me-edit" id="nick-form"><label class="visually-hidden" for="nick">ชื่อของคุณ</label>
        <input id="nick" class="input" value="${esc($('#nick')?.value ?? nick)}" placeholder="ชื่อที่อยากให้เรียก" autocomplete="nickname" enterkeyhint="done">
        <button class="btn btn-primary btn-sm">บันทึก</button></form>`
    : `<button class="me-name" id="nick-edit">${nick ? `สวัสดี <b>${esc(nick)}</b>` : 'ตั้งชื่อของคุณ'}${icon('pencil')}</button>`;
  const code = mode === 'code' && S.me.label
    ? `<span class="me-code"><span class="small muted">รหัส</span> <span class="mono" id="me-code">${show ? esc(fmtCode(S.me.label)) : '••••-••••'}</span>
        <button class="btn btn-ghost btn-sm me-eye" id="me-eye" aria-pressed="${show}" aria-label="${show ? 'ซ่อนรหัส' : 'แสดงรหัส'}">${icon(show ? 'eyeOff' : 'eye')}</button></span>`
    : '';
  // open mode has no identity to switch away from (a new one would just be another vote)
  const sw = mode === 'code' ? '<button class="btn btn-ghost btn-sm" id="switch">ไม่ใช่คุณ?</button>' : '';
  return `<div class="me me-card">${name}${code || sw ? `<div class="me-row">${code}${sw}</div>` : ''}</div>`;
}

function bindMe() {
  // a live update re-renders the list: keep typing where it was
  if (editingNick && meTyping) { const i = $('#nick'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  $('#nick')?.addEventListener('focus', () => { meTyping = true; });
  $('#nick')?.addEventListener('blur', () => { setTimeout(() => { meTyping = !!document.activeElement && document.activeElement.id === 'nick'; }, 0); });
  const eye = $('#me-eye');
  if (eye) eye.addEventListener('click', () => {
    localStorage.setItem(SHOWCODE_KEY, localStorage.getItem(SHOWCODE_KEY) === '1' ? '0' : '1');
    render(); $('#me-eye')?.focus();
  });
  const ed = $('#nick-edit');
  if (ed) ed.addEventListener('click', () => { editingNick = true; render(); const i = $('#nick'); i.focus(); i.select(); });
  const f = $('#nick-form');
  if (f) f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#nick').value.trim();
    if (v) localStorage.setItem(NICK_KEY, v); else localStorage.removeItem(NICK_KEY);
    editingNick = false; render(); $('#nick-edit')?.focus();
  });
}
