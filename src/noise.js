// Noise filtering: strip text that changes on every load but means nothing
const { diffWords } = require('diff');

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g,      // ISO timestamps
  /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/gi,                                          // clock times
  /\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/g,                                           // numeric dates
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{2,4}\\b`, 'gi'),          // 15 Oct 2026
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(st|nd|rd|th)?,?\\s+\\d{2,4}\\b`, 'gi'),          // October 15, 2026
  /\b(\d+|an?|one)\s+(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago\b/gi, // "5 minutes ago"
  /\b(just now|updated today|yesterday)\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,             // UUIDs
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g,             // random tokens / session ids
  /\b\d[\d,.]*\s*[kKmM]?\+?\s*(views?|likes?|comments?|followers?|visitors?|online|shares?|reviews?|ratings?|people|reads?|downloads?)\b/gi // counters
];

// CSS selectors hidden before reading text when the noise filter is on
const NOISE_SELECTORS = [
  'iframe', 'ins.adsbygoogle', '[id^="google_ads"]', '[id*="div-gpt-ad"]', '[class*="advert"]',
  '[class*="ad-slot"]', '[class*="ad-banner"]', '[class*="promo-banner"]', '[class*="carousel"]',
  '[class*="slider"]', '[class*="ticker"]', '[class*="cookie"]', '[aria-live]', 'marquee'
].join(',');

function clean(text, { ignoreNumbers = false } = {}) {
  let t = text || '';
  for (const p of PATTERNS) t = t.replace(p, ' ');
  if (ignoreNumbers) t = t.replace(/\d[\d,.]*/g, '#');
  return t.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

const words = s => s.split(/\s+/).filter(Boolean).length;

// How much changed between two versions (used for sensitivity + summaries)
function changeStats(a, b) {
  const parts = diffWords(a, b);
  let added = 0, removed = 0;
  for (const p of parts) {
    if (p.added) added += words(p.value);
    else if (p.removed) removed += words(p.value);
  }
  const pct = ((added + removed) / Math.max(1, words(a) + words(b))) * 100;
  const firstAdded = parts.find(p => p.added && p.value.trim());
  const firstRemoved = parts.find(p => p.removed && p.value.trim());
  const snippet = (firstAdded || firstRemoved)?.value.trim().replace(/\s+/g, ' ').slice(0, 90) || '';
  const summary = `+${added} / −${removed} words (${pct.toFixed(1)}% changed)` +
    (snippet ? `: ${firstAdded ? 'added' : 'removed'} “${snippet}${snippet.length >= 90 ? '…' : ''}”` : '');
  return { parts, added, removed, pct, summary };
}

module.exports = { clean, changeStats, NOISE_SELECTORS };
