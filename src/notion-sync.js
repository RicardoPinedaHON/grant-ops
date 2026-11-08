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
const { grantFingerprint, grantsMatch, sameHostDifferentProgram } = require('./utils/grant-fingerprint');
const { isResearchStale, formatDeadlineNote, computeDeadlineFields } = require('./notion-client');
const { INELIGIBLE_FLAGS } = require('./scorer/index');

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
    // Staleness bookkeeping (2026-08-18) — a research verdict used to be
    // authoritative forever (see effectiveRecommendation below); these let
    // deep-research.js tell "researched, and still fresh" apart from
    // "researched a while ago, and the score has moved a lot since" for
    // Notion-backlog candidates it doesn't hold in its own local cache.
    'Last Researched':     { date: {} },
    'Researched At Score': { number: {} },
    // Near-miss validation gate (src/near-miss-check.js) — separate from
    // deep research: one cheap page fetch to re-judge fit for grants that
    // scored SKIP by a narrow margin on a thin scraped description, not a
    // live open/closed investigation.
    'Near-Miss Checked':   { checkbox: {} },
    // Ricardo, 2026-09-12: makes an estimated/historical deadline visibly
    // distinct from a confirmed one, instead of a guess quietly looking
    // identical to a verified date. See deep-research.js/notion-sync.js's
    // deadline-writing logic — this is set whenever research produced a
    // best_deadline_date, at whatever confidence level it came from.
    'Deadline Confidence': { select: { options: [
      { name: 'confirmed' }, { name: 'estimated_annual' },
      { name: 'historical' }, { name: 'rolling' },
    ] } },
    // Live urgency indicator (Ricardo, 2026-09-11) — a Notion FORMULA
    // column, computed by Notion itself at view time from the real
    // `Deadline` date property. Exists because `Deadline Note` (the text
    // version above) only gets refreshed when a page happens to get
    // PATCHed — most pages sit untouched for weeks, so its "Xd left!" text
    // silently drifts wrong. This column never goes stale; it needs no
    // pipeline run at all to stay correct. Keep in sync with
    // notion-client.js's formatDeadlineNote() thresholds (≤14d red, ≤45d
    // yellow, else green) if those ever change.
    'Días Restantes (live)': { formula: { expression:
      'if(empty(prop("Deadline")), "🔄 Rolling", ' +
      'if(dateBetween(prop("Deadline"), now(), "days") < 0, "⛔ Closed", ' +
      'if(dateBetween(prop("Deadline"), now(), "days") <= 14, "🔴 " + format(dateBetween(prop("Deadline"), now(), "days")) + "d left!", ' +
      'if(dateBetween(prop("Deadline"), now(), "days") <= 45, "🟡 " + format(dateBetween(prop("Deadline"), now(), "days")) + "d", ' +
      '"🟢 " + format(dateBetween(prop("Deadline"), now(), "days")) + "d"))))'
    } },
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
  // Flat list of every page, title+url included — used for the fuzzy
  // cross-source dedup pass below (findFuzzyMatch), which the fingerprint/
  // URL Map alone can't do since it only supports exact-key lookup.
  const allPages = [];
  let cursor;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionRequest('POST', `databases/${DB_ID}/query`, body);
    for (const page of (res.results || [])) {
      const fingerprint = page.properties?.Fingerprint?.rich_text?.[0]?.text?.content || '';
      const url = page.properties?.URL?.url || '';
      const title = page.properties?.Name?.title?.[0]?.plain_text || '';
      const key = fingerprint || url;
      const score = page.properties?.Score?.number ?? null;
      const tier  = page.properties?.Tier?.select?.name ?? null;
      const angle = page.properties?.['Application Angle']?.rich_text?.[0]?.text?.content ?? '';
      const researched = page.properties?.['Deep Researched']?.checkbox ?? false;
      // If both a fingerprint-keyed and url-keyed lookup could find this page,
      // register it under both so identityKeyFor() matches either way.
      const entry = { pageId: page.id, score, tier, angle, researched, title, url };
      if (key) {
        pages.set(key, entry);
        if (fingerprint && url) pages.set(url, entry);
      }
      allPages.push(entry);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return { pages, allPages };
}

// Ricardo, 2026-09-12: exact fingerprint/URL matching misses the SAME real
// grant scraped from two different sources — a portal aggregator, the
// funder's own official site, and/or LinkedIn each produce a different
// domain, hence a different fingerprint. Confirmed live 3 times (YCJF,
// GEF SGP CSO Challenge Program, Stanley 1913 Creators Fund), each
// splitting into two weaker orphaned pages that never won a deep-research
// slot alone, competing against each other instead of being one stronger
// candidate. `grantsMatch()` already exists and is already trusted for
// exactly this kind of fuzzy identity check (deep-research.js's
// filterAlreadyResearchedDuplicates) — reused here, BEFORE a new page
// gets created, not just at research-target-selection time after the
// fact. O(new candidates × existing pages) — cheap in practice (a few
// dozen new grants per run against a few hundred existing pages).
function findFuzzyMatch(grant, allPages) {
  return allPages.find(p => p.pageId && grantsMatch(grant, { title: p.title, url: p.url }));
}

