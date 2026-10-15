require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, SHOTS, DIFFS } = require('./db');
const { iso, normalizeUrl, validateUrl, esc } = require('./util');
const { changeStats } = require('./noise');
const { diffImage } = require('./imagediff');
const { renderForPicker, closeBrowser } = require('./fetcher');
const { runDigest, channels } = require('./alerts');
const scheduler = require('./scheduler');

const PORT = +process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shots', express.static(SHOTS));
app.use('/diffs', express.static(DIFFS));

const getMonitor = id => db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Validate + clean monitor fields (used for create and update)
function readMonitor(body, existing = {}) {
  const m = { ...existing, ...body };
  if (!m.name || !String(m.name).trim()) return { error: 'Name is required' };
  const urlErr = validateUrl(m.url);
  if (urlErr) return { error: urlErr };
  const interval = Math.round(+m.interval_min);
  if (!(interval >= 15 && interval <= 1440)) return { error: 'Check interval must be between 15 minutes and 24 hours' };
  const sens = +m.sensitivity || 0;
  if (sens < 0 || sens > 100) return { error: 'Sensitivity must be 0–100%' };
  return {
    value: {
      name: String(m.name).trim().slice(0, 100), url: String(m.url).trim(), norm_url: normalizeUrl(m.url),
      interval_min: interval, watch_css: String(m.watch_css || '').trim(), ignore_css: String(m.ignore_css || '').trim(),
      noise_filter: m.noise_filter === false || m.noise_filter === 0 || m.noise_filter === '0' ? 0 : 1,
      ignore_numbers: m.ignore_numbers === true || m.ignore_numbers === 1 || m.ignore_numbers === '1' ? 1 : 0,
      sensitivity: sens, keywords: String(m.keywords || '').trim(),
      alert_mode: m.alert_mode === 'digest' ? 'digest' : 'instant',
      paused: m.paused ? 1 : 0
    }
  };
}

