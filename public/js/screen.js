'use strict';
// Projector screen. Full re-render only when the view changes; live numbers are patched in place
// so bar transitions and the counter animation run smoothly.

let state = null;
let sig = '';
let lastVoters = null;
let lastStep = null; // null until first draw, so a reload at step 3 doesn't replay confetti

const fsBtn = $('#fs');
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
fsBtn.addEventListener('click', toggleFs);
document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFs(); });
document.addEventListener('fullscreenchange', () => { fsBtn.hidden = !!document.fullscreenElement; });

// the stream when it delivers; otherwise the snapshot every 2 s (live bars stay close to real time)
liveStream('/api/screen/stream', (data) => {
  state = data; draw();
  // cheers belong to the intro only: leaving it clears whatever is still floating
  if (data.screen.mode !== 'intro') { cheerBox.replaceChildren(); textQueue.length = 0; return; }
  if (data.cheers) { hideCheers(data.cheers.hidden); showCheers(data.cheers.items); }
}, (ok) => { $('#conn').hidden = ok; }, { pollMs: 2000, events: { cheers: showCheers } });

/* ---------- cheers: emoji rise on the right, text slides across in lanes ---------- */
// The same cheer can arrive twice (stream push, then inside a later snapshot): ids keep it once.
const cheerSeen = new Set();
const cheerGone = new Set();
const CHEER_MAX_EMOJI = 40, CHEER_MAX_TEXT = 8, CHEER_LANES = 6;
const laneFreeAt = Array(CHEER_LANES).fill(0);
const textQueue = [];
const cheerBox = $('#cheers');
function showCheers(items) {
  if (!state || state.screen.mode !== 'intro') return;
  for (const c of items || []) {
    if (cheerSeen.has(c.id) || cheerGone.has(c.id)) continue;
    cheerSeen.add(c.id);
    if (c.k === 'e') floatEmoji(c.v); else { textQueue.push(c); if (textQueue.length > 20) textQueue.shift(); }
  }
  if (cheerSeen.size > 3000) cheerSeen.clear();
  pumpText();
}
function hideCheers(ids) {
  for (const id of ids || []) {
    if (cheerGone.has(id)) continue;
    cheerGone.add(id);
    const el = cheerBox.querySelector(`[data-id="${id}"]`); if (el) el.remove();
    const q = textQueue.findIndex((c) => c.id === id); if (q >= 0) textQueue.splice(q, 1);
  }
}
function floatEmoji(v) {
  if (cheerBox.childElementCount - cheerBox.querySelectorAll('.ch-t').length >= CHEER_MAX_EMOJI) return;
  const el = document.createElement('span');
  el.className = 'ch-e'; el.textContent = v;
  el.style.left = 80 + Math.random() * 15 + 'vw';
  el.style.setProperty('--dx', (Math.random() * 10 - 5).toFixed(1) + 'vw');
  el.style.animationDuration = (2.8 + Math.random() * 1.2).toFixed(2) + 's';
  el.addEventListener('animationend', () => el.remove());
  cheerBox.append(el);
}
function pumpText() {
  while (textQueue.length && cheerBox.querySelectorAll('.ch-t').length < CHEER_MAX_TEXT) {
    const now = Date.now();
    const lane = laneFreeAt.indexOf(Math.min(...laneFreeAt));
    if (laneFreeAt[lane] > now) { setTimeout(pumpText, laneFreeAt[lane] - now + 20); return; }
    const c = textQueue.shift();
    const el = document.createElement('span');
    el.className = 'ch-t'; el.dataset.id = c.id; el.textContent = c.v; // text only, never markup
    el.style.top = 14 + lane * 11 + 'vh';
    el.addEventListener('animationend', () => { el.remove(); pumpText(); });
    cheerBox.append(el);
    // the next one in this lane starts once this one's tail is on screen plus a gap
    const w = el.offsetWidth, speed = (innerWidth + w) / 11000; // px per ms (11 s crossing)
    laneFreeAt[lane] = now + (w + innerWidth * 0.06) / speed;
  }
}

