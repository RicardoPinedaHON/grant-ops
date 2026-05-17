const Parser = require('rss-parser');
const axios = require('axios');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'grant-ops/1.0 (NGO grant monitoring tool)' },
});

// Some RSS feeds have unescaped & in URLs — sanitize before parsing
function sanitizeXml(xml) {
  // Fix unescaped & that aren't already part of an entity (&amp; &lt; etc.)
  return xml.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
}

const LAC_KEYWORDS = [
  'honduras', 'central america', 'latin america', 'lac', 'caribbean',
  'centroamerica', 'latinoamerica', 'mesoamerica',
];
const THEME_KEYWORDS = [
  'environment', 'climate', 'air quality', 'water', 'forest', 'biodiversity',
  'youth', 'circular economy', 'waste', 'energy', 'indigenous',
  'medio ambiente', 'clima', 'calidad del aire', 'agua', 'bosque',
  'juventud', 'economia circular', 'residuos', 'energia',
];

async function fetchRSS(sources) {
  const results = await Promise.allSettled(
    sources.filter(s => s.enabled).map(s => fetchFeed(s))
  );

  const grants = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      grants.push(...result.value);
    }
  }
  return grants;
}

async function fetchFeed(source) {
  let feed;
  try {
    // Fetch raw XML first so we can sanitize malformed entities before parsing
    const res = await axios.get(source.url, {
      timeout: 20000,
      headers: { 'User-Agent': 'grant-ops/1.0 (NGO grant monitoring tool)' },
      responseType: 'text',
    });
    const cleanXml = sanitizeXml(res.data);
    feed = await parser.parseString(cleanXml);
  } catch (err) {
    console.warn(`  [RSS] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }

  const grants = [];
  for (const item of feed.items || []) {
    const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`.toLowerCase();
    const isLAC = LAC_KEYWORDS.some(kw => text.includes(kw));
    const isThematic = THEME_KEYWORDS.some(kw => text.includes(kw));

    // Include if LAC-relevant OR thematically relevant (scorer will filter further)
    if (!isLAC && !isThematic) continue;

    grants.push({
      source: source.name,
      id: `rss_${Buffer.from(item.link || item.title || '').toString('base64').slice(0, 20)}`,
      title: item.title || '',
      description: item.contentSnippet || item.content || '',
      url: item.link || '',
      funder: feed.title || source.name,
      deadline: extractDeadline(item.contentSnippet || item.content || ''),
      amount_min: null,
      amount_max: null,
      country: isLAC ? detectCountry(text) : null,
      themes: detectThemes(text),
      type: 'rss',
      fetched_at: new Date().toISOString(),
    });
  }

  console.log(`  [RSS] ${source.name}: ${grants.length} relevant items`);
  return grants;
}

function extractDeadline(text) {
  // Look for common deadline patterns: "deadline: Jan 15", "due by March 1, 2026", etc.
  const patterns = [
    /deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /due\s+(?:by|date)[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /closes?\s+(?:on)?[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed)) return parsed.toISOString().split('T')[0];
    }
  }
  return null;
}

function detectCountry(text) {
  if (text.includes('honduras')) return 'Honduras';
  if (text.includes('central america') || text.includes('centroamerica')) return 'Central America';
  if (text.includes('latin america') || text.includes('lac')) return 'LAC';
  return null;
}

function detectThemes(text) {
  return THEME_KEYWORDS.filter(kw => text.includes(kw));
}

module.exports = { fetchRSS };
