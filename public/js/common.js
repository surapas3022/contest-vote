// Shared helpers: API calls, escaping, icons (lucide paths), toast, confirm dialog, live stream.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function api(method, url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('เชื่อมต่อไม่ได้ ตรวจสัญญาณอินเทอร์เน็ตแล้วลองอีกครั้ง', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'ระบบขัดข้อง ลองอีกครั้ง', res.status, data);
  return data;
}

// lucide icon paths (ISC license)
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.83 0L6 21"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  expand: '<path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/>',
  wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><line x1="2" x2="22" y1="2" y2="22"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

/**
 * Confirm dialog with outcome-named buttons. Optional typed confirmation.
 * Resolves true if confirmed.
 */
function confirmDialog({ title, body, confirmLabel, cancelLabel = 'ยกเลิก', danger = true, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.innerHTML = `
      <form method="dialog" class="dlg-body">
        <h2 style="font-size:var(--fs-20)">${esc(title)}</h2>
        <p class="muted">${body}</p>
        ${typeToConfirm ? `<div class="field"><label for="dlg-type">พิมพ์ “${esc(typeToConfirm)}” เพื่อยืนยัน</label><input id="dlg-type" class="input" autocomplete="off"></div>` : ''}
        <div class="dlg-actions">
          <button value="cancel" class="btn btn-ghost">${esc(cancelLabel)}</button>
          <button value="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button>
        </div>
      </form>`;
    document.body.append(dlg);
    const okBtn = dlg.querySelector('button[value=ok]');
    const typed = dlg.querySelector('#dlg-type');
    if (typed) typed.addEventListener('input', () => { okBtn.disabled = typed.value.trim() !== typeToConfirm; });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    dlg.showModal();
    (typed || dlg.querySelector('button[value=cancel]')).focus();
  });
}

/*
 * Live data that keeps working when the live stream doesn't.
 * - The snapshot is read once with a plain GET right away, so the page never waits on the stream.
 * - SSE is used when it actually delivers. A proxy that holds the stream back (Cloudflare Quick
 *   Tunnel, buffering proxies) shows up as "no data within a few seconds": the stream is closed so
 *   it doesn't occupy a request slot, and this device stops trying it for a while.
 * - Whenever the stream isn't delivering, the snapshot is asked for every few seconds instead.
 */
const NO_STREAM_KEY = 'cv_nostream_until';
const STREAM_FIRST_MS = 6000;  // stream must deliver its first message within this
const STREAM_SILENT_MS = 40000; // server pings every 15 s; longer silence = stuck
const STREAM_RETRY_MS = 30000; // after a drop, try the stream again (while polling meanwhile)
function streamBlocked() {
  if (/\.trycloudflare\.com$/i.test(location.hostname)) return true; // documented: no SSE
  try { return Number(localStorage.getItem(NO_STREAM_KEY)) > Date.now(); } catch { return false; }
}
function blockStream() {
  try { localStorage.setItem(NO_STREAM_KEY, String(Date.now() + 6 * 3600 * 1000)); } catch { /* storage off */ }
}

/**
 * liveStream(streamUrl, onData, onState, { stateUrl, pollMs }) → stop()
 * stateUrl defaults to streamUrl with /stream → /state. onData only fires when the data changed.
 */
function liveStream(url, onData, onState, opts = {}) {
  const stateUrl = opts.stateUrl || url.replace(/\/stream$/, '/state');
  const pollMs = opts.pollMs || 3000;
  let es = null; let streaming = false; let stopped = false; let silentDrops = 0;
  let last = null; let lastPollOkAt = 0; let pollTimer = null; let watchTimer = null; let retryTimer = null; let polling = false;
  const setState = (ok) => onState && onState(ok);
  const deliver = (text) => {
    if (text === last) return;
    let data; try { data = JSON.parse(text); } catch { return; }
    last = text; onData(data);
  };

  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (stopped || streaming || polling) return;
    polling = true;
    try {
      const res = await fetch(stateUrl, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      // once the stream is delivering, a reply that was already in flight may be older: drop it
      lastPollOkAt = Date.now();
      if (!stopped && !streaming) { deliver(text); setState(true); }
    } catch { if (!stopped && !streaming) setState(false); }
    polling = false;
    schedulePoll();
  }
  function schedulePoll() {
    if (stopped || streaming || pollTimer || document.hidden) return; // hidden tab: resume on visible
    pollTimer = setTimeout(poll, pollMs * (0.8 + Math.random() * 0.4)); // jitter: phones don't sync up
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || stopped) return;
    // phone woke up: a stream that slept may be dead without an error → check right away
    if (streaming && Date.now() - lastEventAt > 20000) dropStream(true);
    else if (!streaming) poll();
  });
  let lastEventAt = 0;

  function arm(ms, onTimeout) { clearTimeout(watchTimer); watchTimer = setTimeout(onTimeout, ms); }
  function dropStream(retry) {
    clearTimeout(watchTimer);
    if (es) { es.close(); es = null; }
    streaming = false;
    poll();
    clearTimeout(retryTimer);
    if (retry && !stopped) retryTimer = setTimeout(openStream, STREAM_RETRY_MS);
  }
  function openStream() {
    if (stopped || es || streamBlocked()) return;
    let got = false;
    const src = new EventSource(url);
    es = src;
    // no data while plain requests to the same server get through (or headers came back empty):
    // something in between holds the stream → stop using it on this device for a while
    const opened = Date.now();
    arm(STREAM_FIRST_MS, () => {
      const held = src.readyState === EventSource.OPEN || lastPollOkAt >= opened;
      if (held) blockStream();
      dropStream(!held);
    });
    const alive = () => { lastEventAt = Date.now(); arm(STREAM_SILENT_MS, () => {
      // worked, then went quiet: try again later; twice in a row → treat like a buffering proxy
      if (++silentDrops >= 2) { blockStream(); dropStream(false); } else dropStream(true);
    }); };
    src.onmessage = (e) => {
      if (!got) { got = true; streaming = true; clearTimeout(pollTimer); pollTimer = null; }
      alive(); setState(true); deliver(e.data);
    };
    // pings arriving on time = the path really is live → forget earlier silent drops
    src.addEventListener('ping', () => { if (got) { silentDrops = 0; alive(); } });
    // extra named events (the big screen's cheers): data that is not the page state
    for (const [name, fn] of Object.entries(opts.events || {})) src.addEventListener(name, (e) => {
      if (!got) return;
      alive(); let d; try { d = JSON.parse(e.data); } catch { return; } fn(d);
    });
    src.onerror = () => { if (es === src) dropStream(true); }; // poll at once, reconnect later
  }

  poll();
  openStream();
  return () => {
    stopped = true;
    clearTimeout(pollTimer); clearTimeout(watchTimer); clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
  };
}

/** Button pending state: prevents double press. */
async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.removeAttribute('aria-busy'); }
}

function photoHtml(c, size, cls = '') {
  const style = `width:${size}px;height:${size}px;border-radius:var(--radius-control);object-fit:cover;flex:none`;
  return c.photo
    ? `<img src="${esc(c.photo)}" alt="" class="${cls}" style="${style}" loading="lazy">`
    : `<div class="photo-ph ${cls}" style="${style};font-size:${Math.round(size / 3)}px" aria-hidden="true">${esc(c.number)}</div>`;
}
