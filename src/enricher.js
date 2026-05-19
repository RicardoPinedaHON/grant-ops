'use strict';
/**
 * enricher.js
 * For grants that are missing a deadline or amount, fetches the source page
 * and tries to extract that info with regex before scoring begins.
 *
 * - Uses lightweight axios (no Playwright) for speed
 * - Results are cached in output/enrichment_cache.json (7-day TTL)
 * - Grants with no findable deadline are marked as "rolling"
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'output', 'enrichment_cache.json');
const TIMEOUT_MS = 9000;

// ── Date extraction ──────────────────────────────────────────────────────────
const DEADLINE_PATTERNS = [
  /deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /closes?\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /due\s+(?:by\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /apply\s+by\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /submit\s+by\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /applications?\s+(?:due|close[ds]?)\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /fecha\s+l[ií]mite[:\s]+(\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4})/i,
  /convocatoria\s+(?:cierra|vence)[:\s]+(\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4})/i,
  /(\d{4}-\d{2}-\d{2})/,
  /(\d{1,2}\/\d{1,2}\/\d{4})/,
];

// Patterns that mean "no fixed deadline"
const ROLLING_PATTERNS = /rolling\s+(?:applications?|deadline|basis|review)|open[-\s]ended|no\s+(?:fixed\s+)?deadline|year[-\s]round|continuous(?:ly)?|abierta\s+permanentemente|convocatoria\s+permanente/i;

// ── Amount extraction ────────────────────────────────────────────────────────
const AMOUNT_PATTERNS = [
  /up\s+to\s+(?:USD\s*)?\$?([\d,]+)(?:\s*(?:USD|million|M|k))?/i,
  /\$\s*([\d,]+(?:,000)?)\s*(?:USD)?\s*(?:[-–to]+\s*\$?\s*([\d,]+(?:,000)?))?/,
  /(?:USD|EUR)\s*([\d,]+(?:,000)?)\s*(?:[-–to]+\s*(?:USD|EUR)?\s*([\d,]+(?:,000)?))?/i,
  /grants?\s+(?:of|up\s+to|from|range(?:s?))\s+\$?([\d,]+)/i,
  /award(?:ing|s)?\s+\$?([\d,]+)/i,
  /hasta\s+\$?\s*([\d,]+)/i,
  /máximo[:\s]+\$?\s*([\d,]+)/i,
];

// ── Spanish month → number ───────────────────────────────────────────────────
const SPANISH_MONTHS = {
  enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
  julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12,
};

function parseDate(str) {
  if (!str) return null;
  str = str.trim();

  // ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // "15 de julio de 2026"
  const spMatch = str.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
  if (spMatch) {
    const m = SPANISH_MONTHS[spMatch[2].toLowerCase()];
    if (m) {
      const d = new Date(+spMatch[3], m - 1, +spMatch[1]);
      return d.toISOString().split('T')[0];
    }
  }

  // "MM/DD/YYYY"
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const d = new Date(+slashMatch[3], +slashMatch[1] - 1, +slashMatch[2]);
    return d.toISOString().split('T')[0];
  }

  // English: "June 15, 2026" / "15 June 2026"
  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return null;
}

function extractFromText(text) {
  const result = { deadline: null, amount_min: null, amount_max: null, is_rolling: false };
  if (!text) return result;

  if (ROLLING_PATTERNS.test(text)) {
    result.is_rolling = true;
    result.deadline   = 'rolling';
    return result;
  }

  const today = new Date().toISOString().split('T')[0];

  for (const pat of DEADLINE_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const parsed = parseDate(m[1] || m[0]);
      if (parsed && parsed >= today) {
        result.deadline = parsed;
        break;
      }
    }
  }

  for (const pat of AMOUNT_PATTERNS) {
    const m = text.match(pat);
    if (!m) continue;
    const raw1 = (m[1] || '').replace(/,/g, '');
    const raw2 = (m[2] || '').replace(/,/g, '');
    const n1 = parseInt(raw1, 10);
    const n2 = parseInt(raw2, 10);
    if (n1 > 100) {
      if (n2 > n1) {
        result.amount_min = n1;
        result.amount_max = n2;
      } else {
        result.amount_max = n1;
      }
      break;
    }
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

// ── Per-grant fetch ──────────────────────────────────────────────────────────
async function fetchAndExtract(url) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; grant-ops/1.0; NGO grant scanner)' },
      maxRedirects: 3,
      responseType: 'text',
    });
    const html   = String(res.data || '');
    const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ')
                         .slice(0, 60000); // cap to avoid OOM on huge pages
    return extractFromText(stripped);
  } catch {
    return { deadline: null, amount_min: null, amount_max: null, is_rolling: false };
  }
}

// ── Main export ──────────────────────────────────────────────────────────────
async function enrichGrants(items) {
  const cache = loadCache();
  const TTL   = 7 * 24 * 60 * 60 * 1000; // 7 days

  const needsEnrichment = items.filter(item => {
    const grant = item.grant || item;
    const url   = grant.url;
    if (!url) return false;

    // Skip static "rolling" entries
    if (grant.deadline === 'rolling') return false;

    const cached = cache[url];
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL) return false;

    return !grant.deadline || (!grant.amount_max && !grant.amount_min);
  });

  if (needsEnrichment.length === 0) {
    console.log('  Enricher: nothing to fetch (all cached or complete)');
    return applyCache(items, cache);
  }

  console.log(`  Enricher: fetching ${needsEnrichment.length} pages for missing deadline/amount...`);
  let found = 0;

  for (const item of needsEnrichment) {
    const grant = item.grant || item;
    const url   = grant.url;
    process.stdout.write('·');

    const extracted = await fetchAndExtract(url);
    cache[url] = { ...extracted, fetched_at: new Date().toISOString() };

    if (extracted.deadline || extracted.amount_max) found++;
  }

  console.log(`\n  Enricher: resolved ${found}/${needsEnrichment.length} grants`);
  saveCache(cache);

  return applyCache(items, cache);
}

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

module.exports = { enrichGrants };
