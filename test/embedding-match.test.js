'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, cosine, classifyPair, findCandidates, embedTexts } = require('../src/utils/embedding-match');

const g = (title, url = '') => ({ title, url });

test('cleanTitle drops line separators and UTF-8-as-Latin-1 junk', () => {
  assert.equal(cleanTitle('UN SDGâ€¨Action Awards'), 'UN SDG Action Awards');
  assert.equal(cleanTitle('UN SDG Action  Awards'), 'UN SDG Action Awards');
});

test('classifyPair: needs a second signal, not similarity alone', () => {
  // "Youth Climate Fund" / "Youth Climate Prize" measured 0.87 — similar but different programs
  assert.equal(classifyPair(g('Youth Climate Fund', 'https://a.org/1'), g('Youth Climate Prize', 'https://b.org/2'), 0.87), null);
  // below the threshold is never proposed
  assert.equal(classifyPair(g('Irish Aid Grants 2027', 'https://a.org/1'), g('Dubai Cares Education', 'https://b.org/2'), 0.42), null);
});

test('classifyPair: one title contained in the other is a signal', () => {
  const hit = classifyPair(g('Whitley Awards 2027', 'https://a.org/1'), g('2027 Whitley Awards — Conservación de Vida Silvestre', 'https://b.org/2'), 0.86);
  assert.ok(hit);
  assert.ok(hit.why.includes('one title contains the other'));
});

test('classifyPair: near-identical vectors count on their own', () => {
  const hit = classifyPair(g('Zayed Sustainability Prize', 'https://a.org/1'), g('Premio Zayed a la Sostenibilidad', 'https://b.org/2'), 0.96);
  assert.ok(hit && hit.why[0].startsWith('near-identical'));
});

test('classifyPair: vetoes beat any score (year, sibling program, same-host program)', () => {
  assert.equal(classifyPair(g('Girl Up Project Awards 2025', 'https://a.org/1'), g('Girl Up Project Awards 2026', 'https://b.org/2'), 0.97), null);
  assert.equal(classifyPair(g('Social Shifters MoveNow Social Innovation Challenge', 'https://a.org/1'), g('Social Shifters Global Innovation Challenge 2026', 'https://b.org/2'), 0.99), null);
  assert.equal(classifyPair(
    g('2027 Global Health Challenge', 'https://solve.mit.edu/challenges/global-health'),
    g('2027 Global Economic Prosperity Challenge', 'https://solve.mit.edu/challenges/economic-prosperity'), 0.98), null);
});

test('classifyPair: pairs the rules already match are not re-reported', () => {
  assert.equal(classifyPair(g('GirlUp Project Awards', 'https://x.org/a'), g('Girl Up Project Awards 2026', 'https://y.org/b'), 0.99), null);
});

test('findCandidates: ranks by score, against a second list, and null when the server is down', async () => {
  const vec = { 'Whitley Awards 2027': [1, 0], '2027 Whitley Awards — Conservación': [0.98, 0.2], 'Totally Different Prize': [0, 1] };
  const embed = async texts => texts.map(t => vec[t]);
  const out = await findCandidates([g('Whitley Awards 2027', 'https://a.org/1')], [g('2027 Whitley Awards — Conservación', 'https://b.org/2'), g('Totally Different Prize', 'https://c.org/3')], { embed });
  assert.equal(out.length, 1);
  assert.equal(out[0].b.title, '2027 Whitley Awards — Conservación');
  assert.equal(await findCandidates([g('x')], null, { embed: async () => null }), null);
});

test('embedTexts returns null instead of throwing when the server is unreachable or answers badly', async () => {
  assert.equal(await embedTexts(['a'], { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null);
  assert.equal(await embedTexts(['a'], { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await embedTexts(['a', 'b'], { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) }) }), null);
  assert.deepEqual(await embedTexts(['a'], { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }) }), [[1, 2]]);
});

test('cosine of identical and orthogonal vectors', () => {
  assert.ok(Math.abs(cosine([1, 2], [1, 2]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('REGRESSION (2026-11-03 audit): the Notion page "Allianz Social Shifters 2026" IS MoveNow, by its url', () => {
  const page = { title: 'Allianz Social Shifters 2026', url: 'https://www.leadersoftoday.com/opportunities/allianz-movenow-social-innovation-challenge-2026' };
  const record = { title: 'Social Shifters MoveNow Social Innovation Challenge', url: 'https://www.linkedin.com/company/allyforaction/' };
  const hit = classifyPair(record, page, 0.63);
  assert.ok(hit && hit.why[0].startsWith('same program marker'));
  // while the Global Innovation Challenge page stays a different program
  assert.equal(classifyPair(record, { title: 'Social Shifters Global Innovation Challenge 2026', url: 'https://www.socialshifters.co/global-innovation-challenge/' }, 0.95), null);
});
