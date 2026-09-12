'use strict';
/**
 * notion-client.js
 *
 * Shared low-level Notion helpers, factored out of deep-research.js when
 * near-miss-check.js needed the exact same "query Notion, turn a page back
 * into a grant object" logic (2026-08-18) — keeping two copies in sync by
 * hand is how bugs like this happen. notion-sync.js keeps its own
 * notionRequest() (its property-building/schema logic is different enough,
 * and it's the one place `.env` loading + DB_ID resolution originally
 * lived) — this module is for the read-oriented helpers everything else
 * needs.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/${endpoint}`,
      method,
      // agent: false — prevents Node's default keep-alive agent from
      // holding the process open after the real work is done (the same
      // hang class documented in CLAUDE.md's troubleshooting section).
      agent: false,
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
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

function richText(prop) {
  return (prop?.rich_text || []).map(t => t.plain_text).join('') || null;
}

function parseAmount(amountStr) {
  if (!amountStr) return { amount_min: null, amount_max: null };
  const nums = amountStr.replace(/,/g, '').match(/\d+/g);
  if (!nums) return { amount_min: null, amount_max: null };
  if (nums.length >= 2) return { amount_min: parseInt(nums[0], 10), amount_max: parseInt(nums[1], 10) };
  return { amount_min: null, amount_max: parseInt(nums[0], 10) };
}

// Turns a Notion database page back into a grant object shaped like the
// ones scan.js produces — good enough for research/re-scoring prompts,
// which only need title/funder/url/country/themes/amount/deadline/description.
function notionPageToGrant(page) {
  const p = page.properties;
  const title = p.Name?.title?.[0]?.plain_text || '(untitled)';
  const { amount_min, amount_max } = parseAmount(richText(p.Amount));
  return {
    title,
    funder: richText(p.Funder) || title,
    source: richText(p.Source) || 'Notion (historical backlog)',
    url: p.URL?.url || null,
    country: richText(p.Country),
    themes: (p.Themes?.multi_select || []).map(t => t.name),
    amount_min, amount_max,
    deadline: p.Deadline?.date?.start || null,
    description: [
      richText(p['Application Angle']) ? `Application angle (from prior scoring): ${richText(p['Application Angle'])}` : null,
      richText(p['Best Projects']) ? `Best-fit Sustenta projects: ${richText(p['Best Projects'])}` : null,
      richText(p['Score Breakdown']) ? `Score breakdown: ${richText(p['Score Breakdown'])}` : null,
      richText(p['Deadline Note']) ? `Deadline note: ${richText(p['Deadline Note'])}` : null,
    ].filter(Boolean).join('\n'),
    type: 'grant',
    _notion_page_id: page.id,
    _scan_date: p['Scan Date']?.date?.start || null,
    _status: p.Status?.select?.name || null,
  };
}

// A research verdict used to be treated as authoritative forever — see
// deep-research.js and notion-sync.js's effectiveRecommendation() for where
// this matters. Re-research/re-trust only once it's been a while AND the
// formula score has actually moved enough for the old verdict to be
// suspect; a stale verdict on a grant whose score hasn't budged isn't
// worth revisiting.
const STALE_RESEARCH_DAYS = 90;
const STALE_SCORE_DRIFT = 0.5;
function isResearchStale(entry, currentScore) {
  if (!entry?.researched_at) return false;
  const ageDays = (Date.now() - new Date(entry.researched_at).getTime()) / 86400000;
  if (ageDays < STALE_RESEARCH_DAYS) return false;
  if (entry.scored_at_score == null || currentScore == null) return false;
  return Math.abs(currentScore - entry.scored_at_score) >= STALE_SCORE_DRIFT;
}

// Selection-fairness helper (deep-research.js): a grant sitting in the
// Notion backlog for many cycles gradually earns a priority bonus, so it
// doesn't get permanently outranked by whatever scored highest THIS run —
// see deep-research.js for the full reasoning. Local same-day candidates
// naturally get 0 (their scanDate is today).
const AGING_BONUS_PER_WEEK = 0.15;
const AGING_BONUS_CAP = 1.0;
function agingBonus(scanDate) {
  if (!scanDate) return 0;
  const days = (Date.now() - new Date(scanDate).getTime()) / 86400000;
  if (!(days > 0)) return 0;
  return Math.min(AGING_BONUS_CAP, (days / 7) * AGING_BONUS_PER_WEEK);
}

// Renders a grant's deadline as the emoji-coded "days left" text shown in
// Notion's Deadline Note column. Pulled out of notion-sync.js (2026-09-11)
// so deep-research.js can call the exact same formatter when it PATCHes a
// discovered_deadline into an existing backlog page — a second copy of this
// would drift out of sync with the real one, same INELIGIBLE_FLAGS lesson
// from 2026-08-25 (see CLAUDE.md). Takes the raw deadline string (grant.deadline
// or a research-discovered "YYYY-MM-DD"), not a full grant object.
function formatDeadlineNote(deadline) {
  const d = deadline;
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

// Turns a deep-research result's best_deadline_date + deadline_confidence
// (see prompts.js — REQUIRED from every research pass since 2026-09-12,
// "rolling" only for a genuinely evidenced no-fixed-cycle funder) into the
// Notion Deadline date property + Deadline Note text, marking anything
// short of a confirmed current date so a guess never looks identical to a
// verified one. Shared by deep-research.js (Notion-backlog grants) and
// notion-sync.js (same-day grants) — one implementation, not two that can
// drift apart (same INELIGIBLE_FLAGS lesson, 2026-08-25).
function computeDeadlineFields(bestDeadlineDate, deadlineConfidence) {
  const isRealDate = /^\d{4}-\d{2}-\d{2}$/.test(bestDeadlineDate || '');
  const isRolling = bestDeadlineDate === 'rolling';

  const deadlineObj = isRealDate ? { start: bestDeadlineDate } : null;

  let deadlineNote = null;
  if (isRealDate) {
    deadlineNote = formatDeadlineNote(bestDeadlineDate);
    if (deadlineConfidence === 'estimated_annual') deadlineNote = '≈ ' + deadlineNote + ' (estimado)';
    else if (deadlineConfidence === 'historical') deadlineNote += ' (última fecha conocida — próxima ronda sin confirmar)';
  } else if (isRolling) {
    deadlineNote = formatDeadlineNote('rolling');
  }

  return { deadlineObj, deadlineNote, isRealDate, isRolling };
}

module.exports = {
  notionRequest, richText, parseAmount, notionPageToGrant,
  isResearchStale, STALE_RESEARCH_DAYS, STALE_SCORE_DRIFT,
  agingBonus, AGING_BONUS_PER_WEEK, AGING_BONUS_CAP,
  formatDeadlineNote, computeDeadlineFields,
};
