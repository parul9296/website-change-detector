// Alerts: Discord / Telegram webhooks + email, no duplicates, optional daily digest
const nodemailer = require('nodemailer');
const { db } = require('./db');
const { iso, splitList } = require('./util');

const BASE = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function channels() {
  const list = [];
  if (process.env.DISCORD_WEBHOOK) list.push('discord');
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) list.push('telegram');
  if (process.env.SMTP_HOST && process.env.ALERT_EMAIL) list.push('email');
  if (!list.length) list.push('console');
  return list;
}

let mailer;
async function send(channel, { title, text }) {
  if (channel === 'console') return console.log(`\n[ALERT] ${title}\n${text}\n`);
  if (channel === 'discord') {
    const r = await fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${text}`.slice(0, 1990) })
    });
    if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
  }
  if (channel === 'telegram') {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `${title}\n${text}`.slice(0, 4000), disable_web_page_preview: true })
    });
    if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
  }
  if (channel === 'email') {
    mailer ||= nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: +process.env.SMTP_PORT === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: process.env.ALERT_EMAIL, subject: title, text });
  }
}

// Insert first, send second: the UNIQUE(snapshot_id, channel) row makes duplicates impossible
async function sendOnce(channel, monitorId, snapshotIds, msg) {
  const ins = db.prepare('INSERT OR IGNORE INTO alerts(monitor_id, snapshot_id, channel, status, sent_at) VALUES (?,?,?,?,?)');
  const fresh = snapshotIds.filter(sid => ins.run(monitorId, sid, channel, 'sending', iso()).changes > 0);
  if (!fresh.length) return;
  const mark = db.prepare('UPDATE alerts SET status=? WHERE snapshot_id=? AND channel=?');
  try {
    await send(channel.replace(/^digest:/, ''), msg);
    fresh.forEach(sid => mark.run('sent', sid, channel));
  } catch (e) {
    console.error(`Alert via ${channel} failed:`, e.message);
    fresh.forEach(sid => mark.run(`failed: ${e.message}`.slice(0, 200), sid, channel));
  }
}

// Called when a new snapshot is stored
async function notify(m, snap, stats) {
  // Keyword-only alerts
  const kws = splitList(m.keywords).map(k => k.toLowerCase());
  if (kws.length) {
    const changed = stats.parts.filter(p => p.added || p.removed).map(p => p.value).join(' ').toLowerCase();
    if (!kws.some(k => changed.includes(k))) return;
  }
  // Flap suppression: page flipping back to a version we already alerted about in the last 24h
  const flap = db.prepare(`SELECT 1 FROM snapshots s JOIN alerts a ON a.snapshot_id = s.id
    WHERE s.monitor_id = ? AND s.hash = ? AND s.id <> ? AND a.sent_at > ? LIMIT 1`)
    .get(m.id, snap.hash, snap.id, iso(Date.now() - 864e5));
  if (flap) return;

  db.prepare('UPDATE snapshots SET alertable = 1 WHERE id = ?').run(snap.id);
  if (m.alert_mode === 'digest') return; // collected by the daily digest instead

  const msg = {
    title: `🔔 ${m.name} changed`,
    text: `${snap.summary}\n${m.url}\nDiff: ${BASE()}/monitor.html?id=${m.id}&b=${snap.id}`
  };
  for (const ch of channels()) await sendOnce(ch, m.id, [snap.id], msg);
}

// One combined message for all 'digest' monitors that changed in the last 24h
async function runDigest() {
  const rows = db.prepare(`SELECT s.id, s.summary, s.created_at, m.id AS mid, m.name, m.url
    FROM snapshots s JOIN monitors m ON m.id = s.monitor_id
    WHERE m.alert_mode = 'digest' AND s.alertable = 1 AND s.created_at > ?
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.snapshot_id = s.id)
    ORDER BY m.name, s.id`).all(iso(Date.now() - 864e5));
  if (!rows.length) return 0;
  const text = rows.map(r => `• ${r.name}: ${r.summary}\n  ${BASE()}/monitor.html?id=${r.mid}&b=${r.id}`).join('\n');
  const msg = { title: `📰 Daily digest: ${rows.length} change(s)`, text };
  for (const ch of channels()) await sendOnce(`digest:${ch}`, null, rows.map(r => r.id), msg);
  return rows.length;
}

module.exports = { notify, runDigest, channels };
