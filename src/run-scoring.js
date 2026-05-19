/**
 * run-scoring.js
 * Rule-based scoring pass. Reads grants_prescored.json, applies manual scorer,
 * outputs grants_scored.json + HTML/MD/TSV reports.
 *
 * Run: node src/run-scoring.js
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');
const { combineScores }                       = require('./scorer/index');
const { scoreGrant }                          = require('./scorer/manual-scorer');
const { saveTSV, saveMarkdownReport, saveHTMLReport } = require('./tracker/index');
const { syncToNotion }                                = require('./notion-sync');

const prescored = JSON.parse(fs.readFileSync('./output/grants_prescored.json', 'utf8'));
const profile   = yaml.parse(fs.readFileSync('./org-profile.yaml', 'utf8'));

const scoredGrants = prescored.map(item => {
  const claudeResponse = scoreGrant(item.grant);
  const scoring = combineScores(item.prescore, claudeResponse);
  return { grant: item.grant, scoring };
});

fs.writeFileSync('./output/grants_scored.json', JSON.stringify(scoredGrants, null, 2));
const tsvPath    = saveTSV(scoredGrants);
const reportPath = saveMarkdownReport(scoredGrants, profile);
const htmlPath   = saveHTMLReport(scoredGrants, profile);

const byRec = {};
scoredGrants.forEach(g => { byRec[g.scoring.recommendation] = (byRec[g.scoring.recommendation] || 0) + 1; });
console.log('Scoring complete! Distribution:', JSON.stringify(byRec));
console.log('TSV:', tsvPath);
console.log('Report (MD):', reportPath);
console.log('Report (HTML):', htmlPath);

const actionable = scoredGrants
  .filter(g => ['APPLY_NOW', 'CONSIDER'].includes(g.scoring.recommendation))
  .sort((a, b) => b.scoring.final_score - a.scoring.final_score);

if (actionable.length) {
  console.log('\n=== ACTIONABLE GRANTS ===');
  actionable.forEach(({ grant, scoring }) => {
    console.log(scoring.final_score.toFixed(1), scoring.recommendation, '-', grant.title.slice(0, 70));
    if (scoring.application_angle) console.log('  ->', scoring.application_angle.slice(0, 120));
  });
}

syncToNotion(scoredGrants).catch(err => console.error('Notion sync error:', err.message));
