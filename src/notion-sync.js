'use strict';
/**
 * notion-sync.js
 * Pushes ALL scored grants to Notion.
 * - Deduplicates by URL (re-runs only add new grants)
 * - Adds Score Breakdown column showing per-dimension points
 * - Writes page body with reasoning + last-scanned timestamp
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

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

/** Ensure the database has all required properties. Creates missing ones. */
async function ensureSchema() {
  const db = await notionRequest('GET', `databases/${DB_ID}`, null);
  if (!db.properties) return; // can't verify

  const existing = Object.keys(db.properties);
  const needed = {
    'Deadline Note':   { rich_text: {} },
    'Score Breakdown': { rich_text: {} },
  };

  const toCreate = Object.fromEntries(
    Object.entries(needed).filter(([name]) => !existing.includes(name))
  );

  if (Object.keys(toCreate).length === 0) return;

  console.log(`   Creating missing Notion columns: ${Object.keys(toCreate).join(', ')}`);
  await notionRequest('PATCH', `databases/${DB_ID}`, { properties: toCreate });
}

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

const INELIGIBLE_FLAGS = [
  'WRONG_GEOGRAPHY', 'SCHOLARSHIP_ONLY', 'COURSE_NOT_GRANT',
  'VC_ONLY', 'NEWS_ARTICLE', 'CONFERENCE_NOT_GRANT',
  'NO_SPECIFIC_OPPORTUNITY', 'INELIGIBLE_GEO',
];

function tierLabel(scoring) {
  const score = scoring.final_score ?? 0;
  if (scoring.recommendation === 'INELIGIBLE' ||
      (scoring.flags || []).some(f => INELIGIBLE_FLAGS.includes(f))) return '⛔ Ineligible';
  if (score >= 4.2) return '🔥 Apply Now';
  if (score >= 3.5) return '⭐ Consider';
  if (score >= 2.8) return '👀 Monitor';
  return '⏭ Skip';
}

function tierOrder(scoring) {
  if (scoring.recommendation === 'INELIGIBLE' ||
      (scoring.flags || []).some(f => INELIGIBLE_FLAGS.includes(f))) return 5;
  const score = scoring.final_score ?? 0;
  if (score >= 4.2) return 0;
  if (score >= 3.5) return 1;
  if (score >= 2.8) return 2;
  return 3;
}

function formatAmount(grant) {
  if (grant.amount_max && grant.amount_min) {
    return `$${Number(grant.amount_min).toLocaleString()} – $${Number(grant.amount_max).toLocaleString()}`;
  }
  if (grant.amount_max) return `Up to $${Number(grant.amount_max).toLocaleString()}`;
  if (grant.amount_min) return `From $${Number(grant.amount_min).toLocaleString()}`;
  return 'Amount TBD — see funder site';
}

/** Always-visible deadline text — never blank in Notion. */
function formatDeadlineNote(grant) {
  const d = grant.deadline;
  if (!d || d === 'rolling') return '🔄 Rolling — open call';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const dt   = new Date(d + 'T12:00:00Z');
    const days = Math.round((dt - Date.now()) / 86400000);
    const fmt  = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (days < 0)   return `⛔ Closed (${fmt})`;
    if (days <= 14) return `🔴 ${fmt} (${days}d left!)`;
    if (days <= 45) return `🟡 ${fmt} (${days}d)`;
    return `🟢 ${fmt} (${days}d)`;
  }
  return `📅 ${d}`;
}

/**
 * Builds a human-readable score breakdown string.
 * e.g. "Geo:1.00 | Size:0.56 | DL:0.56 | Org:0.30 | Partner:0.30 | Align:1.10 | Fit:+0.10 = 3.92"
 */
function buildScoreBreakdown(scoring) {
  const s = scoring.scores || {};
  const parts = [
    `Geo:${(s.geo            || 0).toFixed(2)}`,
    `Size:${(s.size          || 0).toFixed(2)}`,
    `DL:${(s.deadline        || 0).toFixed(2)}`,
    `Org:${(s.org_type       || 0).toFixed(2)}`,
    `Partner:${(s.partnership|| 0).toFixed(2)}`,
    `Align:${(s.mission_alignment || 0).toFixed(2)}`,
    `Fit:${(s.strategic_fit  >= 0 ? '+' : '')}${(s.strategic_fit || 0).toFixed(2)}`,
  ];
  return parts.join(' | ') + ` = ${(scoring.final_score || 0).toFixed(2)}`;
}

/**
 * Builds the Notion page body (children blocks):
 *   - Score Breakdown table/paragraph
 *   - Reasoning
 *   - Flags
 *   - Last Scanned timestamp
 */
