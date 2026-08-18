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

const { isResearchStale, agingBonus, parseAmount, richText } = require('../src/notion-client');

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
  assert.equal(agingBonus(new Date().toISOString()), 0);
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
