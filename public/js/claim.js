'use strict';
// Claim a vote card from the registration desk QR. Nothing is used up until the guest presses "รับบัตร",
// so link previews in camera or chat apps cannot take the ticket. The card is kept on this phone and can be
// saved as a picture; its QR is the same signed link as a printed card.
const CARD_KEY = 'cv_card';
const TOKEN_KEY = 'cv_token'; // shared with the voter page, so "เข้าร่วมกิจกรรม" is already signed in
const ticket = new URLSearchParams(location.search).get('t');
// keep the one-time ticket out of history and of anything shared from this page
if (ticket) history.replaceState(null, '', location.pathname);

const stored = () => { try { return JSON.parse(localStorage.getItem(CARD_KEY) || 'null'); } catch { return null; } };

function renderStart(err = '') {
  $('#app').innerHTML = `
    <p class="ev" id="ev"></p>
    <h1>รับบัตรโหวตของคุณ</h1>
    <p class="lead">กดปุ่มด้านล่างเพื่อรับบัตร บัตรนี้ใช้เชียร์และโหวตตลอดงาน คนละ 1 ใบ</p>
    ${err ? `<div class="banner banner-error" role="alert">${icon('alert')}<span>${esc(err)}</span></div>` : ''}
    <button class="btn btn-primary btn-big" id="claim" ${ticket ? '' : 'disabled'}>รับบัตร</button>
    ${ticket ? '' : '<p class="lead">ไม่พบ QR ที่สแกน สแกน QR ที่จุดลงทะเบียนอีกครั้ง</p>'}`;
  api('GET', '/api/state').then((st) => { const ev = $('#ev'); if (ev) ev.textContent = st.event.name; }, () => {});
  const b = $('#claim');
  if (b && ticket) b.addEventListener('click', () => busy(b, claim));
}

async function claim() {
  try {
    const r = await api('POST', '/api/desk/claim', { t: ticket });
    const card = { eventName: r.eventName, code: r.code, qr: r.qr, link: r.link, voteUrl: r.link.split('?')[0] };
    localStorage.setItem(CARD_KEY, JSON.stringify(card));
    localStorage.setItem(TOKEN_KEY, r.token);
    renderCard(card, true);
  } catch (e) { renderStart(e.message); }
}

function renderCard(card, fresh = false) {
  $('#app').innerHTML = `
    <h1>${fresh ? 'ได้บัตรแล้ว' : 'บัตรโหวตของคุณ'}</h1>
    <div class="ticket" id="ticket">
      <span class="t-ev">${esc(card.eventName)}</span><span class="t-lbl">บัตรโหวต</span>
      <span class="t-qr" role="img" aria-label="QR บัตรโหวตของคุณ">${card.qr}</span>
      <span class="t-code">${esc(card.code)}</span>
      <span class="t-how">สแกน QR หรือเข้า ${esc(card.voteUrl)} แล้วกรอกรหัส</span>
    </div>
    <p class="warn">${icon('alert')}<span>บันทึกรูปไว้ ถ้าเปลี่ยนเครื่องหรือล้างเบราว์เซอร์ ใช้ QR ในรูปเข้าได้อีกครั้ง · รูปนี้คือสิทธิ์โหวตของคุณ อย่าโพสต์หรือส่งต่อ</span></p>
    <div class="actions">
      <button class="btn btn-big" id="save">${icon('download')}บันทึกรูปบัตร</button>
      <div class="banner banner-error" id="save-err" role="alert" hidden>${icon('alert')}<span>บันทึกรูปไม่ได้ในเบราว์เซอร์นี้ แคปหน้าจอบัตรด้านบนเก็บไว้แทนได้ ใช้ได้เหมือนกัน</span></div>
      <a class="btn btn-primary btn-big" href="/">เข้าร่วมกิจกรรม${icon('chevronRight')}</a>
    </div>
    ${ticket && !fresh ? `<button class="btn btn-ghost btn-sm" id="again">ใช้เครื่องนี้รับบัตรให้อีกคน</button>` : ''}`;
  $('#save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const box = $('#save-err');
    try { await saveImage(card); box.hidden = true; } catch {
      // stays on the page: the screenshot is always a way out
      box.hidden = false;
    }
  }));
  const again = $('#again');
  if (again) again.addEventListener('click', () => renderStart());
}

/* ---------- card as a picture ---------- */

function loadSvg(svg) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// wrap Thai text by measured width (Intl.Segmenter splits Thai into words where supported)
function wrap(ctx, text, max) {
  const seg = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map((x) => x.segment) : text.split(/(\s+)/);
  const lines = []; let line = '';
  for (const w of seg) {
    if (ctx.measureText(line + w).width > max && line) { lines.push(line.trim()); line = w; } else line += w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

async function saveImage(card) {
  const W = 1080, H = 1440, P = 72;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  await Promise.all(['700 56px Anuphan', '400 36px Anuphan'].map((f) => document.fonts.load(f)));
  ctx.fillStyle = '#140c0b'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(P, P, W - 2 * P, H - 2 * P, 40); ctx.fill();
  ctx.textAlign = 'center'; ctx.fillStyle = '#1f1715';
  ctx.font = '700 56px Anuphan';
  let y = P + 120;
  for (const l of wrap(ctx, card.eventName, W - 4 * P).slice(0, 2)) { ctx.fillText(l, W / 2, y); y += 80; }
  ctx.font = '400 36px Anuphan'; ctx.fillStyle = '#6b5f5c'; ctx.fillText('บัตรโหวต', W / 2, y + 10);
  const qr = await loadSvg(card.qr);
  const Q = 620; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, (W - Q) / 2, y + 60, Q, Q);
  ctx.fillStyle = '#1f1715'; ctx.font = '700 88px ui-monospace, Menlo, monospace';
  ctx.fillText(card.code, W / 2, y + 60 + Q + 120);
  ctx.fillStyle = '#6b5f5c'; ctx.font = '400 30px Anuphan';
  let y2 = y + 60 + Q + 200;
  for (const l of wrap(ctx, `สแกน QR หรือเข้า ${card.voteUrl} แล้วกรอกรหัส · อย่าโพสต์หรือส่งต่อ`, W - 4 * P)) { ctx.fillText(l, W / 2, y2); y2 += 46; }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const name = `บัตรโหวต-${card.code}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  // phones: the share sheet has "Save Image"; elsewhere: a normal download
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'บัตรโหวต' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('บันทึกรูปบัตรแล้ว');
}

const have = stored();
if (have) renderCard(have); else renderStart();
