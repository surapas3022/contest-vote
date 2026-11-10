'use strict';
/*
 * Small SMTP client for sending the code emails through Gmail or a company mail server.
 * Built on node's net/tls instead of nodemailer: the nodemailer releases that still run on
 * Node 18 carry open security advisories, and the fixed ones need Node 20.
 *
 * Covers what this app needs and nothing more: implicit TLS (port 465) or STARTTLS (587/25),
 * always with a verified certificate (no plain-text fallback: the login and the mail only go
 * over an encrypted connection whose certificate checked out, or not at all),
 * AUTH PLAIN / LOGIN, one recipient per message, an HTML + text body with attachments (inline
 * by Content-ID or regular), and a small pool so a batch does not log in once per email.
 */
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

class SmtpError extends Error {
  /**
   * code: ECONNECTION | ETIMEDOUT | ETLS | ENOTLS | EAUTH | EPROTOCOL
   * stage: connect | greeting | ehlo | starttls | auth | mail | rcpt | data
   * tls (ETLS only): 'cert' = certificate not trusted · 'name' = certificate is for another host · 'other'
   */
  constructor(message, { code, responseCode, response, stage, tls: tlsKind } = {}) {
    super(message);
    Object.assign(this, { code, responseCode: responseCode || 0, response: response || '', stage: stage || '', tls: tlsKind || '' });
  }
}

const CRLF = '\r\n';
const TLS_ERR = /CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME|ERR_SSL|ERR_TLS|wrong version number|handshake|alert/i;
const CERT_UNTRUSTED = /SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|CERT_UNTRUSTED|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_REVOKED|INVALID_CA|CERT_SIGNATURE_FAILURE/i;
const CERT_WRONG_NAME = /ALTNAME|HOSTNAME|IP: .* is not in the cert|Host: .* is not in the cert/i;

function netError(e, stage) {
  if (e instanceof SmtpError) return e;
  const msg = String(e && (e.code || e.message) || e);
  const all = `${msg} ${String(e && e.message)}`;
  const isTls = TLS_ERR.test(all);
  const code = isTls ? 'ETLS' : e && e.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'ECONNECTION';
  const kind = !isTls ? '' : CERT_WRONG_NAME.test(all) ? 'name' : CERT_UNTRUSTED.test(all) ? 'cert' : 'other';
  return new SmtpError(String(e && e.message || msg), { code, stage, tls: kind });
}

/**
 * TLS settings for both port 465 and STARTTLS. The certificate is always checked, against the
 * system's trusted roots plus the company's own CA (opts.ca, PEM text) when given. `host` is
 * passed even when upgrading an existing socket, so the name check uses the real host, not "localhost".
 */
function tlsOptions(o) {
  return {
    servername: net.isIP(o.host) ? undefined : o.host,
    host: o.host,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(o.ca ? { ca: [...tls.rootCertificates, ...[].concat(o.ca)] } : {}),
  };
}

const clientName = () => (os.hostname() || '').replace(/[^A-Za-z0-9.-]/g, '').replace(/^[.-]+|[.-]+$/g, '') || 'localhost';

class Connection {
  constructor(opts, onClose) {
    this.opts = opts; this.onClose = onClose;
    this.buf = ''; this.cur = []; this.ready = []; this.waiters = [];
    this.closed = false; this.dirty = false; this.sent = 0; this.ext = new Map();
  }

  async open() {
    const o = this.opts;
    const tlsOpts = tlsOptions(o);
    const sock = await new Promise((resolve, reject) => {
      const s = o.secure ? tls.connect({ host: o.host, port: o.port, ...tlsOpts }) : net.connect({ host: o.host, port: o.port });
      const fail = (e) => { s.destroy(); reject(netError(e, 'connect')); };
      const late = () => fail(new SmtpError(`ต่อไม่ติดภายใน ${o.timeout / 1000} วินาที`, { code: 'ETIMEDOUT', stage: 'connect' }));
      s.once('error', fail);
      s.setTimeout(o.timeout); s.once('timeout', late);
      s.once(o.secure ? 'secureConnect' : 'connect', () => { s.off('error', fail); s.off('timeout', late); resolve(s); });
    });
    this.attach(sock);
    await this.expect([220], 'greeting');
    await this.ehlo();
    if (!o.secure) {
      // Never go on in the clear: no password, no message. A server that does not offer STARTTLS
      // may really lack it, or someone on the network removed the line from its reply.
      if (!this.ext.has('STARTTLS')) {
        throw new SmtpError('เซิร์ฟเวอร์ไม่เสนอ STARTTLS', { code: 'ENOTLS', stage: 'starttls' });
      }
      const r = await this.cmd('STARTTLS', [220], 'starttls');
      // anything already sent after the 220 arrived unencrypted and must not be read as if it came over TLS
      if (this.buf || this.cur.length || this.ready.length) {
        throw new SmtpError('เซิร์ฟเวอร์ส่งข้อมูลแทรกมาก่อนเริ่มเข้ารหัส', { code: 'EPROTOCOL', stage: 'starttls', response: r.text });
      }
      await this.upgrade(tlsOpts);
      await this.ehlo();
    }
    if (!(this.socket instanceof tls.TLSSocket && this.socket.encrypted && this.socket.authorized)) {
      throw new SmtpError('การเชื่อมต่อยังไม่ได้เข้ารหัสหรือยังไม่ได้ตรวจใบรับรอง', { code: 'ENOTLS', stage: 'starttls' });
    }
    if (o.user) await this.auth();
  }

