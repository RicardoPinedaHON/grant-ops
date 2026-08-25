#!/usr/bin/env node
/**
 * near-miss-check.js
 *
 * Cheap validation gate for grants that scored SKIP by a narrow margin.
 * Added 2026-08-18 after an audit found real candidates (Halton "Indoor
 * Environmental Quality Grants", GEF SGP CSO Challenge) stuck at SKIP with
 * mission_alignment near zero — for a grant literally about PM2.5/
 * particulates, Sustenta's core focus area. Root cause: grants arriving via
 * RSS/LinkedIn/portal aggregators get a thin one-line scraped description,
 * not the funder's own text (only foundations.js's hardcoded entries get
 * that). The scoring prompt's own "don't score high just because a keyword
 * matches" guard then defaults to doubt when it's denied the detail that
 * would show the real fit. And since SKIP is permanently excluded from
 * deep-research.js's RESEARCH_ELIGIBLE list, there was no mechanism to ever
 * revisit that verdict.
 *
 * This is NOT deep research (no live search, no open/closed investigation,
 * no funder-history check). It's ONE plain page fetch per candidate,
 * re-judging fit only — mission_alignment and competitive_fit — against
 * the funder's own page text instead of the thin scraped summary. Far
 * cheaper than deep-research.js's per-grant multi-fetch budget, which is
 * exactly why it can run BEFORE that stage as a gate: anything it upgrades
 * past the Monitor floor becomes eligible for real deep research next.
 *
 * Same "prepare data, expose a save function, let Claude Code do the
 * scoring" pattern as deep-research.js/score-with-claude.js.
 *
 * Usage: node src/near-miss-check.js [--limit=8]
 *   then: read === NEAR_MISS_TARGETS_JSON === from stdout, answer each with
 *   its recheck_prompt (already built via buildNearMissRecheckPrompt), then
 *   call global.saveNearMissResults([{ grant, result }, ...]).
 *
 * Candidates come ONLY from Notion (not grants_scored.json) — by the time
 * this stage runs in the pipeline (after the first Notion sync), every
 * SKIP-tier grant from today's scan is already a Notion page too, so
 * querying Notion directly reaches BOTH today's arrivals AND the existing
 * backlog already sitting there with one code path, no separate local vs.
 * backlog logic to keep in sync (unlike deep-research.js, which predates
 * this and still has to merge two sources).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yaml = require('yaml');
const { notionRequest, notionPageToGrant } = require('./notion-client');
const { combineScores, MONITOR_THRESHOLD } = require('./scorer/index');
const { buildNearMissRecheckPrompt } = require('./scorer/prompts');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');

// Band below the Monitor floor worth a second look. Below this, a grant is
// so far off that a richer description almost never changes the verdict —
// spending a page-fetch budget there wouldn't be "cheap" anymore relative
// to what it could plausibly find.
const NEAR_MISS_MARGIN = 0.5;
const NEAR_MISS_FLOOR = MONITOR_THRESHOLD - NEAR_MISS_MARGIN;
const DEFAULT_LIMIT = 8;

// ── Fetch a funder's page as plain text, cheaply ────────────────────────────
// Plain HTTPS GET + tag-strip, same spirit as email-outlook.js's htmlToText —
// deliberately NOT a headless browser (Playwright) or a WebFetch tool call:
// this needs to run inside the unattended headless pipeline too, and stay
// cheap enough to justify doing it before the Skip verdict is even final.
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchPageText(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; grant-ops near-miss check)' },
      validateStatus: s => s < 500,
    });
    if (typeof res.data !== 'string') return null;
    return htmlToText(res.data);
  } catch (err) {
    console.warn(`  [NearMiss] Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

// ── Candidate query ──────────────────────────────────────────────────────────
async function fetchNearMissCandidates() {
  if (!process.env.NOTION_TOKEN && !process.env.NOTION_DB_ID) {
    // notion-client.js's own loadEnv() already ran on require; if these are
    // still unset the .env genuinely doesn't have them.
  }
  const dbId = process.env.NOTION_DB_ID;
  if (!process.env.NOTION_TOKEN || !dbId) {
    console.error('NOTION_TOKEN/NOTION_DB_ID not set — near-miss check needs Notion (that\'s where the Skip-tier backlog lives).');
    return [];
  }

  const out = [];
  let cursor;
  const filter = {
    and: [
      { property: 'Tier', select: { equals: '⏭ Skip' } },
      { property: 'Score', number: { greater_than_or_equal_to: NEAR_MISS_FLOOR } },
      { property: 'Score', number: { less_than: MONITOR_THRESHOLD } },
      { property: 'Near-Miss Checked', checkbox: { equals: false } },
    ],
  };
  // Highest-scored-first: found live 2026-08-18 that this band can hold 100+
  // grants at once (months of accumulated Skip-tier scans) — with no sort,
  // Notion returns its own arbitrary order and the specific grants worth
  // checking most (closest to the floor, most likely to actually flip) could
  // sit unprocessed for many cycles behind grants scoring 2.0 that were
  // never going anywhere. This is the same class of fix as deep-research.js's
  // pinned/aging selection, applied here too.
  const sorts = [{ property: 'Score', direction: 'descending' }];
  do {
    const body = { page_size: 100, filter, sorts };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionRequest('POST', `databases/${dbId}/query`, body);
    if (!resp.results) {
      if (resp.error || resp.message) console.error('Notion near-miss query failed:', resp.message || resp.error);
      break;
    }
    for (const page of resp.results) {
      const grant = notionPageToGrant(page);
      if (!grant.url) continue; // nothing to fetch — leave it as-is, don't fake a recheck
      out.push({ grant, prescoreLike: buildSyntheticPrescore(page) });
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return out;
}

// Notion only stores the already-COMBINED score breakdown (rule sub-scores
// + mission_alignment + competitive_fit + strategic_fit, as free text in
// "Score Breakdown"), not the original prescore object combineScores()
// needs. Reconstruct an equivalent one from the page's own properties so
// the recheck can reuse the exact same combining logic as normal scoring
// instead of a parallel formula that could drift out of sync with it.
function buildSyntheticPrescore(page) {
  const p = page.properties;
  const breakdown = p['Score Breakdown']?.rich_text?.[0]?.plain_text || '';
  const num = (key) => {
    const m = breakdown.match(new RegExp(`${key}:([+-]?[\\d.]+)`));
    return m ? parseFloat(m[1]) : 0;
  };
  const scores = {
    geo: num('Geo'), size: num('Size'), deadline: num('DL'),
    org_type: num('Org'), partnership: num('Partner'),
  };
  const ruleSubtotal = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    prescore: ruleSubtotal,
    scores,
    flags: [],
    daysRemaining: null,
    originalMissionAlignment: num('Align'),
    originalCompetitiveFit: num('Compete'),
    // strategic_fit ("Fit:" in the breakdown) is NOT re-derived by the
    // recheck (see saveNearMissResults) — it must be carried over here,
    // not dropped to 0, or a grant whose fit genuinely didn't change would
    // still silently gain/lose whatever the original strategic_fit was.
    originalStrategicFit: num('Fit'),
    _pageId: page.id,
    _bestProjects: p['Best Projects']?.rich_text?.[0]?.plain_text || '',
    _applicationAngle: p['Application Angle']?.rich_text?.[0]?.plain_text || '',
  };
}

/**
 * Claude Code calls this after rechecking all targets.
 * @param {Array} results — [{ grant, prescoreLike, result }], result =
 *   { mission_alignment, competitive_fit, changed, reasoning } per
 *   buildNearMissRecheckPrompt's requested JSON shape.
 */
