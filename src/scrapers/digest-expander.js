/**
 * digest-expander.js
 *
 * Detects newsletter/digest items in the grant list (e.g. ImpactFunding
 * "86 New Impact Funding Opportunities!") and replaces them with the
 * individual grant entries found inside each digest page.
 *
 * Called from scrapers/index.js after all sources are fetched.
 */

'use strict';

const { getPage, safeGoto } = require('./playwright-base');

// Patterns that identify a digest/newsletter post rather than a single grant
const DIGEST_PATTERNS = [
  /\d+\s+new\s+(impact\s+)?funding\s+opportunit/i,
  /funding\s+opportunit.*\(\d+\s+new/i,
  /update.*\d+\s+new.*opportunit/i,
];

// Domains we treat as "aggregator noise" (not actual grant links)
const SKIP_DOMAINS = [
  'substack.com', 'twitter.com', 'linkedin.com', 'facebook.com',
  'instagram.com', 'youtube.com', 'unsubscribe', 'mailto:', '#',
  'google.com', 'apple.com', 'spotify.com',
];

function isDigest(grant) {
  return DIGEST_PATTERNS.some(p => p.test(grant.title));
}

/**
 * Expand a digest URL → array of individual grant objects.
 * Returns [] on failure (original digest item kept).
 */
async function expandDigestPage(digestGrant) {
  const page = await getPage();
  const extracted = [];

  try {
    const ok = await safeGoto(page, digestGrant.url, 30000);
    if (!ok) return [];

    // Substack renders its content client-side — wait for article body
    try {
      await page.waitForSelector('.available-content, .body.markup, article.post', { timeout: 10000 });
    } catch (_) { /* proceed with whatever loaded */ }
    await page.waitForTimeout(2000);

    const entries = await page.evaluate((skipDomains) => {
      // Look for the article content in Substack's DOM
      const content =
        document.querySelector('.available-content') ||
        document.querySelector('.body.markup') ||
        document.querySelector('article') ||
        document.body;

      const results = [];
      const seenUrls = new Set();

      // Walk every anchor in the content
      const links = Array.from(content.querySelectorAll('a[href]'));

      for (const link of links) {
        const href = link.href || '';
        // Skip internal / social / noise links
        if (skipDomains.some(d => href.includes(d))) continue;
        if (!href.startsWith('http')) continue;
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        const title = link.textContent.trim();
        if (title.length < 15) continue; // Skip "Apply here", "→", etc.

        // Grab surrounding paragraph for context (description, amount, deadline)
        const parent = link.closest('p, li, h3, h4, div.post-preview');
        const siblingP = parent ? parent.nextElementSibling : null;
        const context = [
          parent ? parent.textContent.trim() : '',
          siblingP && siblingP.tagName === 'P' ? siblingP.textContent.trim() : '',
        ].join(' ').slice(0, 500);

        results.push({ title, url: href, context });
      }

      return results;
    }, SKIP_DOMAINS);

    const today = new Date();

    for (const entry of entries) {
      const deadline = extractDeadline(entry.context) || extractDeadline(entry.title);
      const amount = extractAmount(entry.context) || extractAmount(entry.title);

      // Skip entries that look like navigation / blog links (no date, no amount, short context)
      if (!deadline && !amount && entry.context.length < 40) continue;

      extracted.push({
        source: digestGrant.source,
        id: `digest_${Buffer.from(entry.url).toString('base64').slice(0, 20)}`,
        title: entry.title,
        description: entry.context.slice(0, 400),
        url: entry.url,
        funder: guessFunder(entry.title, entry.url),
        deadline: deadline || null,
        amount_min: amount ? amount.min : null,
        amount_max: amount ? amount.max : null,
        country: 'International',
        themes: [],
        type: 'grant',
        fetched_at: today.toISOString(),
        _from_digest: digestGrant.url,
      });
    }

    console.log(`    Expanded "${digestGrant.title.slice(0, 55)}..." → ${extracted.length} individual grants`);
  } catch (err) {
    console.warn(`    [digest-expander] Error expanding ${digestGrant.url}: ${err.message}`);
  } finally {
    await page.close();
  }

  return extracted;
}

/** Extract deadline string from text. Returns ISO date or null. */
function extractDeadline(text) {
  if (!text) return null;

  // "Deadline: June 15, 2026" / "Due: 15 June 2026" / "Closes: 2026-06-15"
  const patterns = [
    /(?:deadline|due|closes?|apply\s+by|submit\s+by)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:deadline|due|closes?|apply\s+by)[:\s]+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
    /(?:deadline|due|closes?)[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /(\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2})/i,
    /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      try {
        const d = new Date(m[1]);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
      } catch (_) { /* ignore parse errors */ }
    }
  }
  return null;
}

