'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { qualifyTitle, isGenericTitle, funderIsReliable } = require('../src/utils/title-naming');
const { applyExtractionCorrections } = require('../src/score-with-claude');

test('generic newsletter titles get the funder prefixed', () => {
  assert.equal(qualifyTitle('Fall Grant Cycle', 'NBA Foundation', 'Email: Fast Forward'), 'NBA Foundation — Fall Grant Cycle');
  assert.equal(qualifyTitle('STEM K-12', 'NSF', 'Email: Fast Forward'), 'NSF — STEM K-12');
  assert.equal(qualifyTitle('Community Grants', 'Sundt Foundation', 'Email: Fast Forward'), 'Sundt Foundation — Community Grants');
});

test('specific titles are left alone', () => {
  assert.equal(qualifyTitle('Whitley Awards 2027', 'Whitley Fund for Nature', 'WePropel'), 'Whitley Awards 2027');
  assert.equal(qualifyTitle('Girl Up Project Awards 2026', 'Leaders of Today Opportunities', 'LinkedIn: Leaders of Today Opportunities'), 'Girl Up Project Awards 2026');
});

test('funder already in the title is not repeated, including run-together forms', () => {
  assert.equal(qualifyTitle('Oak Foundation Grants', 'Oak Foundation', 'Email: ImpactShip'), 'Oak Foundation Grants');
  assert.equal(qualifyTitle('Sparkplug Foundation', 'sparkplugfoundation', 'ImpactFunding Substack'), 'Sparkplug Foundation');
  assert.equal(qualifyTitle('UN SDGAction Awards', 'UN SDG Action', 'Email: ImpactShip'), 'UN SDGAction Awards');
});

test('never prefixes with an untrustworthy funder', () => {
  // the channel itself, nothing, a garbled value, a multi-funder list
  assert.equal(qualifyTitle('Annual Call', 'Leaders of Today Opportunities', 'LinkedIn: Leaders of Today Opportunities'), 'Annual Call');
  assert.equal(qualifyTitle('Annual Call', '', 'Email: X'), 'Annual Call');
  assert.equal(qualifyTitle('Convocatoria #Pensar', 'ConOtros 2026Grupo SURA | Fundación Bolívar', 'WePropel'), 'Convocatoria #Pensar');
  assert.equal(qualifyTitle('Fifth Call for Funding Applications', 'UNDP, European Union, British Government, Finland', 'EasyGrant'), 'Fifth Call for Funding Applications');
  assert.equal(funderIsReliable('', 'x'), false);
});

test('isGenericTitle tells generic from named programs', () => {
  assert.equal(isGenericTitle('Fall Grant Cycle'), true);
  assert.equal(isGenericTitle('Introductory Grants'), true);
  assert.equal(isGenericTitle('Brazil’s Climate Finance Crossroads: A Compass pointing the way'), false);
  assert.equal(isGenericTitle('Yale Emerging Climate Leaders Fellowship'), false);
});

test('applyExtractionCorrections qualifies the title even when Claude returns none', () => {
  const grant = { title: 'Introductory Grants', funder: 'The Clowes Fund', source: 'Email: Fast Forward' };
  assert.equal(applyExtractionCorrections(grant, {}).title, 'The Clowes Fund — Introductory Grants');
  // and does not double-prefix a title Claude already qualified
  assert.equal(applyExtractionCorrections(grant, { clean_title: 'The Clowes Fund — Introductory Grants' }).title, 'The Clowes Fund — Introductory Grants');
});
