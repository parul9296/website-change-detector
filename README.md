# 🔎 Website Change Detector

A service that monitors public web pages and alerts you to **meaningful** changes while ignoring noise
(timestamps, counters, ads, rotating banners, random tokens).

Built with **Node.js, Express, Playwright (headless Chromium), SQLite, pixelmatch**.

---

## Features

| # | Requirement | How it's done |
|---|---|---|
| 1 | Add URL, name, interval (15 min – 24 h); render in headless browser | Dashboard form → `POST /api/monitors`. Pages render in **Playwright** Chromium (JS-heavy sites work). |
| 2 | Scheduler + job queue, timeouts, retries; public pages only | Scheduler runs every 30 s and queues due URLs. Queue has a concurrency limit, a **per-job timeout** (60 s), and **3 retries with exponential backoff + jitter**. Private/local IPs and URLs with credentials are rejected; nothing is logged in. |
| 3 | Save text + screenshot; new snapshot only when hash changes | Each check extracts cleaned text and a screenshot. A **SHA-256 hash** of the cleaned text is compared with the last version; a snapshot is stored only when it differs (unused screenshots are deleted). |
| 4 | Noise filtering + sensitivity | Regex filters remove times, dates, “5 min ago”, UUIDs, random tokens, “1,234 views” counters. Ads/banners/carousels/tickers/iframes are hidden before reading text. Optional “treat all numbers as noise”. **Sensitivity** = minimum % of words changed before it counts. |
| 5 | Visual picker for watch / ignore regions (CSS selectors) | **Pick regions** opens the rendered page (scripts stripped). Click any element in *Watch* or *Ignore* mode → a CSS selector is generated and saved. |
| 6 | Text diff, highlighted screenshot diff, side-by-side of any two versions | Version timeline with A/B selection → word-level **text diff**, **side-by-side** screenshots and a **pixel diff** image (changed pixels in red, via pixelmatch). |
| 7 | Alerts by email + Telegram/Discord with summary + diff link; no duplicates; daily digest | Discord webhook, Telegram bot, SMTP email. Each alert row is unique on `(snapshot_id, channel)`, so the same change can never be sent twice. Per-monitor **daily digest** mode. Falls back to printing alerts in the terminal. |
| 8 | Per-page timeline + dashboard with last checked, last changed, status | Dashboard shows status **ok / error / blocked / pending**, error reason, last checked, last changed, versions. |

**Bonus implemented:** keyword-only alerts, per-page **RSS feed** (`/rss/:id`), one-line change summaries
(e.g. `+7 / −1 words (25% changed): added “Lab exam moved to Friday”`), flap suppression, pause/resume.

---

## Design questions

**1. Is a site outage or CAPTCHA a change?**
No. They are *status* problems, not content changes. HTTP errors/timeouts set the monitor to **error**;
CAPTCHA / bot-check pages (reCAPTCHA, hCaptcha, Cloudflare challenge, “verify you are human”, HTTP 403) set it to
**blocked**. No snapshot is stored and no change alert is sent, so the next real version is compared with the
last *good* version.

**2. If 200 users watch the same URL, is it fetched 200 times?**
No. Every URL is **normalised** (lower-case host, no `#fragment`, tracking params like `utm_*`/`fbclid` removed,
query params sorted, no trailing slash). The queue holds **one job per normalised URL**, so the page is rendered
once; then each watcher's own watch/ignore regions, noise settings and sensitivity are applied to that single
render, and the screenshot file is shared. The dashboard shows “shared fetch with N other watchers”.

**3. How to avoid endless alerts on pages that differ on every load?**
- Noise filters (timestamps, counters, tokens, ads, carousels) run **before hashing**.
- Watch only the region you care about / ignore noisy regions with the visual picker.
- **Sensitivity threshold**: changes below X% of words are ignored (small changes accumulate until they matter).
- **Keyword-only** alerts.
- **Flap suppression**: if the page flips back to a version already alerted in the last 24 h, no new alert.
- Alerts are unique per snapshot + channel, and digest mode batches everything into one message per day.

**4. How to avoid hammering a site with requests?**
- Minimum interval of **15 minutes**, plus one shared fetch per URL (answer 2).
- **Per-domain rate limit**: at least `DOMAIN_GAP_MS` (5 s) between requests to the same host.
- Global **concurrency limit** (2 browser jobs at a time).
- **Jitter** on the next check time so checks don't all fire together.
- **Exponential backoff** on errors; only 3 retries, then wait for the next interval.
- Identifies itself with a `WebsiteChangeDetector/1.0` user-agent.

---

## Run it

Requires **Node.js 20+**.

```bash
npm install
npx playwright install chromium
npm start
```

Open **http://localhost:3000**, add a page, and it is checked within a few seconds.

### Configure alerts (optional)

Copy `.env.example` to `.env` and fill in any of:

- **Discord:** Channel settings → Integrations → Webhooks → copy URL → `DISCORD_WEBHOOK=`
- **Telegram:** create a bot with @BotFather → `TELEGRAM_BOT_TOKEN=` and your `TELEGRAM_CHAT_ID=`
- **Email:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL` (e.g. Gmail with an app password)

With nothing configured, alerts are printed in the terminal.

### Try it locally with a noisy test page

```bash
npm run test-page                 # terminal 1: demo page on http://localhost:4000
ALLOW_PRIVATE=1 npm start         # terminal 2 (PowerShell: $env:ALLOW_PRIVATE="1"; npm start)
```

Add `http://localhost:4000` as a monitor. The page has a live clock, random ad, view counter and session token
that change on every load, yet **no new version is created**. Open `http://localhost:4000/bump` to make a real
change, press **Check now**, and an alert + new version appear.

---

## Project structure

```
src/
  server.js     Express server: REST API, compare, picker proxy, RSS
  scheduler.js  Scheduler + job queue (dedupe per URL, rate limit, timeout, retries, digest)
  fetcher.js    Playwright rendering, CAPTCHA/outage detection, region extraction, screenshots
  noise.js      Noise filters + change statistics / summaries
  alerts.js     Discord, Telegram, email, no-duplicate logic, daily digest
  imagediff.js  Highlighted screenshot diff (pixelmatch)
  db.js         SQLite schema (monitors, snapshots, alerts)
  util.js       URL normalisation / validation helpers
public/
  index.html    Dashboard
  monitor.html  Version timeline + compare (text / side-by-side / pixel diff)
  picker.html   Visual region picker
test/
  test-page.js  Local noisy page for testing
```

### API

| Method | Endpoint | Purpose |
|---|---|---|
| GET/POST | `/api/monitors` | List / create monitors |
| GET/PUT/DELETE | `/api/monitors/:id` | Read / update / delete |
| POST | `/api/monitors/:id/check` | Check now |
| GET | `/api/monitors/:id/snapshots` | Version timeline |
| GET | `/api/compare?a=&b=` | Text diff + screenshot diff of two versions |
| GET | `/rss/:id` | RSS feed of changes |
| POST | `/api/digest/run` | Send the daily digest now |

## Limitations / future work

- In-memory job queue (fine for one server; Redis/BullMQ would be next for multiple workers).
- `robots.txt` is not checked yet.
- Number tracking with charts and a browser extension are not implemented.