/** Extract amount range from text. Returns {min, max} in USD or null. */
function extractAmount(text) {
  if (!text) return null;

  // "up to $500,000" / "$50,000 - $200,000" / "USD 100,000" / "$50K"
  const patterns = [
    /up\s+to\s+(?:USD?|€|£|\$)\s*([\d,]+)(?:k\b)?/i,
    /(?:USD?|€|£|\$)\s*([\d,]+)(?:k\b)?\s*[-–to]+\s*(?:USD?|€|£|\$)?\s*([\d,]+)(?:k\b)?/i,
    /(?:USD?|\$)\s*([\d,]+)(?:k\b)?/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let val1 = parseNum(m[1]);
      let val2 = m[2] ? parseNum(m[2]) : null;
      if (m[0].toLowerCase().includes('k')) { val1 *= 1000; if (val2) val2 *= 1000; }
      if (val1 > 500) return { min: val2 ? val1 : null, max: val2 || val1 };
    }
  }
  return null;
}

function parseNum(str) {
  return parseFloat((str || '0').replace(/,/g, ''));
}

/** Guess funder name from title/URL. */
function guessFunder(title, url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    // Map well-known domains
    const domainMap = {
      'undp.org': 'UNDP', 'worldbank.org': 'World Bank', 'iucn.org': 'IUCN',
      'gef.org': 'GEF', 'climateaction.fund': 'Climate Action Fund',
      'unep.org': 'UNEP', 'eci.ox.ac.uk': 'Oxford ECI', 'usaid.gov': 'USAID',
      'macfound.org': 'MacArthur Foundation', 'ciff.org': 'CIFF',
      'wellcome.org': 'Wellcome Trust', 'rockefellerfoundation.org': 'Rockefeller Foundation',
    };
    for (const [d, name] of Object.entries(domainMap)) {
      if (host.includes(d)) return name;
    }
    return host.split('.').slice(-2, -1)[0]; // e.g. "usaid" from "grants.usaid.gov"
  } catch (_) {
    return 'Unknown';
  }
}

/**
 * Main entry point.
 * Takes the full grants array, expands all digest items in parallel (with
 * concurrency limit of 3), and returns a new array with digests replaced
 * by their individual entries.
 */
async function expandAllDigests(grants) {
  const digestItems = grants.filter(isDigest);
  const nonDigest = grants.filter(g => !isDigest(g));

  if (digestItems.length === 0) return grants;

  console.log(`\n[Digest Expander] Found ${digestItems.length} digest(s) to expand...`);

  // Expand sequentially to avoid hammering servers
  const expandedSets = [];
  for (const digest of digestItems) {
    const items = await expandDigestPage(digest);
    if (items.length > 0) {
      expandedSets.push(...items);
    } else {
      // Expansion failed — keep the original digest item
      nonDigest.push(digest);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`  Digest expansion complete: ${expandedSets.length} individual grants extracted`);

  // Deduplicate against existing grants by URL
  const existingUrls = new Set(nonDigest.map(g => g.url));
  const deduped = expandedSets.filter(g => {
    if (existingUrls.has(g.url)) return false;
    existingUrls.add(g.url);
    return true;
  });

  console.log(`  After dedup: ${deduped.length} new grants added`);

  return [...nonDigest, ...deduped];
}

module.exports = { expandAllDigests, isDigest };
