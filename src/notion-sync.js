'use strict';
/**
 * notion-sync.js
 * Pushes scored grants to Notion database.
 * Skips grants already in Notion (deduplicates by URL).
 * Only syncs CONSIDER and above (score >= 2.8), skips SKIP tier.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env manually (no dotenv dependency)
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

loadEnv();

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path: `/v1/${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Get all URLs already in the Notion DB to avoid duplicates
async function getExistingURLs() {
  const urls = new Set();
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest('POST', `databases/${DB_ID}/query`, body);
    if (res.results) {
      for (const page of res.results) {
        const url = page.properties?.URL?.url;
        if (url) urls.add(url);
      }
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return urls;
}

function tierLabel(score) {
  if (score >= 4.2) return '🔥 Apply Now';
  if (score >= 3.5) return '⭐ Consider';
  if (score >= 2.8) return '👀 Monitor';
  return '⏭ Skip';
}

function formatAmount(grant) {
  if (grant.amount_max) {
    const min = grant.amount_min ? `$${grant.amount_min.toLocaleString()}–` : '$';
    return `${min}$${grant.amount_max.toLocaleString()}`;
  }
  return 'TBD';
}

function buildPage(grant, scoring) {
  const score = scoring.final_score ?? 0;
  const today = new Date().toISOString().split('T')[0];

  // Parse deadline
  let deadlineObj = null;
  if (grant.deadline && grant.deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
    deadlineObj = { start: grant.deadline };
  }

  // Themes as multi_select options
  const themes = (grant.themes || []).slice(0, 10).map(t => ({
    name: String(t).slice(0, 100),
  }));

  return {
    parent: { database_id: DB_ID },
    properties: {
      Name: {
        title: [{ text: { content: String(grant.title || 'Untitled').slice(0, 200) } }],
      },
      Funder: {
        rich_text: [{ text: { content: String(grant.funder || '').slice(0, 200) } }],
      },
      Score: { number: Math.round(score * 100) / 100 },
      Tier: { select: { name: tierLabel(score) } },
      Status: { select: { name: 'New' } },
      Amount: {
        rich_text: [{ text: { content: formatAmount(grant) } }],
      },
      ...(deadlineObj ? { Deadline: { date: deadlineObj } } : {}),
      Country: {
        rich_text: [{ text: { content: String(grant.country || '').slice(0, 200) } }],
      },
      ...(themes.length ? { Themes: { multi_select: themes } } : {}),
      'Application Angle': {
        rich_text: [{ text: { content: String(scoring.application_angle || '').slice(0, 2000) } }],
      },
      'Best Projects': {
        rich_text: [{ text: { content: (scoring.best_projects || []).join(', ').slice(0, 500) } }],
      },
      URL: { url: grant.url || null },
      Source: {
        rich_text: [{ text: { content: String(grant.source || '').slice(0, 200) } }],
      },
      'Scan Date': { date: { start: today } },
    },
  };
}

async function syncToNotion(scoredGrants) {
  if (!TOKEN || !DB_ID) {
    console.log('  ⚠  Notion not configured — skipping sync (add NOTION_TOKEN + NOTION_DB_ID to .env)');
    return;
  }

  // Only sync MONITOR and above
  const toSync = scoredGrants.filter(g =>
    g.scoring && g.scoring.final_score != null && g.scoring.final_score >= 2.8
  );

  console.log(`\n📋 Notion sync — checking ${toSync.length} grants (score ≥ 2.8)...`);

  const existing = await getExistingURLs();
  console.log(`   ${existing.size} already in Notion, skipping duplicates`);

  let added = 0, skipped = 0, errors = 0;

  for (const { grant, scoring } of toSync) {
    if (grant.url && existing.has(grant.url)) {
      skipped++;
      continue;
    }
    try {
      const res = await notionRequest('POST', 'pages', buildPage(grant, scoring));
      if (res.id) {
        added++;
        process.stdout.write('.');
      } else {
        errors++;
        if (res.message) console.error(`\n   Error on "${grant.title}": ${res.message}`);
      }
    } catch (err) {
      errors++;
      console.error(`\n   Error on "${grant.title}": ${err.message}`);
    }
  }

  console.log(`\n   ✅ Added ${added} new grants | ${skipped} already existed | ${errors} errors`);
  if (added > 0) {
    console.log(`   🔗 https://www.notion.so/${DB_ID.replace(/-/g, '')}`);
  }
}

module.exports = { syncToNotion };

// Run standalone: node src/notion-sync.js
if (require.main === module) {
  const SCORED = path.join(__dirname, '..', 'output', 'grants_scored.json');
  if (!fs.existsSync(SCORED)) {
    console.error('No grants_scored.json found. Run: grant-ops run first.');
    process.exit(1);
  }
  const scored = JSON.parse(fs.readFileSync(SCORED, 'utf8'));
  syncToNotion(scored).catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
}
