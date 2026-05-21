'use strict';
/**
 * enricher.js
 * PLAYWRIGHT-based enrichment. For every grant missing a deadline or amount,
 * fetches the source page and extracts that data before scoring.
 *
 * Guarantees: after this step runs, EVERY grant has either:
 *   - A real ISO deadline (e.g. "2026-09-09")
 *   - OR deadline === 'rolling'   (open / no fixed date)
 *
 * Amount is best-effort: if genuinely not findable on the page, stays null
 * and Notion shows "Amount TBD — see funder site".
 *
 * Caches results in output/enrichment_cache.json (7-day TTL).
 * Processes grants 4 at a time to keep total runtime reasonable.
 */

const fs   = require('fs');
const path = require('path');
const { getPage, safeGoto, closeBrowser } = require('./scrapers/playwright-base');
const { braveEnrichGrants } = require('./brave-search');

const CACHE_FILE  = path.join(__dirname, '..', 'output', 'enrichment_cache.json');
const CONCURRENCY = 4;
const PAGE_WAIT   = 3000; // ms after page load
const PAGE_TIMEOUT= 18000;
const TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Date patterns (English + Spanish) ───────────────────────────────────────
const DEADLINE_PATS = [
  /deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /closes?\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /due\s+(?:by\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /apply\s+by\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /submit(?:ted)?\s+(?:by\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /applications?\s+(?:due|close[ds]?)\s+(?:by\s+|on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /open(?:s)?\s+through\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /fecha\s+l[ií]mite[:\s]+(\d{1,2}\s+de\s+[a-záéíóúü]+\s+de\s+\d{4})/i,
  /(?:cierre|vencimiento|cierra)[:\s]+(\d{1,2}\s+de\s+[a-záéíóúü]+\s+de\s+\d{4})/i,
  /convocatoria\s+(?:abierta\s+)?hasta\s+(?:el\s+)?(\d{1,2}\s+de\s+[a-záéíóúü]+\s+de\s+\d{4})/i,
  // ISO and numeric
  /deadline[:\s]+(\d{4}-\d{2}-\d{2})/i,
  /(\d{4}-\d{2}-\d{2})/,
  /(\d{1,2}\/\d{1,2}\/\d{4})/,
];

const ROLLING_PATS = /rolling\s+(?:applications?|review|deadline|basis)|open[-\s]ended|no\s+(?:fixed\s+)?deadline|year[-\s]round|continuous(?:ly)?|ongoing|always\s+accepting|convocatoria\s+permanente|siempre\s+abierta|abierta\s+permanentemente/i;

// ── Amount patterns ──────────────────────────────────────────────────────────
const AMOUNT_PATS = [
  // "up to $50,000" / "up to USD 50,000"
  /up\s+to\s+(?:USD\s*)?\$?\s*([\d,]+)/i,
  // "$25,000 – $50,000"
  /\$\s*([\d,]+)\s*(?:[-–to]+\s*\$?\s*([\d,]+))?/,
  // "USD 25,000 to USD 50,000"
  /(?:USD|EUR)\s*([\d,]+)\s*(?:(?:to|[-–])\s*(?:USD|EUR)?\s*([\d,]+))?/i,
  // "grants of $25,000"
  /grants?\s+(?:of|up\s+to|from|range(?:s)?)\s+\$?\s*([\d,]+)/i,
  // "award up to $100,000"
  /award(?:ing|s)?\s+(?:up\s+to\s+)?\$?\s*([\d,]+)/i,
  // "hasta $50.000" or "hasta USD 50,000"
  /hasta\s+(?:USD\s*)?\$?\s*([\d.]+)/i,
  // "máximo: $25,000"
  /m[aá]ximo[:\s]+\$?\s*([\d,]+)/i,
  // "prize: $50k" / "prize pool: $100k"
  /prize(?:\s+pool)?[:\s]+\$?\s*([\d,]+)\s*k?\b/i,
];

const SPANISH_MONTHS = {
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,
};

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // "15 de julio de 2026"
  const sp = str.match(/(\d{1,2})\s+de\s+([a-záéíóúü]+)\s+de\s+(\d{4})/i);
  if (sp) {
    const m = SPANISH_MONTHS[sp[2].toLowerCase()];
    if (m) return new Date(+sp[3], m-1, +sp[1]).toISOString().split('T')[0];
  }
  // "MM/DD/YYYY"
  const sl = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (sl) return new Date(+sl[3], +sl[1]-1, +sl[2]).toISOString().split('T')[0];

  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return null;
}

function extractFromText(text) {
  const result = { deadline: null, amount_min: null, amount_max: null };
  if (!text || text.length < 20) {
    result.deadline = 'rolling';
    return result;
  }

  // Rolling check
  if (ROLLING_PATS.test(text)) {
    result.deadline = 'rolling';
    // Still try to extract amount even if rolling
  } else {
    // Deadline extraction
    const today = new Date().toISOString().split('T')[0];
    for (const pat of DEADLINE_PATS) {
      const m = text.match(pat);
      if (!m) continue;
      const parsed = parseDate(m[1] || m[0]);
      if (parsed && parsed >= today) {
        result.deadline = parsed;
        break;
      }
    }
    if (!result.deadline) result.deadline = 'rolling'; // not found → treat as rolling
  }

  // Amount extraction
  for (const pat of AMOUNT_PATS) {
    const m = text.match(pat);
    if (!m) continue;
    const r1 = (m[1] || '').replace(/[,.]/g, '');
    const r2 = (m[2] || '').replace(/[,.]/g, '');
    const n1 = parseInt(r1, 10);
    const n2 = parseInt(r2, 10);
    if (isNaN(n1) || n1 < 500) continue; // ignore tiny numbers (dates, IDs, etc.)
    if (!isNaN(n2) && n2 > n1) {
      result.amount_min = n1;
      result.amount_max = n2;
    } else {
      result.amount_max = n1;
    }
    break;
  }

  return result;
}

// ── Cache helpers ────────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveCache(cache) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Single-page fetch with Playwright ───────────────────────────────────────
async function fetchAndExtract(url) {
  const page = await getPage();
  try {
    const ok = await safeGoto(page, url, PAGE_TIMEOUT);
    if (!ok) return { deadline: 'rolling', amount_min: null, amount_max: null };

    await page.waitForTimeout(PAGE_WAIT);

    // Get visible text from the page (innerText strips hidden elements)
    const text = await page.evaluate(() => {
      try { return document.body.innerText || document.body.textContent || ''; }
      catch { return ''; }
    });

    return extractFromText(text);
  } catch {
    return { deadline: 'rolling', amount_min: null, amount_max: null };
  } finally {
    try { await page.close(); } catch {}
  }
}

// ── Batch processor ──────────────────────────────────────────────────────────
async function processBatch(items, cache) {
  return Promise.all(items.map(async ({ item, url }) => {
    const extracted = await fetchAndExtract(url);
    cache[url] = { ...extracted, fetched_at: new Date().toISOString() };
    return { item, url, extracted };
  }));
}

// ── Main export ──────────────────────────────────────────────────────────────
async function enrichGrants(items) {
  const cache = loadCache();

  // Determine which grants need enrichment
  const needsWork = items.filter(item => {
    const grant = item.grant || item;
    const url   = grant.url;
    if (!url) return false;
    if (grant.deadline === 'rolling') return false; // already explicit

    const cached = cache[url];
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS) return false;

    const needsDeadline = !grant.deadline;
    const needsAmount   = !grant.amount_max && !grant.amount_min;
    return needsDeadline || needsAmount;
  });

  if (needsWork.length === 0) {
    console.log('  Enricher: nothing to fetch (all cached or already complete)');
    return applyDefaults(applyCache(items, cache));
  }

  console.log(`  Enricher: fetching ${needsWork.length} pages with Playwright (${CONCURRENCY} at a time)...`);
  let found = 0;
  let processed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < needsWork.length; i += CONCURRENCY) {
    const batch = needsWork.slice(i, i + CONCURRENCY).map(item => ({
      item,
      url: (item.grant || item).url,
    }));

    const results = await processBatch(batch, cache);
    for (const { extracted } of results) {
      processed++;
      if (extracted.deadline !== 'rolling' || extracted.amount_max) found++;
    }
    process.stdout.write(`  [${processed}/${needsWork.length}]\r`);
  }

  console.log(`\n  Enricher: resolved deadline/amount for ${found} grants; rest marked "rolling"`);
  saveCache(cache);

  // Second pass: use Brave Search for grants still missing amount data
  const afterPlaywright = applyCache(items, cache);
  const afterBrave = await braveEnrichGrants(afterPlaywright);

  return applyDefaults(afterBrave);
}

// Apply cached values to grant objects
function applyCache(items, cache) {
  return items.map(item => {
    const grant  = item.grant || item;
    const cached = cache[grant.url];
    if (!cached) return item;

    const updated = { ...grant };
    if (!updated.deadline && cached.deadline) updated.deadline = cached.deadline;
    if (!updated.amount_max && cached.amount_max) updated.amount_max = cached.amount_max;
    if (!updated.amount_min && cached.amount_min) updated.amount_min = cached.amount_min;

    if (item.grant !== undefined) return { ...item, grant: updated };
    return updated;
  });
}

// Final safety net: any grant still missing deadline gets 'rolling'
function applyDefaults(items) {
  return items.map(item => {
    const grant = item.grant || item;
    if (!grant.deadline) {
      const updated = { ...grant, deadline: 'rolling' };
      if (item.grant !== undefined) return { ...item, grant: updated };
      return updated;
    }
    return item;
  });
}

module.exports = { enrichGrants };
