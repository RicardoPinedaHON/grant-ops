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
const { buildPromptForClaude, scoreWithoutClaude } = require('./scorer/index');
const { saveTSV, saveMarkdownReport, loadHistory, saveHistory, isKnown, markSeen } = require('./tracker/index');

const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');
const SOURCES_PATH = path.join(process.cwd(), 'config', 'sources.yaml');
const OUTPUT_DIR = path.join(process.cwd(), 'output');

async function main() {
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
  const rawGrants = await fetchAllGrants(sources);

  // Save raw for reference
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'grants_raw.json'),
    JSON.stringify(rawGrants, null, 2)
  );

  // Filter out already-seen grants (unless --all flag)
  const isAll = process.argv.includes('--all');
  const newGrants = isAll ? rawGrants : rawGrants.filter(g => !isKnown(g, history));
  const skippedCount = rawGrants.length - newGrants.length;

  console.log(chalk.cyan(`\n${rawGrants.length} grants fetched, ${newGrants.length} new${skippedCount ? ` (${skippedCount} already seen)` : ''}`));

  // Pre-score with rules
  const prescored = [];
  const skippedGeo = [];

  for (const grant of newGrants) {
    const result = buildPromptForClaude(grant, profile);
    if (!result) {
      if (grant.__flags?.includes('INELIGIBLE_GEO')) {
        skippedGeo.push(grant.title);
      }
      continue;
    }
    prescored.push({
      grant,
      prescore: result.prescore,
      claude_prompt: result.prompt,
    });
    markSeen(grant, history);
  }

  console.log(chalk.cyan(`${prescored.length} grants passed pre-filter, ready for Claude scoring`));
  if (skippedGeo.length) {
    console.log(chalk.gray(`  Skipped ${skippedGeo.length} grants (geographic ineligibility)`));
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
