#!/usr/bin/env node
/**
 * deep-research.js
 *
 * Loads grants_scored.json, picks the best-scored grants NOT already
 * researched, and exposes them for Claude Code to deep-research live —
 * NO API KEY, NO third-party search API. Claude Code (this session) uses
 * its own WebSearch/WebFetch tools (or the Agent tool to run one research
 * subagent per grant) and then calls saveResearchResults() to persist.
 *
 * Usage: open this file in Claude Code and say "deep research the top grants"
 *   or:  node src/deep-research.js [--limit=5]   (prints instructions + prompts)
 *
 * Mirrors score-with-claude.js's design on purpose — same "prepare data,
 * expose a save function, let Claude Code do the actual work" pattern,
 * not a second architecture.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { buildResearchPrompt } = require('./scorer/research-prompts');
const { loadResearchCache, saveResearchCache, getResearch, setResearch } = require('./tracker/index');
const { notionRequest, richText, notionPageToGrant, isResearchStale, agingBonus } = require('./notion-client');
const { grantsMatch } = require('./utils/grant-fingerprint');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const SCORED_FILE = path.join(OUTPUT_DIR, 'grants_scored.json');
const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');

const TIER_TO_RECOMMENDATION = {
  '🚀 Apply Now': 'APPLY_NOW', '⭐ Consider': 'CONSIDER', '👀 Monitor': 'MONITOR',
};
// Mirrors notion-sync.js's tierLabel() exactly, so a research result that
// changes the recommendation (e.g. a stale APPLY_NOW turning out to be
// closed) is reflected in Notion with the same tier vocabulary as the rest
// of the pipeline.
const TIER_TO_RECOMMENDATION_REVERSE = {
  APPLY_NOW: '🚀 Apply Now', CONSIDER: '⭐ Consider', MONITOR: '👀 Monitor',
  INELIGIBLE: '⛔ Ineligible', SKIP: '⏭ Skip',
};

// isResearchStale (imported above, from notion-client.js): a research
// result used to be treated as authoritative FOREVER — a grant researched
// once as MONITOR stayed MONITOR in Notion even if a later rescan pushed
// its formula score into Apply-Now territory (found in an audit 2026-08-18:
// a grant sitting at 4.21 with its Tier still pinned to an old Monitor
// verdict). Now it's only trusted forever until it's stale (old AND the
// score moved a lot) — see notion-client.js for the exact rule.

// Ricardo, 2026-08-09: local grants_scored.json only ever holds the CURRENT
// run's freshly-scanned grants (it's overwritten every scan) — it has no
// memory of grants scored well on a PAST run. Without this, "APPLY_NOW/
// CONSIDER/MONITOR get deep-researched automatically every 2 days" would
// only ever apply to that day's new arrivals and would never touch the
// backlog already sitting in Notion (78 grants, going back months, found
// when this was widened). Pulling directly from Notion — the durable
// record — is what actually makes the scheduled pipeline drain that
// backlog over time (still capped at `limit` per run for cost control).
// Ricardo, 2026-08-22: the SAME real program routinely gets scraped from
// its own site AND from an aggregator/repost under a completely different
// domain (e.g. "Youth Climate Justice Fund (YCJF) 2026" at ycjf.org vs.
// "Fondos de YCJF..." at gestionandote.org) — grantFingerprint() gives these
// structurally incompatible keys (domain-based vs. acronym/title-based), so
// they were never recognized as the same grant. Confirmed live: both got
// independently deep-researched the same day, wasting two of the capped
// research slots on one real opportunity. Changing grantFingerprint() itself
// is too risky (it's the persisted Notion identity key for the whole
// database — a format change would make every existing page look "new" on
// its next sync and mass-duplicate them). Instead, this collects every
// already-researched grant's {title, url} while scanning the database
// anyway, and cross-checks new candidates against it with the looser,
// pairwise grantsMatch() (shared acronym or ≥60% title-word overlap) before
// they're ever offered as research targets — a narrower, safe fix scoped to
// exactly where the waste happens.
async function fetchNotionBacklog(alreadyHaveFingerprints) {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DB_ID) return [];
  const out = [];
  const researchedGrants = [];
  let cursor;
  try {
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const resp = await notionRequest('POST', `databases/${process.env.NOTION_DB_ID}/query`, body);
      if (!resp.results) break;
      for (const page of resp.results) {
        if (page.properties?.['Deep Researched']?.checkbox) {
          researchedGrants.push({
            title: page.properties?.Name?.title?.[0]?.plain_text || '',
            url: page.properties?.URL?.url || '',
          });
        }
        const tierName = page.properties?.Tier?.select?.name;
        const recommendation = TIER_TO_RECOMMENDATION[tierName];
        if (!recommendation) continue;
        const currentScore = page.properties?.Score?.number ?? 0;
        const researchedAt = page.properties?.['Last Researched']?.date?.start || null;
        const researchedAtScore = page.properties?.['Researched At Score']?.number ?? null;
        if (researchedAt && !isResearchStale({ researched_at: researchedAt, scored_at_score: researchedAtScore }, currentScore)) {
          continue; // researched, and not stale enough yet to re-research
        }
        const grant = notionPageToGrant(page);
        if (alreadyHaveFingerprints.has(grant.url || grant.title)) continue;
        out.push({
          grant,
          scoring: { final_score: currentScore, recommendation, days_remaining: null },
          // Status is Ricardo's manual field (notion-sync.js) — setting it to
          // "Priority" is how he tells the pipeline "I already know this one
          // matters, research it next cycle regardless of score" (root cause
          // 2 below: pure top-score-wins meant a 2.55 could never win against
          // same-day 4.2-scorers, no matter how many cycles it waited).
          pinned: grant._status === 'Priority',
          scanDate: grant._scan_date,
        });
      }
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);
  } catch (err) {
    console.error('Notion backlog query failed (continuing with local candidates only):', err.message);
  }

  const deduped = filterAlreadyResearchedDuplicates(out, researchedGrants);
  const skipped = out.length - deduped.length;
  if (skipped > 0) console.log(`  Filtered ${skipped} likely-duplicate-of-already-researched candidate(s) before selection.`);
  return deduped;
}

// Extracted as a pure function purely for test coverage — see the comment
// above fetchNotionBacklog for the full incident this exists to prevent.
function filterAlreadyResearchedDuplicates(candidates, researchedGrants) {
  return candidates.filter(item => {
    const dupe = researchedGrants.find(rg => grantsMatch(item.grant, rg));
    if (dupe) {
      console.log(`  [dedup] Skipping "${item.grant.title.slice(0, 60)}" — looks like the same grant as already-researched "${dupe.title.slice(0, 60)}"`);
      return false;
    }
    return true;
  });
}

// Ricardo, 2026-08-09: broadened from ['APPLY_NOW', 'CONSIDER'] — the rule+Claude
// scoring pipeline had gone over a month (since ~June 26) without producing a
// single APPLY_NOW/CONSIDER grant, which silently starved deep-research of any
// targets at all. Take a stab at MONITOR too, best-scored first, so real
// candidates aren't lost just because scoring runs conservative. SKIP/
// INELIGIBLE remain excluded — those are the ones "que no" (genuinely not
// worth the research cost: wrong geography, expired, too small, etc).
const RESEARCH_ELIGIBLE = ['APPLY_NOW', 'CONSIDER', 'MONITOR'];
const DEFAULT_LIMIT = 5;

if (!fs.existsSync(SCORED_FILE)) {
  console.error('grants_scored.json not found. Run scoring first (node src/run-scoring.js or score with Claude Code).');
  process.exit(1);
}

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : DEFAULT_LIMIT;

const scored = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
const profile = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const researchCache = loadResearchCache();

global.profile = profile;

/**
 * Claude Code calls this after researching all targets.
 * @param {Array} results — array of { grant, report, result } where:
 *   - report is the full human-readable text (Part 1 of the prompt's output)
 *   - result is the parsed JSON block (Part 2): { likelihood_percent,
 *     recommendation, appears_closed_or_expired, status_evidence,
 *     reopens_within_12mo, reopening_estimate, confidence, sources }
 */
