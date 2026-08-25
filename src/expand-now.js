#!/usr/bin/env node
/**
 * expand-now.js
 *
 * Opens every ImpactFunding digest currently in grants_scored.json with
 * Playwright, extracts individual grants, and exposes them for Claude Code
 * to score with real per-grant judgment — same "prepare data, expose a
 * save function, let Claude Code do the actual reasoning" pattern as
 * scan.js -> score-with-claude.js.
 *
 * Fixed 2026-08-25 — this used to score digest-expanded grants via
 * manual-scorer.js's keyword/hardcoded fallback internally, the exact same
 * fake-AI problem the main pipeline had until 2026-08-22 (see CLAUDE.md's
 * "Automated Claude scoring" section), just left unfixed here because
 * digest volume had been low-to-zero on most runs. Now it builds real
 * claude_prompts via buildPromptForClaude() and waits for genuine judgment
 * like every other grant in the pipeline.
 *
 * Usage:
 *   node src/expand-now.js
 *     -> expands digests, writes output/grants_prescored_digest.json,
 *        prints each item's claude_prompt, and waits.
 *   Then, from Claude Code: for each item, read item.claude_prompt and
 *   respond with the JSON object score-with-claude.js's contract requests
 *   (mission_alignment, competitive_fit, strategic_fit, best_projects,
 *   application_angle, confidence, reasoning, optional _ineligible), map
 *   through scoreOneGrant(item, response), and call
 *   global.saveExpandedResults(scoredArray) — or, from a driver script in a
 *   fresh process, require() this file's exported scoreOneGrant/mergeAndSave.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

const { expandAllDigests } = require('./scrapers/digest-expander');
const { closeBrowser }     = require('./scrapers/playwright-base');
const { buildPromptForClaude, combineScores } = require('./scorer/index');
const { saveTSV, saveMarkdownReport, saveHTMLReport } = require('./tracker/index');

const OUTPUT                = path.join(process.cwd(), 'output');
const SCORED_FILE           = path.join(OUTPUT, 'grants_scored.json');
const PRESCORED_DIGEST_FILE = path.join(OUTPUT, 'grants_prescored_digest.json');
const PROFILE_PATH          = path.join(process.cwd(), 'org-profile.yaml');

// ─── Pure logic (exported, safe to unit-test / reuse from a driver script) ──
// Mirrors score-with-claude.js's scoreOneGrant() exactly — same contract,
// just kept local here too so this file doesn't need score-with-claude.js
// as a dependency for something this small.

function scoreOneGrant(prescoredItem, claudeResponse) {
  if (!prescoredItem) throw new Error('No prescored item given');
  const scoring = combineScores(prescoredItem.prescore, claudeResponse);
  return { grant: prescoredItem.grant, scoring };
}

// Merges newly (really) scored digest grants into the existing non-digest
// scored set, deduping by URL, and writes grants_scored.json + reports —
// the same merge behavior the old single-pass version had, just fed real
// scores instead of manual-scorer.js's boilerplate now.
function mergeAndSave(nonDigestScored, newlyScored, profile) {
  const existingUrls = new Set(nonDigestScored.map(g => g.grant.url).filter(Boolean));
  const deduped = newlyScored.filter(g => {
    if (!g.grant.url || existingUrls.has(g.grant.url)) return false;
    existingUrls.add(g.grant.url);
    return true;
  });

  const allScored = [...nonDigestScored, ...deduped];
  fs.writeFileSync(SCORED_FILE, JSON.stringify(allScored, null, 2));

  const tsvPath  = saveTSV(allScored);
  const mdPath   = saveMarkdownReport(allScored, profile);
  const htmlPath = saveHTMLReport(allScored, profile);

  return { allScored, added: deduped.length, tsvPath, mdPath, htmlPath };
}

// ─── Orchestration (only runs when invoked directly) ────────────────────────

if (require.main === module) {
  if (!fs.existsSync(SCORED_FILE)) {
    console.error('No grants_scored.json found. Run: node src/scan.js first.');
    process.exit(1);
  }

  const existingScored  = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const profile          = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

  // Pull out raw digest grant objects from ImpactFunding Substack
  const digestGrants    = existingScored
    .filter(g => g.grant.source === 'ImpactFunding Substack')
    .map(g => g.grant);
  const nonDigestScored = existingScored.filter(g => g.grant.source !== 'ImpactFunding Substack');

  if (digestGrants.length === 0) {
    console.log('No ImpactFunding digest items found — nothing to expand.');
    process.exit(0);
  }

  console.log(`\n📬  Expanding ${digestGrants.length} ImpactFunding newsletter(s)...`);
  console.log('    Playwright will open each URL and extract individual grants.\n');

  (async () => {
    const expandedRaw = await expandAllDigests(digestGrants);
    await closeBrowser();

    if (expandedRaw.length === 0) {
      console.warn('\n⚠️  No grants extracted. Substack pages may be paywalled or unreachable.');
      process.exit(0);
    }

    // Pre-score + build a REAL scoring prompt for each extracted grant —
    // buildPromptForClaude(), the same function scan.js uses, not
    // manual-scorer.js's hardcoded/keyword fallback.
    const prescored = [];
    let skipped = 0;
    for (const grant of expandedRaw) {
      const result = buildPromptForClaude(grant, profile);
      if (!result) { skipped++; continue; }
      prescored.push({ grant, prescore: result.prescore, claude_prompt: result.prompt });
    }

    console.log(`\n  Ready for scoring: ${prescored.length}  |  Skipped (low prescore/geo): ${skipped}`);

    if (prescored.length === 0) {
      console.log('  Nothing passed the pre-filter — nothing to score.');
      process.exit(0);
    }

    fs.writeFileSync(PRESCORED_DIGEST_FILE, JSON.stringify(prescored, null, 2));

    console.log(`\nFor each item below, read item.claude_prompt and respond with the JSON object`);
    console.log(`score-with-claude.js's contract requests (mission_alignment, competitive_fit,`);
    console.log(`strategic_fit, best_projects, application_angle, confidence, reasoning, optional`);
    console.log(`_ineligible). Map each through scoreOneGrant(item, response), then call`);
    console.log(`global.saveExpandedResults(scoredArray).`);
    console.log(`\nDigest grants ready for Claude scoring:`);
    prescored.forEach((item, i) => console.log(`  [${i}] ${item.grant.title.slice(0, 70)}`));

    // ─── Globals exposed for Claude Code to use ────────────────────────────
    global.prescoredDigest = prescored;
    global.nonDigestScored = nonDigestScored;
    global.profile = profile;

    /**
     * Claude Code calls this after scoring all digest grants.
     * @param {Array} scoredGrants — array of { grant, scoring } objects,
     *   e.g. global.prescoredDigest.map((item, i) => scoreOneGrant(item, responses[i]))
     */
    global.saveExpandedResults = function saveExpandedResults(scoredGrants) {
      const { allScored, added, tsvPath, mdPath, htmlPath } = mergeAndSave(nonDigestScored, scoredGrants, profile);

      const byRec = {};
      allScored.forEach(g => { byRec[g.scoring.recommendation] = (byRec[g.scoring.recommendation] || 0) + 1; });

      console.log(`\n✅  Expansion scored + merged: ${added} new unique grant(s) added.`);
      console.log('   Distribution:', JSON.stringify(byRec));
      console.log('   Report:', htmlPath);

      const actionable = allScored
        .filter(g => ['APPLY_NOW', 'CONSIDER'].includes(g.scoring.recommendation))
        .sort((a, b) => b.scoring.final_score - a.scoring.final_score);
      if (actionable.length) {
        console.log('\n=== ACTIONABLE GRANTS ===');
        actionable.forEach(({ grant, scoring }) => {
          console.log(`  ${scoring.final_score.toFixed(1)} ${scoring.recommendation} — ${grant.title.slice(0, 70)}`);
          if (scoring.application_angle) console.log(`      ${scoring.application_angle.slice(0, 110)}`);
        });
      }

      // Same fresh-one-off-process hang mitigation as score-with-claude.js/
      // near-miss-check.js/deep-research.js's save functions (see CLAUDE.md
      // Troubleshooting) — this is meant to be called via a driver script in
      // its own process, whose only job is to persist and stop.
      process.exit(0);
    };

    global.scoreOneExpanded = function scoreOneExpanded(index, claudeResponse) {
      return scoreOneGrant(prescored[index], claudeResponse);
    };
  })().catch(err => {
    console.error('\n❌  Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { scoreOneGrant, mergeAndSave };
