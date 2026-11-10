'use strict';
// Admin: login → tabs (หัวข้อ / จอใหญ่ / ผลโหวต / ตั้งค่างาน). Live state over SSE.
// Lists re-render on each update; while an input inside <main> has focus the re-render waits until blur.

const A = {
  st: null,
  tab: new URLSearchParams(location.hash.slice(1)).get('tab') || 'topics',
  openTopics: new Set(JSON.parse(sessionStorage.getItem('openTopics') || '[]')),
  errors: {},     // area -> message (inline banners)
  pending: false,
  online: true,
  stopStream: null,
};
const TABS = [
  ['topics', 'หัวข้อประกวด', 'trophy'],
  ['screen', 'จอใหญ่', 'monitor'],
  ['results', 'ผลโหวต', 'chart'],
  ['settings', 'ตั้งค่างาน', 'users'],
];
const MODE_TEXT = {
  code: ['รหัสโหวต (แนะนำ)', 'ระบบสร้างรหัสตามจำนวนคน พิมพ์แจกคนละใบ บนบัตรมี QR ที่สแกนแล้วเข้าได้เลย หนึ่งบัตรเท่ากับหนึ่งเสียง กันโหวตซ้ำได้ดีที่สุด'],
  name: ['กรอกชื่อหรือรหัสพนักงาน', 'ต้องใส่รายชื่อพนักงานก่อน ชื่อที่ไม่อยู่ในรายชื่อโหวตไม่ได้ แต่ยังสวมชื่อกันได้: ใครรู้ชื่อหรือรหัสพนักงานของคนอื่นก็พิมพ์เข้าไปโหวตแทน หรือเปลี่ยนโหวตของเขาได้โดยเจ้าตัวไม่รู้'],
  open: ['ไม่ต้องกรอกอะไร (งานเล่น ๆ เท่านั้น)', 'สแกนแล้วโหวตได้เลย แต่กันโหวตซ้ำไม่ได้ คนที่เปิดหลายเบราว์เซอร์หรือใช้สคริปต์โหวตกี่ครั้งก็ได้ ห้ามใช้กับการประกวดที่มีรางวัลหรือต้องการผลที่เชื่อถือได้'],
};
const OPEN_WARNING = 'ตอนนี้ใช้แบบ “ไม่ต้องกรอกอะไร” ซึ่งกันโหวตซ้ำไม่ได้ ผลโหวตจึงเชื่อถือไม่ได้ ใช้กับงานเล่น ๆ เท่านั้น ถ้ามีรางวัลให้เปลี่ยนเป็นแบบรหัสโหวต';
const NAME_WARNING = 'แบบกรอกชื่อกันได้แค่ชื่อที่ไม่อยู่ในรายชื่อ ใครรู้ชื่อหรือรหัสพนักงานของคนอื่นก็พิมพ์เข้าไปโหวตแทน หรือเปลี่ยนโหวตของเขาได้โดยเจ้าตัวไม่รู้ ถ้าต้องการกันการสวมสิทธิ์ให้ใช้แบบรหัสโหวต';

/** plain-http admin from another device: password and cookie travel unencrypted over the Wi-Fi */
function insecureBanner() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'http:' || local) return '';
  return `<div class="banner banner-warning" role="alert">${icon('alert')}<span>หน้านี้เชื่อมต่อแบบไม่เข้ารหัส (http) ใครอยู่ Wi-Fi วงเดียวกันดักรหัสผ่านและสิทธิ์แอดมินได้ ก่อนใช้งานจริงให้รันเซิร์ฟเวอร์พร้อม HTTPS_PORT แล้วเข้าหน้าแอดมินทาง https (ดูวิธีใน README)</span></div>`;
}
const STATUS = {
  draft: '<span class="badge badge-draft">ยังไม่เปิด</span>',
  open: '<span class="badge badge-open">เปิดโหวต</span>',
  closed: () => `<span class="badge badge-closed">${icon('lock')}ปิดโหวตแล้ว</span>`,
};
const statusBadge = (s) => (typeof STATUS[s] === 'function' ? STATUS[s]() : STATUS[s]);

/* ---------- boot ---------- */

boot();
async function boot() {
  try {
    A.st = await api('GET', '/api/admin/state');
    startStream();
    renderShell();
  } catch (e) {
    if (e.status === 401) renderLogin();
    else {
      $('#root').innerHTML = `<div class="center-state"><div class="banner banner-error">${icon('alert')}<span>${esc(e.message)}</span></div><button class="btn" id="reload">${icon('refresh')}ลองใหม่</button></div>`;
      $('#reload').addEventListener('click', () => location.reload());
    }
  }
}

function startStream() {
  A.stopStream = liveStream('/api/admin/stream', (d) => { A.st = d; scheduleRender(); }, (ok) => {
    if (ok !== A.online) {
      A.online = ok; const el = $('#conn'); if (el) el.innerHTML = connHtml();
      // stream dropped: if it was because the session expired, go back to the login form
      if (!ok) api('GET', '/api/admin/state').catch((e) => {
        if (e.status === 401) { A.stopStream && A.stopStream(); renderLogin('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่'); }
      });
    }
  });
}
const connHtml = () => (A.online ? '<span class="badge badge-open">ออนไลน์</span>' : `<span class="badge badge-draft">${icon('wifiOff')}กำลังต่อใหม่</span>`);

function scheduleRender() {
  const ae = document.activeElement;
  const typing = ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName) && !/radio|checkbox|button|submit/.test(ae.type);
  if (typing && $('main')?.contains(ae)) { A.pending = true; return; }
  if (document.querySelector('dialog[open]')) { A.pending = true; return; }
  renderMain();
}
document.addEventListener('focusout', () => setTimeout(() => { if (A.pending) { A.pending = false; scheduleRender(); } }, 50));

/* ---------- login ---------- */

function renderLogin(err = '') {
  $('#root').innerHTML = `
    <form class="card login" id="login" novalidate>
      <h1 style="font-size:var(--fs-20)">เข้าหน้าแอดมิน</h1>
      ${insecureBanner()}
      <div class="field"><label for="pw">รหัสผ่าน</label>
        <input id="pw" type="password" class="input" autocomplete="current-password" ${err ? 'aria-invalid="true" aria-describedby="pw-err"' : ''}>
        ${err ? `<p class="field-error" id="pw-err">${icon('alert')}<span>${esc(err)}</span></p>` : ''}</div>
      <button class="btn btn-primary btn-block">เข้าสู่ระบบ</button>
    </form>`;
  $('#pw').focus();
  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('#login button'), async () => {
      try { await api('POST', '/api/admin/login', { password: $('#pw').value }); boot(); }
      catch (er) { renderLogin(er.message); }
    });
  });
}

/* ---------- shell ---------- */

