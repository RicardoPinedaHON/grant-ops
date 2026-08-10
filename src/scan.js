#!/usr/bin/env node
/**
 * grant-ops scan
 *
 * Fetches grants from all configured sources, pre-scores them with rules,
 * then outputs:
 *   - output/grants_raw.json     ← raw grants for Claude to score
 *   - output/grants_prescored.json ← rule-scored, prompts ready
 *   - output/grants.tsv          ← rule-only scores (instant)
 *   - output/report_YYYY-MM-DD.md ← full report after Claude scoring
 *
 * When run via Claude Code, Claude reads grants_prescored.json and
 * calls the scoring prompts to produce the final scored report.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const chalk = require('chalk');

const { fetchAllGrants } = require('./scrapers/index');
const { buildPromptForClaude, scoreWithoutClaude, isNewsArticle, SKIP_THRESHOLD } = require('./scorer/index');
const { prescoreGrant } = require('./scorer/rules');
const { saveTSV, saveMarkdownReport, loadHistory, saveHistory, isKnown, markSeen } = require('./tracker/index');
const log = require('./logger');

const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');
const SOURCES_PATH = path.join(process.cwd(), 'config', 'sources.yaml');
const OUTPUT_DIR = path.join(process.cwd(), 'output');

async function main() {
  const logFile = log.initLog('scan');
  console.log(chalk.bold('\n🔍 grant-ops — Grant Opportunity Scanner\n'));

  // Load org profile
  if (!fs.existsSync(PROFILE_PATH)) {
    console.error(chalk.red('❌ org-profile.yaml not found. Copy org-profile.example.yaml and fill it in.'));
    process.exit(1);
  }
  const profile = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  console.log(chalk.green(`✓ Profile loaded: ${profile.organization.name}`));

  // Load sources config
  const sources = yaml.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));

  // Load seen history
  const history = loadHistory();

  // Fetch all grants
  console.log(chalk.bold('\nFetching grants from all sources...'));
  // `history` is passed through so LinkedIn's post-level dedup persists in
  // history.json exactly like every other source's grant-level dedup.
  const rawGrants = await fetchAllGrants(sources, history);

  // Save raw for reference
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'grants_raw.json'),
    JSON.stringify(rawGrants, null, 2)
  );

  // Log all sources + raw grants
  log.logSection('RAW GRANTS BY SOURCE');
  const bySource = {};
  for (const g of rawGrants) {
    bySource[g.source] = (bySource[g.source] || 0) + 1;
  }
  for (const [src, cnt] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    log.logSourceResult(src, cnt);
  }

  log.logSection(`ALL PARSED OPPORTUNITIES (${rawGrants.length} total)`);
  for (const g of rawGrants) {
    log.logGrantParsed(g);
  }

  // Filter out already-seen grants (unless --all flag)
  const isAll = process.argv.includes('--all');
  const newGrants = isAll ? rawGrants : rawGrants.filter(g => !isKnown(g, history));
  const skippedCount = rawGrants.length - newGrants.length;

  console.log(chalk.cyan(`\n${rawGrants.length} grants fetched, ${newGrants.length} new${skippedCount ? ` (${skippedCount} already seen)` : ''}`));

  // Pre-score with rules — log each decision
  const prescored = [];
  const skippedGeo = [];
  const filterCounts = { geo: 0, expired: 0, lowscore: 0, news: 0, passed: 0 };

  log.logSection(`PRE-FILTER DECISIONS (new grants only: ${newGrants.length})`);

  for (const grant of newGrants) {
    const prescore = prescoreGrant(grant, profile);
    const result   = buildPromptForClaude(grant, profile);

    if (!result) {
      // Determine reason. Prefer the SPECIFIC flag checkIneligibility() already
      // computed (rules.js) over re-deriving a guess — that's the actual reason
      // buildPromptForClaude returned null in every hard-ineligibility case, and
      // trusting it avoids relabeling everything as a generic catch-all (a real
      // bug this fixes: SKIP_THRESHOLD used to be undefined here — not exported
      // from scorer/index.js — so the LOW_SCORE branch below never matched and
      // every low-score grant was mislabeled NEWS_ARTICLE).
      const HARD_INELIGIBLE_FLAGS = [
        'WRONG_GEOGRAPHY', 'INELIGIBLE_GEO', 'SCHOLARSHIP_ONLY', 'COURSE_NOT_GRANT',
        'VC_ONLY', 'NEWS_ARTICLE', 'NO_SPECIFIC_OPPORTUNITY', 'CONFERENCE_NOT_GRANT',
      ];
      const hardFlag = prescore.flags?.find(f => HARD_INELIGIBLE_FLAGS.includes(f));

      let reason = 'UNKNOWN';
      let detail = `prescore=${prescore.prescore?.toFixed(2)}`;

      if (hardFlag === 'WRONG_GEOGRAPHY' || hardFlag === 'INELIGIBLE_GEO') {
        reason = 'GEO_INELIGIBLE';
        detail = prescore.flags.join(', ');
        skippedGeo.push(grant.title);
        filterCounts.geo++;
      } else if (hardFlag) {
        reason = hardFlag;
        detail = prescore.flags.join(', ');
        filterCounts.news++;
      } else if (prescore.daysRemaining !== null && prescore.daysRemaining < 0) {
        reason = 'EXPIRED';
        detail = `deadline ${grant.deadline}, ${Math.abs(prescore.daysRemaining)}d ago`;
        filterCounts.expired++;
      } else if (isNewsArticle(grant)) {
        reason = 'NEWS_ARTICLE';
        filterCounts.news++;
      } else if (prescore.prescore < SKIP_THRESHOLD) {
        reason = 'LOW_SCORE';
        detail = `prescore=${prescore.prescore?.toFixed(2)} < ${SKIP_THRESHOLD}`;
        filterCounts.lowscore++;
      } else {
        // Should never happen — buildPromptForClaude returned null for a reason
        // none of the above checks caught. Surfaced loudly instead of silently
        // mislabeled, so a future gap like the SKIP_THRESHOLD one is visible.
        filterCounts.news++;
      }
      log.logGrantFiltered(grant, reason, detail);
      continue;
    }

    prescored.push({
      grant,
      prescore: result.prescore,
      claude_prompt: result.prompt,
    });
    filterCounts.passed++;
    markSeen(grant, history);
  }

  console.log(chalk.cyan(`${prescored.length} grants passed pre-filter, ready for Claude scoring`));
  if (skippedGeo.length) {
    console.log(chalk.gray(`  Skipped ${skippedGeo.length} grants (geographic ineligibility)`));
  }

  log.logSection('GRANTS PASSING PRE-FILTER (will be scored)');
  for (const item of prescored) {
    const { grant, prescore } = item;
    const deadline = grant.deadline ? `due:${grant.deadline}` : 'no-deadline';
    log.writeLine(`  QUEUED   [prescore=${prescore.prescore?.toFixed(2)}] "${grant.title.slice(0, 70)}" | ${grant.source} | ${deadline}`);
  }

  // Save prescored for Claude to process
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'grants_prescored.json'),
    JSON.stringify(prescored, null, 2)
  );

  // Rule-only scores (instant output, no Claude needed)
  const ruleOnlyScored = prescored.map(item => ({
    grant: item.grant,
    scoring: scoreWithoutClaude(item.grant, profile),
  }));

  const tsvPath = saveTSV(ruleOnlyScored);
  console.log(chalk.green(`\n✓ Rule-based scores saved to: ${tsvPath}`));
  console.log(chalk.yellow('\n📋 Next step: Claude will now score each grant for mission alignment.'));
  console.log(chalk.yellow('   Run: node src/score-with-claude.js'));
  console.log(chalk.yellow('   Or if using Claude Code: ask Claude to run the full scoring.\n'));

  // Save history
  saveHistory(history);

  // Print quick summary
  printSummary(ruleOnlyScored);

  // Finish log
  log.logSummary({
    'Total fetched':        rawGrants.length,
    'Already seen (skip)':  skippedCount,
    'New grants':           newGrants.length,
    'Filtered geo':         filterCounts.geo,
    'Filtered expired':     filterCounts.expired,
    'Filtered low score':   filterCounts.lowscore,
    'Filtered news':        filterCounts.news,
    'Passed pre-filter':    filterCounts.passed,
  });
  const logFile2 = log.closeLog();
  console.log(chalk.gray(`  Scan log: ${logFile2}`));
}

function printSummary(scored) {
  const sorted = scored.sort((a, b) => b.scoring.final_score - a.scoring.final_score);
  const top5 = sorted.slice(0, 5);

  console.log(chalk.bold('\n--- Top 5 (rule-based, Claude scoring pending) ---'));
  for (const item of top5) {
    const { grant, scoring } = item;
    const bar = '█'.repeat(Math.round(scoring.final_score * 2));
    const deadline = grant.deadline ? ` | Due: ${grant.deadline}` : '';
    console.log(`  ${chalk.bold(scoring.final_score.toFixed(1))} ${bar} ${grant.title.slice(0, 60)}${deadline}`);
    console.log(`     ${chalk.gray(grant.funder + ' — ' + grant.source)}`);
  }
  console.log('');
}

main().catch(err => {
  console.error(chalk.red('\n❌ Fatal error:'), err.message);
  console.error(err.stack);
  process.exit(1);
});