  attach(s) {
    this.socket = s;
    s.setTimeout(this.opts.timeout);
    this.onData = (d) => this.feed(d);
    this.onTimeout = () => this.destroy(new SmtpError(`เซิร์ฟเวอร์อีเมลไม่ตอบภายใน ${this.opts.timeout / 1000} วินาที`, { code: 'ETIMEDOUT' }));
    this.onError = (e) => this.destroy(netError(e));
    this.onEnd = () => this.destroy(new SmtpError('เซิร์ฟเวอร์อีเมลปิดการเชื่อมต่อ', { code: 'ECONNECTION' }));
    s.on('data', this.onData); s.on('timeout', this.onTimeout); s.on('error', this.onError); s.on('close', this.onEnd);
  }
  detach() {
    const s = this.socket;
    s.off('data', this.onData); s.off('timeout', this.onTimeout); s.off('error', this.onError); s.off('close', this.onEnd);
  }

  upgrade(tlsOpts) {
    this.detach();
    const plain = this.socket;
    plain.setTimeout(0); // the TLS socket on top keeps its own timer
    plain.on('error', () => {}); // its errors reach the TLS socket too
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, ...tlsOpts });
      const fail = (e) => { s.destroy(); this.destroy(netError(e, 'starttls')); reject(netError(e, 'starttls')); };
      s.once('error', fail);
      s.once('secureConnect', () => { s.off('error', fail); this.attach(s); resolve(); });
    });
  }

  feed(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) { this.destroy(new SmtpError('เซิร์ฟเวอร์ตอบกลับในรูปแบบที่ไม่รู้จัก: ' + line.slice(0, 100), { code: 'EPROTOCOL' })); return; }
      this.cur.push(m[3]);
      if (m[2] !== '-') {
        const r = { code: Number(m[1]), lines: this.cur, text: `${m[1]} ${this.cur.join(' ')}`.trim() };
        this.cur = [];
        const w = this.waiters.shift();
        if (w) w.resolve(r); else this.ready.push(r);
      }
    }
  }

  read() {
    if (this.ready.length) return Promise.resolve(this.ready.shift());
    if (this.closed) return Promise.reject(this.closeErr);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  write(s) {
    if (this.closed) throw this.closeErr;
    this.socket.write(s);
  }
  async expect(okCodes, stage) {
    let r;
    try { r = await this.read(); } catch (e) { throw Object.assign(e, { stage: e.stage || stage }); }
    if (!okCodes.includes(r.code)) {
      throw new SmtpError(r.text, { code: stage === 'auth' ? 'EAUTH' : 'EPROTOCOL', responseCode: r.code, response: r.text, stage });
    }
    return r;
  }
  cmd(line, okCodes, stage) { this.write(line + CRLF); return this.expect(okCodes, stage); }

  async ehlo() {
    let r;
    try { r = await this.cmd('EHLO ' + clientName(), [250], 'ehlo'); } catch (e) {
      if (!(e.responseCode >= 500)) throw e;
      r = await this.cmd('HELO ' + clientName(), [250], 'ehlo');
    }
    this.ext = new Map(r.lines.slice(1).map((l) => { const [k, ...v] = l.trim().split(/[\s=]+/); return [k.toUpperCase(), v.map((x) => x.toUpperCase())]; }));
  }

  async auth() {
    const { user, pass } = this.opts;
    const mechs = this.ext.get('AUTH') || [];
    if (mechs.includes('PLAIN') || !mechs.includes('LOGIN')) {
      await this.cmd('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64'), [235], 'auth');
    } else {
      await this.cmd('AUTH LOGIN', [334], 'auth');
      await this.cmd(Buffer.from(user, 'utf8').toString('base64'), [334], 'auth');
      await this.cmd(Buffer.from(pass, 'utf8').toString('base64'), [235], 'auth');
    }
  }

  async send(from, to, raw) {
    if (this.dirty) await this.cmd('RSET', [250], 'mail');
    this.dirty = true;
    await this.cmd(`MAIL FROM:<${from}>`, [250], 'mail');
    await this.cmd(`RCPT TO:<${to}>`, [250, 251], 'rcpt');
    await this.cmd('DATA', [354], 'data');
    // dot-stuffing: a line that starts with "." would otherwise end the message early
    const r = await this.cmd(raw.replace(/(^|\r\n)\./g, '$1..') + CRLF + '.', [250], 'data');
    this.dirty = false; this.sent++;
    return r.text;
  }

  destroy(err) {
    if (this.closed) return;
    this.closed = true;
    this.closeErr = err || new SmtpError('ปิดการเชื่อมต่อแล้ว', { code: 'ECONNECTION' });
    for (const w of this.waiters.splice(0)) w.reject(this.closeErr);
    if (this.socket) { this.detach(); this.socket.on('error', () => {}); this.socket.destroy(); }
    if (this.onClose) this.onClose(this);
  }
  quit() {
    if (this.closed) return;
    try { this.socket.write('QUIT' + CRLF); this.socket.end(); } catch { /* closing anyway */ }
    this.destroy();
  }
}

