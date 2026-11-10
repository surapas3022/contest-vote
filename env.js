'use strict';
/*
 * Reads KEY=VALUE lines from a .env file into process.env (no extra package needed on Node 18).
 * A variable that is already set — typed before the command or set by the host — always wins,
 * even when it is set to an empty string.
 *
 *   # comment                 KEY=value          export KEY=value
 *   KEY='value with # and spaces'                KEY="line one\nline two"
 *   KEY=value # comment after a space
 */
const fs = require('fs');

function parseValue(v) {
  let m = /^'([^']*)'\s*(?:#.*)?$/.exec(v);
  if (m) return m[1];
  m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(v);
  if (m) return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
  return v.replace(/(^|\s+)#.*$/, '').trim();
}

/** → { file, loaded: [names], skipped: [names already set], bad: [line numbers] } or null when there is no file */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const out = { file, loaded: [], skipped: [], bad: [] };
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { out.bad.push(i + 1); return; }
    if (Object.prototype.hasOwnProperty.call(process.env, m[1])) { out.skipped.push(m[1]); return; }
    process.env[m[1]] = parseValue(m[2]);
    out.loaded.push(m[1]);
  });
  return out;
}

module.exports = { loadEnvFile, parseValue };