global.saveResearchResults = async function saveResearchResults(results) {
  const saved = [];
  // For the staleness check (isResearchStale above): what did this grant
  // score AT THE TIME of this research, so a future rescan can tell whether
  // it's drifted enough to be worth re-researching. Looked up from
  // global.researchTargets (set once candidate selection finishes) rather
  // than widening this function's own parameter — results only ever come
  // back as { grant, report, result } per the external contract above.
  const scoreAtResearchTime = new Map(
    (global.researchTargets || []).map(t => [t.grant.url || t.grant.title, t.scoring.final_score])
  );

  for (const { grant, report, result } of results) {
    let recommendation = result.recommendation;
    let timingDowngraded = false;

    // Deterministic override — don't trust the subagent alone to apply this
    // (Ricardo, 2026-08-07): APPLY_NOW means "act now." If the call is
    // closed/expired AND our best educated guess says it won't reopen
    // within the next 12 months, that's not something to act on now — pull
    // it down to CONSIDER (good fit, just not urgent). Absent/unknown
    // reopens_within_12mo defaults to the cautious "false" per the prompt's
    // own instruction, so a missing field still triggers the downgrade
    // rather than silently skipping it. This only ever touches APPLY_NOW —
    // CONSIDER/MONITOR/SKIP/INELIGIBLE from the fit-based step pass through
    // untouched.
    const reopensSoon = result.reopens_within_12mo === true;
    if (result.appears_closed_or_expired && !reopensSoon && recommendation === 'APPLY_NOW') {
      recommendation = 'CONSIDER';
      timingDowngraded = true;
    }

    const entry = {
      ...result, recommendation, timing_downgraded: timingDowngraded, report,
      scored_at_score: scoreAtResearchTime.get(grant.url || grant.title) ?? null,
    };
    setResearch(grant, entry, researchCache);
    saved.push({ grant, entry });

    // Ricardo, 2026-08-09: grants pulled from the Notion backlog (see
    // fetchNotionBacklog above) aren't in this run's grants_scored.json, so
    // the normal notion-sync.js re-sync step (skill step 5) never sees them
    // and can't push the research fields itself. PATCH those pages directly,
    // right here, so backlog-sourced research actually lands in Notion.
    // Locally-scored grants (no _notion_page_id) are untouched here — they
    // flow through the existing notion-sync.js path as before.
    if (grant._notion_page_id && process.env.NOTION_TOKEN && process.env.NOTION_DB_ID) {
      try {
        const tierName = TIER_TO_RECOMMENDATION_REVERSE[recommendation] || '⏭ Skip';
        const researchStatus = entry.appears_closed_or_expired ? 'Closed'
          : (entry.status_evidence == null ? 'Could not confirm' : 'Open');
        const resp = await notionRequest('PATCH', `pages/${grant._notion_page_id}`, {
          properties: {
            'Deep Researched': { checkbox: true },
            'Likelihood %': { number: entry.likelihood_percent ?? null },
            'Research Status': { select: { name: researchStatus } },
            'Research Summary': { rich_text: [{ text: { content: (report || '').slice(0, 1900) } }] },
            Tier: { select: { name: tierName } },
            // Staleness bookkeeping (see isResearchStale above) — without
            // these, a backlog-sourced grant researched once stays excluded
            // from re-research forever, even after its score moves a lot.
            'Last Researched':      { date: { start: new Date().toISOString().split('T')[0] } },
            'Researched At Score':  { number: entry.scored_at_score ?? null },
          },
        });
        if (resp.object !== 'page') {
          console.error(`  [Notion PATCH failed] ${grant.title.slice(0, 60)} ->`, JSON.stringify(resp).slice(0, 300));
        }
      } catch (err) {
        console.error(`  [Notion PATCH error] ${grant.title.slice(0, 60)} ->`, err.message);
      }
    }
  }

  saveResearchCache(researchCache);

  const reportPath = appendResearchSection(saved);

  console.log(`\nSaved ${saved.length} research result(s) to output/grants_research.json`);
  console.log(`Appended research section to: ${reportPath}`);
  saved.forEach(({ grant, entry }) => {
    const flag = entry.timing_downgraded ? '  [TIMING DOWNGRADE: closed, not reopening within 12mo]' : '';
    console.log(`  ${entry.likelihood_percent}% ${entry.recommendation} — ${grant.title.slice(0, 60)}${flag}`);
  });

  return { researchFile: path.join(OUTPUT_DIR, 'grants_research.json'), reportPath };
};

