// Headless browser rendering with Playwright (one shared browser, one context per job)
const { chromium } = require('playwright');
const { splitList } = require('./util');
const { NOISE_SELECTORS } = require('./noise');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 WebsiteChangeDetector/1.0';
const NAV_TIMEOUT = +process.env.NAV_TIMEOUT_MS || 30000;
const MAX_SHOT_HEIGHT = 5000;
const BLOCK_RE = /captcha|verify you are (a )?human|are you a robot|unusual traffic|just a moment|attention required|checking your browser|access denied/i;

let browserPromise;
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
  }
  browserPromise = chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  return browserPromise;
}

async function openPage(url) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const res = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  return { ctx, page, res };
}

// Runs inside the browser: hide ignored regions, read text of watched regions (or whole body)
function extractInPage({ watch, ignore, noise }) {
  const hidden = [];
  const hide = sel => {
    try { document.querySelectorAll(sel).forEach(el => { hidden.push([el, el.style.display]); el.style.display = 'none'; }); } catch {}
  };
  ignore.forEach(hide);
  if (noise) hide(noise);
  let text;
  if (watch.length) {
    const parts = [];
    for (const sel of watch) { try { document.querySelectorAll(sel).forEach(el => parts.push(el.innerText)); } catch {} }
    text = parts.join('\n');
  } else {
    text = document.body ? document.body.innerText : '';
  }
  hidden.reverse().forEach(([el, d]) => { el.style.display = d; });
  return text;
}

// Fetch a URL ONCE and extract text for every monitor that watches it
async function fetchGroup(url, monitors, shotPath) {
  const { ctx, page, res } = await openPage(url);
  try {
    const status = res ? res.status() : 0;
    const title = await page.title().catch(() => '');
    const body = await page.innerText('body').catch(() => '');
    const captchaFrame = await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], #challenge-form, #cf-challenge-running');

    // Outage / CAPTCHA are NOT content changes -> reported as status only
    if (captchaFrame || status === 403 || (body.length < 3000 && BLOCK_RE.test(`${title} ${body}`)))
      return { blocked: true, reason: captchaFrame ? 'CAPTCHA detected' : status === 403 ? 'Blocked by site (HTTP 403)' : 'Bot check / CAPTCHA page detected' };
    if (!status || status >= 400) throw new Error(`HTTP ${status || 'no response'}`);

    const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 800);
    await page.screenshot({ path: shotPath, fullPage: true, clip: { x: 0, y: 0, width: 1280, height: Math.min(Math.max(height, 800), MAX_SHOT_HEIGHT) } });

    const results = {};
    for (const m of monitors) {
      results[m.id] = await page.evaluate(extractInPage, {
        watch: splitList(m.watch_css), ignore: splitList(m.ignore_css), noise: m.noise_filter ? NOISE_SELECTORS : ''
      });
    }
    return { results };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Rendered HTML (scripts removed) for the visual region picker
async function renderForPicker(url) {
  const { ctx, page } = await openPage(url);
  try { return await page.content(); } finally { await ctx.close().catch(() => {}); }
}

async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise.catch(() => null); if (b) await b.close().catch(() => {}); }
}

module.exports = { fetchGroup, renderForPicker, closeBrowser };
