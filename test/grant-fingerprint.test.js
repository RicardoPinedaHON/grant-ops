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

// Regression coverage for the 2026-09-12 fix: short titles (2 significant
// words after stopword/year stripping) never qualified for the >= 3 word
// overlap check no matter how identical — confirmed live as a real
// duplicate (Stanley 1913 Creators Fund, scraped from both EasyGrant and
// the funder's own site).
test('grantsMatch: short titles (2 significant words) that are otherwise identical DO match', () => {
  const a = { title: 'Stanley 1913 Creators Fund', url: 'https://app.easygrant.io/lists/discover/abc' };
  const b = { title: 'Stanley 1913 Creators Fund – 2026 Program', url: 'https://www.stanley1913.com/pages/stanley-1913-creators-fund' };
  assert.equal(grantsMatch(a, b), true);
});

test('grantsMatch: short titles sharing only 1 of 2 words do NOT match (avoids the "Youth Climate Fund" vs "Youth Climate Prize" false positive)', () => {
  const a = { title: 'Youth Climate Fund', url: 'https://a.org/x' };
  const b = { title: 'Youth Climate Prize', url: 'https://b.org/y' };
  assert.equal(grantsMatch(a, b), false);
});

test('grantsMatch: an acronym-only title vs its fully-spelled-out name is a KNOWN, unfixed gap (GEF SGP case)', () => {
  const a = { title: 'Convocatoria de Subvención abierta! GEF SGP CSO Challenge', url: 'https://lnkd.in/dmZWe5id' };
  const b = { title: 'Global Environment Facility - Small Grants Program - CSO Challenge Program', url: 'https://csochallenge.org/#apply' };
  assert.equal(grantsMatch(a, b), false);
});

test('REGRESSION: two different challenges on solve.mit.edu are NOT duplicates (2027 Health vs Economic Prosperity)', () => {
  const health = { title: '2027 Global Health Challenge', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge' };
  const econ = { title: '2027 Global Economic Prosperity Challenge', url: 'https://solve.mit.edu/challenges/2027-global-economic-prosperity-challenge' };
  const untitled = { title: 'https://lnkd.in/d82dHDER', url: 'https://solve.mit.edu/challenges/2027-global-economic-prosperity-challenge' };
  assert.equal(grantsMatch(health, econ), false);
  assert.equal(grantsMatch(health, untitled), false);
  // The fingerprint stays host+year on purpose (persisted Notion identity key,
  // see CLAUDE.md) — grantsMatch()/isKnown()/exactMatchFor() are the guards.
  assert.equal(grantFingerprint(health), grantFingerprint(econ));
});

test('grantsMatch: same deep program path with a different title is still the same grant', () => {
  const a = { title: '2027 Global Health Challenge', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge' };
  const b = { title: 'Solve Global Health Challenge 2027 — Apply', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge/' };
  assert.equal(grantsMatch(a, b), true);
});

test('isKnown: an old host+year fingerprint alias does not swallow a different program on the same host', () => {
  const { isKnown } = require('../src/tracker/index');
  const history = {
    wp_x: { title: '2027 Global Health Challenge', url: 'https://solve.mit.edu/challenges/2027-global-health-challenge' },
    'fp:solve.mit.edu||2027': { grant_id: 'wp_x', title: '2027 Global Health Challenge' },
  };
  const econ = { id: 'li_1', title: '2027 Global Economic Prosperity Challenge', url: 'https://solve.mit.edu/challenges/2027-global-economic-prosperity-challenge' };
  assert.equal(isKnown(econ, history), false);
});

test('REGRESSION (LinkedIn repeat audit): "GirlUp Project Awards" is the same grant as "Girl Up Project Awards 2026"', () => {
  const a = { title: 'GirlUp Project Awards', url: 'https://www.linkedin.com/company/allyforaction/' };
  const b = { title: 'Girl Up Project Awards 2026', url: 'https://girlup.org/project-awards' };
  assert.equal(grantsMatch(a, b), true);
  // a different year is a different round
  assert.equal(grantsMatch({ title: 'Girl Up Project Awards 2025', url: 'https://x.org/a' }, { title: 'GirlUp Project Awards 2026', url: 'https://y.org/b' }), false);
});

test('REGRESSION (LinkedIn repeat audit): "UN Environment Programme Small Grants Programme" is "UNEP Small Grants Program 2026"', () => {
  const a = { title: 'UN Environment Programme Small Grants Programme', url: 'https://www.linkedin.com/company/allyforaction/' };
  const b = { title: 'UNEP Small Grants Program 2026', url: 'https://www.unep.org/small-grants' };
  assert.equal(grantsMatch(a, b), true);
});

test('acronym expansion does not merge different programs of the same funder', () => {
  const small = { title: 'United Nations Environment Programme Small Grants Programme', url: 'https://a.org/1' };
  const fin = { title: 'UNEP Finance Initiative Membership', url: 'https://b.org/2' };
  assert.equal(grantsMatch(small, fin), false);
  assert.equal(grantsMatch({ title: 'Youth Climate Fund', url: 'https://a.org/1' }, { title: 'Youth Climate Prize', url: 'https://b.org/2' }), false);
});

test('short or merely similar titles are not squashed into a match', () => {
  assert.equal(grantsMatch({ title: 'Green Fund', url: 'https://a.org/1' }, { title: 'GreenFund', url: 'https://b.org/2' }), false);
});

test('findKnown says WHAT a skipped grant repeats (id match, fingerprint match, or none)', () => {
  const { findKnown } = require('../src/tracker/index');
  const fp = grantFingerprint({ title: 'GirlUp Project Awards', url: 'https://www.linkedin.com/company/x/' });
  const history = {
    li_a: { title: 'GirlUp Project Awards', first_seen: '2026-10-20T10:00:00Z', url: 'https://girlup.org/awards' },
    [`fp:${fp}`]: { grant_id: 'li_a', title: 'GirlUp Project Awards', first_seen: '2026-10-20T10:00:00Z' },
  };
  assert.equal(findKnown({ id: 'li_a', title: 'x', url: '' }, history).via, 'same id');
  const byFp = findKnown({ id: 'li_new', title: 'GirlUp Project Awards', url: 'https://www.linkedin.com/company/x/' }, history);
  assert.equal(byFp.via, 'same fingerprint');
  assert.equal(byFp.title, 'GirlUp Project Awards');
  assert.equal(findKnown({ id: 'li_z', title: 'Totally Different Prize', url: 'https://www.linkedin.com/company/x/' }, history), null);
});

test('REGRESSION (LinkedIn repeat audit): Social Shifters MoveNow is a different program from the Global Innovation Challenge', () => {
  const movenow = { title: 'Social Shifters MoveNow Social Innovation Challenge', url: 'https://www.linkedin.com/company/startup-networks/' };
  const global = { title: 'Social Shifters Global Innovation Challenge 2026', url: 'https://app.easygrant.io/x/1' };
  assert.equal(grantsMatch(movenow, global), false);
  // the same MoveNow call spelled two ways still matches itself
  assert.equal(grantsMatch(movenow, { title: 'The Allianz x Social Shifters MoveNow Social Innovation Challenge 2026', url: 'https://opportunitydesk.org/y' }), true);
});
