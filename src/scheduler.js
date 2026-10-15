// Scheduler + job queue: shared fetches per URL, per-domain rate limit, timeouts, retries with backoff
const fs = require('fs');
const path = require('path');
const { db, SHOTS } = require('./db');
const { sha, iso, sleep, withTimeout, host } = require('./util');
const { clean, changeStats } = require('./noise');
const { fetchGroup } = require('./fetcher');
const { notify, runDigest } = require('./alerts');

const MAX_CONCURRENCY = +process.env.MAX_CONCURRENCY || 2;   // jobs running at once
const DOMAIN_GAP_MS   = +process.env.DOMAIN_GAP_MS || 5000;  // min gap between hits to the same site
const JOB_TIMEOUT_MS  = +process.env.JOB_TIMEOUT_MS || 60000;
const RETRIES         = +process.env.RETRIES || 3;
const DIGEST_HOUR     = process.env.DIGEST_HOUR === undefined ? 9 : +process.env.DIGEST_HOUR;

const queue = [];            // normalised URLs waiting to be fetched
const queued = new Set();    // de-duplicates jobs: one job per URL, no matter how many watchers
const lastHit = new Map();   // host -> last request time
let running = 0, pumpTimer = null;

const q = {
  latest: db.prepare('SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1'),
  insert: db.prepare(`INSERT INTO snapshots(monitor_id, text, hash, shot, change_pct, summary, created_at)
                      VALUES (?,?,?,?,?,?,?)`),
  finish: db.prepare('UPDATE monitors SET status=?, last_error=?, last_checked=?, next_check=? WHERE id=?'),
  changed: db.prepare('UPDATE monitors SET last_changed=? WHERE id=?')
};

// Next check = interval + up to 5% random jitter so checks don't all fire at the same moment
function finish(m, status, error = null) {
  const jitter = Math.random() * Math.min(m.interval_min * 60000 * 0.05, 120000);
  q.finish.run(status, error, iso(), Date.now() + m.interval_min * 60000 + jitter, m.id);
}

function enqueueDue() {
  const due = db.prepare('SELECT DISTINCT norm_url FROM monitors WHERE paused = 0 AND next_check <= ?').all(Date.now());
  for (const { norm_url } of due) if (!queued.has(norm_url)) { queued.add(norm_url); queue.push(norm_url); }
  pump();
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const i = queue.findIndex(u => Date.now() - (lastHit.get(host(u)) || 0) >= DOMAIN_GAP_MS);
    if (i === -1) { // every queued site was hit too recently - try again shortly
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 1000);
      return;
    }
    const url = queue.splice(i, 1)[0];
    running++;
    lastHit.set(host(url), Date.now());
    runJob(url).catch(e => console.error('Job crashed:', e)).finally(() => { running--; queued.delete(url); enqueueDue(); });
  }
}

async function runJob(normUrl) {
  const due = db.prepare('SELECT * FROM monitors WHERE norm_url = ? AND paused = 0 AND next_check <= ?').all(normUrl, Date.now() + 5000);
  if (!due.length) return;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const shotName = `${sha(normUrl).slice(0, 12)}-${Date.now()}.png`;
    const shotPath = path.join(SHOTS, shotName);
    try {
      const r = await withTimeout(fetchGroup(due[0].url, due, shotPath), JOB_TIMEOUT_MS, 'Check');
      if (r.blocked) { due.forEach(m => finish(m, 'blocked', r.reason)); return; }
      let used = false;
      for (const m of due) used = (await processResult(m, r.results[m.id], shotName)) || used;
      if (!used) fs.rmSync(shotPath, { force: true }); // nothing changed -> don't keep the screenshot
      return;
    } catch (e) {
      fs.rmSync(shotPath, { force: true });
      console.warn(`Check failed (${attempt}/${RETRIES}) ${normUrl}: ${e.message}`);
      if (attempt === RETRIES) { due.forEach(m => finish(m, 'error', e.message)); return; }
      await sleep(2000 * 2 ** attempt + Math.random() * 1000); // exponential backoff + jitter
    }
  }
}

async function processResult(m, raw, shot) {
  const text = clean(raw, { ignoreNumbers: !!m.ignore_numbers });
  if (!text) { finish(m, 'error', m.watch_css ? 'Watched region not found on page' : 'Page has no text'); return false; }

  const hash = sha(text);
  const last = q.latest.get(m.id);
  if (last && last.hash === hash) { finish(m, 'ok'); return false; }   // same content hash -> no new snapshot

  let stats = null;
  if (last) {
    stats = changeStats(last.text, text);
    if (stats.pct < (m.sensitivity || 0)) { finish(m, 'ok'); return false; } // below sensitivity threshold
  }
  const now = iso();
  const summary = stats ? stats.summary : 'First snapshot';
  const { lastInsertRowid: id } = q.insert.run(m.id, text, hash, shot, stats ? stats.pct : null, summary, now);
  q.changed.run(now, m.id);
  finish(m, 'ok');
  if (last) notify(m, { id, hash, summary }, stats).catch(e => console.error('Notify failed:', e.message));
  return true;
}

// Daily digest at DIGEST_HOUR (local time); set DIGEST_HOUR=-1 to disable
let lastDigestDay = null;
function maybeDigest() {
  const now = new Date();
  const day = now.toDateString();
  if (DIGEST_HOUR >= 0 && now.getHours() === DIGEST_HOUR && lastDigestDay !== day) {
    lastDigestDay = day;
    runDigest().then(n => n && console.log(`Daily digest sent (${n} changes)`)).catch(e => console.error('Digest failed:', e.message));
  }
}

function start() {
  enqueueDue();
  setInterval(enqueueDue, 30000);
  setInterval(maybeDigest, 60000);
  console.log(`Scheduler started (concurrency ${MAX_CONCURRENCY}, ${DOMAIN_GAP_MS / 1000}s per-domain gap, ${RETRIES} retries)`);
}

module.exports = { start, enqueueDue };
