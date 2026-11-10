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
liveStream('/api/stream', async (data) => {
  const first = !S.pub;
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
  const err = S.joinError ? `<p class="field-error" id="join-err">${icon('alert')}<span>${esc(S.joinError)}</span></p>` : '';
  const field = mode === 'code'
    ? `<div class="field"><label for="j-in">รหัสโหวต</label>
        <input id="j-in" class="input code-input" inputmode="text" autocapitalize="characters" autocomplete="off" maxlength="12" value="${esc(urlCode || '')}" ${S.joinError ? 'aria-invalid="true" aria-describedby="join-err"' : ''}>
        <p class="hint">ดูรหัสบนบัตรที่ได้รับ หรือสแกน QR บนบัตรเพื่อเข้าได้เลย</p>${err}</div>`
    : `<div class="field"><label for="j-in">ชื่อ-นามสกุล หรือรหัสพนักงาน</label>
        <input id="j-in" class="input" autocomplete="name" maxlength="80" ${S.joinError ? 'aria-invalid="true" aria-describedby="join-err"' : ''}>
        <p class="hint">พิมพ์ตามรายชื่อพนักงานของงานนี้ ถ้าเปลี่ยนเครื่องให้ใช้ชื่อหรือรหัสเดิม จะเห็นโหวตเดิมของคุณ</p>${err}</div>`;
  $('#app').innerHTML = `
    <form class="card join" id="join-form" novalidate>
      <h2>${mode === 'code' ? 'กรอกรหัสโหวตเพื่อเริ่ม' : 'บอกเราว่าคุณคือใคร'}</h2>
      ${field}
      <button class="btn btn-primary btn-block" type="submit">เข้าโหวต</button>
    </form>`;
  const input = $('#j-in');
  if (!urlCode) input.focus();
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

function renderList() {
  const topics = S.pub.topics;
  const me = (S.me?.label ? `<div class="me"><span>โหวตในชื่อ <b>${esc(S.me.label)}</b></span>
     <button class="btn btn-ghost btn-sm" id="switch">ไม่ใช่คุณ?</button></div>` : '')
    + (S.pub.event.accessMode === 'open' ? `<div class="banner banner-info" style="margin-bottom:var(--sp-4)">${icon('alert')}<span>รอบนี้โหวตได้โดยไม่ต้องยืนยันตัวตน จึงกันการโหวตซ้ำไม่ได้ ผลโหวตใช้เพื่อความสนุกเท่านั้น</span></div>` : '');
  if (!topics.length) {
    $('#app').innerHTML = me + `<div class="center-state card">
      ${icon('trophy')}<h2 style="font-size:var(--fs-20)">ยังไม่เปิดโหวต</h2>
      <p class="muted">รอผู้จัดเปิดหัวข้อสักครู่ หน้านี้จะอัปเดตเองโดยไม่ต้องโหลดใหม่</p></div>`;
  } else {
    const item = (t) => {
      const picks = savedPicks(t);
      const mine = picks.length
        ? `<span class="badge badge-done">${icon('check')}โหวตแล้ว${t.maxVotes > 1 ? ` ${picks.length}/${t.maxVotes}` : ''}</span>`
        : (t.status === 'open' ? '<span>ยังไม่ได้โหวต</span>' : '<span>ไม่ได้โหวต</span>');
      return `<li><button class="topic-item" data-id="${t.id}">
        <span class="grow"><span class="title">${esc(t.title)}</span>
          <span class="meta">${statusBadge(t)}${mine}</span></span>${icon('chevronRight')}</button></li>`;
    };
    const open = topics.filter((t) => t.status === 'open');
    const closed = topics.filter((t) => t.status === 'closed');
    $('#app').innerHTML = me
      + (open.length ? `<h2 class="section-title">เปิดโหวตอยู่ (${open.length})</h2><ul class="topic-list">${open.map(item).join('')}</ul>`
        : `<div class="banner banner-info">${icon('lock')}<span>ตอนนี้ไม่มีหัวข้อที่เปิดโหวต รอผู้จัดเปิดหัวข้อถัดไป</span></div>`)
      + (closed.length ? `<h2 class="section-title">ปิดโหวตแล้ว</h2><ul class="topic-list">${closed.map(item).join('')}</ul>` : '');
  }
  $('#app').querySelectorAll('.topic-item').forEach((b) => b.addEventListener('click', () => go({ name: 'topic', id: b.dataset.id })));
  const sw = $('#switch');
  if (sw) sw.addEventListener('click', () => { localStorage.removeItem(TOKEN_KEY); S.token = null; S.me = null; S.drafts = {}; S.joinError = ''; go({ name: 'join' }, false); });
}

function renderTopic(t) {
  const open = t.status === 'open';
  const saved = savedPicks(t);
  const draft = draftPicks(t);
  const single = t.maxVotes === 1;
  const rule = single ? 'เลือกได้ 1 คน' : `เลือกได้สูงสุด ${t.maxVotes} คน`;
  let msg = S.topicMsg;
  if (!open) msg = { kind: 'info', text: saved.length ? 'หัวข้อนี้ปิดโหวตแล้ว ด้านล่างคือที่คุณเลือกไว้' : 'หัวข้อนี้ปิดโหวตแล้ว คุณไม่ได้โหวตหัวข้อนี้' };
  const msgHtml = msg ? `<div class="banner banner-${msg.kind}" style="margin-bottom:var(--sp-4)">${icon(msg.kind === 'success' ? 'check' : msg.kind === 'info' ? 'lock' : 'alert')}<span>${esc(msg.text)}</span></div>` : '';

  $('#app').innerHTML = `
    <div class="topic-head"><h2>${esc(t.title)}</h2>
      <p class="meta muted">${statusBadge(t)} · ${rule}</p></div>
    ${msgHtml}
    <ul class="choices" role="group" aria-label="${esc(t.title)}">
      ${t.contestants.map((c) => `<li><button class="choice" data-id="${c.id}" aria-pressed="${draft.includes(c.id)}" ${open ? '' : 'disabled'}>
        ${photoHtml(c, 72)}
        <span class="grow"><span class="num">หมายเลข ${esc(c.number)}</span><br><span class="name">${esc(c.name)}</span></span>
        <span class="tick ${single ? '' : 'square'}">${icon('check')}</span></button></li>`).join('')}
    </ul>`;

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
      S.topicMsg = { kind: 'success', text: r.picks.length ? 'บันทึกโหวตแล้ว เปลี่ยนใจได้จนกว่าหัวข้อจะปิด' : 'ถอนโหวตหัวข้อนี้แล้ว' };
    } catch (err) {
      if (err.status === 401) { S.token = null; localStorage.removeItem(TOKEN_KEY); return ensureSession(); }
      S.topicMsg = { kind: 'error', text: err.message + ' — ที่เลือกไว้ยังอยู่ กดบันทึกอีกครั้งได้' };
    }
    const cur = topicById(t.id);
    if (cur && S.view.name === 'topic') renderTopic(cur);
  }));
}
