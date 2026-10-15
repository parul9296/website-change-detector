// SQLite database: monitors, snapshots (versions) and sent alerts
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const SHOTS = path.join(DATA, 'shots');
const DIFFS = path.join(DATA, 'diffs');
[DATA, SHOTS, DIFFS].forEach(d => fs.mkdirSync(d, { recursive: true }));

const db = new Database(path.join(DATA, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS monitors (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  norm_url      TEXT NOT NULL,          -- normalised URL, shared fetch key
  interval_min  INTEGER NOT NULL,
  watch_css     TEXT DEFAULT '',        -- regions to watch (comma separated CSS selectors)
  ignore_css    TEXT DEFAULT '',        -- regions to ignore
  noise_filter  INTEGER DEFAULT 1,      -- hide common ads / banners / carousels
  ignore_numbers INTEGER DEFAULT 0,     -- treat all numbers as noise
  sensitivity   REAL DEFAULT 0,         -- min % of words changed before it counts
  keywords      TEXT DEFAULT '',        -- alert only if a keyword is in the changed text
  alert_mode    TEXT DEFAULT 'instant', -- 'instant' | 'digest'
  paused        INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'pending', -- pending | ok | error | blocked
  last_error    TEXT,
  last_checked  TEXT,
  last_changed  TEXT,
  next_check    INTEGER DEFAULT 0,
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitors_norm ON monitors(norm_url);

CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY,
  monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  shot        TEXT,
  change_pct  REAL,
  summary     TEXT,
  alertable   INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_monitor ON snapshots(monitor_id, id);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY,
  monitor_id  INTEGER,
  snapshot_id INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT,
  sent_at     TEXT NOT NULL,
  UNIQUE(snapshot_id, channel)          -- guarantees no duplicate alerts
);
`);

module.exports = { db, DATA, SHOTS, DIFFS };