function buildPageChildren(grant, scoring) {
  const now       = new Date();
  const timestamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const breakdown = buildScoreBreakdown(scoring);
  const reasoning = scoring.reasoning || '';
  const flags     = (scoring.flags || []).join(', ') || 'none';
  const deadline  = grant.deadline === 'rolling'
    ? '🔄 Rolling / No fixed deadline'
    : (grant.deadline || 'Not found — check funder website');

  const blocks = [
    // Score breakdown
    {
      object: 'block', type: 'heading_3',
      heading_3: {
        rich_text: [{ type: 'text', text: { content: '📊 Score Breakdown' } }],
      },
    },
    {
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: breakdown }, annotations: { code: true } }],
      },
    },
  ];

  // Reasoning (if present)
  if (reasoning) {
    blocks.push(
      {
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: '💡 Reasoning' } }] },
      },
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: reasoning.slice(0, 1500) } }] },
      },
    );
  }

  // Deadline clarification
  blocks.push(
    {
      object: 'block', type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '📅 Deadline' } }] },
    },
    {
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: deadline } }] },
    },
  );

  // Flags (if any non-standard)
  if (scoring.flags && scoring.flags.length > 0) {
    blocks.push({
      object: 'block', type: 'callout',
      callout: {
        icon: { emoji: '⚠️' },
        rich_text: [{ type: 'text', text: { content: `Flags: ${flags}` } }],
        color: 'yellow_background',
      },
    });
  }

  // Divider + last scanned
  blocks.push(
    { object: 'block', type: 'divider', divider: {} },
    {
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: `🕐 Last scanned: ${timestamp}` },
          annotations: { color: 'gray' },
        }],
      },
    },
  );

  return blocks;
}

function buildPage(grant, scoring) {
  const score  = scoring.final_score ?? 0;
  const today  = new Date().toISOString().split('T')[0];
  const amount = formatAmount(grant);

  let deadlineObj = null;
  if (grant.deadline && /^\d{4}-\d{2}-\d{2}$/.test(grant.deadline)) {
    deadlineObj = { start: grant.deadline };
  }

  const themes = (grant.themes || []).slice(0, 10).map(t => ({
    name: String(t).slice(0, 100),
  }));

  return {
    parent: { database_id: DB_ID },
    properties: {
      Name: {
        title: [{ text: { content: String(grant.title || 'Untitled').slice(0, 200) } }],
      },
      Score: { number: Math.round(score * 100) / 100 },
      Tier:  { select: { name: tierLabel(scoring) } },
      ...(deadlineObj ? { Deadline: { date: deadlineObj } } : {}),
      URL:   { url: grant.url || null },
      Funder: {
        rich_text: [{ text: { content: String(grant.funder || '').slice(0, 200) } }],
      },
      Amount: {
        rich_text: [{ text: { content: amount } }],
      },
      Country: {
        rich_text: [{ text: { content: String(grant.country || '').slice(0, 200) } }],
      },
      ...(themes.length ? { Themes: { multi_select: themes } } : {}),
      'Deadline Note': {
        rich_text: [{ text: { content: formatDeadlineNote(grant) } }],
      },
      'Score Breakdown': {
        rich_text: [{ text: { content: buildScoreBreakdown(scoring).slice(0, 500) } }],
      },
      'Application Angle': {
        rich_text: [{ text: { content: String(scoring.application_angle || '').slice(0, 2000) } }],
      },
      'Best Projects': {
        rich_text: [{ text: { content: (scoring.best_projects || []).join(', ').slice(0, 500) } }],
      },
      Source: {
        rich_text: [{ text: { content: String(grant.source || '').slice(0, 200) } }],
      },
      Status:      { select: { name: 'New' } },
      'Scan Date': { date: { start: today } },
    },
    children: buildPageChildren(grant, scoring),
  };
}

async function syncToNotion(scoredGrants) {
  if (!TOKEN || !DB_ID) {
    console.log('  ⚠  Notion not configured — add NOTION_TOKEN + NOTION_DB_ID to .env');
    return;
  }

  // Sort: tier first, then score descending within tier
  const sorted = [...scoredGrants]
    .filter(g => g.scoring && g.scoring.final_score != null)
    .sort((a, b) => {
      const ta = tierOrder(a.scoring);
      const tb = tierOrder(b.scoring);
      if (ta !== tb) return ta - tb;
      return b.scoring.final_score - a.scoring.final_score;
    });

  console.log(`\n📋 Notion sync — ${sorted.length} grants (all tiers)...`);

  await ensureSchema();
  const existing = await getExistingURLs();
  console.log(`   ${existing.size} already in Notion, skipping duplicates`);

  let added = 0, skipped = 0, errors = 0;

  for (const { grant, scoring } of sorted) {
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

  console.log(`\n   ✅ Added ${added} new | ${skipped} already existed | ${errors} errors`);
  if (added > 0) {
    console.log(`   🔗 https://www.notion.so/${DB_ID.replace(/-/g, '')}`);
  }
}

module.exports = { syncToNotion };

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