function renderShell() {
  $('#root').innerHTML = `
    <header class="a-top"><div class="wrap">
      <div class="a-top-in"><h1 id="ev-title"></h1><span id="conn" class="conn-dot">${connHtml()}</span>
        <button class="btn btn-ghost btn-sm" id="logout" aria-label="ออกจากระบบ">${icon('logout')}<span class="hide-sm">ออกจากระบบ</span></button></div>
      <nav class="tabs" role="tablist">${TABS.map(([k, label, ic]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${A.tab === k}">${icon(ic)}${label}</button>`).join('')}</nav>
    </div></header>
    <main class="wrap" id="main"></main>`;
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    A.tab = b.dataset.tab; history.replaceState(null, '', '#tab=' + A.tab);
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === b));
    A.errors = {}; renderMain(); window.scrollTo(0, 0);
  }));
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); A.stopStream && A.stopStream(); renderLogin(); });
  renderMain();
}

function renderMain() {
  const main = $('#main');
  if (!main || !A.st) return;
  $('#ev-title').textContent = A.st.event.name;
  document.title = 'แอดมิน · ' + A.st.event.name;
  const y = window.scrollY;
  main.innerHTML = insecureBanner() + ({ topics: tabTopics, screen: tabScreen, results: tabResults, settings: tabSettings })[A.tab]();
  bind(main);
  window.scrollTo(0, y);
}

const errBanner = (area) => (A.errors[area] ? `<div class="banner banner-error" role="alert">${icon('alert')}<span>${esc(A.errors[area])}</span></div>` : '');

/** run an API action from a button; error goes inline to `area` */
async function act(btn, area, fn, okMsg) {
  return busy(btn, async () => {
    try {
      const r = await fn();
      delete A.errors[area];
      A.st = r && r.topics && r.event ? r : await api('GET', '/api/admin/state');
      if (okMsg) toast(okMsg);
      renderMain();
      return r;
    } catch (e) {
      if (e.status === 401) return renderLogin('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่');
      A.errors[area] = e.message; renderMain();
    }
  });
}

/* ---------- tab: topics ---------- */

function tabTopics() {
  const ts = A.st.topics;
  const list = ts.length ? ts.map((t, i) => topicCard(t, i, ts.length)).join('') : `
    <div class="card center-state">${icon('trophy')}<h2 style="font-size:var(--fs-18)">ยังไม่มีหัวข้อประกวด</h2>
      <p class="muted">สร้างหัวข้อแรกด้านบน เช่น “ชุดสวยสุด” แล้วเพิ่มผู้เข้าประกวด จากนั้นกดเปิดโหวต</p></div>`;
  return `
    <form class="card panel" data-form="new-topic" novalidate>
      <h2>สร้างหัวข้อประกวด</h2>
      ${errBanner('new-topic')}
      <div class="grid-2">
        <div class="field"><label for="nt-title">ชื่อหัวข้อ</label><input id="nt-title" name="title" class="input" maxlength="120" placeholder="เช่น ชุดสวยสุด"></div>
        <div class="field"><label for="nt-max">แต่ละคนเลือกได้ (คน)</label><input id="nt-max" name="maxVotes" class="input" type="number" min="1" max="50" value="1" inputmode="numeric"></div>
      </div>
      <div class="row end"><button class="btn btn-primary">${icon('plus')}สร้างหัวข้อ</button></div>
    </form>
    ${list}`;
}

function topicCard(t, i, n) {
  const open = A.openTopics.has(t.id);
  const act1 = t.status === 'open'
    ? `<button class="btn btn-sm" data-act="status" data-id="${t.id}" data-to="closed">${icon('lock')}ปิดโหวต</button>`
    : `<button class="btn btn-primary btn-sm" data-act="status" data-id="${t.id}" data-to="open">${t.status === 'closed' ? 'เปิดโหวตอีกครั้ง' : 'เปิดโหวต'}</button>`;
  return `<section class="card topic-card">
    <div class="head">
      <div class="t"><b>${esc(t.title)}</b>
        <span class="meta">${statusBadge(t.status)}<span>เลือกได้ ${t.maxVotes} คน</span>·<span>ผู้เข้าประกวด ${t.contestants.length}</span>·<span>โหวตแล้ว ${t.voters} คน</span></span></div>
      <div class="row">
        ${act1}
        <button class="btn btn-sm" data-act="toggle" data-id="${t.id}" aria-expanded="${open}">${icon(open ? 'chevronUp' : 'chevronDown')}${open ? 'ซ่อนรายละเอียด' : 'ผู้เข้าประกวด'}</button>
      </div>
    </div>
    ${A.errors['t-' + t.id] ? `<div style="padding:0 var(--sp-4) var(--sp-4)">${errBanner('t-' + t.id)}</div>` : ''}
    ${open ? `<div class="body">
      ${t.contestants.length ? `<ul class="c-list">${t.contestants.map((c) => `<li class="c-row">
        ${photoHtml(c, 48)}<span class="nm"><span class="no">${esc(c.number)}</span>${esc(c.name)}</span>
        <button class="btn btn-ghost btn-sm icon-btn" data-act="edit-c" data-id="${t.id}" data-cid="${c.id}" aria-label="แก้ไข ${esc(c.name)}">${icon('pencil')}</button>
        <button class="btn btn-ghost btn-sm icon-btn" data-act="del-c" data-id="${t.id}" data-cid="${c.id}" aria-label="ลบ ${esc(c.name)}">${icon('trash')}</button>
      </li>`).join('')}</ul>` : '<p class="muted small">ยังไม่มีผู้เข้าประกวด เพิ่มอย่างน้อย 1 คนก่อนเปิดโหวต</p>'}
      <div class="row">
        <button class="btn btn-primary btn-sm" data-act="add-c" data-id="${t.id}">${icon('plus')}เพิ่มผู้เข้าประกวด</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm icon-btn" data-act="move" data-dir="up" data-id="${t.id}" ${i === 0 ? 'disabled' : ''} aria-label="เลื่อนหัวข้อขึ้น">${icon('chevronUp')}</button>
        <button class="btn btn-ghost btn-sm icon-btn" data-act="move" data-dir="down" data-id="${t.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="เลื่อนหัวข้อลง">${icon('chevronDown')}</button>
        <button class="btn btn-sm" data-act="edit-t" data-id="${t.id}">${icon('pencil')}แก้ไขหัวข้อ</button>
        <button class="btn btn-danger btn-sm" data-act="del-t" data-id="${t.id}">${icon('trash')}ลบหัวข้อ</button>
      </div></div>` : ''}
  </section>`;
}

/* ---------- tab: screen ---------- */

function tabScreen() {
  const s = A.st.screen;
  const t = A.st.topics.find((x) => x.id === s.topicId);
  const opts = [{ id: '', title: 'หน้ารวม: QR + ชื่องาน', status: null }, ...A.st.topics];
  let ctl = '';
  if (t) {
    const canReveal = t.status === 'closed';
    ctl = `<div class="card panel">
      <h2>${esc(t.title)}</h2>
      <p class="meta muted small">${statusBadge(t.status)} · โหวตแล้ว ${t.voters} คน</p>
      ${errBanner('screen')}
      <div class="seg" role="group" aria-label="สิ่งที่จอแสดง">
        <button class="btn" data-act="mode" data-mode="hidden" aria-pressed="${s.mode === 'hidden'}">${icon('eyeOff')}ซ่อนคะแนน</button>
        <button class="btn" data-act="mode" data-mode="live" aria-pressed="${s.mode === 'live'}">${icon('chart')}โชว์คะแนนสด</button>
        <button class="btn" data-act="mode" data-mode="reveal" aria-pressed="${s.mode === 'reveal'}" ${canReveal ? '' : 'disabled'}>${icon('trophy')}ประกาศผล</button>
      </div>
      ${!canReveal ? `<div class="row"><p class="hint">ประกาศผลได้หลังปิดโหวต</p>${t.status === 'open' ? `<button class="btn btn-sm" data-act="status" data-id="${t.id}" data-to="closed">${icon('lock')}ปิดโหวตหัวข้อนี้</button>` : ''}</div>` : ''}
      ${s.mode === 'reveal' ? revealControls(t, s) : ''}
    </div>`;
  }
  return `
    <div class="card panel">
      <div class="row"><h2 class="spacer">ให้จอใหญ่แสดง</h2>
        <a class="btn btn-sm" href="/screen" target="_blank" rel="noopener">${icon('monitor')}เปิดหน้าจอใหญ่</a></div>
      <p class="hint">เปิดลิงก์ “เปิดหน้าจอใหญ่” บนเครื่องที่ต่อโปรเจกเตอร์ แล้วกด F ให้เต็มจอ ควบคุมจากหน้านี้ได้เลย (ใช้มือถือก็ได้)</p>
      <div class="radio-list">${opts.map((o) => `<label class="radio-opt"><input type="radio" name="screen-topic" value="${o.id}" ${(s.topicId || '') === o.id ? 'checked' : ''}>
        <span><b>${esc(o.title)}</b>${o.status ? `<span class="small muted">${statusBadge(o.status)}</span>` : ''}</span></label>`).join('')}</div>
    </div>
    ${ctl}`;
}

function revealControls(t, s) {
  const step = s.revealStep;
  const labels = ['เปิดอันดับ 3', 'เปิดอันดับ 2', 'เปิดอันดับ 1'];
  const top = t.results.filter((r) => r.votes > 0);
  const levels = [...new Set(top.map((r) => r.votes))].slice(0, 3);
  const preview = levels.map((v, i) => `<li><b>อันดับ ${i + 1}</b> · ${top.filter((r) => r.votes === v).map((r) => esc(r.number + ' ' + r.name)).join(', ')} (${v} คะแนน)</li>`).join('');
  return `<div class="banner banner-info">${icon('trophy')}<span>${step === 0 ? 'จอขึ้น “ผลโหวตกำลังจะประกาศ…” กดปุ่มด้านล่างทีละขั้นเพื่อเปิดอันดับ' : step === 3 ? 'เปิดครบทั้ง 3 อันดับแล้ว' : `เปิดถึงอันดับ ${4 - step} แล้ว`}</span></div>
    <div class="row">
      ${step < 3 ? `<button class="btn btn-primary" data-act="step" data-step="${step + 1}">${labels[step]}</button>` : ''}
      ${step > 0 ? `<button class="btn" data-act="step" data-step="0">${icon('refresh')}เริ่มลุ้นใหม่</button>` : ''}
    </div>
    <details><summary class="small muted" style="cursor:pointer">ดูผลล่วงหน้า (เฉพาะแอดมิน)</summary>
      ${preview ? `<ol style="list-style:none;padding:0;margin:var(--sp-2) 0 0;display:grid;gap:var(--sp-1)">${preview}</ol>` : '<p class="small muted">ยังไม่มีใครได้คะแนน</p>'}
    </details>`;
}

/* ---------- tab: results ---------- */

function tabResults() {
  const ts = A.st.topics;
  const head = `<div class="card panel"><div class="row"><h2 class="spacer">ผลโหวต</h2>
    <a class="btn btn-primary btn-sm" href="/api/admin/results.csv" download>${icon('download')}ดาวน์โหลด CSV</a></div>
    <p class="hint">อัปเดตสดทุกครั้งที่มีคนโหวต · ไฟล์ CSV เปิดใน Excel ได้ภาษาไทยไม่เพี้ยน</p>
    ${A.st.event.accessMode === 'open' ? `<div class="banner banner-warning">${icon('alert')}<span>${OPEN_WARNING}</span></div>` : ''}</div>`;
  if (!ts.length) return head + `<div class="card center-state">${icon('chart')}<p class="muted">ยังไม่มีหัวข้อประกวด สร้างได้ที่แท็บ “หัวข้อประกวด”</p></div>`;
  return head + ts.map((t) => {
    const max = Math.max(1, ...t.results.map((r) => r.votes));
    return `<section class="card panel">
      <div class="row"><h3 class="spacer">${esc(t.title)}</h3>${statusBadge(t.status)}<span class="small muted">โหวตแล้ว ${t.voters} คน</span></div>
      ${t.results.length ? `<table class="results"><thead><tr><th class="num">อันดับ</th><th>ผู้เข้าประกวด</th><th class="num">คะแนน</th><th style="width:30%"><span class="sr">สัดส่วน</span></th></tr></thead><tbody>
        ${t.results.map((r) => `<tr><td class="num">${r.votes ? r.rank : '–'}</td><td><b>${esc(r.number)}</b> ${esc(r.name)}</td><td class="num">${r.votes.toLocaleString('th-TH')}</td>
          <td><div class="rbar"><span style="width:${(r.votes / max) * 100}%"></span></div></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted small">ยังไม่มีผู้เข้าประกวด</p>'}
    </section>`;
  }).join('');
}

/* ---------- tab: settings ---------- */

function tabSettings() {
  const st = A.st;
  const locked = st.ballotCount > 0;
  const codeBox = st.event.accessMode === 'code' ? `
    <section class="card panel">
      <h2>รหัสโหวต</h2>
      ${errBanner('codes')}
      <div class="row" style="gap:var(--sp-6)">
        <div><p class="small muted">รหัสทั้งหมด</p><p class="stat">${st.codes.total.toLocaleString('th-TH')}</p></div>
        <div><p class="small muted">ใช้เข้าโหวตแล้ว</p><p class="stat">${st.codes.used.toLocaleString('th-TH')}</p></div>
      </div>
      <form class="row" data-form="codes" novalidate style="align-items:end">
        <div class="field" style="width:180px"><label for="code-n">${st.codes.total ? 'สร้างเพิ่ม (ใบ)' : 'จำนวนรหัส (ใบ)'}</label>
          <input id="code-n" name="count" class="input" type="number" min="1" max="2000" value="${st.codes.total ? 10 : 220}" inputmode="numeric"></div>
        <button class="btn btn-primary">${icon('plus')}สร้างรหัส</button>
      </form>
      <p class="hint">แนะนำให้สร้างเผื่อจำนวนคนสัก 10% · รหัสแต่ละใบโหวตได้ตามจำนวนที่แต่ละหัวข้อกำหนด${st.mail.total ? ' · รหัสที่ส่งทางอีเมลไม่นับรวมที่นี่และไม่ถูกพิมพ์เป็นบัตร' : ''}</p>
      <div class="row">
        ${st.codes.total ? `<a class="btn" href="/print" target="_blank" rel="noopener">${icon('printer')}พิมพ์บัตรรหัส</a>` : `<button class="btn" disabled>${icon('printer')}พิมพ์บัตรรหัส</button>`}
        ${st.codes.total ? `<button class="btn btn-danger" data-act="del-codes">${icon('trash')}ลบรหัสทั้งหมด</button>` : ''}
      </div>
    </section>
    ${mailBox(st)}` : '';
  if (st.event.accessMode === 'name' && A.rosterText === undefined) loadRoster();
  const rosterValue = A.rosterDraft ?? A.rosterText;
  const rosterBox = st.event.accessMode === 'name' ? `
    <section class="card panel">
      <h2>รายชื่อพนักงานที่โหวตได้</h2>
      ${errBanner('roster')}
      ${st.roster.count ? '' : `<div class="banner banner-error">${icon('alert')}<span>ยังไม่มีรายชื่อ ตอนนี้ยังไม่มีใครเข้าโหวตได้ ใส่รายชื่อด้านล่างแล้วกดบันทึก</span></div>`}
      <div class="banner banner-warning">${icon('alert')}<span>${NAME_WARNING}</span></div>
      ${st.roster.unlistedWithVotes ? `<div class="banner banner-warning">${icon('alert')}<div><span>มี ${st.roster.unlistedWithVotes.toLocaleString('th-TH')} คนที่โหวตไปแล้วแต่ไม่อยู่ในรายชื่อตอนนี้ (เข้ามาก่อนมีรายชื่อ หรือถูกเอาชื่อออก) คะแนนของเขายังนับอยู่</span><br>
        <button class="btn btn-danger btn-sm" data-act="purge-unlisted">${icon('trash')}ลบโหวตของคนกลุ่มนี้</button></div></div>` : ''}
      <form data-form="roster" novalidate>
        <div class="field"><label for="roster">รายชื่อ บรรทัดละคน · บันทึกไว้ ${st.roster.count.toLocaleString('th-TH')} คน</label>
          <textarea id="roster" name="text" class="input" rows="10" ${rosterValue === undefined ? 'disabled' : ''} placeholder="E001, สมชาย ใจดี&#10;E002, สมหญิง รักงาน&#10;หรือใส่แค่ชื่อ-นามสกุล">${rosterValue === undefined ? 'กำลังโหลด…' : esc(rosterValue)}</textarea>
          <p class="hint">วางจาก Excel สองคอลัมน์ (รหัสพนักงาน, ชื่อ-นามสกุล) ได้เลย หรือใส่แค่ชื่อก็ได้ · คนโหวตพิมพ์รหัสหรือชื่อก็ได้ เว้นวรรคหรือตัวพิมพ์เล็ก/ใหญ่ต่างกันถือเป็นคนเดียวกัน · ถ้ามีชื่อซ้ำกันต้องใส่รหัสพนักงานแยก</p></div>
        <div class="row end"><button class="btn btn-primary" ${rosterValue === undefined ? 'disabled' : ''}>บันทึกรายชื่อ</button></div>
      </form>
    </section>` : '';
  return `
    <form class="card panel" data-form="event" novalidate>
      <h2>ข้อมูลงาน</h2>
      ${errBanner('event')}
      <div class="field"><label for="ev-name">ชื่องาน</label><input id="ev-name" name="name" class="input" maxlength="120" value="${esc(st.event.name)}"></div>
      <div class="field"><label for="ev-url">ลิงก์ที่ QR พาไป (ไม่บังคับ)</label>
        <input id="ev-url" name="publicUrl" class="input" inputmode="url" value="${esc(st.event.publicUrl)}" placeholder="${esc(st.lanUrl)}">
        <p class="hint">เว้นว่าง = ใช้ที่อยู่ของเครื่องนี้ในวง Wi-Fi (${esc(st.lanUrl)}) มือถือต้องต่อ Wi-Fi วงเดียวกัน · ถ้าเอาขึ้นเว็บแล้วให้ใส่โดเมนจริง เช่น https://vote.example.com</p></div>
      <dl class="kv"><dt>QR ตอนนี้พาไป</dt><dd><b>${esc(st.voteUrl)}</b></dd></dl>
      <div class="row end"><button class="btn btn-primary">บันทึกข้อมูลงาน</button></div>
    </form>

    <section class="card panel">
      <h2>วิธีเข้าโหวต</h2>
      ${errBanner('mode')}
      ${locked ? `<div class="banner banner-warning">${icon('lock')}<span>มีโหวตแล้ว ${st.ballotCount.toLocaleString('th-TH')} รายการ จึงเปลี่ยนวิธีเข้าไม่ได้ ถ้าจะเปลี่ยนต้องล้างผลโหวตทั้งหมดก่อน (ด้านล่าง)</span></div>` : ''}
      <div class="radio-list">${Object.entries(MODE_TEXT).map(([k, [title, desc]]) => `
        <label class="radio-opt"><input type="radio" name="accessMode" value="${k}" ${st.event.accessMode === k ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          <span><b>${title}</b><span class="small muted">${desc}</span></span></label>`).join('')}</div>
      ${st.event.accessMode === 'open' ? `<div class="banner banner-warning">${icon('alert')}<span>${OPEN_WARNING}</span></div>` : ''}
    </section>

    ${codeBox}
    ${rosterBox}

    <section class="card panel">
      <h2>ล้างผลโหวต</h2>
      ${errBanner('reset')}
      <p class="small muted">ลบโหวตทุกหัวข้อและรายชื่อคนที่เข้าโหวต (หัวข้อ ผู้เข้าประกวด และรหัสโหวตยังอยู่) ใช้ตอนซ้อมเสร็จแล้วจะเริ่มงานจริง ย้อนกลับไม่ได้ — ดาวน์โหลด CSV เก็บไว้ก่อน</p>
      <div class="row"><button class="btn btn-danger" data-act="reset">${icon('trash')}ล้างผลโหวตทั้งหมด</button></div>
    </section>`;
}

/* ---------- settings: codes by email ---------- */

const MAIL_FILTERS = [
  ['all', 'ทั้งหมด', () => true],
  ['pending', 'ยังไม่ส่ง', (r) => r.status === 'pending'],
  ['sent', 'ส่งแล้ว', (r) => r.status === 'sent'],
  ['failed', 'ไม่สำเร็จ', (r) => r.status === 'failed'],
  ['notused', 'ยังไม่เข้าโหวต', (r) => r.status === 'sent' && !r.used],
];
const MAIL_LIST_MAX = 200;
const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function mailBox(st) {
  const m = st.mail;
  if (!A.mail || A.mail.rev !== m.rev) loadMail();
  const draft = A.mailDraft ?? '';
  const n = (x) => x.toLocaleString('th-TH');
  const stat = (label, v, cls = '') => `<div><p class="small muted">${label}</p><p class="stat ${cls}">${n(v)}</p></div>`;
  return `<section class="card panel" id="mail-box">
    <h2>ส่งรหัสทางอีเมล</h2>
    <p class="hint">ใช้แทนหรือใช้คู่กับบัตรก็ได้ ระบบให้รหัสคนละใบกับแต่ละอีเมล ในอีเมลมีปุ่มเข้าโหวตและ QR กดหรือสแกนแล้วเข้าโหวตได้เลยเหมือน QR บนบัตร</p>
    ${errBanner('mail')}
    ${m.configured ? mailProviderBlock(m) : `<div class="banner banner-warning">${icon('alert')}<span>${esc(m.problem)} · ใส่ค่าในไฟล์ <code>.env</code> แล้วรันเซิร์ฟเวอร์ใหม่ (ดูหัวข้อ “ส่งรหัสทางอีเมล” ใน README) · เพิ่มรายชื่อไว้ก่อนได้</span></div>`}
    ${st.publicLink ? '' : `<div class="banner banner-warning">${icon('alert')}<span>ลิงก์ในอีเมลจะพาไป <b>${esc(st.voteUrl)}</b> ซึ่งเปิดได้เฉพาะมือถือที่ต่อ Wi-Fi วงเดียวกับเครื่องนี้ ถ้าจะให้คนเปิดจากที่ไหนก็ได้ ต้องเอาขึ้นเว็บแล้วใส่ลิงก์ https ในช่อง “ลิงก์ที่ QR พาไป” ด้านบนก่อนส่ง</span></div>`}
    ${m.lastError ? `<div class="banner banner-error" role="alert">${icon('alert')}<span>การส่งหยุดลง: ${esc(m.lastError)} · แก้แล้วกด “ส่งอีกครั้งให้ที่ไม่สำเร็จ”</span></div>` : ''}
    ${m.total ? `<div class="row" style="gap:var(--sp-6)">
      ${stat('อีเมลทั้งหมด', m.total)}${stat('ส่งแล้ว', m.sent)}${stat('ยังไม่ส่ง', m.pending)}${m.failed ? stat('ไม่สำเร็จ', m.failed, 'text-danger') : ''}${m.sending ? stat('กำลังส่ง', m.sending) : ''}${stat('เข้าโหวตแล้ว', m.used)}
    </div>` : ''}
    ${m.stale ? `<div class="banner banner-warning">${icon('alert')}<div><span>${n(m.stale)} คนได้อีเมลที่มีลิงก์เก่า (ลิงก์ของงานเปลี่ยนไปหลังส่ง) ลิงก์ในอีเมลนั้นอาจเปิดไม่ได้แล้ว รหัสยังใช้ได้เหมือนเดิม</span><br>
      <button class="btn btn-sm" data-act="mail-send" data-which="stale" ${m.configured ? '' : 'disabled'}>${icon('refresh')}ส่งใหม่ให้ ${n(m.stale)} คนนี้</button></div></div>` : ''}
    ${m.total ? `<div class="row">
      <button class="btn btn-primary" data-act="mail-send" data-which="pending" ${m.configured && m.pending ? '' : 'disabled'}>${icon('mail')}ส่งให้คนที่ยังไม่ได้ส่ง (${n(m.pending)})</button>
      ${m.failed ? `<button class="btn" data-act="mail-send" data-which="failed" ${m.configured ? '' : 'disabled'}>${icon('refresh')}ส่งอีกครั้งให้ที่ไม่สำเร็จ (${n(m.failed)})</button>` : ''}
    </div>
    ${m.sending ? `<p class="hint" role="status">กำลังส่ง… เหลืออีก ${n(m.sending)} ฉบับ ปิดหน้านี้ได้ ระบบส่งต่อเอง</p>` : ''}
    ${m.provider ? `<p class="hint">“ส่งแล้ว” แปลว่า ${esc(m.provider.accepts)} รับอีเมลไปส่งแล้ว ถ้าผู้รับบอกว่าไม่ได้รับ ให้ดูในโฟลเดอร์สแปมก่อน แล้วค่อยกดส่งซ้ำที่ชื่อเขา</p>` : ''}` : ''}
    <form data-form="mail-add" novalidate>
      <div class="field"><label for="mail-text">${m.total ? 'เพิ่มอีเมล' : 'อีเมลที่จะส่งรหัส'} บรรทัดละคน · ใส่ชื่อด้วยก็ได้</label>
        <textarea id="mail-text" name="text" class="input" rows="5" placeholder="somchai@example.com&#10;สมหญิง รักงาน, somying@example.com">${esc(draft)}</textarea>
        <p class="hint">วางจาก Excel สองคอลัมน์ (ชื่อ กับ อีเมล) ได้เลย · อีเมลที่มีอยู่แล้วจะถูกข้าม · เพิ่มแล้วยังไม่ส่งทันที ต้องกดปุ่มส่งอีกที</p></div>
      <div class="row end"><button class="btn btn-primary">${icon('plus')}เพิ่มอีเมล</button></div>
    </form>
    ${m.total ? mailListSection() : ''}
  </section>`;
}

/** daily-limit room left, by this server's own count (Infinity when the service has no set limit) */
const quotaLeft = (m) => (m.provider && m.provider.limit ? Math.max(0, m.provider.limit - m.provider.sent24h) : Infinity);

/** which service sends, as whom, and how much of its daily limit is used */
function mailProviderBlock(m) {
  const p = m.provider;
  const n = (x) => x.toLocaleString('th-TH');
  const left = quotaLeft(m);
  const quota = p.limit
    ? `ส่งได้ราววันละ ${n(p.limit)} ฉบับ · 24 ชั่วโมงที่ผ่านมาส่งไปแล้ว ${n(p.sent24h)} · <b class="${left < Math.max(m.pending, 1) ? 'text-danger' : ''}">เหลือราว ${n(left)} ฉบับ</b>`
    : 'ไม่ได้ตั้งจำนวนต่อวัน (ขึ้นกับเซิร์ฟเวอร์ของบริษัท ตั้ง MAIL_DAILY_LIMIT ได้ถ้ารู้ตัวเลข)';
  return `<div class="row" style="align-items:flex-start">
      <dl class="kv" style="flex:1 1 16rem">
        <dt>ส่งด้วย</dt><dd><b>${esc(p.label)}</b> · ${esc(p.account)}</dd>
        <dt>ผู้ส่ง</dt><dd>${esc(m.from || '')}</dd>
        <dt>ต่อวัน</dt><dd>${quota}</dd>
      </dl>
      <button class="btn btn-sm" data-act="mail-test">${icon('mail')}ส่งฉบับทดสอบ</button>
    </div>
    ${p.limit && m.pending > left ? `<div class="banner banner-warning">${icon('alert')}<span>มีคนรอส่ง ${n(m.pending)} คน แต่ ${esc(p.label)} ส่งได้อีกราว ${n(left)} ฉบับใน 24 ชั่วโมงนี้ ตอนกดส่งจะให้เลือกส่งเท่าที่ส่งได้ก่อน ที่เหลือค่อยส่งวันถัดไป</span></div>` : ''}
    ${m.check && !m.check.ok ? `<div class="banner banner-error" role="alert">${icon('alert')}<span>ตอนเปิดเซิร์ฟเวอร์ล็อกอิน ${esc(p.label)} ไม่ได้: ${esc(m.check.error)} · แก้ใน <code>.env</code> แล้วรันเซิร์ฟเวอร์ใหม่</span></div>` : ''}
    ${(m.notes || []).map((t) => `<div class="banner banner-warning">${icon('alert')}<span>${esc(t)}</span></div>`).join('')}`;
}

function mailListSection() {
  const f = A.mailFilter || 'all';
  const all = A.mail?.recipients || [];
  return `<div class="m-list-wrap">
    <div class="row">
      <div class="seg" role="group" aria-label="กรองรายชื่อ">${MAIL_FILTERS.map(([k, label, fn]) => `<button class="btn btn-sm" data-act="mail-filter" data-f="${k}" aria-pressed="${f === k}">${label} ${all.filter(fn).length.toLocaleString('th-TH')}</button>`).join('')}</div>
    </div>
    <div class="field"><label for="mail-q" class="sr">ค้นหาอีเมลหรือชื่อ</label>
      <input id="mail-q" class="input" type="search" placeholder="ค้นหาอีเมลหรือชื่อ" value="${esc(A.mailQuery || '')}" autocomplete="off"></div>
    <div id="mail-list">${mailListHtml()}</div>
  </div>`;
}

const MAIL_BADGE = {
  pending: () => '<span class="badge badge-closed">ยังไม่ส่ง</span>',
  queued: () => '<span class="badge badge-done">รอส่ง…</span>',
  sending: () => '<span class="badge badge-done">กำลังส่ง…</span>',
  sent: (r) => `<span class="badge badge-open">${icon('check')}ส่งแล้ว${r.sends > 1 ? ` ${r.sends} ครั้ง` : ''}</span>`,
  failed: () => `<span class="badge badge-failed">${icon('alert')}ส่งไม่สำเร็จ</span>`,
};

function mailListHtml() {
  if (!A.mail) return '<p class="muted small">กำลังโหลดรายชื่อ…</p>';
  const fn = (MAIL_FILTERS.find(([k]) => k === (A.mailFilter || 'all')) || MAIL_FILTERS[0])[2];
  const q = (A.mailQuery || '').trim().toLowerCase();
  const list = A.mail.recipients.filter((r) => fn(r) && (!q || r.email.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.code.toLowerCase().replace('-', '').includes(q.replace('-', ''))));
  if (!list.length) return `<p class="muted small">${q ? 'ไม่พบอีเมลหรือชื่อที่ค้นหา' : 'ไม่มีรายชื่อในกลุ่มนี้'}</p>`;
  const busyRow = (r) => r.status === 'queued' || r.status === 'sending';
  return `<ul class="m-list">${list.slice(0, MAIL_LIST_MAX).map((r) => `<li class="m-row">
      <div class="who">${r.name ? `<b>${esc(r.name)}</b>` : ''}<span class="em">${esc(r.email)}</span><span class="small muted">รหัส ${esc(r.code)}</span></div>
      <div class="st"><span class="badges">${MAIL_BADGE[r.status](r)}${r.used ? '<span class="badge badge-done">เข้าโหวตแล้ว</span>' : ''}${r.stale ? '<span class="badge badge-draft">ลิงก์เก่า</span>' : ''}</span>
        ${r.status === 'failed' ? `<span class="small text-danger">${esc(r.error)}</span>` : r.sentAt ? `<span class="small muted">ส่งล่าสุด ${fmtTime(r.sentAt)}</span>` : ''}</div>
      <div class="acts">
        <button class="btn btn-sm" data-act="mail-send" data-which="one" data-id="${r.id}" ${A.st.mail.configured && !busyRow(r) ? '' : 'disabled'}>${icon(r.status === 'pending' ? 'mail' : 'refresh')}${r.status === 'pending' ? 'ส่ง' : 'ส่งซ้ำ'}</button>
        <button class="btn btn-ghost btn-sm icon-btn" data-act="mail-del" data-id="${r.id}" ${busyRow(r) ? 'disabled' : ''} aria-label="ลบ ${esc(r.email)}">${icon('trash')}</button>
      </div></li>`).join('')}</ul>
    ${list.length > MAIL_LIST_MAX ? `<p class="hint">แสดง ${MAIL_LIST_MAX} จาก ${list.length.toLocaleString('th-TH')} รายการ พิมพ์ค้นหาเพื่อดูคนอื่น</p>` : ''}`;
}

async function loadMail() {
  if (A.mailLoading) return;
  A.mailLoading = true;
  try { A.mail = await api('GET', '/api/admin/mail'); }
  catch (e) { if (e.status === 401) { A.mailLoading = false; return renderLogin('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่'); } A.errors.mail = e.message; A.mail = A.mail || { rev: -1, recipients: [] }; }
  A.mailLoading = false;
  if (A.tab !== 'settings') return;
  // only the list changes: refresh it in place so typing in the search box or the textarea is not disturbed
  if (document.querySelector('#mail-list') && !A.errors.mail) {
    refreshMailList();
    if (A.st.mail.rev !== A.mail.rev) setTimeout(loadMail, 500); // more changes while loading (e.g. sending)
  } else scheduleRender();
}
function refreshMailList() {
  const el = $('#mail-list');
  if (!el) return;
  el.innerHTML = mailListHtml();
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onAct));
  document.querySelectorAll('[data-act=mail-filter]').forEach((b) => {
    const fn = MAIL_FILTERS.find(([k]) => k === b.dataset.f)[2];
    b.textContent = `${MAIL_FILTERS.find(([k]) => k === b.dataset.f)[1]} ${A.mail.recipients.filter(fn).length.toLocaleString('th-TH')}`;
  });
}

function mailTestDialog() {
  formDialog('ส่งฉบับทดสอบ', `
    <p class="small muted">ส่งอีเมลหน้าตาเหมือนที่ผู้รับจะได้ แต่ใช้รหัสตัวอย่าง (เข้าโหวตไม่ได้) ไว้ดูว่าตั้งค่าถูกและอีเมลไม่ตกไปอยู่ในสแปม</p>
    ${A.st.mail.provider ? `<p class="small">ส่งด้วย <b>${esc(A.st.mail.provider.label)}</b> ในชื่อ ${esc(A.st.mail.from || '')}</p>` : ''}
    <div class="field"><label for="mt-to">ส่งไปที่อีเมล</label><input id="mt-to" name="to" class="input" type="email" inputmode="email" autocomplete="email" value="${esc(A.testTo || '')}"></div>`,
  'ส่งฉบับทดสอบ', async (f) => {
    const to = new FormData(f).get('to');
    await api('POST', '/api/admin/mail/test', { to });
    A.testTo = to;
    toast('ส่งฉบับทดสอบแล้ว ดูในกล่องจดหมาย (และโฟลเดอร์สแปม)');
  });
}

/* ---------- events ---------- */

function bind(main) {
  main.querySelectorAll('form[data-form]').forEach((f) => f.addEventListener('submit', onSubmit));
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onAct));
  main.querySelectorAll('input[name=screen-topic]').forEach((r) => r.addEventListener('change', () =>
    act(r, 'screen', () => api('PUT', '/api/admin/screen', { topicId: r.value || null }))));
  main.querySelectorAll('input[name=accessMode]').forEach((r) => r.addEventListener('change', async () => {
    const ask = {
      open: { title: 'ใช้แบบ “ไม่ต้องกรอกอะไร”?', body: esc(MODE_TEXT.open[1]), confirmLabel: 'ใช้แบบนี้ (งานเล่น ๆ)' },
      name: { title: 'ใช้แบบ “กรอกชื่อหรือรหัสพนักงาน”?', body: esc(NAME_WARNING) + '<br><br>ต้องใส่รายชื่อพนักงานก่อน คนถึงจะเข้าโหวตได้', confirmLabel: 'ใช้แบบนี้' },
    }[r.value];
    if (ask && !(await confirmDialog({ ...ask, cancelLabel: 'ไม่เปลี่ยน', danger: false }))) return renderMain();
    act(r, 'mode', () => api('PUT', '/api/admin/event', { accessMode: r.value }), 'เปลี่ยนวิธีเข้าโหวตแล้ว');
  }));
  const ta = main.querySelector('#roster');
  if (ta) ta.addEventListener('input', () => { A.rosterDraft = ta.value; });
  const mt = main.querySelector('#mail-text');
  if (mt) mt.addEventListener('input', () => { A.mailDraft = mt.value; });
  const mq = main.querySelector('#mail-q');
  if (mq) mq.addEventListener('input', () => { A.mailQuery = mq.value; refreshMailList(); });
}

async function loadRoster() {
  if (A.rosterLoading) return;
  A.rosterLoading = true;
  try { A.rosterText = (await api('GET', '/api/admin/roster')).text; }
  catch (e) { A.rosterText = ''; A.errors.roster = e.message; }
  A.rosterLoading = false;
  scheduleRender();
}

function onSubmit(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = e.submitter || f.querySelector('button');
  const v = Object.fromEntries(new FormData(f));
  const kind = f.dataset.form;
  if (kind === 'new-topic') {
    act(btn, 'new-topic', async () => {
      const t = await api('POST', '/api/admin/topics', { title: v.title, maxVotes: Number(v.maxVotes) });
      A.openTopics.add(t.id); saveOpen();
    }, 'สร้างหัวข้อแล้ว');
  } else if (kind === 'event') {
    act(btn, 'event', () => api('PUT', '/api/admin/event', { name: v.name, publicUrl: v.publicUrl }), 'บันทึกข้อมูลงานแล้ว');
  } else if (kind === 'codes') {
    act(btn, 'codes', () => api('POST', '/api/admin/codes', { count: Number(v.count) }), 'สร้างรหัสแล้ว');
  } else if (kind === 'roster') {
    act(btn, 'roster', async () => {
      const r = await api('PUT', '/api/admin/roster', { text: v.text });
      A.rosterText = r.rosterText; A.rosterDraft = undefined;
      return r;
    }, 'บันทึกรายชื่อแล้ว');
  } else if (kind === 'mail-add') {
    act(btn, 'mail', async () => {
      const r = await api('POST', '/api/admin/mail/recipients', { text: v.text });
      A.mailDraft = undefined;
      toast(`เพิ่ม ${r.added.toLocaleString('th-TH')} อีเมลแล้ว${r.skipped ? ` · ข้ามอีเมลที่มีอยู่แล้ว ${r.skipped.toLocaleString('th-TH')} รายการ` : ''} · ยังไม่ได้ส่ง`);
      return r;
    });
  }
}

const findT = (id) => A.st.topics.find((t) => t.id === id);
const saveOpen = () => sessionStorage.setItem('openTopics', JSON.stringify([...A.openTopics]));

async function onAct(e) {
  const b = e.currentTarget;
  const { act: a, id, cid } = b.dataset;
  const t = id && findT(id);
  const area = A.tab === 'screen' ? 'screen' : 't-' + id;
  switch (a) {
    case 'toggle':
      A.openTopics.has(id) ? A.openTopics.delete(id) : A.openTopics.add(id); saveOpen(); renderMain(); break;
    case 'status':
      act(b, area, () => api('PUT', `/api/admin/topics/${id}`, { status: b.dataset.to }), b.dataset.to === 'open' ? `เปิดโหวต “${t.title}” แล้ว` : `ปิดโหวต “${t.title}” แล้ว`); break;
    case 'move':
      act(b, area, () => api('POST', `/api/admin/topics/${id}/move`, { dir: b.dataset.dir })); break;
    case 'edit-t': topicDialog(t); break;
    case 'add-c': contestantDialog(t, null); break;
    case 'edit-c': contestantDialog(t, t.contestants.find((c) => c.id === cid)); break;
    case 'del-t': {
      const ok = await confirmDialog({
        title: `ลบหัวข้อ “${t.title}”?`,
        body: `ผู้เข้าประกวด ${t.contestants.length} คน${t.voters ? ` และโหวต ${t.voters} คน` : ''} ในหัวข้อนี้จะหายไปด้วย ย้อนกลับไม่ได้`,
        confirmLabel: 'ลบหัวข้อนี้', cancelLabel: 'เก็บไว้',
      });
      if (ok) act(b, area, () => api('DELETE', `/api/admin/topics/${id}`), 'ลบหัวข้อแล้ว');
      break;
    }
    case 'del-c': {
      const c = t.contestants.find((x) => x.id === cid);
      const votes = t.results.find((r) => r.id === cid)?.votes || 0;
      const ok = await confirmDialog({
        title: `ลบ “${c.number} ${c.name}”?`,
        body: votes ? `คะแนนที่ได้ไปแล้ว ${votes} คะแนนจะหายไปด้วย` : 'ยังไม่มีใครโหวตคนนี้',
        confirmLabel: 'ลบผู้เข้าประกวด', cancelLabel: 'เก็บไว้',
      });
      if (ok) act(b, area, () => api('DELETE', `/api/admin/topics/${id}/contestants/${cid}`), 'ลบผู้เข้าประกวดแล้ว');
      break;
    }
    case 'mode':
      act(b, 'screen', () => api('PUT', '/api/admin/screen', { mode: b.dataset.mode })); break;
    case 'step':
      act(b, 'screen', () => api('PUT', '/api/admin/screen', { revealStep: Number(b.dataset.step) })); break;
    case 'del-codes': {
      const ok = await confirmDialog({ title: `ลบรหัสโหวตทั้งหมด ${A.st.codes.total} รหัส?`, body: 'บัตรที่พิมพ์ไปแล้วจะใช้ไม่ได้ ต้องสร้างและพิมพ์ใหม่', confirmLabel: 'ลบรหัสทั้งหมด', cancelLabel: 'เก็บไว้' });
      if (ok) act(b, 'codes', () => api('DELETE', '/api/admin/codes'), 'ลบรหัสแล้ว');
      break;
    }
    case 'purge-unlisted': {
      const n = A.st.roster.unlistedWithVotes;
      const ok = await confirmDialog({ title: `ลบโหวตของ ${n} คนที่ไม่อยู่ในรายชื่อ?`, body: 'คะแนนที่คนกลุ่มนี้โหวตไว้ทุกหัวข้อจะหายไป ย้อนกลับไม่ได้', confirmLabel: 'ลบโหวตกลุ่มนี้', cancelLabel: 'เก็บไว้' });
      if (ok) act(b, 'roster', () => api('POST', '/api/admin/roster/purge-unlisted'), 'ลบโหวตแล้ว');
      break;
    }
    case 'mail-filter':
      A.mailFilter = b.dataset.f; renderMain(); break;
    case 'mail-test': mailTestDialog(); break;
    case 'mail-send': {
      const which = b.dataset.which;
      const m = A.st.mail;
      const r = which === 'one' && A.mail?.recipients.find((x) => x.id === id);
      let max;
      if (which !== 'one') {
        const nf = (x) => x.toLocaleString('th-TH');
        const count = { pending: m.pending, stale: m.stale, failed: m.failed }[which];
        const p = m.provider;
        const left = quotaLeft(m);
        const over = count > left;
        const counted = p && p.limit ? `${esc(p.label)} ส่งได้ราววันละ ${nf(p.limit)} ฉบับ · 24 ชั่วโมงที่ผ่านมาส่งไปแล้ว ${nf(p.sent24h)} ฉบับ` : '';
        if (over) {
          const ok = await confirmDialog({
            title: left ? `ส่งได้อีกราว ${nf(left)} ฉบับ จาก ${nf(count)}` : `ช่วงนี้ส่งครบจำนวนต่อวันของ ${p.label} แล้ว`,
            body: `${counted}<br>${left
              ? `แนะนำให้ส่ง ${nf(left)} ฉบับก่อน อีก ${nf(count - left)} คนยังอยู่ในรายชื่อตามเดิม กดปุ่มเดิมส่งต่อได้เมื่อครบ 24 ชั่วโมง`
              : `ถ้าส่งตอนนี้ ${esc(p.label)} มักไม่รับ แล้วระบบจะหยุดส่งทั้งชุด รอให้ครบ 24 ชั่วโมงก่อนดีกว่า`}
              <br><span class="small muted">นับเฉพาะที่ส่งจากระบบนี้ ถ้าบัญชีเดียวกันส่งอีเมลอื่นด้วย จะเหลือน้อยกว่านี้</span>`,
            confirmLabel: left ? `ส่ง ${nf(left)} ฉบับก่อน` : 'ลองส่งอยู่ดี', cancelLabel: 'ยังไม่ส่ง', danger: !left,
          });
          if (!ok) break;
          if (left) max = left;
        } else if (which !== 'failed') {
          const ok = await confirmDialog({
            title: `ส่งรหัสโหวตทางอีเมลให้ ${nf(count)} คน?`,
            body: `ส่งด้วย ${esc(p ? p.label : '')} ในชื่อ ${esc(m.from || '')}<br>ลิงก์ในอีเมลพาไป ${esc(A.st.voteUrl)}${A.st.publicLink ? '' : ' (เปิดได้เฉพาะตอนต่อ Wi-Fi วงเดียวกับเครื่องนี้)'}${counted ? `<br>${counted} ส่งชุดนี้แล้วจะเหลือราว ${nf(left - count)} ฉบับ` : ''}`,
            confirmLabel: `ส่ง ${nf(count)} ฉบับ`, cancelLabel: 'ยังไม่ส่ง', danger: false,
          });
          if (!ok) break;
        }
      }
      act(b, 'mail', () => api('POST', '/api/admin/mail/send', which === 'one' ? { which, id } : { which, max }),
        r ? `กำลังส่งไปที่ ${r.email}` : max ? `เริ่มส่ง ${max.toLocaleString('th-TH')} ฉบับแล้ว ดูสถานะได้ในรายชื่อด้านล่าง` : 'เริ่มส่งแล้ว ดูสถานะได้ในรายชื่อด้านล่าง');
      break;
    }
    case 'mail-del': {
      const r = A.mail?.recipients.find((x) => x.id === id);
      if (!r) break;
      const ok = await confirmDialog({
        title: `ลบ ${r.email}?`,
        body: r.status === 'sent' || r.sends ? 'รหัสในอีเมลที่ส่งไปแล้วจะใช้ไม่ได้ทันที ถ้าพิมพ์อีเมลผิด ให้ลบแล้วเพิ่มอีเมลที่ถูกใหม่ จะได้รหัสใหม่' : 'อีเมลนี้ยังไม่ได้ส่ง ลบแล้วรหัสของอีเมลนี้จะถูกลบด้วย',
        confirmLabel: 'ลบอีเมลนี้', cancelLabel: 'เก็บไว้',
      });
      if (ok) act(b, 'mail', () => api('DELETE', `/api/admin/mail/recipients/${id}`), 'ลบอีเมลแล้ว');
      break;
    }
    case 'reset': {
      const ok = await confirmDialog({
        title: 'ล้างผลโหวตทั้งหมด?',
        body: `โหวต ${A.st.ballotCount.toLocaleString('th-TH')} รายการจากทุกหัวข้อจะหายไป ย้อนกลับไม่ได้`,
        confirmLabel: 'ล้างผลโหวต', cancelLabel: 'เก็บไว้', typeToConfirm: 'ล้างผล',
      });
      if (ok) act(b, 'reset', () => api('POST', '/api/admin/reset-votes', { confirm: 'ล้างผล' }), 'ล้างผลโหวตแล้ว');
      break;
    }
  }
}

/* ---------- dialogs (not touched by live re-render) ---------- */

function formDialog(title, fieldsHtml, submitLabel, onSave, afterOpen) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg';
  dlg.innerHTML = `<form class="dlg-body" novalidate>
    <h2 style="font-size:var(--fs-20)">${esc(title)}</h2>
    <div class="dlg-err"></div>
    ${fieldsHtml}
    <div class="dlg-actions"><button type="button" class="btn btn-ghost" data-cancel>ยกเลิก</button><button class="btn btn-primary">${esc(submitLabel)}</button></div>
  </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { dlg.remove(); if (A.pending) { A.pending = false; renderMain(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('.btn-primary'), async () => {
      try { await onSave(form); dlg.close(); }
      catch (er) {
        if (er.status === 401) { dlg.close(); return renderLogin('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่'); }
        dlg.querySelector('.dlg-err').innerHTML = `<div class="banner banner-error" role="alert">${icon('alert')}<span>${esc(er.message)}</span></div>`;
      }
    });
  });
  dlg.showModal();
  afterOpen && afterOpen(dlg);
  form.querySelector('input')?.focus();
}