// ─── Build candidates (local scan + Notion backlog) and expose the target
// list. Async because of the Notion query — kept AFTER global.saveResearchResults
// is already assigned above (synchronously) so that a `node -e "require(...);
// global.saveResearchResults(...)"` invocation (skill step 4, run separately
// from step 2) never depends on this having finished. `node src/deep-
// research.js` run as a plain script (step 2) naturally waits for this to
// complete before the process exits, since Node doesn't exit while a promise
// is pending. ─────────────────────────────────────────────────────────────
// Ricardo, 2026-08-18: pure "sort by score, take top N" meant a grant that
// scored 2.55 or 2.5 could NEVER win a slot — it was competing against
// same-day 4.2-scorers every single cycle, forever, no matter how many
// times the pipeline ran (this is what an audit found happening to the
// CTCN/AFCIA and Social Shifters entries: both real Monitor-tier candidates,
// both perpetually starved). Two fixes, not mutually exclusive:
//   - a manual pin (Status = "Priority" in Notion) always gets a slot,
//     since Ricardo already knowing something matters is a stronger signal
//     than the formula
//   - an aging bonus for everything else, so a grant that's been waiting in
//     the Notion backlog across multiple cycles gradually catches up to
//     fresh high scorers instead of being permanently outranked by them.
//     Local same-day candidates get zero bonus (scanDate is today either
//     way) — aging is specifically about NOT losing to today's arrivals
//     forever, not about beating them on day one.
const PINNED_SLOTS = 2;

