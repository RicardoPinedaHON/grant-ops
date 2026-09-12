'use strict';
/**
 * Tests for src/notion-client.js — the pure Notion-adjacent helpers factored
 * out during the 2026-08-18 pipeline audit (Halton, GEF SGP CSO Challenge,
 * CTCN/AFCIA, Social Shifters all found stuck at Skip/Monitor with no way
 * to ever surface — see git log for the full writeup). Covers the two
 * fixes that live here: isResearchStale() (root cause 4 — a research
 * verdict used to be trusted forever, even after the score moved a lot)
 * and agingBonus() (part of root cause 2 — pure top-score-wins meant a
 * backlog grant could never win a research slot against fresh high
 * scorers, no matter how many cycles it waited).
 *
 * No network calls — notionRequest/notionPageToGrant aren't covered here
 * (they need a live/mocked Notion response; the pure scoring/date logic
 * is what actually had bugs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isResearchStale, agingBonus, parseAmount, richText, computeDeadlineFields, formatDeadlineNote } = require('../src/notion-client');

test('isResearchStale: fresh research (even with a big score drift) is not stale', () => {
  const entry = { researched_at: new Date().toISOString(), scored_at_score: 2.5 };
  assert.equal(isResearchStale(entry, 4.5), false);
});

test('isResearchStale: old research whose score barely moved is not stale', () => {
  const oldDate = new Date(Date.now() - 120 * 86400000).toISOString(); // 120 days ago
  const entry = { researched_at: oldDate, scored_at_score: 2.5 };
  assert.equal(isResearchStale(entry, 2.6), false); // drift 0.1 < threshold
});

test('isResearchStale: old research whose score moved a lot IS stale', () => {
  const oldDate = new Date(Date.now() - 120 * 86400000).toISOString();
  const entry = { researched_at: oldDate, scored_at_score: 2.5 };
  // Matches the audited symptom: a grant researched as Monitor (~2.5) later
  // rescanning to 4.21 (Apply-Now territory) but staying pinned to Monitor.
  assert.equal(isResearchStale(entry, 4.21), true);
});

test('isResearchStale: missing researched_at or scored_at_score is treated as not stale (never trusted-forever without data)', () => {
  assert.equal(isResearchStale(null, 4.0), false);
  assert.equal(isResearchStale({ researched_at: null }, 4.0), false);
  const oldDate = new Date(Date.now() - 120 * 86400000).toISOString();
  assert.equal(isResearchStale({ researched_at: oldDate, scored_at_score: null }, 4.0), false);
});

test('agingBonus: no scan date (or today) contributes nothing — same-day candidates get no boost', () => {
  assert.equal(agingBonus(null), 0);
  // Pre-existing flakiness found in passing (2026-09-12, unrelated to this
  // session's actual changes): agingBonus() reads Date.now() itself, a few
  // microseconds after this test captured `new Date().toISOString()` —
  // real (if tiny) elapsed time can produce a near-zero-but-nonzero bonus,
  // failing a strict `=== 0` assertion intermittently. A tolerance is
  // correct here, not a mock — the function isn't wrong to return a sliver
  // of bonus for genuinely elapsed time.
  assert.ok(agingBonus(new Date().toISOString()) < 1e-6);
});

test('agingBonus: grows with time waiting and is capped', () => {
  const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const tenWeeksAgo = new Date(Date.now() - 70 * 86400000).toISOString();
  const bonus1wk = agingBonus(oneWeekAgo);
  const bonus10wk = agingBonus(tenWeeksAgo);
  assert.ok(bonus1wk > 0);
  assert.ok(bonus10wk > bonus1wk); // strictly increases with age
  assert.ok(bonus10wk <= 1.0); // capped
});

test('agingBonus: enough waiting lets a modest scorer catch up to a fresh high scorer', () => {
  // The exact scenario the audit found: CTCN/AFCIA at 2.55 could never beat
  // a same-day 4.2-scorer under pure top-score-wins, no matter how long it
  // waited. With aging, eventually score + bonus closes the gap.
  const monthsWaiting = new Date(Date.now() - 90 * 86400000).toISOString();
  const oldCandidateEffective = 2.55 + agingBonus(monthsWaiting);
  const freshHighScorer = 4.2 + agingBonus(null);
  // Not claiming it overtakes in this specific run — just that the gap
  // narrows monotonically instead of staying fixed at 1.65 forever.
  assert.ok((4.2 - 2.55) - (freshHighScorer - oldCandidateEffective) > 0);
});

test('parseAmount: single figure and range both parse', () => {
  assert.deepEqual(parseAmount(null), { amount_min: null, amount_max: null });
  assert.deepEqual(parseAmount('Up to $50,000'), { amount_min: null, amount_max: 50000 });
  assert.deepEqual(parseAmount('$10,000 – $100,000'), { amount_min: 10000, amount_max: 100000 });
});

test('richText: joins Notion rich_text runs, and returns null for empty', () => {
  assert.equal(richText({ rich_text: [{ plain_text: 'Hello ' }, { plain_text: 'world' }] }), 'Hello world');
  assert.equal(richText({ rich_text: [] }), null);
  assert.equal(richText(undefined), null);
});

// Regression coverage for the 2026-09-12 fix: deep-research used to only
// ever write a Deadline when a CURRENT confirmed date was found — an
// estimated-next-cycle or last-known-historical guess (both required from
// every research pass now, see prompts.js) never made it past prose in the
// report, leaving "Rolling" for grants that actually have fixed dates.
test('computeDeadlineFields: a confirmed date sets Deadline with no extra marker', () => {
  const { deadlineObj, deadlineNote } = computeDeadlineFields('2026-09-15', 'confirmed');
  assert.deepEqual(deadlineObj, { start: '2026-09-15' });
  assert.doesNotMatch(deadlineNote, /estimado|última fecha conocida/);
});

test('computeDeadlineFields: an estimated_annual guess still sets a real Deadline, marked as an estimate', () => {
  const { deadlineObj, deadlineNote } = computeDeadlineFields('2027-01-15', 'estimated_annual');
  assert.deepEqual(deadlineObj, { start: '2027-01-15' });
  assert.match(deadlineNote, /^≈/);
  assert.match(deadlineNote, /estimado/);
});

test('computeDeadlineFields: a historical (last-known) deadline sets Deadline, not "rolling"', () => {
  const { deadlineObj, deadlineNote, isRealDate, isRolling } = computeDeadlineFields('2026-03-01', 'historical');
  assert.deepEqual(deadlineObj, { start: '2026-03-01' });
  assert.equal(isRealDate, true);
  assert.equal(isRolling, false);
  assert.match(deadlineNote, /última fecha conocida/);
});

test('computeDeadlineFields: "rolling" produces no Deadline date, only the Rolling note', () => {
  const { deadlineObj, deadlineNote, isRolling } = computeDeadlineFields('rolling', 'rolling');
  assert.equal(deadlineObj, null);
  assert.equal(isRolling, true);
  assert.equal(deadlineNote, formatDeadlineNote('rolling'));
});
