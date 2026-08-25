'use strict';
/**
 * Tests for src/utils/grant-fingerprint.js — this file had NO dedicated
 * test coverage before 2026-08-25, despite being the core dedup identity
 * logic used by notion-sync.js, tracker/index.js, scrapers/index.js, and
 * (as of 2026-08-22) deep-research.js's duplicate-of-already-researched
 * filter. That gap let two real, silent bugs sit in AGGREGATOR_DOMAINS for
 * an unknown length of time:
 *
 *   - 'easygrant.org' was just plain wrong — the scraper actually uses
 *     app.easygrant.io (see portals.js). Since urlDomain() only strips a
 *     literal "www." prefix (not "app."), the correct entry has to be the
 *     exact subdomain "app.easygrant.io".
 *   - 'leadersoftoday.org' was wrong too — the real domain is
 *     www.leadersoftoday.com.
 *
 * Because grantsMatch()'s non-aggregator branch treats "same domain" as
 * "same grant" by design, both typos meant EasyGrant/Leaders of Today —
 * platforms that host THOUSANDS of unrelated listings under one shared
 * domain — were being treated the same way a real single-funder domain
 * is. Caught live 2026-08-25 when deep-research.js's
 * filterAlreadyResearchedDuplicates() nearly skipped a genuinely different
 * grant ("Global Innovation Challenge 2026" / Social Shifters) as a
 * false-positive duplicate of an unrelated one ("Hispanic Impact Fund" /
 * Austin Community Foundation) purely because both happened to be scraped
 * from app.easygrant.io.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { grantsMatch, grantFingerprint, urlDomain, AGGREGATOR_DOMAINS } = require('../src/utils/grant-fingerprint');

test('REGRESSION: two unrelated grants hosted on the EasyGrant discovery platform are NOT matched as duplicates', () => {
  const hispanicImpactFund = { title: 'Hispanic Impact Fund', url: 'https://app.easygrant.io/lists/discover/01KSH5RKJMW0NCV9G8SC0WHR6F' };
  const globalInnovationChallenge = { title: 'Global Innovation Challenge 2026', url: 'https://app.easygrant.io/lists/discover/01KST4RRR05WJ2ZQC3D8PPE3ME' };
  assert.equal(grantsMatch(hispanicImpactFund, globalInnovationChallenge), false);
  // Also confirms they get genuinely distinct fingerprints, not just a
  // pairwise non-match — this is what protects the Notion identity key too.
  assert.notEqual(grantFingerprint(hispanicImpactFund), grantFingerprint(globalInnovationChallenge));
});

test('REGRESSION: app.easygrant.io is classified as an aggregator domain (exact subdomain, not just easygrant.io)', () => {
  assert.equal(AGGREGATOR_DOMAINS.has('app.easygrant.io'), true);
  assert.equal(urlDomain('https://app.easygrant.io/lists/discover/xyz'), 'app.easygrant.io');
});

test('REGRESSION: Leaders of Today is classified under its real domain (.com, not the old wrong .org)', () => {
  assert.equal(AGGREGATOR_DOMAINS.has('leadersoftoday.com'), true);
  assert.equal(AGGREGATOR_DOMAINS.has('leadersoftoday.org'), false);
});

test('grantsMatch: two postings on the SAME real funder domain in the SAME year are treated as the same grant', () => {
  const a = { title: 'Youth4Climate Grants 2026', url: 'https://www.youth4climate.org/apply' };
  const b = { title: 'Youth4Climate — How to Apply', url: 'https://www.youth4climate.org/how-to-apply' };
  assert.equal(grantsMatch(a, b), true);
});

test('grantsMatch: same real funder domain but different years are NOT the same grant', () => {
  // Distinct URLs per year, deliberately — grantsMatch()'s very first check
  // is an exact-URL match that short-circuits BEFORE the year comparison
  // ever runs, so two identical URLs would incorrectly match regardless of
  // year (a known, separate, pre-existing gap — see deep-research.test.js).
  const a = { title: 'Youth4Climate Grants 2026', url: 'https://www.youth4climate.org/apply/2026' };
  const b = { title: 'Youth4Climate Grants 2027', url: 'https://www.youth4climate.org/apply/2027' };
  assert.equal(grantsMatch(a, b), false);
});

test('grantsMatch: a shared distinctive acronym matches across different domains', () => {
  const a = { title: 'Youth Climate Justice Fund (YCJF) 2026', url: 'https://ycjf.org/how-to-apply' };
  const b = { title: 'Fondos de YCJF para impulsar la acción climática', url: 'https://www.gestionandote.org/fondos-de-ycjf/' };
  assert.equal(grantsMatch(a, b), true);
});

test('grantsMatch: generic overlapping words alone (no shared domain, no shared acronym) do not falsely match', () => {
  const a = { title: 'Global Environment Facility - Small Grants Program', url: 'https://csochallenge.org/#apply' };
  const b = { title: 'Global Innovation Challenge 2026', url: 'https://app.easygrant.io/lists/discover/abc' };
  assert.equal(grantsMatch(a, b), false);
});

test('grantFingerprint: aggregator-sourced grants fingerprint by title text, not domain', () => {
  const fp = grantFingerprint({ title: 'Fondos de YCJF para impulsar la acción climática', url: 'https://www.gestionandote.org/fondos-de-ycjf/' });
  assert.ok(fp.length > 3);
  assert.ok(!fp.startsWith('gestionandote.org'));
});

test('grantFingerprint: real funder domains fingerprint by domain+year, collapsing url variants', () => {
  const a = grantFingerprint({ title: 'Youth4Climate Grants 2026', url: 'https://www.youth4climate.org/apply' });
  const b = grantFingerprint({ title: 'Youth4Climate — How to Apply 2026', url: 'https://www.youth4climate.org/how-to-apply' });
  assert.equal(a, b);
});
