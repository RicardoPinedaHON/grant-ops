'use strict';
/**
 * brave-search.js
 * Uses the Brave Search API to find missing deadline and amount data
 * for grants that Playwright couldn't resolve.
 *
 * Also used as a quality-check signal: if no results reference an open
 * grant call, the entry is likely stale or irrelevant.
 *
 * Key stored in .env as BRAVE_SEARCH_KEY (never committed).
 * Results cached 7 days alongside the Playwright enrichment cache.
 */

const https  = require('https');
const zlib   = require('zlib');
const fs     = require('fs');
const path   = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'output', 'brave_cache.json');
const TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const DELAY_MS   = 600; // between requests to respect rate limits

function loadKey() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n').find(l => l.startsWith('BRAVE_SEARCH_KEY='));
  return line ? line.split('=')[1].trim() : null;
}

const BRAVE_KEY = process.env.BRAVE_SEARCH_KEY || loadKey();

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch {}
  return {};
}
function saveCache(cache) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Brave API call ────────────────────────────────────────────────────────────
function braveSearch(query) {
  return new Promise(resolve => {
    if (!BRAVE_KEY) return resolve(null);
    const params = new URLSearchParams({ q: query, count: '5' });
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/web/v1/search?${params}`,
      method: 'GET',
      headers: {
        'Accept':               'application/json',
        'Accept-Encoding':      'gzip',
        'X-Subscription-Token': BRAVE_KEY,
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const decode = res.headers['content-encoding'] === 'gzip'
            ? zlib.gunzipSync(buf)
            : buf;
          resolve(JSON.parse(decode.toString()));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(9000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Theme keyword map ─────────────────────────────────────────────────────────
const THEME_KEYWORDS = [
  { pattern: /climate/i,           theme: 'Climate' },
  { pattern: /youth/i,             theme: 'Youth-Led' },
  { pattern: /water/i,             theme: 'Water' },
  { pattern: /forest/i,            theme: 'Forests' },
  { pattern: /indigenous/i,        theme: 'Indigenous Rights' },
  { pattern: /circular\s+economy/i,theme: 'Circular Economy' },
  { pattern: /air\s+quality/i,     theme: 'Air Quality' },
  { pattern: /waste/i,             theme: 'Waste Management' },
  { pattern: /biodiversity/i,      theme: 'Biodiversity' },
  { pattern: /tech(?:nology)?/i,   theme: 'Technology' },
];

// ── Geo signal patterns ───────────────────────────────────────────────────────
const GEO_PATS = [
  /Honduras/i,
  /Central\s+America/i,
  /Latin\s+America/i,
  /\bLAC\b/,
  /Global/i,
  /Africa[-\s]only/i,
  /Africa/i,
  /Asia/i,
];

// ── Org type signal patterns ──────────────────────────────────────────────────
const ORG_TYPE_PATS = [
  /local\s+NGO/i,
  /US[-\s]based\s+only/i,
  /northern\s+NGO\s+required/i,
  /youth[-\s]led/i,
];

// ── Extract deadline / amount from Brave result snippets ─────────────────────
const DATE_PATS = [
  /deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /closes?\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /due\s+(?:by\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /apply\s+by\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /applications?\s+(?:due|close[ds]?)\s+(?:by\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
  /(\d{4}-\d{2}-\d{2})/,
];
const AMT_PATS = [
  /up\s+to\s+(?:USD\s*)?\$?\s*([\d,]+)/i,
  /\$\s*([\d,]+)\s*(?:[-–to]+\s*\$?\s*([\d,]+))?/,
  /(?:USD|EUR)\s*([\d,]+)\s*(?:(?:to|[-–])\s*(?:USD|EUR)?\s*([\d,]+))?/i,
  /grants?\s+(?:of|up\s+to|range(?:s)?)\s+\$?\s*([\d,]+)/i,
];
const ROLLING_PAT = /rolling|open[-\s]ended|no\s+deadline|year[-\s]round|continuous/i;

function parseDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().split('T')[0];
  return null;
}

function extractFromSnippets(snippets) {
  const result = { deadline: null, amount_min: null, amount_max: null, themes: [], geo_signal: null, org_type_signal: null };
  const today  = new Date().toISOString().split('T')[0];
  const text   = snippets.join(' ');

  if (ROLLING_PAT.test(text)) { result.deadline = 'rolling'; }

  if (!result.deadline) {
    for (const p of DATE_PATS) {
      const m = text.match(p);
      if (!m) continue;
      const parsed = parseDate(m[1] || m[0]);
      if (parsed && parsed >= today) { result.deadline = parsed; break; }
    }
  }

  for (const p of AMT_PATS) {
    const m = text.match(p);
    if (!m) continue;
    const n1 = parseInt((m[1] || '').replace(/,/g, ''), 10);
    const n2 = parseInt((m[2] || '').replace(/,/g, ''), 10);
    if (isNaN(n1) || n1 < 500) continue;
    if (!isNaN(n2) && n2 > n1) { result.amount_min = n1; result.amount_max = n2; }
    else { result.amount_max = n1; }
    break;
  }

  // Extract themes
  const themeSet = new Set();
  for (const { pattern, theme } of THEME_KEYWORDS) {
    if (pattern.test(text)) themeSet.add(theme);
  }
  result.themes = Array.from(themeSet);

  // Extract geo signal (first match wins)
  for (const pat of GEO_PATS) {
    const m = text.match(pat);
    if (m) { result.geo_signal = m[0]; break; }
  }

  // Extract org type signal (first match wins)
  for (const pat of ORG_TYPE_PATS) {
    const m = text.match(pat);
    if (m) { result.org_type_signal = m[0]; break; }
  }

  return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * For each grant in the list that is still missing deadline or amount,
 * run a Brave Search query and attempt to fill in the data.
 *
 * Returns the updated grants array.
 */
async function braveEnrichGrants(grants) {
  if (!BRAVE_KEY) {
    console.log('  Brave Search: no key configured (BRAVE_SEARCH_KEY missing)');
    return grants;
  }

  const cache = loadCache();
  const needsSearch = grants.filter(item => {
    const grant = item.grant || item;
    const ckey  = `brave:${grant.url || grant.title}`;
    const cached = cache[ckey];
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS) return false;
    const missingDeadline = !grant.deadline || grant.deadline === 'rolling';
    const missingAmount   = !grant.amount_max && !grant.amount_min;
    const missingThemes   = !grant.themes || grant.themes.length === 0;
    // Search if missing amount, deadline, or themes
    return missingAmount || (!grant.deadline) || missingThemes;
  });

  if (needsSearch.length === 0) {
    console.log('  Brave Search: nothing to look up (all cached)');
    return applyBraveCache(grants, cache);
  }

  console.log(`  Brave Search: looking up ${needsSearch.length} grants...`);
  let found = 0;

  for (const item of needsSearch) {
    const grant = item.grant || item;
    const ckey  = `brave:${grant.url || grant.title}`;

    // Build a focused query
    const title  = (grant.title  || '').slice(0, 70);
    const funder = (grant.funder || '').slice(0, 40);
    const query  = `"${title}" grant deadline amount 2026 apply`;

    const data = await braveSearch(query);
    await sleep(DELAY_MS);

    if (!data?.web?.results) {
      cache[ckey] = { deadline: null, amount_min: null, amount_max: null, themes: [], geo_signal: null, org_type_signal: null, fetched_at: new Date().toISOString() };
      continue;
    }

    // Collect all snippets from results
    const snippets = data.web.results.flatMap(r => [
      r.title || '', r.description || '', ...(r.extra_snippets || [])
    ]);

    const extracted = extractFromSnippets(snippets);
    cache[ckey] = { ...extracted, fetched_at: new Date().toISOString() };

    if (extracted.amount_max || (extracted.deadline && extracted.deadline !== 'rolling')) found++;
    process.stdout.write('·');
  }

  if (needsSearch.length > 0) console.log(`\n  Brave Search: found real data for ${found}/${needsSearch.length} grants`);
  saveCache(cache);

  return applyBraveCache(grants, cache);
}

function applyBraveCache(grants, cache) {
  return grants.map(item => {
    const grant = item.grant || item;
    const ckey  = `brave:${grant.url || grant.title}`;
    const cached = cache[ckey];
    if (!cached) return item;

    const updated = { ...grant };
    // Only override if still missing
    if (!updated.deadline && cached.deadline) updated.deadline = cached.deadline;
    if (!updated.amount_max && cached.amount_max) updated.amount_max = cached.amount_max;
    if (!updated.amount_min && cached.amount_min) updated.amount_min = cached.amount_min;
    if (!updated.themes?.length && cached.themes?.length) updated.themes = cached.themes;
    if (!updated.country && cached.geo_signal) updated.country = cached.geo_signal;

    if (item.grant !== undefined) return { ...item, grant: updated };
    return updated;
  });
}

module.exports = { braveEnrichGrants };
