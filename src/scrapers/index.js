const { fetchReliefWeb } = require('./reliefweb');
const { fetchGrantsGov } = require('./grantsgov');
const { fetchRSS } = require('./rss');
const { fetchFundsForNGOs } = require('./fundsforngos');
const { fetchSpanishAggregators } = require('./spanish-aggregators');
const { fetchUSAIDAndGrantsGov } = require('./usaid-grantsgov');
const { expandAllDigests } = require('./digest-expander');
const { closeBrowser } = require('./playwright-base');

async function fetchAllGrants(sourcesConfig) {
  const { apis, rss, scrapers } = sourcesConfig;
  const allGrants = [];

  // --- API sources (parallel) ---
  console.log('\n[1/4] Fetching API sources...');
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
  console.log('\n[2/4] Fetching RSS feeds...');
  const enabledRSS = (rss || []).filter(s => s.enabled);
  const rssGrants = await fetchRSS(enabledRSS);
  console.log(`  RSS total: ${rssGrants.length} items`);
  allGrants.push(...rssGrants);

  // --- Playwright scrapers (sequential to avoid rate limiting) ---
  console.log('\n[3/4] Scraping fundsforNGOs...');
  try {
    const ffnGrants = await fetchFundsForNGOs();
    console.log(`  fundsforNGOs: ${ffnGrants.length} grants`);
    allGrants.push(...ffnGrants);
  } catch (err) {
    console.warn(`  fundsforNGOs failed: ${err.message}`);
  }

  console.log('\n[4/4] Scraping Spanish aggregators + USAID...');
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

  // Expand digest/newsletter items into individual grant entries
  const expanded = await expandAllDigests(allGrants);

  await closeBrowser();

  // Deduplicate by URL
  const seen = new Set();
  const unique = expanded.filter(g => {
    const key = g.url || g.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nTotal unique grants collected: ${unique.length}`);
  return unique;
}

module.exports = { fetchAllGrants };