// ---------- Monitors API ----------
app.get('/api/monitors', (req, res) => {
  res.json(db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM snapshots s WHERE s.monitor_id = m.id) AS versions,
      (SELECT COUNT(*) FROM monitors x WHERE x.norm_url = m.norm_url) AS watchers
    FROM monitors m ORDER BY m.id DESC`).all());
});

app.get('/api/monitors/:id', (req, res) => {
  const m = getMonitor(req.params.id);
  m ? res.json(m) : bad(res, 'Not found', 404);
});

app.post('/api/monitors', (req, res) => {
  const { value: v, error } = readMonitor(req.body);
  if (error) return bad(res, error);
  const r = db.prepare(`INSERT INTO monitors(name,url,norm_url,interval_min,watch_css,ignore_css,noise_filter,ignore_numbers,
      sensitivity,keywords,alert_mode,paused,next_check,created_at)
    VALUES (@name,@url,@norm_url,@interval_min,@watch_css,@ignore_css,@noise_filter,@ignore_numbers,
      @sensitivity,@keywords,@alert_mode,@paused,0,@created_at)`).run({ ...v, created_at: iso() });
  scheduler.enqueueDue();
  res.json(getMonitor(r.lastInsertRowid));
});

app.put('/api/monitors/:id', (req, res) => {
  const old = getMonitor(req.params.id);
  if (!old) return bad(res, 'Not found', 404);
  const { value: v, error } = readMonitor(req.body, old);
  if (error) return bad(res, error);
  db.prepare(`UPDATE monitors SET name=@name,url=@url,norm_url=@norm_url,interval_min=@interval_min,watch_css=@watch_css,
      ignore_css=@ignore_css,noise_filter=@noise_filter,ignore_numbers=@ignore_numbers,sensitivity=@sensitivity,
      keywords=@keywords,alert_mode=@alert_mode,paused=@paused WHERE id=@id`).run({ ...v, id: old.id });
  res.json(getMonitor(old.id));
});

app.delete('/api/monitors/:id', (req, res) => {
  db.prepare('DELETE FROM snapshots WHERE monitor_id = ?').run(req.params.id);
  db.prepare('DELETE FROM monitors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/monitors/:id/check', (req, res) => {
  db.prepare('UPDATE monitors SET next_check = 0 WHERE id = ?').run(req.params.id);
  scheduler.enqueueDue();
  res.json({ ok: true });
});

// ---------- Versions, diffs, comparison ----------
app.get('/api/monitors/:id/snapshots', (req, res) => {
  res.json(db.prepare(`SELECT id, shot, change_pct, summary, created_at FROM snapshots
    WHERE monitor_id = ? ORDER BY id DESC`).all(req.params.id));
});

app.get('/api/compare', (req, res) => {
  const a = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.query.a);
  const b = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.query.b);
  if (!a || !b) return bad(res, 'Pick two versions', 404);
  if (a.monitor_id !== b.monitor_id) return bad(res, 'Versions belong to different monitors');
  const stats = changeStats(a.text, b.text);
  let diffImg = null, pixelsChanged = null;
  try {
    const name = `${a.id}-${b.id}.png`, out = path.join(DIFFS, name);
    if (!fs.existsSync(out)) pixelsChanged = diffImage(path.join(SHOTS, a.shot), path.join(SHOTS, b.shot), out);
    diffImg = `/diffs/${name}`;
  } catch (e) { console.warn('Image diff failed:', e.message); }
  res.json({
    a: { id: a.id, created_at: a.created_at, shot: `/shots/${a.shot}` },
    b: { id: b.id, created_at: b.created_at, shot: `/shots/${b.shot}` },
    parts: stats.parts.map(p => ({ value: p.value, added: !!p.added, removed: !!p.removed })),
    summary: stats.summary, diffImg, pixelsChanged
  });
});

// ---------- Visual region picker ----------
const PICKER_SCRIPT = `(() => {
  let cur;
  const css = s => window.CSS && CSS.escape ? CSS.escape(s) : s;
  function selector(el) {
    if (el.id) return '#' + css(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 5) {
      if (el.id) { parts.unshift('#' + css(el.id)); return parts.join(' > '); }
      let s = el.tagName.toLowerCase();
      const cls = [...el.classList].filter(c => c !== '__cd_hover' && /^[a-zA-Z][\\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const same = el.parentElement ? [...el.parentElement.children].filter(c => c.tagName === el.tagName) : [];
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      parts.unshift(s);
      el = el.parentElement;
    }
    if (el === document.body) parts.unshift('body');
    return parts.join(' > ');
  }
  document.addEventListener('mouseover', e => { cur && cur.classList.remove('__cd_hover'); cur = e.target; cur.classList.add('__cd_hover'); }, true);
  document.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    parent.postMessage({ cdSelector: selector(e.target), text: (e.target.innerText || '').trim().slice(0, 80) }, '*');
  }, true);
  window.addEventListener('message', e => {
    if (!e.data || !e.data.cdHighlight) return;
    document.querySelectorAll('.__cd_watch,.__cd_ignore').forEach(x => x.classList.remove('__cd_watch', '__cd_ignore'));
    for (const [cls, list] of [['__cd_watch', e.data.watch], ['__cd_ignore', e.data.ignore]])
      for (const s of list) { try { document.querySelectorAll(s).forEach(x => x.classList.add(cls)); } catch {} }
  });
  parent.postMessage({ cdReady: true }, '*');
})();`;

app.get('/proxy/:id', async (req, res) => {
  const m = getMonitor(req.params.id);
  if (!m) return res.status(404).send('Not found');
  try {
    let html = await renderForPicker(m.url);
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    const head = `<base href="${esc(m.url)}"><style>
      .__cd_hover{outline:2px dashed #e8590c!important;cursor:crosshair!important}
      .__cd_watch{outline:3px solid #2b8a3e!important;background:rgba(43,138,62,.12)!important}
      .__cd_ignore{outline:3px solid #c92a2a!important;background:rgba(201,42,42,.12)!important}</style>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, h => h + head) : head + html;
    res.set('Content-Security-Policy', "script-src 'unsafe-inline'; frame-ancestors 'self'");
    res.send(html + `<script>${PICKER_SCRIPT}</script>`);
  } catch (e) {
    res.status(502).send(`<p style="font-family:sans-serif">Could not load page: ${esc(e.message)}</p>`);
  }
});

// ---------- Per-page RSS feed ----------
app.get('/rss/:id', (req, res) => {
  const m = getMonitor(req.params.id);
  if (!m) return res.status(404).send('Not found');
  const base = `${req.protocol}://${req.get('host')}`;
  const items = db.prepare('SELECT id, summary, created_at FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 50').all(m.id);
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(m.name)} – changes</title><link>${esc(m.url)}</link>
<description>Changes detected on ${esc(m.url)}</description>
${items.map(s => `<item><title>${esc(s.summary)}</title><link>${base}/monitor.html?id=${m.id}&amp;b=${s.id}</link>
<guid isPermaLink="false">snapshot-${s.id}</guid><pubDate>${new Date(s.created_at).toUTCString()}</pubDate></item>`).join('\n')}
</channel></rss>`);
});

// ---------- Misc ----------
app.post('/api/digest/run', async (req, res) => res.json({ sent: await runDigest() }));
app.get('/api/status', (req, res) => res.json({ channels: channels(), time: iso() }));

const server = app.listen(PORT, () => {
  console.log(`Website Change Detector running on http://localhost:${PORT}`);
  console.log(`Alert channels: ${channels().join(', ')}`);
  scheduler.start();
});

const shutdown = async () => { server.close(); await closeBrowser(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
