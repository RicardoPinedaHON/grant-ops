'use strict';
/**
 * Tests for src/score-with-claude.js's pure logic — added 2026-08-22 when
 * this script got wired into the AUTOMATED pipeline for the first time
 * (see CLAUDE.md's "Automated Claude scoring"). Before this, it was only
 * ever exercised by hand in an interactive session ("score the grants"),
 * with zero test coverage — not acceptable once it's the thing every
 * scheduled run depends on.
 *
 * Orchestration (reading grants_prescored.json/org-profile.yaml, the
 * global.saveResults/global.scoreOne side effects) is guarded behind
 * `require.main === module` and isn't covered here — same convention as
 * near-miss-check.js/deep-research.js. What's covered: scoreOneGrant()
 * (the actual combine step) and saveScoredGrants()/buildDistribution()
 * (what gets written to disk and reported).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { scoreOneGrant, buildDistribution, saveScoredGrants } = require('../src/score-with-claude');

function makePrescoredItem(overrides = {}) {
  return {
    grant: { title: 'Test Grant', url: 'https://example.org/grant', ...overrides.grant },
    prescore: {
      prescore: 2.0,
      scores: { geo: 0.6, size: 0.5, deadline: 0.4, org_type: 0.3, partnership: 0.2 },
      flags: [],
      daysRemaining: 30,
      ...overrides.prescore,
    },
  };
}

test('scoreOneGrant: combines prescore + Claude response into a real recommendation', () => {
  const item = makePrescoredItem();
  const claudeResponse = {
    mission_alignment: 1.1, competitive_fit: -0.1, strategic_fit: 0.05,
    best_projects: ['Aire Limpio Honduras'], application_angle: 'Strong PM2.5 fit',
    confidence: 'high', reasoning: 'Direct match on air quality monitoring.',
  };
  const { grant, scoring } = scoreOneGrant(item, claudeResponse);
  assert.equal(grant.title, 'Test Grant');
  // 2.0 + 1.1 - 0.1 + 0.05 = 3.05 -> below CONSIDER (3.2), above MONITOR (2.5)
  assert.equal(scoring.final_score, 3.05);
  assert.equal(scoring.recommendation, 'MONITOR');
  assert.deepEqual(scoring.best_projects, ['Aire Limpio Honduras']);
  assert.equal(scoring.reasoning, 'Direct match on air quality monitoring.');
});

test('scoreOneGrant: a real per-grant Claude judgment is NOT the manual-scorer boilerplate', () => {
  // Regression guard for the exact bug found live 2026-08-22: the automated
  // pipeline's cheap fallback (manual-scorer.js) produces the literal string
  // "Grant from newsletter but no strong thematic match with Sustenta's
  // focus areas." for anything it doesn't recognize, regardless of what the
  // grant actually is. A real score-with-claude.js call must carry through
  // whatever specific reasoning was actually given, not that fallback.
  const item = makePrescoredItem({ grant: { title: 'Halton Indoor Environmental Quality Grants' } });
  const claudeResponse = {
    mission_alignment: 1.0, competitive_fit: -0.1, strategic_fit: 0,
    best_projects: ['Aire Limpio Honduras'], application_angle: null,
    confidence: 'high',
    reasoning: 'Funder explicitly funds indoor air quality/particulate research — direct match to Aire Limpio Honduras.',
  };
  const { scoring } = scoreOneGrant(item, claudeResponse);
  assert.notEqual(scoring.reasoning, "Grant from newsletter but no strong thematic match with Sustenta's focus areas.");
  assert.match(scoring.reasoning, /indoor air quality/i);
});

test('scoreOneGrant: throws clearly on a missing index rather than silently scoring undefined', () => {
  assert.throws(() => scoreOneGrant(undefined, {}), /No prescored item given/);
});

test('buildDistribution: tallies recommendations across scored grants', () => {
  const scored = [
    { scoring: { recommendation: 'APPLY_NOW' } },
    { scoring: { recommendation: 'MONITOR' } },
    { scoring: { recommendation: 'MONITOR' } },
    { scoring: { recommendation: 'SKIP' } },
  ];
  assert.deepEqual(buildDistribution(scored), { APPLY_NOW: 1, MONITOR: 2, SKIP: 1 });
});

test('saveScoredGrants: writes grants_scored.json and returns real file paths', (t) => {
  // REGRESSION TEST for a real incident (2026-08-22): this test used to
  // process.chdir() into a tmp dir before calling saveScoredGrants(),
  // expecting it to write there. It doesn't — score-with-claude.js's
  // `OUTPUT_DIR` (and tracker/index.js's, which saveTSV/saveMarkdownReport/
  // saveHTMLReport all use) is a MODULE-LOAD-TIME constant
  // (`path.join(process.cwd(), 'output')`), evaluated once when the module
  // is first require()'d — chdir() afterward changes nothing. The result:
  // this test silently overwrote the REAL project's output/grants_scored.json
  // with dummy {title:"A"}/{title:"B"} fixture data, which then flowed into
  // a real deep-research run as a fake "$4.0 APPLY_NOW" candidate before
  // anyone noticed. Mock fs.writeFileSync instead of touching real paths —
  // this is the only way to test this safely until OUTPUT_DIR stops being
  // baked in at require time (a larger refactor touching tracker/index.js,
  // not done here).
  const writes = [];
  t.mock.method(fs, 'writeFileSync', (filePath, content) => {
    writes.push({ filePath: String(filePath), content: String(content) });
  });
  // ensureOutputDir() (called by saveTSV/saveMarkdownReport/saveHTMLReport)
  // checks fs.existsSync/mkdirSync first — harmless against the real
  // project's already-existing output/ dir, left unmocked on purpose.

  const profile = { organization: { name: 'Test Org' } };
  const scoredGrants = [
    { grant: { title: 'Real Grant A' }, scoring: { final_score: 4.0, recommendation: 'APPLY_NOW', scores: {}, best_projects: [], flags: [] } },
    { grant: { title: 'Real Grant B' }, scoring: { final_score: 2.0, recommendation: 'SKIP', scores: {}, best_projects: [], flags: [] } },
  ];
  const result = saveScoredGrants(scoredGrants, profile);

  assert.deepEqual(result.distribution, { APPLY_NOW: 1, SKIP: 1 });
  const scoredWrite = writes.find(w => w.filePath === result.scoredFile);
  assert.ok(scoredWrite, 'saveScoredGrants must write to the path it returns as scoredFile');
  const written = JSON.parse(scoredWrite.content);
  assert.equal(written.length, 2);
  assert.equal(written[0].grant.title, 'Real Grant A');
});