// Same vocabulary as notion-sync.js's tierLabel()/deep-research.js's
// TIER_TO_RECOMMENDATION_REVERSE — kept local rather than imported since
// near-miss-check.js's combineScores() call can never actually produce
// INELIGIBLE (flags is always [] here; this stage only ever re-judges fit
// on grants that already passed the hard-ineligibility filter once).
const TIER_LABELS = { APPLY_NOW: '🚀 Apply Now', CONSIDER: '⭐ Consider', MONITOR: '👀 Monitor', SKIP: '⏭ Skip' };

global.saveNearMissResults = async function saveNearMissResults(results) {
  let upgraded = 0;
  for (const { grant, prescoreLike, result } of results) {
    const claudeResponseLike = {
      mission_alignment: result.mission_alignment,
      competitive_fit: result.competitive_fit,
      // NOT re-derived by the recheck (see buildNearMissRecheckPrompt) —
      // carry the ORIGINAL strategic_fit through unchanged, don't drop it
      // to 0. Found live 2026-08-18: dropping it silently inflated the
      // score of a grant whose fit genuinely hadn't changed, crossing it
      // past the Monitor floor for the wrong reason.
      strategic_fit: prescoreLike.originalStrategicFit,
      best_projects: prescoreLike._bestProjects ? prescoreLike._bestProjects.split(',').map(s => s.trim()) : [],
      application_angle: prescoreLike._applicationAngle || null,
      confidence: 'medium',
      reasoning: `[Near-miss recheck] ${result.reasoning}`,
    };
    const newScoring = combineScores(prescoreLike, claudeResponseLike);
    const wasUpgraded = newScoring.recommendation !== 'SKIP';
    if (wasUpgraded) upgraded++;

    try {
      const resp = await notionRequest('PATCH', `pages/${prescoreLike._pageId}`, {
        properties: {
          Score: { number: newScoring.final_score },
          // Use the REAL computed tier (could be Monitor, Consider, even
          // Apply Now) — not a flattened Monitor/Skip binary. Found live
          // 2026-08-18: GEF SGP CSO Challenge and Halton both actually
          // computed to CONSIDER, but an earlier version of this code
          // always wrote either "Monitor" or "Skip" regardless, so Notion
          // would have shown the wrong tier next to the right score.
          Tier: { select: { name: TIER_LABELS[newScoring.recommendation] || '⏭ Skip' } },
          'Score Breakdown': { rich_text: [{ text: { content:
            `Geo:${prescoreLike.scores.geo.toFixed(2)} | Size:${prescoreLike.scores.size.toFixed(2)} | DL:${prescoreLike.scores.deadline.toFixed(2)} | Org:${prescoreLike.scores.org_type.toFixed(2)} | Partner:${prescoreLike.scores.partnership.toFixed(2)} | Align:${result.mission_alignment.toFixed(2)} | Compete:${result.competitive_fit >= 0 ? '+' : ''}${result.competitive_fit.toFixed(2)} | Fit:${prescoreLike.originalStrategicFit >= 0 ? '+' : ''}${prescoreLike.originalStrategicFit.toFixed(2)} = ${newScoring.final_score.toFixed(2)} [near-miss rechecked]`
          } }] },
          'Competitive Fit': { number: Math.round(result.competitive_fit * 100) / 100 },
          'Near-Miss Checked': { checkbox: true },
        },
      });
      if (resp.object !== 'page') {
        console.error(`  [Notion PATCH failed] ${grant.title.slice(0, 60)} ->`, JSON.stringify(resp).slice(0, 300));
        continue;
      }
      const flag = wasUpgraded ? `  [UPGRADED → ${newScoring.recommendation}, now eligible for deep research]` : '';
      console.log(`  ${prescoreLike.prescore.toFixed(2)}+${result.mission_alignment.toFixed(2)}+${result.competitive_fit.toFixed(2)} = ${newScoring.final_score.toFixed(2)} — ${grant.title.slice(0, 60)}${flag}`);
    } catch (err) {
      console.error(`  [Notion PATCH error] ${grant.title.slice(0, 60)} ->`, err.message);
    }
  }
  console.log(`\n${upgraded}/${results.length} near-miss grant(s) upgraded past the Monitor floor.`);

  // Same fresh-one-off-process pattern as deep-research.js's
  // saveResearchResults (this is always invoked via `node -e "require(...);
  // global.saveNearMissResults([...])"`, never from a test or a long-lived
  // process) — and the same documented "finishes real work, never exits"
  // hang applies here too. Exiting explicitly is a mitigation, not a fix for
  // the underlying cause (see CLAUDE.md Troubleshooting).
  process.exit(0);
};