// the server always encodes its own vote link; ?u= only makes the image reload when that link changes
const qrSrc = () => '/api/qr.svg?u=' + encodeURIComponent(state.voteUrl);
const qrPanel = () => `<aside class="qr-panel"><img src="${qrSrc()}" alt="QR สำหรับเข้าโหวต"><span class="lbl">สแกนเพื่อโหวต</span><span class="url">${esc(state.voteUrl)}</span></aside>`;

function draw() {
  const s = state.screen;
  const topic = state.topics.find((t) => t.id === s.topicId) || null;
  const newSig = JSON.stringify([state.event.name, state.voteUrl, s.topicId, s.mode, s.revealStep, s.intro, topic && topic.status, topic && topic.contestants, !topic && state.topics.map((t) => [t.title, t.status])]);
  if (newSig !== sig) {
    sig = newSig;
    const el = $('#stage');
    if (s.mode === 'intro' && s.intro) el.innerHTML = intro(s.intro);
    else if (!topic) el.innerHTML = lobby();
    else if (s.mode === 'reveal' && topic.status === 'closed') el.innerHTML = reveal(topic, s);
    else if (s.mode === 'live') el.innerHTML = live(topic);
    else el.innerHTML = hidden(topic);
    if (s.mode === 'reveal' && s.revealStep === 3 && lastStep !== null && lastStep !== 3) confetti();
    lastStep = s.mode === 'reveal' ? s.revealStep : 0;
    lastVoters = null;
  }
  patch(topic, s);
}

function header(topic) {
  const sub = topic.status === 'open' ? 'เปิดโหวตอยู่' : topic.status === 'closed' ? 'ปิดโหวตแล้ว' : 'ยังไม่เปิดโหวต';
  const rule = topic.maxVotes > 1 ? ` · เลือกได้ ${topic.maxVotes} คน` : '';
  return `<header><p class="s-event">${esc(state.event.name)}</p><div class="s-head"><h1 class="s-title">${esc(topic.title)}</h1><p class="s-sub">${sub}${rule}</p></div></header>`;
}