/* ---------------- message ---------------- */

const ASCII = /^[\x20-\x7e]*$/;
const noBreaks = (s) => String(s || '').replace(/[\r\n]+/g, ' ');

/** RFC 2047 encoded words, each ≤ 75 chars, folded onto continuation lines */
function encodeWords(s) {
  s = noBreaks(s);
  if (ASCII.test(s)) return s;
  const words = []; let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(CRLF + ' ');
}
function address({ name, email }) {
  name = noBreaks(name).trim();
  if (!name) return email;
  return `${ASCII.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeWords(name)} <${email}>`;
}
const b64 = (buf) => buf.toString('base64').replace(/.{76}(?=.)/g, '$&' + CRLF);
const boundary = () => '=_cv_' + crypto.randomBytes(12).toString('hex');
const MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf' };

const textPart = (type, s) => ({ headers: [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64'], body: b64(Buffer.from(s, 'utf8')) });
function attachmentPart(a) {
  const filename = String(a.filename || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  const type = MIME_TYPES[filename.split('.').pop().toLowerCase()] || 'application/octet-stream';
  return {
    headers: [`Content-Type: ${type}; name="${filename}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${a.cid ? 'inline' : 'attachment'}; filename="${filename}"`,
      ...(a.cid ? [`Content-ID: <${String(a.cid).replace(/[^A-Za-z0-9.@_-]/g, '')}>`] : [])],
    body: b64(a.content),
  };
}
function multipart(kind, parts) {
  const b = boundary();
  return {
    headers: [`Content-Type: multipart/${kind}; boundary="${b}"`],
    body: parts.map((p) => `--${b}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join('') + `--${b}--`,
  };
}

/** { from:{name,email}, to:{name,email}, subject, html, text, attachments:[{ filename, content: Buffer, cid? }] } → { raw, messageId } */
function buildMessage(m) {
  for (const a of [m.from.email, m.to.email]) if (!a || /[\s<>]/.test(a)) throw new SmtpError('อีเมลไม่ถูกต้อง: ' + a, { code: 'EPROTOCOL' });
  const atts = m.attachments || [];
  let body = multipart('alternative', [textPart('text/plain', m.text || ''), textPart('text/html', m.html || '')]);
  const inline = atts.filter((a) => a.cid); const regular = atts.filter((a) => !a.cid);
  if (inline.length) body = multipart('related', [body, ...inline.map(attachmentPart)]);
  if (regular.length) body = multipart('mixed', [body, ...regular.map(attachmentPart)]);
  const messageId = `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${m.from.email.split('@')[1]}>`;
  const headers = [
    `From: ${address(m.from)}`, `To: ${address(m.to)}`, `Subject: ${encodeWords(m.subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
    ...body.headers,
  ];
  return { raw: headers.join(CRLF) + CRLF + CRLF + body.body, messageId };
}

/* ---------------- pool ---------------- */

/**
 * opts: { host, port, secure, user, pass, ca (PEM text of extra trusted CA certificates), timeout = 30000, maxConnections = 3, maxMessages = 100 }
 * → { send(message) → { messageId, response }, verify(), close() }
 */
function createSmtpPool(opts) {
  opts = { timeout: 30000, maxConnections: 3, maxMessages: 100, ...opts };
  const live = new Set(); const idle = []; const waiting = [];
  const wake = () => { const w = waiting.shift(); if (w) w(); };
  const onClose = (c) => {
    live.delete(c);
    const i = idle.indexOf(c);
    if (i >= 0) idle.splice(i, 1);
    wake();
  };

  async function acquire() {
    for (;;) {
      const c = idle.pop();
      if (c) return c;
      if (live.size < opts.maxConnections) {
        const n = new Connection(opts, onClose);
        live.add(n);
        try { await n.open(); } catch (e) { n.destroy(e); throw e; }
        return n;
      }
      await new Promise((r) => waiting.push(r));
    }
  }
  function release(c, reusable) {
    if (reusable && !c.closed && c.sent < opts.maxMessages) { idle.push(c); wake(); } else c.quit();
  }

  return {
    async send(message) {
      const { raw, messageId } = buildMessage(message);
      const c = await acquire();
      try {
        const response = await c.send(message.from.email, message.to.email, raw);
        release(c, true);
        return { messageId, response };
      } catch (e) {
        // a refused address leaves the connection usable (RSET next time); anything else starts fresh
        release(c, e.responseCode >= 500 && e.stage !== 'auth');
        throw e;
      }
    },
    /** connect and log in once, then hang up */
    async verify() {
      const c = new Connection(opts);
      try { await c.open(); } finally { c.quit(); }
    },
    close() { for (const c of [...live]) c.quit(); },
  };
}

module.exports = { createSmtpPool, buildMessage, SmtpError };