// Only run the actual pipeline stage when invoked directly (`node src/near-
// miss-check.js`), not when required as a library — org-profile.yaml is
// gitignored/per-org and reading it unconditionally at module scope would
// make this file unsafe to require() (e.g. from tests, or from a fresh
// clone before the setup wizard has run). global.saveNearMissResults above
// stays defined either way, matching deep-research.js/score-with-claude.js's
// existing "expose a save function" contract.
if (require.main === module) (async () => {
  const profile = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  global.profile = profile;
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : DEFAULT_LIMIT;

  console.log(`\n=== Grant-Ops: Near-Miss Validation Gate ===`);
  console.log(`Organization: ${profile.organization.name}`);
  console.log(`Band checked: score in [${NEAR_MISS_FLOOR.toFixed(2)}, ${MONITOR_THRESHOLD.toFixed(2)}), Tier = Skip, not yet checked`);

  const allCandidates = await fetchNearMissCandidates();
  const candidates = allCandidates.slice(0, limit);
  console.log(`Candidates in band: ${allCandidates.length}${allCandidates.length > limit ? ` (highest-scored ${limit} taken this run, ${allCandidates.length - limit} remain for next cycle)` : ''}`);

  if (!candidates.length) {
    console.log('Nothing to check this run.');
    return;
  }

  const targets = [];
  for (const { grant, prescoreLike } of candidates) {
    const pageText = await fetchPageText(grant.url);
    if (!pageText) {
      // Couldn't fetch it — mark checked anyway so a permanently-broken URL
      // doesn't get retried forever (cost-control, same reasoning as the
      // capped limit above); it just stays Skip.
      try {
        await notionRequest('PATCH', `pages/${prescoreLike._pageId}`, {
          properties: { 'Near-Miss Checked': { checkbox: true } },
        });
      } catch { /* non-critical */ }
      console.log(`  [skip — fetch failed] ${grant.title.slice(0, 60)}`);
      continue;
    }
    targets.push({
      grant, prescoreLike,
      recheck_prompt: buildNearMissRecheckPrompt(grant, pageText, profile, prescoreLike),
    });
  }

  if (!targets.length) {
    console.log('No candidate page fetched successfully this run.');
    return;
  }

  console.log(`\nFor each item in global.nearMissTargets, answer recheck_prompt (one Agent`);
  console.log(`subagent per grant, in parallel, is fine — no live search needed, the page`);
  console.log(`text is already included). Parse the JSON block from each response, then call`);
  console.log(`global.saveNearMissResults([{ grant, prescoreLike, result }, ...]).\n`);

  targets.forEach((t, i) => console.log(`  [${i}] ${t.grant.title.slice(0, 70)}`));

  global.nearMissTargets = targets;

  console.log('\n=== NEAR_MISS_TARGETS_JSON ===');
  console.log(JSON.stringify(targets));
})();

module.exports = {
  NEAR_MISS_MARGIN, NEAR_MISS_FLOOR, DEFAULT_LIMIT,
  htmlToText, buildSyntheticPrescore,
};