// The Fingerprint key is host+year, so a DIFFERENT program on the same funder
// host (solve.mit.edu/challenges/<other>) resolves to the old page and would
// overwrite it. Drop the exact-key hit when the page is clearly another program.
function exactMatchFor(grant, entry) {
  if (!entry) return null;
  return sameHostDifferentProgram(grant, { title: entry.title, url: entry.url }) ? null : entry;
}

function identityKeyFor(grant) {
  const fp = grantFingerprint(grant);
  return (fp && fp.length > 3) ? fp : (grant.url || null);
}

// ── Tier helpers ──────────────────────────────────────────────────────────────
// Use scoring.recommendation directly (stays in sync with scorer/index.js thresholds)
// INELIGIBLE_FLAGS itself is imported from scorer/index.js (above) — it used to be
// duplicated verbatim here, which meant updating one copy without the other would
// silently desync which flags force an Ineligible tier (found 2026-08-25 gap review).

// Deep research (src/deep-research.js) is more authoritative than the
// surface-level rule+Claude score — it actually checked the funder's live
// page, past grantees, and current open/closed status. When a research
// result exists for a grant, its recommendation wins over scoring's —
// UNLESS that research has gone stale (old, AND the fresh score has since
// moved a lot — see notion-client.js's isResearchStale). Otherwise a grant
// researched once as Monitor stayed pinned to Monitor in Notion forever,
// even after a later rescan pushed it into Apply-Now territory.
function effectiveRecommendation(scoring, research) {
  if (research && !isResearchStale(research, scoring.final_score)) return research.recommendation;
  return scoring.recommendation;
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

  // A live-researched best_deadline_date overrides the original scrape —
  // it's what actually caught GEF SGP CSO Challenge Program's real Sept 15
  // deadline after the scrape had only seen "rolling" (Ricardo, 2026-09-11).
  // best_deadline_date is REQUIRED from research now (2026-09-12) — never
  // null, and only "rolling" when the funder genuinely has no fixed cycle;
  // confirmed/estimated_annual/historical all carry a real date, per
  // deadline_confidence (see prompts.js and deep-research.js for the same
  // logic applied to Notion-backlog grants).
  const hasResearchDeadline = research?.best_deadline_date != null;
  const { deadlineObj: researchDeadlineObj, deadlineNote: researchDeadlineNote } =
    hasResearchDeadline ? computeDeadlineFields(research.best_deadline_date, research.deadline_confidence) : {};

  // No research yet (or research gave no usable deadline at all) -> fall
  // back to whatever the scrape/scoring pass already found.
  const deadlineObj = hasResearchDeadline ? (researchDeadlineObj || null)
    : (grant.deadline && /^\d{4}-\d{2}-\d{2}$/.test(grant.deadline) ? { start: grant.deadline } : null);
  const effectiveDeadlineNote = hasResearchDeadline ? (researchDeadlineNote || formatDeadlineNote('rolling'))
    : formatDeadlineNote(grant.deadline);

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
    'Deadline Note':     { rich_text: [{ text: { content: effectiveDeadlineNote } }] },
    ...(research?.deadline_confidence ? { 'Deadline Confidence': { select: { name: research.deadline_confidence } } } : {}),
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
      ...(research.researched_at ? { 'Last Researched': { date: { start: research.researched_at.split('T')[0] } } } : {}),
      ...(research.scored_at_score != null ? { 'Researched At Score': { number: research.scored_at_score } } : {}),
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

  const todayStr = new Date().toISOString().split('T')[0];

  // Ricardo, 2026-09-14: this used to be `withScore.filter(g => g.research)`
  // — how many of TODAY's freshly-scanned grants happen to carry a research
  // object. Nearly always wrong: deep-research.js pulls most of its targets
  // from the Notion BACKLOG (grants scored on a past run), not today's
  // batch — confirmed live, a run that genuinely deep-researched 5 grants
  // still showed "🔎 0 deep-researched" because none of the 5 were among
  // today's scan. A live query for pages with `Last Researched` = today is
  // accurate regardless of which script (this sync, or deep-research.js's
  // direct backlog PATCH) actually touched them.
  let researched = 0;
  try {
    const res = await notionRequest('POST', `databases/${DB_ID}/query`, {
      filter: { property: 'Last Researched', date: { equals: todayStr } },
      page_size: 1,
    });
    // We only need the count, but Notion's query API doesn't return a bare
    // count — page through has_more to get the real total (deep-research
    // is capped at 5/run so this is always a handful of requests at most).
    researched = (res.results || []).length;
    let cursor = res.has_more ? res.next_cursor : null;
    while (cursor) {
      const next = await notionRequest('POST', `databases/${DB_ID}/query`, {
        filter: { property: 'Last Researched', date: { equals: todayStr } },
        page_size: 100, start_cursor: cursor,
      });
      researched += (next.results || []).length;
      cursor = next.has_more ? next.next_cursor : null;
    }
  } catch (err) {
    console.error(`   ⚠  Could not count today's deep-researched grants: ${err.message}`);
  }

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
  const line2 = `📊 ${total} analyzed   🚀 ${applyNow} Apply Now   ⭐ ${consider} Consider   👀 ${monitor} Monitor   ⏭ ${skip} Skip   ⛔ ${ineligible} Ineligible   🔎 ${researched} deep-researched today`;

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
  const { pages: existing, allPages } = await getExistingPages();

  const genuinelyNew = sorted.filter(g => !exactMatchFor(g.grant, existing.get(identityKeyFor(g.grant)))).length;
  console.log(`   ${existing.size} in Notion now  ·  ${genuinelyNew} new candidates (before fuzzy dedup)`);

  let added = 0, updated = 0, merged = 0, skipped = 0, errors = 0, notAGrant = 0;

  for (const { grant, scoring, research } of sorted) {
    const key = identityKeyFor(grant);
    const existingPage = key ? exactMatchFor(grant, existing.get(key)) : null;
    // No exact fingerprint/URL match — check for the SAME real grant under
    // a different domain before treating this as genuinely new (see
    // findFuzzyMatch above).
    const fuzzyMatch = existingPage ? null : findFuzzyMatch(grant, allPages);
    const targetPage = existingPage || fuzzyMatch;

    if (!targetPage && (scoring.not_a_grant || (scoring.flags || []).includes('NOT_A_GRANT'))) {
      // Not a grant at all (thank-you post, own subscription ad, paid course):
      // never becomes a Notion page. An existing page is still updated below.
      notAGrant++;
      continue;
    }

    if (!targetPage) {
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

    } else if (fuzzyMatch) {
      // ── Same grant, different source: merge into the existing page
      // instead of creating a duplicate ──
      try {
        await updatePage(targetPage.pageId, grant, scoring, research);
        merged++; process.stdout.write('≈');
      } catch (err) { errors++; console.error(`\n   ✗ merge "${grant.title}" into existing page: ${err.message}`); }

    } else if (shouldUpdate(targetPage, scoring, research)) {
      // ── Changed: update ──
      try {
        await updatePage(targetPage.pageId, grant, scoring, research);
        updated++; process.stdout.write('~');
      } catch (err) { errors++; console.error(`\n   ✗ update "${grant.title}": ${err.message}`); }

    } else {
      // ── Unchanged: skip ──
      skipped++;
    }
  }

  console.log(`\n   ✅ ${added} new  ·  ${updated} re-scored  ·  ${merged} merged (cross-source dedup)  ·  ${skipped} unchanged  ·  ${notAGrant} not-a-grant (not synced)  ·  ${errors} errors`);

  // Update the database header description with fresh stats
  try {
    await updateDatabaseMeta(sorted, added, updated + merged);
    console.log(`   📊 Database stats header updated`);
  } catch (err) {
    console.error(`   ⚠  Could not update DB description: ${err.message}`);
  }

  if (added > 0 || updated > 0 || merged > 0) {
    console.log(`   🔗 https://www.notion.so/${DB_ID.replace(/-/g, '')}`);
  }
}

module.exports = { syncToNotion, findFuzzyMatch, identityKeyFor, exactMatchFor };

// Allow running standalone: node src/notion-sync.js
if (require.main === module) {
  const SCORED = path.join(__dirname, '..', 'output', 'grants_scored.json');
  if (!fs.existsSync(SCORED)) {
    console.error('No grants_scored.json found. Run scan + scoring first.');
    process.exit(1);
  }
  const scored = JSON.parse(fs.readFileSync(SCORED, 'utf8'));
  const { loadResearchCache } = require('./tracker/index');
  syncToNotion(scored, loadResearchCache())
    // Explicit exit once the real work is done — `agent: false` above stops
    // Node's keep-alive HTTPS agent from holding the process open, but this
    // hang has reproduced multiple times anyway (2026-08-18, 2026-08-22) and
    // was never conclusively root-caused (see CLAUDE.md Troubleshooting).
    // Forcing exit here doesn't fix the underlying cause, but it does mean
    // the unattended pipeline stops silently stalling on this exact step.
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Sync failed:', err.message);
      process.exit(1);
    });
}
