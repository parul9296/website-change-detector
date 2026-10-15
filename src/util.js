const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = (t = Date.now()) => new Date(t).toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const splitList = s => (s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);

function withTimeout(promise, ms, label = 'Job') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })
  ]);
}

// Normalise a URL so that the same page watched by many users is fetched once
const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;
function normalizeUrl(u) {
  const x = new URL(u);
  x.hash = '';
  x.hostname = x.hostname.toLowerCase();
  [...x.searchParams.keys()].filter(k => TRACKING.test(k)).forEach(k => x.searchParams.delete(k));
  x.searchParams.sort();
  let s = x.toString();
  if (x.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// Public pages only: block private / local network addresses and credentials in URLs
function validateUrl(u) {
  let x;
  try { x = new URL(u); } catch { return 'Invalid URL'; }
  if (!/^https?:$/.test(x.protocol)) return 'Only http(s) URLs are allowed';
  if (x.username || x.password) return 'URLs with credentials are not allowed (public pages only)';
  if (process.env.ALLOW_PRIVATE === '1') return null;
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i.test(h)
      || h.endsWith('.local') || h.endsWith('.internal'))
    return 'Only public pages can be monitored';
  return null;
}

const host = u => new URL(u).hostname;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { sha, iso, sleep, splitList, withTimeout, normalizeUrl, validateUrl, host, esc };
