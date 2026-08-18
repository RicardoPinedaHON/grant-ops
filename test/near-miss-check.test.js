'use strict';
/**
 * Tests for src/near-miss-check.js's pure helpers. The network/Notion-query
 * half (fetchPageText, fetchNearMissCandidates, saveNearMissResults) isn't
 * covered here — same convention as deep-research.js, which has no test
 * file either, since its "prepare data, expose a save function" scripts
 * are effectively thin orchestration over live APIs. What IS pure and
 * worth covering: htmlToText() (same class of bug as email-outlook.js's
 * htmlToText — a bad strip breaks every downstream fetch) and
 * buildSyntheticPrescore()'s regex parsing of the "Score Breakdown" text
 * Notion stores, which combineScores() then needs a correctly-reconstructed
 * prescore object from to avoid silently drifting from the real scoring
 * formula.
 *
 * Requiring this module is safe (no org-profile.yaml read, no Notion call)
 * because its orchestration is guarded behind `require.main === module`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { htmlToText, buildSyntheticPrescore } = require('../src/near-miss-check');

test('htmlToText: strips tags/styles/scripts and collapses whitespace', () => {
  const html = `<html><head><style>.x{color:red}</style></head>
    <body><script>alert(1)</script>
    <h1>Halton</h1><p>Indoor  Environmental   Quality &amp; PM2.5 Grants</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes('<'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('alert(1)'));
  assert.ok(text.includes('Indoor Environmental Quality & PM2.5 Grants'));
});

test('htmlToText: decodes common HTML entities', () => {
  const text = htmlToText('<p>Terms &amp; Conditions &mdash;&nbsp;&quot;Open&quot;</p>'.replace('&mdash;', ''));
  assert.ok(text.includes('Terms & Conditions'));
  assert.ok(text.includes('"Open"'));
});

test('buildSyntheticPrescore: reconstructs rule sub-scores from the "Score Breakdown" text Notion stores', () => {
  const page = {
    id: 'page-123',
    properties: {
      'Score Breakdown': { rich_text: [{ plain_text: 'Geo:1.00 | Size:0.80 | DL:0.70 | Org:0.40 | Partner:0.30 | Align:0.10 | Compete:-0.20 | Fit:+0.00 = 2.47' }] },
      'Best Projects': { rich_text: [{ plain_text: 'Aire Limpio Honduras' }] },
      'Application Angle': { rich_text: [{ plain_text: 'Some angle' }] },
    },
  };
  const prescore = buildSyntheticPrescore(page);
  assert.equal(prescore.scores.geo, 1.0);
  assert.equal(prescore.scores.size, 0.8);
  assert.equal(prescore.scores.deadline, 0.7);
  assert.equal(prescore.scores.org_type, 0.4);
  assert.equal(prescore.scores.partnership, 0.3);
  // prescore (rule subtotal) must equal the sum of the 5 rule dimensions,
  // NOT include mission_alignment/competitive_fit — those get re-derived
  // by the recheck, not carried over from the stale verdict.
  assert.equal(Math.round(prescore.prescore * 100) / 100, 3.2);
  assert.equal(prescore.originalMissionAlignment, 0.1);
  assert.equal(prescore.originalCompetitiveFit, -0.2);
  assert.equal(prescore.originalStrategicFit, 0);
  assert.equal(prescore._pageId, 'page-123');
  assert.equal(prescore._bestProjects, 'Aire Limpio Honduras');
});

test('buildSyntheticPrescore: missing/malformed breakdown text degrades to all-zero rule scores, not a crash', () => {
  const page = { id: 'page-456', properties: {} };
  const prescore = buildSyntheticPrescore(page);
  assert.equal(prescore.prescore, 0);
  assert.deepEqual(prescore.scores, { geo: 0, size: 0, deadline: 0, org_type: 0, partnership: 0 });
});

test('buildSyntheticPrescore: extracts a non-zero original strategic_fit — regression for the bug where dropping it to 0 silently inflated an unchanged grant\'s score past the Monitor floor', () => {
  const page = {
    id: 'page-789',
    properties: {
      'Score Breakdown': { rich_text: [{ plain_text: 'Geo:0.75 | Size:0.60 | DL:0.52 | Org:0.30 | Partner:0.30 | Align:0.10 | Compete:+0.00 | Fit:-0.10 = 2.47' }] },
    },
  };
  const prescore = buildSyntheticPrescore(page);
  assert.equal(prescore.originalStrategicFit, -0.1);
});
