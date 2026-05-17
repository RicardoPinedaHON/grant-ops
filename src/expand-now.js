#!/usr/bin/env node
/**
 * expand-now.js
 *
 * Opens every ImpactFunding digest currently in grants_scored.json with
 * Playwright, extracts individual grants, scores them, and merges into
 * the existing report without touching already-scored grants.
 *
 * Run: node src/expand-now.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

const { expandAllDigests }   = require('./scrapers/digest-expander');
const { closeBrowser }       = require('./scrapers/playwright-base');
const { buildPromptForClaude, combineScores } = require('./scorer/index');
const { scoreGrant }         = require('./scorer/manual-scorer');
const { saveTSV, saveMarkdownReport, saveHTMLReport } = require('./tracker/index');

const OUTPUT       = path.join(process.cwd(), 'output');
const SCORED_FILE  = path.join(OUTPUT, 'grants_scored.json');
const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');

if (!fs.existsSync(SCORED_FILE)) {
  console.error('No grants_scored.json found. Run: node src/scan.js first.');
  process.exit(1);
}

const existingScored = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
const profile        = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

// Pull out raw digest grant objects from ImpactFunding Substack
const digestGrants   = existingScored
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

  // Pre-score each extracted grant, skip those that don't pass the filter
  const newScored = [];
  let skipped = 0;

  for (const grant of expandedRaw) {
    const result = buildPromptForClaude(grant, profile);
    if (!result) { skipped++; continue; }

    const claudeResponse = scoreGrant(grant);
    const scoring = combineScores(result.prescore, claudeResponse);
    newScored.push({ grant, scoring });
  }

  console.log(`\n  Scored: ${newScored.length}  |  Skipped (low prescore/geo): ${skipped}`);

  // Deduplicate against already-scored grants
  const existingUrls = new Set(nonDigestScored.map(g => g.grant.url).filter(Boolean));
  const deduped = newScored.filter(g => {
    if (!g.grant.url || existingUrls.has(g.grant.url)) return false;
    existingUrls.add(g.grant.url);
    return true;
  });

  console.log(`  After dedup: ${deduped.length} new unique grants added`);

  const allScored = [...nonDigestScored, ...deduped];

  // Save + regenerate all outputs
  fs.writeFileSync(SCORED_FILE, JSON.stringify(allScored, null, 2));

  const tsvPath  = saveTSV(allScored);
  const mdPath   = saveMarkdownReport(allScored, profile);
  const htmlPath = saveHTMLReport(allScored, profile);

  const byRec = {};
  allScored.forEach(g => { byRec[g.scoring.recommendation] = (byRec[g.scoring.recommendation]||0)+1; });

  console.log('\n✅  Expansion complete!');
  console.log('   Distribution:', JSON.stringify(byRec));
  console.log('   Report:', htmlPath);

  const actionable = allScored
    .filter(g => ['APPLY_NOW','CONSIDER'].includes(g.scoring.recommendation))
    .sort((a,b) => b.scoring.final_score - a.scoring.final_score);

  if (actionable.length) {
    console.log('\n=== ACTIONABLE GRANTS ===');
    actionable.forEach(({ grant, scoring }) => {
      console.log(`  ${scoring.final_score.toFixed(1)} ${scoring.recommendation} — ${grant.title.slice(0,70)}`);
      if (scoring.application_angle) console.log(`      ${scoring.application_angle.slice(0,110)}`);
    });
  }
})().catch(err => {
  console.error('\n❌  Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