function lobby() {
  const open = state.topics.filter((t) => t.status === 'open');
  return `<div class="lobby">
    <img class="qr-big" src="${qrSrc()}" alt="QR สำหรับเข้าโหวต">
    <div><h1>${esc(state.event.name)}</h1>
      <p class="scan">สแกน QR เพื่อเข้าร่วม</p><p class="url">${esc(state.voteUrl)}</p>
      ${open.length ? `<ul>${open.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>` : ''}
    </div></div>`;
}

function hidden(topic) {
  return header(topic) + `<div class="s-body"><div class="s-main">
    <div class="counter"><span class="n" id="voters">0</span><span class="t">คนโหวตแล้ว</span></div>
    ${topic.contestants.length ? `<div class="c-grid" style="--cols:${gridCols(topic.contestants.length)}">${topic.contestants.map((c) => `<div class="c-card">
      ${c.photo ? `<img class="ph" src="${esc(c.photo)}" alt="">` : `<div class="photo-ph">${esc(c.number)}</div>`}
      <span class="nm"><span class="no">${esc(c.number)}</span> ${esc(c.name)}</span></div>`).join('')}</div>` : '<p class="empty-stage">ยังไม่มีผู้เข้าประกวด</p>'}
    </div>${qrPanel()}</div>`;
}

// one contestant at a time while they walk on stage; the admin moves next / back
function intro(it) {
  const c = it.shown[it.index];
  const strip = Array.from({ length: it.total }, (_, i) => {
    const p = it.shown[i];
    const cls = i === it.index ? 'now' : p ? 'done' : 'next';
    return `<li class="${cls}">${p ? (p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span>${esc(p.number)}</span>`) : ''}</li>`;
  }).join('');
  return `<header class="compact"><p class="s-event">${esc(state.event.name)}</p><div class="s-head"><h1 class="s-title">${esc(it.title)}</h1>
      <p class="s-sub nowrap">แนะนำผู้เข้าประกวด · คนที่ ${it.index + 1} จาก ${it.total}</p></div></header>
    <div class="intro ${c.photo ? '' : 'no-photo'}" data-i="${it.index}">
      <div class="i-info"><span class="i-lbl">หมายเลข</span><span class="i-no">${esc(c.number)}</span><span class="i-name">${esc(c.name)}</span>
        <ol class="i-strip" aria-hidden="true">${strip}</ol></div>
      ${c.photo ? `<img class="i-photo" src="${esc(c.photo)}" alt="">` : ''}
    </div>`;
}

const gridCols = (n) => (n <= 5 ? 5 : n <= 12 ? 6 : n <= 21 ? 7 : 10);

function live(topic) {
  return header(topic) + `<div class="s-body"><div class="s-main">
    <div class="counter"><span class="n" id="voters" style="font-size:4vw">0</span><span class="t">คนโหวตแล้ว</span></div>
    <div class="bars" style="--n:${topic.contestants.length};--bfs:${Math.min(1.5, 13 / Math.max(topic.contestants.length, 1)).toFixed(2)}vw">${topic.contestants.map((c) => `<div class="bar-row" data-id="${c.id}">
      <div class="who">${photoHtml(c, 40)}<span class="nm"><span class="no">${esc(c.number)}</span>${esc(c.name)}</span></div>
      <div class="track"><div class="fill" style="width:0%"></div></div><span class="v">0</span></div>`).join('')}</div>
    </div>${qrPanel()}</div>`;
}

function reveal(topic, s) {
  const podium = s.podium || [];
  const size = s.podiumSize ?? 3;
  const slot = (place) => {
    const shown = podium.find((p) => p.place === place);
    const revealedYet = place > 3 - s.revealStep;
    let inner;
    if (shown) {
      inner = `<div class="ppl">${shown.winners.map((w) => `<div class="person">${photoHtml(w, 160)}<span class="pname">${esc(w.number)} · ${esc(w.name)}</span></div>`).join('')}</div>
        <span class="pvotes">${shown.votes} คะแนน${shown.winners.length > 1 ? ' · คะแนนเท่ากัน' : ''}</span>`;
    } else if (revealedYet || place > size) {
      inner = revealedYet ? '<span class="q">—</span><span class="pvotes">ไม่มีผู้ได้อันดับนี้</span>' : '<span class="q">?</span>';
    } else inner = '<span class="q">?</span>';
    const many = shown && shown.winners.length > 1 ? 'many' : '';
    const anim = revealedYet && place === 4 - s.revealStep ? 'pop' : '';
    const waiting = !revealedYet ? 'waiting' : '';
    return `<div class="place p${place} ${many} ${waiting}"><div class="slot ${anim}">${inner}</div><span class="rank">อันดับ ${place}</span></div>`;
  };
  const drum = s.revealStep === 0 ? '<p class="drum">ผลโหวตกำลังจะประกาศ…</p>' : s.revealStep === 3 ? `<p class="drum">ขอแสดงความยินดี</p>` : '';
  return header(topic) + `<div class="reveal">${drum}<div class="podium">${slot(2)}${slot(1)}${slot(3)}</div></div>`;
}

function patch(topic, s) {
  if (!topic) return;
  const vEl = $('#voters');
  if (vEl && s.voters !== undefined) {
    vEl.textContent = s.voters.toLocaleString('th-TH');
    if (lastVoters !== null && s.voters > lastVoters) { vEl.classList.remove('bump'); void vEl.offsetWidth; vEl.classList.add('bump'); }
    lastVoters = s.voters;
  }
  if (s.mode === 'live' && s.counts) {
    const max = Math.max(1, ...Object.values(s.counts));
    document.querySelectorAll('.bar-row').forEach((row) => {
      const n = s.counts[row.dataset.id] || 0;
      row.querySelector('.fill').style.width = (n / max) * 100 + '%';
      row.querySelector('.v').textContent = n.toLocaleString('th-TH');
    });
  }
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti');
  const colors = ['#d4a017', '#e8b931', '#b42318', '#fff8f0', '#f97066'];
  box.innerHTML = Array.from({ length: 140 }, () => {
    const d = 2.5 + Math.random() * 2.5;
    return `<i style="left:${Math.random() * 100}vw;background:${colors[Math.floor(Math.random() * colors.length)]};animation-duration:${d}s;animation-delay:${Math.random() * 1.2}s"></i>`;
  }).join('');
  setTimeout(() => { box.innerHTML = ''; }, 6000);
}
