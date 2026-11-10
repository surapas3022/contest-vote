'use strict';
// Proof-of-work for name-mode join (anti name-guessing that does not lock out a shared Wi-Fi).
// Find x so that sha256(hex(sha256(c)) + x) starts with `bits` zero bits.
// Pure JS SHA-256 on purpose: crypto.subtle is missing on plain-http LAN pages.
// Loaded as a page script (solvePow) and also as its own Web Worker.

const POW_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const POW_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** one SHA-256 compression: state (8 words) ← block (64 bytes at offset) */
function powCompress(st, bytes, off, w) {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + POW_K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
}

function powSha256Hex(str) {
  const msg = new TextEncoder().encode(str);
  const len = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(len);
  buf.set(msg); buf[msg.length] = 0x80;
  const bitLen = msg.length * 8;
  buf[len - 4] = (bitLen >>> 24) & 255; buf[len - 3] = (bitLen >>> 16) & 255; buf[len - 2] = (bitLen >>> 8) & 255; buf[len - 1] = bitLen & 255;
  buf[len - 5] = Math.floor(bitLen / 2 ** 32) & 255;
  const st = Int32Array.from(POW_IV); const w = new Int32Array(64);
  for (let off = 0; off < len; off += 64) powCompress(st, buf, off, w);
  return Array.from(st, (x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** search nonces [from, from+count); returns the winning nonce string or null */
function powSearch(c, bits, from, count) {
  const prefix = new TextEncoder().encode(powSha256Hex(c)); // exactly 64 bytes = one block
  const w = new Int32Array(64);
  const mid = Int32Array.from(POW_IV);
  powCompress(mid, prefix, 0, w);
  const block = new Uint8Array(64); const st = new Int32Array(8);
  const shift = 32 - Math.min(bits, 32);
  for (let n = from; n < from + count; n++) {
    const s = String(n);
    block.fill(0);
    for (let i = 0; i < s.length; i++) block[i] = s.charCodeAt(i);
    block[s.length] = 0x80;
    const bitLen = (64 + s.length) * 8;
    block[62] = bitLen >>> 8; block[63] = bitLen & 255;
    st.set(mid);
    powCompress(st, block, 0, w);
    if (bits === 0 || (st[0] >>> shift) === 0) {
      if (bits <= 32) return s;
      if (bits <= 64 && (st[1] >>> (64 - bits)) === 0) return s;
    }
  }
  return null;
}

if (typeof importScripts === 'function') {
  // running as a Web Worker
  self.onmessage = (e) => {
    const { c, bits } = e.data;
    for (let from = 0; ; from += 1e6) {
      const x = powSearch(c, bits, from, 1e6);
      if (x !== null) { self.postMessage(x); return; }
    }
  };
} else {
  /** → Promise<string>; runs in a worker so the page stays responsive, falls back to small slices */
  self.solvePow = function solvePow(c, bits) {
    return new Promise((resolve) => {
      let worker = null;
      try { worker = new Worker('/js/pow.js'); } catch { worker = null; }
      if (worker) {
        worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
        worker.onerror = () => { worker.terminate(); slices(); };
        worker.postMessage({ c, bits });
      } else slices();
      function slices(from = 0) {
        const x = powSearch(c, bits, from, 20000);
        if (x !== null) resolve(x); else setTimeout(() => slices(from + 20000), 0);
      }
    });
  };
}
