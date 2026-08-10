'use strict';
/**
 * notion-sync.js
 * Smart sync to Notion:
 *  - Creates new grant pages
 *  - PATCHes changed pages (score / tier / angle changed) instead of recreating
 *  - Skips truly unchanged pages (fast)
 *  - Updates database description with stats + "last scan" timestamp after every run
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { grantFingerprint } = require('./utils/grant-fingerprint');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;

// ── Low-level HTTP ────────────────────────────────────────────────────────────

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/${endpoint}`,
      method,
      // agent: false — without this, Node's default keep-alive HTTPS agent
      // holds the socket open after the response, keeping the event loop
      // alive so the process never exits on its own (observed: `node
      // src/cli.js run` finishing all real work but hanging indefinitely
      // instead of returning, stalling the scan -> score -> expand chain).
      agent: false,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Schema guard ──────────────────────────────────────────────────────────────

async function ensureSchema() {
  const db = await notionRequest('GET', `databases/${DB_ID}`, null);
  if (!db.properties) return;
  const existing = Object.keys(db.properties);
  const needed = {
    'Deadline Note':      { rich_text: {} },
    'Score Breakdown':    { rich_text: {} },
    'Application Angle':  { rich_text: {} },
    'Best Projects':      { rich_text: {} },
    'Source':             { rich_text: {} },
    'Competitive Fit':    { number: {} },
    // Identity key for dedup — grants without a usable URL (roundup posts,
    // digest-expanded items) used to always look "new" and get re-created
    // every sync. Falls back to grantFingerprint() the same way history.json
    // dedup already does elsewhere in this project.
    'Fingerprint':        { rich_text: {} },
    // Deep-research fields (src/deep-research.js). "Deep Researched" doubles
    // as the visible "this was written/updated by the AI research subagent"
    // marker, since deep research is currently the only thing that sets it.
    'Deep Researched':    { checkbox: {} },
    'Likelihood %':       { number: {} },
    'Research Status':    { select: { options: [
      { name: 'Open' }, { name: 'Closed' }, { name: 'Could not confirm' },
    ] } },
    'Research Summary':   { rich_text: {} },
  };
  const toCreate = Object.fromEntries(
    Object.entries(needed).filter(([name]) => !existing.includes(name))
  );
  if (Object.keys(toCreate).length === 0) return;
  console.log(`   Creating missing Notion columns: ${Object.keys(toCreate).join(', ')}`);
  await notionRequest('PATCH', `databases/${DB_ID}`, { properties: toCreate });
}

// ── Fetch existing pages ──────────────────────────────────────────────────────
// Returns Map<identityKey, { pageId, score, tier, angle }>. identityKey is
// the grant's Fingerprint when present (the stable cross-run identity used
// everywhere else in this project), falling back to URL for older pages
// synced before the Fingerprint column existed.

async function getExistingPages() {
  const pages = new Map();
  let cursor;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionRequest('POST', `databases/${DB_ID}/query`, body);
    for (const page of (res.results || [])) {
      const fingerprint = page.properties?.Fingerprint?.rich_text?.[0]?.text?.content || '';
      const url = page.properties?.URL?.url || '';
      const key = fingerprint || url;
      if (!key) continue;
      const score = page.properties?.Score?.number ?? null;
      const tier  = page.properties?.Tier?.select?.name ?? null;
      const angle = page.properties?.['Application Angle']?.rich_text?.[0]?.text?.content ?? '';
      const researched = page.properties?.['Deep Researched']?.checkbox ?? false;
      // If both a fingerprint-keyed and url-keyed lookup could find this page,
      // register it under both so identityKeyFor() matches either way.
      const entry = { pageId: page.id, score, tier, angle, researched };
      pages.set(key, entry);
      if (fingerprint && url) pages.set(url, entry);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages;
}

function identityKeyFor(grant) {
  const fp = grantFingerprint(grant);
  return (fp && fp.length > 3) ? fp : (grant.url || null);
}

// ── Tier helpers ──────────────────────────────────────────────────────────────
// Use scoring.recommendation directly (stays in sync with scorer/index.js thresholds)

const INELIGIBLE_FLAGS = [
  'WRONG_GEOGRAPHY', 'SCHOLARSHIP_ONLY', 'COURSE_NOT_GRANT',
  'VC_ONLY', 'NEWS_ARTICLE', 'CONFERENCE_NOT_GRANT',
  'NO_SPECIFIC_OPPORTUNITY', 'INELIGIBLE_GEO',
];

// Deep research (src/deep-research.js) is more authoritative than the
// surface-level rule+Claude score — it actually checked the funder's live
// page, past grantees, and current open/closed status. When a research
// result exists for a grant, its recommendation wins over scoring's.
function effectiveRecommendation(scoring, research) {
  return research?.recommendation || scoring.recommendation;
}

function tierLabel(scoring, research) {
  const rec = effectiveRecommendation(scoring, research);
  if (rec === 'INELIGIBLE' ||
      (scoring.flags || []).some(f => INELIGIBLE_FLAGS.includes(f))) return '⛔ Ineligible';
  switch (rec) {
    case 'APPLY_NOW': return '🚀 Apply Now';
    case 'CONSIDER':  return '⭐ Consider';
    case 'MONITOR':   return '👀 Monitor';
    default:          return '⏭ Skip';
  }
}

function tierOrder(scoring, research) {
  const rec = effectiveRecommendation(scoring, research);
  if (rec === 'INELIGIBLE' ||
      (scoring.flags || []).some(f => INELIGIBLE_FLAGS.includes(f))) return 5;
  switch (rec) {
    case 'APPLY_NOW': return 0;
    case 'CONSIDER':  return 1;
    case 'MONITOR':   return 2;
    default:          return 3;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatAmount(grant) {
  if (grant.amount_max && grant.amount_min)
    return `$${Number(grant.amount_min).toLocaleString()} – $${Number(grant.amount_max).toLocaleString()}`;
  if (grant.amount_max) return `Up to $${Number(grant.amount_max).toLocaleString()}`;
  if (grant.amount_min) return `From $${Number(grant.amount_min).toLocaleString()}`;
  return 'Amount TBD — see funder site';
}

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

function buildScoreBreakdown(scoring) {
  const s  = scoring.scores || {};
  const cf = s.competitive_fit;
  const parts = [
    `Geo:${(s.geo             || 0).toFixed(2)}`,
    `Size:${(s.size           || 0).toFixed(2)}`,
    `DL:${(s.deadline         || 0).toFixed(2)}`,
    `Org:${(s.org_type        || 0).toFixed(2)}`,
    `Partner:${(s.partnership || 0).toFixed(2)}`,
    `Align:${(s.mission_alignment || 0).toFixed(2)}`,
    ...(cf != null ? [`Compete:${cf >= 0 ? '+' : ''}${cf.toFixed(2)}`] : []),
    `Fit:${(s.strategic_fit >= 0 ? '+' : '')}${(s.strategic_fit || 0).toFixed(2)}`,
  ];
  return parts.join(' | ') + ` = ${(scoring.final_score || 0).toFixed(2)}`;
}

// ── Property builder (shared by create + update) ──────────────────────────────

// `isCreate` controls whether Status gets set. Status is Ricardo's manual
// workflow field (New/Reviewing/Applied/Won/Rejected) — a re-sync used to
// silently reset it back to "New" every time a grant re-scored, clobbering
// whatever he'd moved it to. Only stamp it on first creation now.
function buildProperties(grant, scoring, research, isCreate) {
  const score  = scoring.final_score ?? 0;
  const today  = new Date().toISOString().split('T')[0];
  const amount = formatAmount(grant);
  const themes = (grant.themes || []).slice(0, 10).map(t => ({ name: String(t).slice(0, 100) }));
  const fingerprint = grantFingerprint(grant);

  let deadlineObj = null;
  if (grant.deadline && /^\d{4}-\d{2}-\d{2}$/.test(grant.deadline))
    deadlineObj = { start: grant.deadline };

  const researchStatusName = research
    ? (research.appears_closed_or_expired ? 'Closed'
      : (research.status_evidence === null || research.status_evidence === undefined ? 'Could not confirm' : 'Open'))
    : null;

  return {
    Name:   { title: [{ text: { content: String(grant.title || 'Untitled').slice(0, 200) } }] },
    Score:  { number: Math.round(score * 100) / 100 },
    Tier:   { select: { name: tierLabel(scoring, research) } },
    ...(deadlineObj ? { Deadline: { date: deadlineObj } } : {}),
    URL:    { url: grant.url || null },
    Funder: { rich_text: [{ text: { content: String(grant.funder || '').slice(0, 200) } }] },
    Amount: { rich_text: [{ text: { content: amount } }] },
    Country:{ rich_text: [{ text: { content: String(grant.country || '').slice(0, 200) } }] },
    ...(themes.length ? { Themes: { multi_select: themes } } : {}),
    Fingerprint:         { rich_text: [{ text: { content: fingerprint.slice(0, 200) } }] },
    'Deadline Note':     { rich_text: [{ text: { content: formatDeadlineNote(grant) } }] },
    'Score Breakdown':   { rich_text: [{ text: { content: buildScoreBreakdown(scoring).slice(0, 500) } }] },
    'Application Angle': { rich_text: [{ text: { content: String(scoring.application_angle || '').slice(0, 2000) } }] },
    'Best Projects':     { rich_text: [{ text: { content: (scoring.best_projects || []).join(', ').slice(0, 500) } }] },
    Source:              { rich_text: [{ text: { content: String(grant.source || '').slice(0, 200) } }] },
    'Competitive Fit':   { number: Math.round((scoring.scores?.competitive_fit ?? 0) * 100) / 100 },
    'Deep Researched':   { checkbox: !!research },
    ...(research ? {
      'Likelihood %':     { number: research.likelihood_percent ?? null },
      'Research Status':  { select: { name: researchStatusName } },
      'Research Summary': { rich_text: [{ text: { content: (research.report || '').slice(0, 1900) } }] },
    } : {}),
    ...(isCreate ? { Status: { select: { name: 'New' } } } : {}),
    'Scan Date': { date: { start: today } },
  };
}

// ── Page body blocks (used only on first create) ──────────────────────────────

function buildPageChildren(grant, scoring, research) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const breakdown = buildScoreBreakdown(scoring);
  const reasoning = scoring.reasoning || '';
  const flags     = (scoring.flags || []).join(', ') || 'none';
  const deadline  = grant.deadline === 'rolling'
    ? '🔄 Rolling / No fixed deadline'
    : (grant.deadline || 'Not found — check funder website');

  const blocks = [
    {
      object: 'block', type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '📊 Score Breakdown' } }] },
    },
    {
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: breakdown }, annotations: { code: true } }],
      },
    },
  ];

  if (reasoning) {
    blocks.push(
      {
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: '💡 Analysis' } }] },
      },
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: reasoning.slice(0, 1500) } }] },
      },
    );
  }

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

  if (research) {
    blocks.push(
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: '🔎 Deep Research' } }] },
      },
      {
        object: 'block', type: 'callout',
        callout: {
          icon: { emoji: research.appears_closed_or_expired ? '⛔' : '✅' },
          rich_text: [{ type: 'text', text: {
            content: `${research.likelihood_percent}% likelihood — ${research.recommendation}` +
              (research.status_evidence ? `. ${research.status_evidence}` : ''),
          } }],
          color: research.appears_closed_or_expired ? 'red_background' : 'green_background',
        },
      },
    );
    // Notion rich_text blocks cap at ~2000 chars — split the full report
    // into paragraph chunks so nothing gets silently truncated.
    const report = research.report || '';
    for (let i = 0; i < report.length; i += 1900) {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: report.slice(i, i + 1900) } }] },
      });
    }
    if (research.sources?.length) {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'Sources: ' + research.sources.join(', ') }, annotations: { color: 'gray' } }] },
      });
    }
  }

  blocks.push(
    { object: 'block', type: 'divider', divider: {} },
    {
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: `🕐 First added: ${timestamp}` },
          annotations: { color: 'gray' },
        }],
      },
    },
  );

  return blocks;
}

// ── Decide whether an existing page needs updating ───────────────────────────

function shouldUpdate(existing, scoring, research) {
  const newTier  = tierLabel(scoring, research);
  const newScore = scoring.final_score ?? 0;
  const newAngle = scoring.application_angle || '';
  if (existing.tier  !== newTier)                         return true;
  if (Math.abs((existing.score || 0) - newScore) > 0.05)  return true;
  if ((existing.angle || '') !== newAngle)                return true;
  if (research && !existing.researched)                   return true; // newly researched
  return false;
}

// ── Update existing page: PATCH properties + append rescore note ──────────────

async function updatePage(pageId, grant, scoring, research) {
  await notionRequest('PATCH', `pages/${pageId}`, { properties: buildProperties(grant, scoring, research, false) });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const note = `Re-scored ${timestamp} → ${tierLabel(scoring, research)} (${(scoring.final_score||0).toFixed(2)}).` +
    (research ? ` Deep research: ${research.likelihood_percent}% — ${(research.status_evidence || '').slice(0, 200)}`
              : ` ${(scoring.reasoning || '').slice(0, 300)}`);
  await notionRequest('PATCH', `blocks/${pageId}/children`, {
    children: [{
      object: 'block', type: 'callout',
      callout: {
        icon: { emoji: research ? '🔎' : '🔄' },
        rich_text: [{ type: 'text', text: { content: note.slice(0, 600) } }],
        color: 'blue_background',
      },
    }],
  });
}

// ── Update database description with scan stats ───────────────────────────────

async function updateDatabaseMeta(scoredGrants, newCount, updatedCount) {
  const withScore = scoredGrants.filter(g => g.scoring?.final_score != null);
  const recs      = withScore.map(g => effectiveRecommendation(g.scoring, g.research));
  const total      = withScore.length;
  const applyNow   = recs.filter(r => r === 'APPLY_NOW').length;
  const consider   = recs.filter(r => r === 'CONSIDER').length;
  const monitor    = recs.filter(r => r === 'MONITOR').length;
  const ineligible = recs.filter(r => r === 'INELIGIBLE').length;
  const skip       = recs.filter(r => r === 'SKIP').length;
  const researched = withScore.filter(g => g.research).length;

  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Tegucigalpa',
  });

  const deltaStr = [
    newCount     > 0 ? `+${newCount} new`         : '',
    updatedCount > 0 ? `${updatedCount} re-scored` : '',
  ].filter(Boolean).join('  ·  ');

  const line1 = `🕐 Last scan: ${dateStr} (Honduras time)${deltaStr ? '   ·   ' + deltaStr : ''}`;
  const line2 = `📊 ${total} analyzed   🚀 ${applyNow} Apply Now   ⭐ ${consider} Consider   👀 ${monitor} Monitor   ⏭ ${skip} Skip   ⛔ ${ineligible} Ineligible   🔎 ${researched} deep-researched`;

  await notionRequest('PATCH', `databases/${DB_ID}`, {
    description: [{ type: 'text', text: { content: line1 + '\n' + line2 } }],
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function syncToNotion(scoredGrants, researchCache) {
  if (!TOKEN || !DB_ID) {
    console.log('  ⚠  Notion not configured — add NOTION_TOKEN + NOTION_DB_ID to .env');
    return;
  }

  const { getResearch } = require('./tracker/index');
  researchCache = researchCache || {};

  const withResearch = scoredGrants
    .filter(g => g.scoring && g.scoring.final_score != null)
    .map(g => ({ ...g, research: getResearch(g.grant, researchCache) }));

  // Highest-priority first, always — matches "empezá arriba desde los mejor
  // puntuados": researched grants use their (more authoritative) research
  // recommendation for ordering, everything else uses the surface score.
  const sorted = withResearch.sort((a, b) => {
    const ta = tierOrder(a.scoring, a.research), tb = tierOrder(b.scoring, b.research);
    return ta !== tb ? ta - tb : b.scoring.final_score - a.scoring.final_score;
  });

  console.log(`\n📋 Notion sync — ${sorted.length} grants (all tiers)...`);

  await ensureSchema();
  const existing = await getExistingPages();

  const genuinelyNew = sorted.filter(g => !existing.has(identityKeyFor(g.grant))).length;
  console.log(`   ${existing.size} in Notion now  ·  ${genuinelyNew} new candidates`);

  let added = 0, updated = 0, skipped = 0, errors = 0;

  for (const { grant, scoring, research } of sorted) {
    const key = identityKeyFor(grant);
    const existingPage = key ? existing.get(key) : null;

    if (!existingPage) {
      // ── New grant: create ──
      try {
        const res = await notionRequest('POST', 'pages', {
          parent: { database_id: DB_ID },
          properties: buildProperties(grant, scoring, research, true),
          children: buildPageChildren(grant, scoring, research),
        });
        if (res.id) { added++; process.stdout.write('+'); }
        else { errors++; if (res.message) console.error(`\n   ✗ create "${grant.title}": ${res.message}`); }
      } catch (err) { errors++; console.error(`\n   ✗ create "${grant.title}": ${err.message}`); }

    } else if (shouldUpdate(existingPage, scoring, research)) {
      // ── Changed: update ──
      try {
        await updatePage(existingPage.pageId, grant, scoring, research);
        updated++; process.stdout.write('~');
      } catch (err) { errors++; console.error(`\n   ✗ update "${grant.title}": ${err.message}`); }

    } else {
      // ── Unchanged: skip ──
      skipped++;
    }
  }

  console.log(`\n   ✅ ${added} new  ·  ${updated} re-scored  ·  ${skipped} unchanged  ·  ${errors} errors`);

  // Update the database header description with fresh stats
  try {
    await updateDatabaseMeta(sorted, added, updated);
    console.log(`   📊 Database stats header updated`);
  } catch (err) {
    console.error(`   ⚠  Could not update DB description: ${err.message}`);
  }

  if (added > 0 || updated > 0) {
    console.log(`   🔗 https://www.notion.so/${DB_ID.replace(/-/g, '')}`);
  }
}

module.exports = { syncToNotion };

// Allow running standalone: node src/notion-sync.js
if (require.main === module) {
  const SCORED = path.join(__dirname, '..', 'output', 'grants_scored.json');
  if (!fs.existsSync(SCORED)) {
    console.error('No grants_scored.json found. Run scan + scoring first.');
    process.exit(1);
  }
  const scored = JSON.parse(fs.readFileSync(SCORED, 'utf8'));
  const { loadResearchCache } = require('./tracker/index');
  syncToNotion(scored, loadResearchCache()).catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
}
