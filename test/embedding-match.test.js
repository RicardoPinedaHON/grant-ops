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
  const rare = { docFreq: () => 1 };
  const hit = classifyPair(g('Whitley Awards 2027', 'https://a.org/1'), g('2027 Whitley Awards — Conservación de Vida Silvestre', 'https://b.org/2'), 0.86, rare);
  assert.ok(hit);
  // a one-word name that is common in the corpus is not distinctive
  assert.equal(classifyPair(g('Whitley Awards 2027', 'https://a.org/1'), g('2027 Whitley Awards — Conservación de Vida Silvestre', 'https://b.org/2'), 0.86, { docFreq: () => 9 }), null);
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

test('REGRESSION (corpus run, 686 titles): generic titles are never proposed on similarity or containment alone', () => {
  // "Small Grants Program 2026" from two different funders: vectors 0.97, different programs
  assert.equal(classifyPair(g('Small Grants Program 2026', 'https://a.org/1'), g('Small Grants Programme 2026', 'https://b.org/2'), 0.97), null);
  // "Fellowship Program 2027" sits inside any funder's longer title
  assert.equal(classifyPair(g('Fellowship Program 2027', 'https://a.org/1'), g('OHCHR Indigenous Fellowship Program 2027', 'https://b.org/2'), 0.85, { docFreq: () => 1 }), null);
  assert.equal(classifyPair(g('Community Grants', 'https://a.org/1'), g('Sundt Foundation — Community Grants', 'https://b.org/2'), 0.85, { docFreq: () => 1 }), null);
});

// ── Hardening: this runs unattended, so every failure must degrade to "no candidates", never throw or hang ──

const okFetch = dim => async (_url, opts) => {
  const input = JSON.parse(opts.body).input;
  return { ok: true, json: async () => ({ data: input.map((t, i) => ({ embedding: Array.from({ length: dim }, (_, k) => (k === i % dim ? 1 : 0.01)) })) }) };
};

test('embedTexts: rejects NaN, empty, and mixed-dimension vectors instead of comparing garbage', async () => {
  const bad = embedding => async () => ({ ok: true, json: async () => ({ data: [{ embedding }] }) });
  assert.equal(await embedTexts(['a'], { fetchImpl: bad([1, NaN]) }), null);
  assert.equal(await embedTexts(['a'], { fetchImpl: bad([]) }), null);
  assert.equal(await embedTexts(['a'], { fetchImpl: bad(null) }), null);
  assert.equal(await embedTexts(['a'], { fetchImpl: bad(['x', 'y']) }), null);
  let call = 0;
  const mixed = async (_u, o) => ({ ok: true, json: async () => ({ data: JSON.parse(o.body).input.map(() => ({ embedding: call++ === 0 ? [1, 2] : [1, 2, 3] })) }) });
  assert.equal(await embedTexts(Array.from({ length: 20 }, (_, i) => `t${i}`), { fetchImpl: mixed }), null); // 2 batches, 2nd has other dim
});

test('embedTexts: a hung server is cut by the timeout and the total budget, not waited on', async () => {
  const hang = (_u, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  assert.equal(await embedTexts(['a'], { fetchImpl: hang, timeoutMs: 40 }), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await embedTexts(['a'], { fetchImpl: okFetch(4), budgetMs: 0 }), null);
});

test('embedTexts: duplicates are sent once, long titles are truncated, non-strings do not throw', async () => {
  const seen = [];
  const f = async (u, o) => { const input = JSON.parse(o.body).input; seen.push(...input); return okFetch(4)(u, o); };
  const out = await embedTexts(['same', 'same', 'x'.repeat(5000), null, undefined, 42], { fetchImpl: f });
  assert.equal(out.length, 6);
  assert.equal(seen.filter(t => t === 'same').length, 1);
  assert.ok(seen.every(t => t.length <= 300));
  assert.ok(out.every(Array.isArray));
});

test('findCandidates: junk input never throws; empty input is "nothing found"; oversize input declines', async () => {
  const embed = async texts => texts.map(() => [1, 0]);
  assert.deepEqual(await findCandidates([], null, { embed }), []);
  assert.deepEqual(await findCandidates(null, null, { embed }), []);
  const messy = [null, undefined, {}, { title: 42 }, { title: '' }, { title: '   ' }, { title: 'Only Real Grant Name', url: null }, { title: 'Only Real Grant Names', url: undefined }];
  const out = await findCandidates(messy, null, { embed });
  assert.ok(Array.isArray(out));
  assert.equal(await findCandidates([g('a title'), g('b title')], null, { embed, maxItems: 1 }), null);
  assert.equal(await findCandidates([g('a title'), g('b title')], null, { embed: async () => { throw new Error('boom'); } }), null);
  assert.equal(await findCandidates([g('a title'), g('b title')], null, { embed: async texts => texts.slice(1).map(() => [1]) }), null);
});

test('findCandidates against the real server URL on a closed port degrades to null quickly', async () => {
  const t0 = Date.now();
  assert.equal(await findCandidates([g('Some Grant Name'), g('Another Grant Name')], null, { url: 'http://127.0.0.1:1/v1/embeddings' }), null);
  assert.ok(Date.now() - t0 < 5000);
});
