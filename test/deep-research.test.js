'use strict';
/**
 * Tests for src/deep-research.js's filterAlreadyResearchedDuplicates() —
 * added 2026-08-22 after a real, confirmed incident: "Youth Climate Justice
 * Fund (YCJF) 2026" (scraped from ycjf.org) and "Fondos de YCJF para
 * impulsar la acción climática de iniciativas de jóvenes" (scraped from the
 * gestionandote.org aggregator) are the same real program, but
 * grantFingerprint() gives them structurally incompatible identity keys
 * (domain-based vs. acronym/title-based — see grant-fingerprint.js), so
 * they were never recognized as duplicates. Confirmed live: both got
 * independently deep-researched the same day (18% and 20% likelihood,
 * two agents investigating the same funder from scratch), wasting one of
 * the capped 5 research slots on a grant that had already been researched
 * under a different scraped title/domain.
 *
 * Requiring deep-research.js is safe here — its live-Notion async IIFE is
 * guarded behind `require.main === module` specifically so this file can
 * be imported without making network calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterAlreadyResearchedDuplicates } = require('../src/deep-research');

test('filterAlreadyResearchedDuplicates: catches the real YCJF case (same funder, different domain, different scraped title)', () => {
  const researchedGrants = [
    { title: 'Youth Climate Justice Fund (YCJF) 2026', url: 'https://ycjf.org/how-to-apply' },
  ];
  const candidates = [
    {
      grant: {
        title: 'Fondos de YCJF para impulsar la acción climática de iniciativas de jóvenes',
        url: 'https://www.gestionandote.org/fondos-de-ycjf-para-impulsar-la-accion-climatica-de-iniciativas-de-jovenes/',
      },
      scoring: { final_score: 3.67, recommendation: 'MONITOR' },
    },
  ];
  const result = filterAlreadyResearchedDuplicates(candidates, researchedGrants);
  assert.equal(result.length, 0, 'the aggregator-sourced repost of an already-researched grant must be filtered out');
});

test('filterAlreadyResearchedDuplicates: does NOT filter a genuinely different grant that happens to share a generic word', () => {
  const researchedGrants = [
    { title: 'Youth Climate Justice Fund (YCJF) 2026', url: 'https://ycjf.org/how-to-apply' },
  ];
  const candidates = [
    {
      grant: { title: 'Global Environment Facility - Small Grants Program - CSO Challenge Program', url: 'https://csochallenge.org/#apply' },
      scoring: { final_score: 3.18, recommendation: 'MONITOR' },
    },
  ];
  const result = filterAlreadyResearchedDuplicates(candidates, researchedGrants);
  assert.equal(result.length, 1, 'an unrelated grant must not be filtered just because both are environmental funds');
});

test('filterAlreadyResearchedDuplicates: different-year rounds on different pages of the same site are NOT treated as duplicates', () => {
  // grantsMatch()'s domain-match branch explicitly keeps different years
  // apart — a 2026 round being "already researched" must not suppress
  // research on a distinctly-paged 2027 round.
  // NOTE (not fixed here, out of scope for this incident): if BOTH years
  // scrape to the exact same URL (a funder reusing one "how to apply" page
  // year over year, common in practice), grantsMatch()'s very first check
  // (`ua === ub` → true) short-circuits before the year comparison ever
  // runs, so identical-URL-different-year WOULD incorrectly match. That's a
  // separate, pre-existing edge case in grantsMatch() itself, not something
  // this filter introduces — flagged for a future pass, not fixed here.
  const researchedGrants = [
    { title: 'Youth Climate Justice Fund 2026 Grant Round', url: 'https://youthclimatejusticefund.org/apply/2026' },
  ];
  const candidates = [
    {
      grant: { title: 'Youth Climate Justice Fund 2027 Grant Round', url: 'https://youthclimatejusticefund.org/apply/2027' },
      scoring: { final_score: 3.8, recommendation: 'APPLY_NOW' },
    },
  ];
  const result = filterAlreadyResearchedDuplicates(candidates, researchedGrants);
  assert.equal(result.length, 1, 'a new annual round of the same program must still be researched');
});

test('filterAlreadyResearchedDuplicates: passes through everything when nothing has been researched yet', () => {
  const candidates = [
    { grant: { title: 'Grant A', url: 'https://a.org' }, scoring: { final_score: 3.0 } },
    { grant: { title: 'Grant B', url: 'https://b.org' }, scoring: { final_score: 2.9 } },
  ];
  const result = filterAlreadyResearchedDuplicates(candidates, []);
  assert.equal(result.length, 2);
});
