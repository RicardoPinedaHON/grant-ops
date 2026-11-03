'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/linkedin-multi-posts.json');
const { applyImageText, listTargets } = require('../src/linkedin-image-text');
const { splitPostIntoRecords, isLikelyOpportunityPost } = require('../src/scrapers/linkedin');

const FP = 'abcdef0123456789abcdef01'.padEnd(64, '0');
const post = {
  ...fx.tarbell_single,
  source_name: 'Fondos y Convocatorias',
  source_url: 'https://www.linkedin.com/company/fondos-y-convocatorias/',
  post_text: '🔔 Convocatorias abiertas esta semana, mira la imagen. Postula ya',
  external_urls: [],
  fingerprint: FP,
};
const IMAGE_TEXT = '1. Fondo Semillas Verdes – hasta $20k – cierra 10 dic 2026 2. Premio Agua Limpia LAC – $5,000 – deadline 15 January 2027 3. Beca Clima Joven – USD 8,000 – cierra 1 feb 2027';

function deps(over = {}) {
  const seen = new Set();
  return {
    split: splitPostIntoRecords,
    resolveLinks: async l => l,
    isOpportunity: isLikelyOpportunityPost,
    buildPrompt: g => ({ prescore: { prescore: 3 }, prompt: `PROMPT ${g.title}` }),
    isKnown: g => seen.has(g.id),
    markSeen: g => seen.add(g.id),
    ...over,
  };
}

test('applyImageText replaces the caption-only record with the grants listed in the image', async () => {
  const captionRecord = splitPostIntoRecords(post)[0];
  const prescored = [
    { grant: captionRecord, prescore: {}, claude_prompt: 'caption only' },
    { grant: { id: 'other', title: 'Unrelated', _linkedin: { fingerprint: 'zzz' } }, prescore: {}, claude_prompt: 'x' },
  ];
  const r = await applyImageText({ pending: [{ key: FP.slice(0, 24), post, files: [] }], texts: { [FP.slice(0, 24)]: IMAGE_TEXT }, prescored, deps: deps() });
  assert.equal(r.replaced, 1);
  assert.equal(r.added, 3);
  assert.equal(r.prescored.length, 4); // 3 new + the unrelated one untouched
  assert.ok(r.prescored.some(i => i.grant.id === 'other'));
  assert.ok(!r.prescored.some(i => i.claude_prompt === 'caption only'));
  const titles = r.prescored.filter(i => i.grant._from_image_text).map(i => i.grant.title);
  assert.deepEqual(titles.map(t => t.split(' –')[0]), ['Fondo Semillas Verdes', 'Premio Agua Limpia LAC', 'Beca Clima Joven']);
});

test('applyImageText keeps the caption-only record when the image had no readable text', async () => {
  const captionRecord = splitPostIntoRecords(post)[0];
  const prescored = [{ grant: captionRecord, prescore: {}, claude_prompt: 'caption only' }];
  const r = await applyImageText({ pending: [{ key: 'k1', post, files: [] }], texts: { k1: '   ' }, prescored, deps: deps() });
  assert.equal(r.skipped, 1);
  assert.equal(r.prescored.length, 1);
  assert.equal(r.prescored[0].claude_prompt, 'caption only');
});

test('applyImageText skips merged text that is still not an opportunity, and posts missing from the texts file', async () => {
  const noise = { ...post, post_text: 'Gracias por acompañarnos en el evento de ayer' };
  const r1 = await applyImageText({ pending: [{ key: 'k', post: noise, files: [] }], texts: { k: 'Foto del equipo en la sala' }, prescored: [], deps: deps() });
  assert.equal(r1.added, 0);
  const r2 = await applyImageText({ pending: [{ key: 'missing', post, files: [] }], texts: {}, prescored: [], deps: deps() });
  assert.equal(r2.skipped, 1);
});

test('applyImageText does not re-add grants history already knows, but re-adds a replaced caption record id', async () => {
  const r = await applyImageText({
    pending: [{ key: 'k', post, files: [] }], texts: { k: IMAGE_TEXT }, prescored: [],
    deps: deps({ isKnown: g => /Premio Agua/.test(g.title) }),
  });
  assert.equal(r.added, 2);
});

test('applyImageText honours the pre-filter (buildPrompt returning null drops the grant)', async () => {
  const r = await applyImageText({
    pending: [{ key: 'k', post, files: [] }], texts: { k: IMAGE_TEXT }, prescored: [],
    deps: deps({ buildPrompt: g => (/Beca Clima/.test(g.title) ? null : { prescore: {}, prompt: 'p' }) }),
  });
  assert.equal(r.added, 2);
});

test('listTargets exposes only what the reading step needs', () => {
  const t = listTargets([{ key: 'k', source_name: 'S', caption: 'c', files: ['/x.jpg'], post: { big: 'object' } }]);
  assert.deepEqual(t, [{ key: 'k', source: 'S', caption: 'c', files: ['/x.jpg'] }]);
});