// Guarded so a plain require() (e.g. from a test importing
// filterAlreadyResearchedDuplicates, or the two-process
// `node -e "require(...); global.saveResearchResults(...)"` save pattern)
// never fires a live Notion query as a side effect — only running this file
// directly (`node src/deep-research.js`) does the actual candidate fetch.
if (require.main === module) (async () => {
  const localCandidates = scored
    .filter(item => RESEARCH_ELIGIBLE.includes(item.scoring.recommendation))
    .filter(item => {
      const cached = getResearch(item.grant, researchCache);
      return !cached || isResearchStale(cached, item.scoring.final_score);
    });

  const localFingerprints = new Set(localCandidates.map(i => i.grant.url || i.grant.title));
  const backlogCandidates = await fetchNotionBacklog(localFingerprints);

  const allEligible = [...localCandidates, ...backlogCandidates];
  const ranked = [...allEligible].sort((a, b) =>
    (b.scoring.final_score + agingBonus(b.scanDate)) - (a.scoring.final_score + agingBonus(a.scanDate))
  );

  const pinned = ranked.filter(i => i.pinned).slice(0, PINNED_SLOTS);
  const pinnedKeys = new Set(pinned.map(i => i.grant.url || i.grant.title));
  const rest = ranked.filter(i => !pinnedKeys.has(i.grant.url || i.grant.title));
  const candidates = [...pinned, ...rest].slice(0, limit);

  console.log(`\n=== Grant-Ops: Deep Research ===`);
  console.log(`Organization: ${profile.organization.name}`);
  console.log(`Eligible (${RESEARCH_ELIGIBLE.join('/')}) grants: ${allEligible.length} (${localCandidates.length} from today's scan, ${backlogCandidates.length} from Notion backlog)`);
  if (pinned.length) console.log(`Manually pinned (Status=Priority), always included: ${pinned.length}`);
  console.log(`Selected for this run (top ${limit}, pinned first): ${candidates.length}`);

  if (!candidates.length) {
    console.log(`\nNothing new to research. Every ${RESEARCH_ELIGIBLE.join('/')} grant already has a cached research result.`);
    return;
  }

  console.log(`\nFor each item in global.researchTargets, use the research_prompt with live web`);
  console.log(`search + page fetches (WebSearch/WebFetch, or one Agent subagent per grant run`);
  console.log(`in parallel). Parse the trailing JSON block from each response, then call`);
  console.log(`global.saveResearchResults([{ grant, report, result }, ...]).\n`);

  const researchTargets = candidates.map(item => ({
    grant: item.grant,
    scoring: item.scoring,
    research_prompt: buildResearchPrompt(item.grant, profile, { daysRemaining: item.scoring.days_remaining }),
  }));

  researchTargets.forEach((t, i) => {
    console.log(`  [${i}] (${t.scoring.final_score.toFixed(2)} ${t.scoring.recommendation}) ${t.grant.title.slice(0, 70)}`);
  });

  global.researchTargets = researchTargets;

  // Printed explicitly (not just set on `global`) so this also works when
  // deep-research.js is run as a plain subprocess (`node src/deep-research.js`,
  // no `require()` in the same process) — the calling agent can parse
  // target.research_prompt straight out of captured stdout instead of relying
  // on cross-process access to a JS global, which doesn't exist.
  console.log('\n=== RESEARCH_TARGETS_JSON ===');
  console.log(JSON.stringify(researchTargets));
})();

function appendResearchSection(saved) {
  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(OUTPUT_DIR, `research_${date}.md`);

  const lines = [`# Grant-Ops Deep Research — ${date}`, `**Organization:** ${profile.organization.name}`, ''];
  for (const { entry } of saved) {
    lines.push(entry.report, '', '---', '');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

module.exports = { RESEARCH_ELIGIBLE, DEFAULT_LIMIT, filterAlreadyResearchedDuplicates };
