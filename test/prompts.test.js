'use strict';
/**
 * Tests for src/scorer/prompts.js — added 2026-08-22 when scoring via
 * buildScoringPrompt() got wired into the automated pipeline for the first
 * time (previously only exercised interactively, with zero coverage).
 *
 * Uses a MOCK profile object, not the real org-profile.yaml (gitignored,
 * per-org, and shouldn't be required for tests to run on a fresh clone).
 * buildScoringPrompt() already takes profile as a parameter rather than
 * reading the file itself, so this needs no fixture file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScoringPrompt, buildOrgSummary, buildGapsBlock, buildGrantSummary, buildNearMissRecheckPrompt } = require('../src/scorer/prompts');

const MOCK_PROFILE = {
  organization: {
    name: 'Test NGO',
    staff_size: { total: 10 },
    annual_budget_usd: 80000,
  },
  geography: { country: 'Testland' },
  experience: {
    largest_grant_received_usd: 40000,
    years_operating: 5,
    previous_funders: ['Test Foundation', 'Another Funder'],
  },
  capacity: {
    grant_size_sweet_spot_min_usd: 20000,
    grant_size_sweet_spot_max_usd: 50000,
  },
  mission: {
    primary_focus: ['climate_action', 'youth_empowerment'],
    projects: [
      { name: 'Clean Air Project', funding_urgency: 'high', status: 'active', description: 'Monitors air quality.' },
    ],
  },
  competitive_context: {
    hard_gaps: ['NO marine/coastal experience', 'NOT a research institution'],
  },
};

const MOCK_GRANT = {
  title: 'Clean Air Innovation Fund',
  funder: 'Example Foundation',
  source: 'RSS',
  amount_min: 20000,
  amount_max: 40000,
  deadline: '2027-01-01',
  country: 'Testland',
  themes: ['air_quality'],
  description: 'Funds community air quality monitoring projects.',
};

const MOCK_PRESCORE = {
  daysRemaining: 100,
  prescore: 2.0,
  scores: { geo: 0.6, size: 0.5, deadline: 0.4, org_type: 0.3, partnership: 0.2 },
};

test('buildScoringPrompt: never hardcodes an org name — uses profile.organization.name dynamically', () => {
  // Regression guard for the exact bug found 2026-08-18: this prompt used to
  // say "Sustenta" and "Honduras/LAC" literally, regardless of what profile
  // was passed in, which broke the region/sector-agnostic design for anyone
  // else using this tool.
  const prompt = buildScoringPrompt(MOCK_GRANT, MOCK_PROFILE, MOCK_PRESCORE);
  assert.ok(prompt.includes('Test NGO'));
  assert.ok(!prompt.includes('Sustenta'));
  assert.ok(!/Honduras\/LAC/.test(prompt));
});

test('buildScoringPrompt: includes the grant details, the org profile, and the scoring rubric', () => {
  const prompt = buildScoringPrompt(MOCK_GRANT, MOCK_PROFILE, MOCK_PRESCORE);
  assert.ok(prompt.includes('Clean Air Innovation Fund'));
  assert.ok(prompt.includes('Example Foundation'));
  assert.ok(prompt.includes('mission_alignment'));
  assert.ok(prompt.includes('competitive_fit'));
  assert.ok(prompt.includes('strategic_fit'));
  assert.ok(prompt.includes('"reasoning"'));
});

test('buildScoringPrompt: requests JSON-only output in the exact shape combineScores() expects', () => {
  const prompt = buildScoringPrompt(MOCK_GRANT, MOCK_PROFILE, MOCK_PRESCORE);
  for (const field of ['mission_alignment', 'competitive_fit', 'strategic_fit', 'best_projects', 'application_angle', 'confidence', 'reasoning']) {
    assert.ok(prompt.includes(`"${field}"`), `missing field ${field} in requested JSON shape`);
  }
});

test('buildOrgSummary: surfaces the org\'s real projects, not a generic placeholder', () => {
  const summary = buildOrgSummary(MOCK_PROFILE);
  assert.ok(summary.includes('Clean Air Project'));
  assert.ok(summary.includes('Test Foundation'));
  assert.ok(summary.includes('Testland'));
});

test('buildGapsBlock: surfaces hard_gaps from competitive_context so competitive_fit has real signal to use', () => {
  const block = buildGapsBlock(MOCK_PROFILE);
  assert.ok(block.includes('NO marine/coastal experience'));
  assert.ok(block.includes('NOT a research institution'));
});

test('buildGapsBlock: degrades gracefully when competitive_context is missing, not a crash', () => {
  const block = buildGapsBlock({ ...MOCK_PROFILE, competitive_context: undefined });
  assert.equal(typeof block, 'string');
  assert.ok(block.length > 0);
});

test('buildGrantSummary: formats amount range and deadline with days-remaining context', () => {
  const summary = buildGrantSummary(MOCK_GRANT, MOCK_PRESCORE);
  assert.ok(summary.includes('$20,000'));
  assert.ok(summary.includes('$40,000') || summary.includes('40,000'));
  assert.ok(summary.includes('2027-01-01'));
  assert.ok(summary.includes('100 days remaining'));
});

test('buildGrantSummary: handles a rolling/no-deadline grant without crashing', () => {
  const summary = buildGrantSummary({ ...MOCK_GRANT, deadline: null }, { daysRemaining: null });
  assert.ok(/rolling|not specified/i.test(summary));
});

test('buildNearMissRecheckPrompt: also stays org-agnostic (same regression class as buildScoringPrompt)', () => {
  const prompt = buildNearMissRecheckPrompt(MOCK_GRANT, 'Some funder page text about air quality grants.', MOCK_PROFILE, { originalMissionAlignment: 0.1, originalCompetitiveFit: 0 });
  assert.ok(prompt.includes('Test NGO'));
  assert.ok(!prompt.includes('Sustenta'));
});
