const { fetchReliefWeb }         = require('./reliefweb');
const { fetchGrantsGov }         = require('./grantsgov');
const { fetchRSS }               = require('./rss');
const { fetchFundsForNGOs }      = require('./fundsforngos');
const { fetchSpanishAggregators }= require('./spanish-aggregators');
const { fetchUSAIDAndGrantsGov } = require('./usaid-grantsgov');
const { fetchFoundations }       = require('./foundations');
const { fetchNewSources }        = require('./new-sources');
const { fetchPortals }           = require('./portals');
const { expandAllDigests }       = require('./digest-expander');
const { closeBrowser }           = require('./playwright-base');

// ── Deduplication by URL ─────────────────────────────────────────────────────
function deduplicateGrants(grants) {
  const seen   = new Set();
  const unique = [];
  for (const g of grants) {
    const key = (g.url || g.id || '').trim().replace(/\/$/, '').toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(g);
  }
  return unique;
}

// ── Main pipeline ────────────────────────────────────────────────────────────
async function fetchAllGrants(sourcesConfig) {
  const { apis, rss, scrapers } = sourcesConfig;
  const allGrants = [];

  // --- API sources (parallel) ---
  console.log('\n[1/7] Fetching API sources...');
  const [reliefwebGrants, grantsGovGrants] = await Promise.allSettled([
    apis.reliefweb?.enabled ? fetchReliefWeb() : Promise.resolve([]),
    apis.grantsgov?.enabled ? fetchGrantsGov(apis.grantsgov) : Promise.resolve([]),
  ]);

  if (reliefwebGrants.status === 'fulfilled') {
    console.log(`  ReliefWeb: ${reliefwebGrants.value.length} grants`);
    allGrants.push(...reliefwebGrants.value);
  }
  if (grantsGovGrants.status === 'fulfilled') {
    console.log(`  Grants.gov: ${grantsGovGrants.value.length} grants`);
    allGrants.push(...grantsGovGrants.value);
  }

  // --- RSS feeds (parallel) ---
  console.log('\n[2/7] Fetching RSS feeds...');
  const enabledRSS = (rss || []).filter(s => s.enabled);
  const rssGrants  = await fetchRSS(enabledRSS);
  console.log(`  RSS total: ${rssGrants.length} items`);
  allGrants.push(...rssGrants);

  // --- Playwright scrapers (sequential to avoid rate limiting) ---
  console.log('\n[3/7] Scraping fundsforNGOs...');
  try {
    const ffnGrants = await fetchFundsForNGOs();
    console.log(`  fundsforNGOs: ${ffnGrants.length} grants`);
    allGrants.push(...ffnGrants);
  } catch (err) {
    console.warn(`  fundsforNGOs failed: ${err.message}`);
  }

  console.log('\n[4/7] Scraping Spanish aggregators + USAID...');
  try {
    const spanishGrants = await fetchSpanishAggregators();
    console.log(`  Spanish aggregators: ${spanishGrants.length} grants`);
    allGrants.push(...spanishGrants);
  } catch (err) {
    console.warn(`  Spanish aggregators failed: ${err.message}`);
  }

  try {
    const govGrants = await fetchUSAIDAndGrantsGov();
    console.log(`  USAID + Grants.gov: ${govGrants.length} grants`);
    allGrants.push(...govGrants);
  } catch (err) {
    console.warn(`  USAID/Grants.gov failed: ${err.message}`);
  }

  console.log('\n[5/7] Scraping foundations (IAF, UNDP SGP, CEPF, Rainforest Trust)...');
  try {
    const foundationGrants = await fetchFoundations();
    console.log(`  Foundations: ${foundationGrants.length} grants`);
    allGrants.push(...foundationGrants);
  } catch (err) {
    console.warn(`  Foundations failed: ${err.message}`);
  }

  console.log('\n[6/7] Fetching new multi-opportunity sources (MAR Fund, HeroX, IDB, Mercociudades + static)...');
  try {
    const newGrants = await fetchNewSources();
    console.log(`  New sources: ${newGrants.length} grants`);
    allGrants.push(...newGrants);
  } catch (err) {
    console.warn(`  New sources failed: ${err.message}`);
  }

  console.log('\n[7/7] Scraping portals (WePropel, EasyGrant, Leaders of Today)...');
  try {
    const portalGrants = await fetchPortals();
    console.log(`  Portals: ${portalGrants.length} grants`);
    allGrants.push(...portalGrants);
  } catch (err) {
    console.warn(`  Portals failed: ${err.message}`);
  }

  // Expand digest/newsletter items into individual grant entries
  const expanded = await expandAllDigests(allGrants);

  await closeBrowser();

  // Deduplicate by URL + title similarity
  const unique = deduplicateGrants(expanded);
  const removed = expanded.length - unique.length;
  if (removed > 0) console.log(`  Dedup: removed ${removed} duplicates`);
  console.log(`\nTotal unique grants collected: ${unique.length}`);

  return unique;
}

module.exports = { fetchAllGrants };
