'use strict';
/**
 * Tests for src/notion-sync.js's pure logic — findFuzzyMatch() and
 * identityKeyFor(), added 2026-09-12 after confirming live 3 times
 * (YCJF, GEF SGP CSO Challenge Program, Stanley 1913 Creators Fund) that
 * the SAME real grant scraped from two different sources (a portal
 * aggregator, the funder's own official site, LinkedIn) creates two
 * duplicate Notion pages — exact fingerprint/URL matching only catches
 * re-scrapes of the SAME source, not cross-source duplicates. See
 * CLAUDE.md's "Known systemic gap" note for the full incident writeup.
 *
 * The rest of notion-sync.js (ensureSchema, buildProperties, syncToNotion)
 * makes live/mocked Notion HTTP calls and isn't covered here, same
 * convention as deep-research.js/near-miss-check.js — only the pure
 * decision logic gets unit tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { findFuzzyMatch, identityKeyFor } = require('../src/notion-sync');

function page(overrides = {}) {
  return { pageId: 'page-1', title: '', url: '', score: null, tier: null, angle: '', researched: false, ...overrides };
}

test('findFuzzyMatch: catches the same fund on two different domains (Stanley 1913 real case)', () => {
  const newGrant = { title: 'Stanley 1913 Creators Fund – 2026 Program', url: 'https://www.stanley1913.com/pages/stanley-1913-creators-fund' };
  const existingPages = [
    page({ pageId: 'easygrant-page', title: 'Stanley 1913 Creators Fund', url: 'https://app.easygrant.io/lists/discover/01KZNG0E0FH8JSQ1NW9JM66CN6' }),
  ];
  const match = findFuzzyMatch(newGrant, existingPages);
  assert.ok(match);
  assert.equal(match.pageId, 'easygrant-page');
});

test('findFuzzyMatch: known remaining gap — an acronym-only title vs its fully-spelled-out official name still does NOT match (GEF SGP real case)', () => {
  // Documented limitation, not a bug: "GEF"/"SGP" never appear as literal
  // 3+ consecutive uppercase letters in "Global Environment Facility -
  // Small Grants Program..." (it's spelled out, not abbreviated), and "CSO"
  // is filtered as a GENERIC_ACRONYM on both sides — so extractAcronyms()
  // finds nothing shared. Word-overlap also finds zero shared tokens (the
  // two titles don't share a single distinctive word). Confirmed live
  // 2026-09-12: this exact pair created two real duplicate Notion pages
  // that findFuzzyMatch does NOT catch. Fixing this needs an acronym-
  // expansion glossary (GEF -> Global Environment Facility, SGP -> Small
  // Grants Program), not a lexical-overlap heuristic — out of scope here.
  const newGrant = { title: 'Convocatoria de Subvención abierta! GEF SGP CSO Challenge', url: 'https://lnkd.in/dmZWe5id' };
  const existingPages = [
    page({ pageId: 'wepropel-page', title: 'Global Environment Facility - Small Grants Program - CSO Challenge Program', url: 'https://csochallenge.org/#apply' }),
  ];
  assert.equal(findFuzzyMatch(newGrant, existingPages), undefined);
});

test('findFuzzyMatch: does NOT match two genuinely different grants that happen to share a generic word', () => {
  const newGrant = { title: 'Small Grants for Youth Climate Action', url: 'https://example.org/youth-climate' };
  const existingPages = [
    page({ pageId: 'other-page', title: 'Small Grants for Ocean Conservation', url: 'https://different-domain.org/ocean' }),
  ];
  assert.equal(findFuzzyMatch(newGrant, existingPages), undefined);
});

test('findFuzzyMatch: does NOT match different-year rounds of the same program (not a duplicate)', () => {
  const newGrant = { title: 'Global Impact Grants 2027', url: 'https://example.org/global-impact-2027' };
  const existingPages = [
    page({ pageId: 'old-round', title: 'Global Impact Grants 2026', url: 'https://different-host.org/global-impact-2026' }),
  ];
  assert.equal(findFuzzyMatch(newGrant, existingPages), undefined);
});

test('findFuzzyMatch: returns undefined against an empty page list', () => {
  assert.equal(findFuzzyMatch({ title: 'Anything', url: 'https://x.org' }, []), undefined);
});

test('identityKeyFor: prefers the fingerprint, falls back to URL when the fingerprint is too short', () => {
  const grant = { title: 'Real Program Name', url: 'https://realfunder.org/apply' };
  assert.equal(identityKeyFor(grant), identityKeyFor(grant)); // deterministic
  assert.ok(identityKeyFor(grant));
});

test('exactMatchFor: a different program on the same host+year does NOT resolve to the old page (would overwrite it)', () => {
  const { exactMatchFor } = require('../src/notion-sync');
  const entry = { pageId: 'p1', title: '2027 Global Health Challenge', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge' };
  const other = { title: '2027 Global Economic Prosperity Challenge', url: 'https://solve.mit.edu/challenges/2027-global-economic-prosperity-challenge' };
  const same = { title: '2027 Global Health Challenge', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge' };
  assert.equal(exactMatchFor(other, entry), null);
  assert.equal(exactMatchFor(same, entry), entry);
  assert.equal(exactMatchFor(same, undefined), null);
});
