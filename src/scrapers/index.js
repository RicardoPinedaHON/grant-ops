const { fetchReliefWeb }         = require('./reliefweb');
const { fetchGrantsGov }         = require('./grantsgov');
const { fetchRSS }               = require('./rss');
const { fetchFundsForNGOs }      = require('./fundsforngos');
const { fetchSpanishAggregators }= require('./spanish-aggregators');
const { fetchUSAIDAndGrantsGov } = require('./usaid-grantsgov');
const { fetchFoundations }       = require('./foundations');
const { fetchNewSources }        = require('./new-sources');
const { fetchPortals }           = require('./portals');
const { fetchEmailGrants }       = require('./email-outlook');
const { fetchLinkedInSources }   = require('./linkedin');
const { expandAllDigests }       = require('./digest-expander');
const { closeBrowser }           = require('./playwright-base');

// ── Fuzzy deduplication: URL + acronym + title similarity ────────────────────
const { grantsMatch } = require('../utils/grant-fingerprint');

// Keep the "richer" version when merging: prefer the one with url, amount, description
function betterGrant(a, b) {
  const scoreA = (a.url ? 2 : 0) + (a.amount_max ? 1 : 0) + (a.description?.length > 20 ? 1 : 0);
  const scoreB = (b.url ? 2 : 0) + (b.amount_max ? 1 : 0) + (b.description?.length > 20 ? 1 : 0);
  return scoreA >= scoreB ? a : b;
}

function deduplicateGrants(grants) {
  const unique = [];
  for (const g of grants) {
    const matchIdx = unique.findIndex(u => grantsMatch(g, u));
    if (matchIdx === -1) {
      unique.push(g);
    } else {
      unique[matchIdx] = betterGrant(unique[matchIdx], g);
    }
  }
  return unique;
}

// ── Main pipeline ────────────────────────────────────────────────────────────
// `history` is the SAME object scan.js loads via loadHistory()/saveHistory()
// — passed through so LinkedIn's post-level dedup persists in history.json
// exactly like every other source's grant-level dedup, with no parallel
// storage. Optional: existing callers that don't pass it just get LinkedIn's
// dedup falling back to an ephemeral object (no persistence, but never a
// crash).
async function fetchAllGrants(sourcesConfig, history = {}) {
  const { apis, rss, scrapers, linkedin } = sourcesConfig;
  const allGrants = [];

  // --- API sources (parallel) ---
  console.log('\n[1/9] Fetching API sources...');
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
  console.log('\n[2/9] Fetching RSS feeds...');
  const enabledRSS = (rss || []).filter(s => s.enabled);
  const rssGrants  = await fetchRSS(enabledRSS);
  console.log(`  RSS total: ${rssGrants.length} items`);
  allGrants.push(...rssGrants);

  // --- Playwright scrapers (sequential to avoid rate limiting) ---
  console.log('\n[3/9] Scraping fundsforNGOs...');
  try {
    const ffnGrants = await fetchFundsForNGOs();
    console.log(`  fundsforNGOs: ${ffnGrants.length} grants`);
    allGrants.push(...ffnGrants);
  } catch (err) {
    console.warn(`  fundsforNGOs failed: ${err.message}`);
  }

  console.log('\n[4/9] Scraping Spanish aggregators + USAID...');
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

  console.log('\n[5/9] Scraping foundations (IAF, UNDP SGP, CEPF, Rainforest Trust)...');
  try {
    const foundationGrants = await fetchFoundations();
    console.log(`  Foundations: ${foundationGrants.length} grants`);
    allGrants.push(...foundationGrants);
  } catch (err) {
    console.warn(`  Foundations failed: ${err.message}`);
  }

  console.log('\n[6/9] Fetching new multi-opportunity sources (MAR Fund, HeroX, IDB, Mercociudades + static)...');
  try {
    const newGrants = await fetchNewSources();
    console.log(`  New sources: ${newGrants.length} grants`);
    allGrants.push(...newGrants);
  } catch (err) {
    console.warn(`  New sources failed: ${err.message}`);
  }

  console.log('\n[7/9] Scraping portals (WePropel, EasyGrant, Leaders of Today)...');
  try {
    const portalGrants = await fetchPortals();
    console.log(`  Portals: ${portalGrants.length} grants`);
    allGrants.push(...portalGrants);
  } catch (err) {
    console.warn(`  Portals failed: ${err.message}`);
  }

  console.log('\n[8/9] Scanning Outlook inbox (Grant Newsletters folder)...');
  try {
    const emailGrants = await fetchEmailGrants();
    console.log(`  Email newsletters: ${emailGrants.length} grants`);
    allGrants.push(...emailGrants);
  } catch (err) {
    console.warn(`  Email scan failed: ${err.message}`);
  }

  console.log('\n[9/9] Checking LinkedIn public sources (Jina Reader, no login)...');
  try {
    const { grants: linkedinGrants, metrics: linkedinMetrics } = await fetchLinkedInSources(linkedin, history);
    console.log(
      `  LinkedIn sources: ${linkedinMetrics.sourcesConfigured} | Successful: ${linkedinMetrics.successful} | ` +
      `Failed: ${linkedinMetrics.failed} | Posts fetched: ${linkedinMetrics.postsFetched} | ` +
      `New posts: ${linkedinMetrics.newPosts} | Already seen: ${linkedinMetrics.alreadySeen} | ` +
      `Opportunities detected: ${linkedinMetrics.opportunitiesDetected}`
    );
    allGrants.push(...linkedinGrants);
  } catch (err) {
    console.warn(`  LinkedIn sources failed: ${err.message}`);
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
