#!/usr/bin/env node
/**
 * score-with-claude.js
 *
 * Loads grants_prescored.json and exposes them for Claude Code to score.
 * NO API KEY NEEDED — Claude Code (this session) reads the prompts and
 * scores each grant natively, then calls saveResults() to write outputs.
 *
 * Usage: open this file in Claude Code and say "score the grants"
 *   or:  node src/score-with-claude.js  (prints instructions + data summary)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { combineScores } = require('./scorer/index');
const { saveTSV, saveMarkdownReport, saveHTMLReport } = require('./tracker/index');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const PRESCORED_FILE = path.join(OUTPUT_DIR, 'grants_prescored.json');
const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');

if (!fs.existsSync(PRESCORED_FILE)) {
  console.error('grants_prescored.json not found. Run: node src/scan.js first.');
  process.exit(1);
}

const prescored = JSON.parse(fs.readFileSync(PRESCORED_FILE, 'utf8'));
const profile = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));

console.log(`\n=== Grant-Ops: Claude Code Scoring ===`);
console.log(`Organization: ${profile.organization.name}`);
console.log(`Grants to score: ${prescored.length}`);
console.log(`\nFor each item in global.prescored, read item.claude_prompt and respond`);
console.log(`with the JSON object it requests. Then call global.saveResults(scoredArray).`);
console.log(`\nData is ready. Claude Code: start scoring!`);
console.log(`\nGrants with prompts:`);
prescored.forEach((item, i) => {
  if (item.claude_prompt) {
    console.log(`  [${i}] ${item.grant.title.slice(0, 70)}`);
  }
});

// ─── Globals exposed for Claude Code to use ─────────────────────────────────

global.prescored = prescored;
global.profile = profile;
global.combineScores = combineScores;

/**
 * Claude Code calls this after scoring all grants.
 * @param {Array} scoredGrants — array of { grant, scoring } objects
 */
global.saveResults = function saveResults(scoredGrants) {
  const scoredFile = path.join(OUTPUT_DIR, 'grants_scored.json');
  fs.writeFileSync(scoredFile, JSON.stringify(scoredGrants, null, 2));

  const tsvPath = saveTSV(scoredGrants);
  const reportPath = saveMarkdownReport(scoredGrants, profile);
  const htmlPath = saveHTMLReport(scoredGrants, profile);

  const byRec = {};
  scoredGrants.forEach(g => {
    byRec[g.scoring.recommendation] = (byRec[g.scoring.recommendation] || 0) + 1;
  });

  console.log(`\nSaved ${scoredGrants.length} scored grants.`);
  console.log('Distribution:', JSON.stringify(byRec));
  console.log('Markdown report:', reportPath);
  console.log('HTML report:    ', htmlPath);
  console.log('TSV:            ', tsvPath);

  const actionable = scoredGrants
    .filter(g => ['APPLY_NOW', 'CONSIDER'].includes(g.scoring.recommendation))
    .sort((a, b) => b.scoring.final_score - a.scoring.final_score);

  if (actionable.length) {
    console.log('\n=== ACTIONABLE GRANTS ===');
    actionable.forEach(({ grant, scoring }) => {
      console.log(`${scoring.final_score.toFixed(1)} ${scoring.recommendation} — ${grant.title.slice(0, 70)}`);
      if (scoring.application_angle) {
        console.log(`  -> ${scoring.application_angle.slice(0, 120)}`);
      }
    });
  }

  return { scoredFile, tsvPath, reportPath, htmlPath };
};

/**
 * Helper: score a single grant and return the combined scoring object.
 * Claude Code can call this one at a time or batch them.
 *
 * @param {number} index  — index into global.prescored
 * @param {object} claudeResponse — { mission_alignment, strategic_fit, best_projects,
 *                                    application_angle, confidence, reasoning }
 */
global.scoreOne = function scoreOne(index, claudeResponse) {
  const item = prescored[index];
  if (!item) throw new Error(`No grant at index ${index}`);
  const scoring = combineScores(item.prescore, claudeResponse);
  return { grant: item.grant, scoring };
};
