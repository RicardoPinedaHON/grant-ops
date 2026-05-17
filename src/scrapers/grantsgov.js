const axios = require('axios');
const Parser = require('rss-parser');

// Grants.gov changed their API (v2 requires auth token).
// The RSS feeds are free and don't require authentication.
const RSS_FEEDS = [
  { url: 'https://www.grants.gov/rss/GG_NewOppByCategory.xml', label: 'All new opportunities' },
  { url: 'https://www.grants.gov/rss/GG_NewOppByAgency.xml', label: 'By agency' },
];

// These agencies frequently fund international/LAC work
const RELEVANT_AGENCIES = [
  'usaid', 'state department', 'department of state', 'agency for international development',
  'environmental protection', 'department of energy', 'national science foundation',
  'national institutes', 'department of agriculture',
];

// Keywords indicating international/LAC relevance
const INTERNATIONAL_KEYWORDS = [
  'international', 'global', 'latin america', 'central america', 'caribbean',
  'honduras', 'lac', 'developing countr', 'foreign', 'overseas', 'bilateral',
  'environment', 'climate', 'air quality', 'water', 'youth', 'biodiversity',
];

const parser = new Parser({ timeout: 20000 });

async function fetchGrantsGov(config) {
  const grants = [];
  const seen = new Set();

  for (const feed of RSS_FEEDS) {
    try {
      const res = await axios.get(feed.url, {
        timeout: 20000,
        headers: { 'User-Agent': 'grant-ops/1.0' },
        responseType: 'text',
      });

      // Sanitize XML before parsing
      const cleanXml = res.data.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
      const parsed = await parser.parseString(cleanXml);

      for (const item of parsed.items || []) {
        const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`.toLowerCase();

        const isRelevant = INTERNATIONAL_KEYWORDS.some(kw => text.includes(kw)) ||
                           RELEVANT_AGENCIES.some(ag => text.includes(ag));
        if (!isRelevant) continue;

        const key = item.link || item.title;
        if (seen.has(key)) continue;
        seen.add(key);

        grants.push(normalize(item));
      }

      console.log(`  [Grants.gov] ${feed.label}: fetched ${parsed.items?.length || 0} items, ${grants.length} relevant`);
    } catch (err) {
      console.warn(`  [Grants.gov] Failed ${feed.label}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  return grants;
}

function normalize(item) {
  const text = item.contentSnippet || item.content || '';

  // Extract amount from description
  const amountMatch = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:million|M\b)?/i);
  let amount = null;
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (/million|M\b/i.test(amountMatch[0])) amount *= 1000000;
  }

  // Extract deadline
  const deadlineMatch = text.match(/clos(?:e|es|ing)[s\s]+(?:on\s+)?(\w+ \d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  let deadline = null;
  if (deadlineMatch) {
    const parsed = new Date(deadlineMatch[1]);
    if (!isNaN(parsed)) deadline = parsed.toISOString().split('T')[0];
  }

  return {
    source: 'Grants.gov',
    id: `gg_${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 20)}`,
    title: item.title || '',
    description: text.slice(0, 500),
    url: item.link || 'https://www.grants.gov',
    funder: extractAgency(item.title || ''),
    deadline,
    amount_min: null,
    amount_max: amount,
    country: 'International',
    themes: [],
    type: 'federal_grant',
    fetched_at: new Date().toISOString(),
  };
}

function extractAgency(title) {
  // Grants.gov titles often contain agency: "USAID - Environmental Program"
  const match = title.match(/^([^:-]+)\s*[-:]/);
  return match ? match[1].trim() : 'US Federal';
}

module.exports = { fetchGrantsGov };
