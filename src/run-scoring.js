/**
 * run-scoring.js
 * Rule-based scoring pass. Reads grants_prescored.json, applies manual scorer,
 * outputs grants_scored.json + HTML/MD/TSV reports + Notion sync.
 *
 * Pipeline:
 *   1. Enrich — fetch missing deadline/amount from source pages
 *   2. Score  — rule-based mission-alignment scoring
 *   3. Report — TSV, Markdown, HTML
 *   4. Sync   — push to Notion
 *
 * Run: node src/run-scoring.js
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');
const { combineScores }                               = require('./scorer/index');
const { scoreGrant }                                  = require('./scorer/manual-scorer');
const { saveTSV, saveMarkdownReport, saveHTMLReport, loadResearchCache } = require('./tracker/index');
const { syncToNotion }                                = require('./notion-sync');
const { enrichGrants }                                = require('./enricher');
const { closeBrowser }                                = require('./scrapers/playwright-base');
const log                                             = require('./logger');

async function main() {
  log.initLog('scoring');
  const prescored = JSON.parse(fs.readFileSync('./output/grants_prescored.json', 'utf8'));
  const profile   = yaml.parse(fs.readFileSync('./org-profile.yaml', 'utf8'));

  // ── Step 1: Enrich missing deadline + amount ──────────────────────────────
  console.log('\n[Enricher] Filling in missing deadline + amount data...');
  const enriched = await enrichGrants(prescored);

  // Write back enriched data so future runs are faster
  fs.writeFileSync('./output/grants_prescored.json', JSON.stringify(enriched, null, 2));

  // ── Step 2: Score ─────────────────────────────────────────────────────────
  log.logSection(`SCORING DECISIONS (${enriched.length} grants)`);
  const scoredGrants = enriched.map(item => {
    const claudeResponse = scoreGrant(item.grant);
    const scoring = combineScores(item.prescore, claudeResponse);
    log.logGrantScored(item.grant, scoring);
    return { grant: item.grant, scoring };
  });

  fs.writeFileSync('./output/grants_scored.json', JSON.stringify(scoredGrants, null, 2));

  // ── Step 3: Reports ───────────────────────────────────────────────────────
  const tsvPath    = saveTSV(scoredGrants);
  const reportPath = saveMarkdownReport(scoredGrants, profile);
  const htmlPath   = saveHTMLReport(scoredGrants, profile);

  const byRec = {};
  scoredGrants.forEach(g => { byRec[g.scoring.recommendation] = (byRec[g.scoring.recommendation] || 0) + 1; });
  console.log('\nScoring complete! Distribution:', JSON.stringify(byRec));
  console.log('TSV:', tsvPath);
  console.log('Report (MD):', reportPath);
  console.log('Report (HTML):', htmlPath);

  const actionable = scoredGrants
    .filter(g => ['APPLY_NOW', 'CONSIDER', 'MONITOR'].includes(g.scoring.recommendation))
    .sort((a, b) => b.scoring.final_score - a.scoring.final_score);

  if (actionable.length) {
    console.log('\n=== ACTIONABLE GRANTS ===');
    actionable.forEach(({ grant, scoring }) => {
      console.log(scoring.final_score.toFixed(1), scoring.recommendation, '-', grant.title.slice(0, 70));
      if (scoring.application_angle) console.log('  ->', scoring.application_angle.slice(0, 120));
    });
  }

  // Log summary
  log.logSummary({ ...byRec,
    'Log file': `output/logs/scoring_*.log`,
  });
  log.closeLog();

  // ── Step 4: Close Playwright browser (opened by enricher) ────────────────
  await closeBrowser().catch(() => {});

  // ── Step 5: Notion sync ───────────────────────────────────────────────────
  // Pass the research cache so grants already deep-researched (by an earlier
  // run or by src/deep-research.js) are tagged/tiered correctly from this
  // very first sync of the run, not just after a later research pass.
  await syncToNotion(scoredGrants, loadResearchCache()).catch(err => console.error('Notion sync error:', err.message));
}

main()
  // Explicit exit once the real work (enrich -> score -> reports -> Notion
  // sync) is done. This is one of the three steps CLAUDE.md's Troubleshooting
  // section names as reproducing the "finishes real work, process never
  // exits" hang (not conclusively root-caused — Playwright/Notion's
  // keep-alive agent are both suspects). Doesn't fix the underlying cause,
  // but stops the unattended pipeline from silently stalling here.
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Scoring failed:', err.message);
    process.exit(1);
  });