function topicDialog(t) {
  formDialog('แก้ไขหัวข้อ', `
    <div class="field"><label for="et-title">ชื่อหัวข้อ</label><input id="et-title" name="title" class="input" maxlength="120" value="${esc(t.title)}"></div>
    <div class="field"><label for="et-max">แต่ละคนเลือกได้ (คน)</label><input id="et-max" name="maxVotes" class="input" type="number" min="1" max="50" value="${t.maxVotes}" inputmode="numeric">
      <p class="hint">1 = คนละ 1 โหวต · มากกว่า 1 = เลือกได้หลายคนไม่เกินจำนวนนี้</p></div>`,
  'บันทึกหัวข้อ', async (f) => {
    const v = Object.fromEntries(new FormData(f));
    await api('PUT', `/api/admin/topics/${t.id}`, { title: v.title, maxVotes: Number(v.maxVotes) });
    toast('บันทึกหัวข้อแล้ว');
  });
}

function nextNumber(t) {
  const nums = t.contestants.map((c) => parseInt(c.number, 10)).filter((n) => !isNaN(n));
  return String(nums.length ? Math.max(...nums) + 1 : 1);
}

function contestantDialog(t, c) {
  let photo; // undefined = unchanged, null = removed, string = new data URL
  formDialog(c ? 'แก้ไขผู้เข้าประกวด' : `เพิ่มผู้เข้าประกวด · ${t.title}`, `
    <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)">
      <div class="field"><label for="ec-no">หมายเลข</label><input id="ec-no" name="number" class="input" maxlength="10" value="${esc(c ? c.number : nextNumber(t))}"></div>
      <div class="field"><label for="ec-name">ชื่อ</label><input id="ec-name" name="name" class="input" maxlength="120" value="${esc(c ? c.name : '')}"></div>
    </div>
    <div class="field"><span class="label">รูป (ไม่บังคับ)</span>
      <div class="photo-pick"><div id="ec-prev">${photoHtml(c || { number: '?' }, 88)}</div>
        <label class="btn btn-sm" style="cursor:pointer">${icon('image')}เลือกรูป<input type="file" accept="image/*" id="ec-file" hidden></label>
        <button type="button" class="btn btn-ghost btn-sm" id="ec-rm" ${c && c.photo ? '' : 'hidden'}>${icon('x')}เอารูปออก</button></div>
      <p class="hint" id="ec-hint">ระบบย่อรูปให้อัตโนมัติ ถ่ายจากมือถือได้เลย</p></div>`,
  c ? 'บันทึกผู้เข้าประกวด' : 'เพิ่มผู้เข้าประกวด', async (f) => {
    const v = Object.fromEntries(new FormData(f));
    const body = { number: v.number, name: v.name };
    if (photo !== undefined) body.photo = photo;
    if (c) await api('PUT', `/api/admin/topics/${t.id}/contestants/${c.id}`, body);
    else await api('POST', `/api/admin/topics/${t.id}/contestants`, body);
    toast(c ? 'บันทึกแล้ว' : `เพิ่ม ${v.name} แล้ว`);
  }, (dlg) => {
    const prev = dlg.querySelector('#ec-prev');
    dlg.querySelector('#ec-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        photo = await resizeImage(file, 600);
        prev.innerHTML = `<img src="${photo}" alt="" style="width:88px;height:88px;border-radius:var(--radius-control);object-fit:cover">`;
        dlg.querySelector('#ec-rm').hidden = false;
        dlg.querySelector('#ec-hint').textContent = 'ระบบย่อรูปให้อัตโนมัติ ถ่ายจากมือถือได้เลย';
      } catch {
        dlg.querySelector('#ec-hint').innerHTML = `<span class="field-error">${icon('alert')}<span>เปิดไฟล์รูปนี้ไม่ได้ ลองรูปอื่น (JPG หรือ PNG)</span></span>`;
      }
    });
    dlg.querySelector('#ec-rm').addEventListener('click', (e) => {
      photo = null; prev.innerHTML = photoHtml({ number: dlg.querySelector('#ec-no').value || '?' }, 88); e.currentTarget.hidden = true;
    });
  });
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      // square-ish crop is left to CSS (object-fit: cover); just scale down
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}
