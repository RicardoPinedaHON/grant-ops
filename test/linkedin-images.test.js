'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isPostImageUrl, pickPostImages, matchPostToImages, downloadImages, cleanupImageDir,
  assertInsideTempRoot, mergeImageTextIntoPost,
} = require('../src/scrapers/linkedin-images');
const { splitPostIntoRecords } = require('../src/scrapers/linkedin');
const fx = require('./fixtures/linkedin-multi-posts.json');

const POST_IMG = 'https://media.licdn.com/dms/image/v2/D4D22AQabc/feedshare-shrink_800/B4DZxyz/0/17000?e=1&v=beta&t=x';

test('isPostImageUrl: accepts feed media, rejects logos, profile photos, covers and non-licdn hosts', () => {
  assert.equal(isPostImageUrl(POST_IMG), true);
  assert.equal(isPostImageUrl('https://media.licdn.com/dms/image/v2/C4D0BAQ/company-logo_100_100/0/1/logo'), false);
  assert.equal(isPostImageUrl('https://media.licdn.com/dms/image/v2/D4D03/profile-displayphoto-shrink_100_100/0/1'), false);
  assert.equal(isPostImageUrl('https://media.licdn.com/dms/image/v2/D4D3DAQ/image-scale_191_1128/B4/0/1/onglink_cover'), false);
  assert.equal(isPostImageUrl('https://example.com/feedshare/x.jpg'), false);
});

test('pickPostImages: keeps large post media only, dedups, caps per post, extracts the activity id', () => {
  const picked = pickPostImages([
    { urn: 'urn:li:activity:7491234567890123456', text: 'Convocatorias de la semana 1 2 3', images: [
      { src: POST_IMG, width: 800, height: 800 },
      { src: POST_IMG, width: 800, height: 800 },
      { src: 'https://media.licdn.com/dms/image/v2/x/company-logo_100_100/0/1/l', width: 100, height: 100 },
      { src: POST_IMG.replace('abc', 'tiny'), width: 90, height: 90 },
    ] },
    { urn: 'urn:li:activity:7490000000000000001', text: 'sin imagen', images: [] },
  ]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].urn, '7491234567890123456');
  assert.equal(picked[0].images.length, 1);
});

test('matchPostToImages: matches by activity id, falls back to the post opening text', () => {
  const picked = pickPostImages([{ urn: 'urn:li:activity:7491234567890123456', text: 'HOST 5,000 followers 2w Global Grant Opportunities + Free Fundraising Resources GirlUp Project Awards', images: [{ src: POST_IMG, width: 800, height: 800 }] }]);
  assert.equal(matchPostToImages({ raw_metadata: { activity_id: '7491234567890123456' }, post_text: 'zzz' }, picked).length, 1);
  assert.equal(matchPostToImages({ raw_metadata: {}, post_text: fx.host_three_grants.post_text.replace(/^📢 /, '') }, picked).length, 1);
  assert.equal(matchPostToImages({ raw_metadata: {}, post_text: 'Un post totalmente distinto sobre otra cosa muy diferente' }, picked).length, 0);
});

test('downloadImages saves only image/* responses under the temp root, cleanupImageDir removes them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'li-img-'));
  const http = { get: async url => url.includes('bad')
    ? { headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>') }
    : { headers: { 'content-type': 'image/png' }, data: Buffer.from([137, 80, 78, 71]) } };
  const files = await downloadImages([POST_IMG, 'https://media.licdn.com/bad'], '7491/../evil', { root, http });
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith(root));
  assert.ok(fs.existsSync(files[0]));
  cleanupImageDir(root);
  assert.equal(fs.existsSync(root), false);
});

test('assertInsideTempRoot refuses paths outside the temp root (cleanup can never delete anything else)', () => {
  const root = path.join(os.tmpdir(), 'li-root');
  assert.throws(() => assertInsideTempRoot(path.join(os.tmpdir(), 'other'), root), /outside/);
  assert.throws(() => assertInsideTempRoot(path.join(root, '..'), root), /outside/);
  assert.doesNotThrow(() => assertInsideTempRoot(path.join(root, 'abc'), root));
});

test('image text merged into a caption-only post recovers the grants that only the image listed', () => {
  const captionOnly = {
    ...fx.tarbell_single,
    source_name: 'Fondos y Convocatorias',
    source_url: 'https://www.linkedin.com/company/fondos-y-convocatorias/',
    post_text: '🔔 Convocatorias abiertas esta semana, mira la imagen',
    external_urls: [],
  };
  assert.equal(splitPostIntoRecords(captionOnly).length, 1);
  const merged = mergeImageTextIntoPost(captionOnly,
    '1. Fondo Semillas Verdes – hasta $20k – cierra 10 dic 2026 2. Premio Agua Limpia LAC – $5,000 – deadline 15 January 2027 3. Beca Clima Joven – USD 8,000 – cierra 1 feb 2027');
  const records = splitPostIntoRecords(merged);
  assert.equal(records.length, 3);
  assert.ok(records[0].title.startsWith('Fondo Semillas Verdes'));
  assert.equal(records[0].amount_max, 20000);
  assert.equal(records[1].deadline, '2027-01-15');
  assert.ok(merged._has_image_text);
});

test('mergeImageTextIntoPost leaves the post untouched when the image had no readable text', () => {
  const p = { post_text: 'x' };
  assert.equal(mergeImageTextIntoPost(p, '   '), p);
});
