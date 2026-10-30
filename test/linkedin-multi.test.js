'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/linkedin-multi-posts.json');
const { classifyLinks, segmentPostText, deriveSegmentTitle } = require('../src/scrapers/linkedin-multi');
const { splitPostIntoRecords, extractAmountRange, extractDeadline } = require('../src/scrapers/linkedin');

test('HOST post: 3 grants listed with ➜ and no links become 3 records, each with its own amount/deadline', () => {
  const records = splitPostIntoRecords(fx.host_three_grants);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.title), [
    'GirlUp Project Awards',
    'CASE at Duke F.M Kirby Prize for Scaling Impact',
    'Social Shifters MoveNow Social Innovation Challenge',
  ]);
  assert.deepEqual(records.map(r => r.deadline), ['2026-10-31', '2026-12-02', '2026-12-18']);
  assert.deepEqual(records.map(r => r.amount_max), [2500, 150000, 10000]);
  // the newsletter sign-up and resource-directory links must not become the grant url
  for (const r of records) assert.ok(!/shorturl|resourcedirectory/.test(r.url), r.url);
  assert.equal(new Set(records.map(r => r.id)).size, 3);
});

test('HOST post: footer call-to-action is not swallowed into the last grant', () => {
  const seg = segmentPostText(fx.host_three_grants.post_text);
  assert.ok(!/Looking for funding|Funding Bulletin|Fundraising Resource/i.test(seg.segments[2].text));
});

test('Innpactia post: 5 keycap-listed grants -> 5 records incl. the MIT Solve one; the "Regístrate" link is not a record', () => {
  const records = splitPostIntoRecords(fx.innpactia_five);
  assert.equal(records.length, 5);
  const titles = records.map(r => r.title);
  assert.ok(titles.some(t => /Global Economic Prosperity Challenge/.test(t)), titles.join(' | '));
  assert.ok(titles.every(t => !/^https?:/.test(t)), 'no title is a raw URL');
  assert.ok(!records.some(r => /innpactia\.com/.test(r.url)), 'sign-up/login page never becomes a grant url');
  const mit = records.find(r => /Economic Prosperity/.test(r.title));
  assert.equal(mit.url, 'https://solve.mit.edu/challenges/2027-global-economic-prosperity-challenge');
});

test('classifyLinks: sign-up, login and own-site-root links are junk; real program links are not', () => {
  const links = classifyLinks(fx.innpactia_five);
  const byUrl = Object.fromEntries(links.map(l => [l.resolved_url, l.junk]));
  assert.ok(byUrl['https://web.innpactia.com/#/auth/log-in']);
  assert.equal(byUrl['https://cieif.org/guidelines-for-grant-applicants/'], null);
  const wphf = classifyLinks(fx.onglink_wphf);
  assert.ok(wphf.find(l => /onglink\.org\/\?trk|onglink\.org\/$/.test(l.original_url)).junk);
  assert.equal(wphf.find(l => /oportunidad_info/.test(l.resolved_url || l.original_url)).junk, null);
});

test('single-grant posts are NOT split: ONGLink WPHF (two support modalities, 📌/📍 labels) stays one record', () => {
  const records = splitPostIntoRecords(fx.onglink_wphf);
  assert.equal(records.length, 1);
  assert.match(records[0].url, /oportunidad_info/);
});

test('single-grant posts without list markers stay one record (Tarbell, ONGLink tools post)', () => {
  assert.equal(splitPostIntoRecords(fx.tarbell_single).length, 1);
  assert.equal(splitPostIntoRecords(fx.onglink_single_details).length, 1);
});

test('segmentPostText: needs 2+ grant-looking segments; amounts/dates with periods are not a numbered list', () => {
  assert.equal(segmentPostText('Postula hasta el 5. Dic 2026 con montos desde 2. Cinco mil dólares para organizaciones juveniles en toda la región'), null);
  assert.equal(segmentPostText('1️⃣ ok 2️⃣ ok'), null);
});

test('segmentPostText: consecutive "1. 2. 3." lists split; arrows used as CTA do not', () => {
  const numbered = '¡Tres convocatorias! 1. Fondo Verde para jóvenes, hasta $20k, cierra 10 dic 2026 2. Premio Agua Limpia, $5,000, deadline 15 January 2027 3. Beca Clima LAC, USD 8,000 cierra 1 feb 2027 Más info en nuestra web';
  const seg = segmentPostText(numbered);
  assert.equal(seg.kind, 'numbered');
  assert.equal(seg.segments.length, 3);
  assert.ok(!/Más info/.test(seg.segments[2].text));
  assert.equal(segmentPostText('Gran convocatoria abierta para ONG con financiamiento de hasta $50,000 ➡️ aplica aquí https://x.org/convocatoria'), null);
});

test('deriveSegmentTitle: cuts long blurbs at the audience clause, keeps short names whole', () => {
  assert.equal(deriveSegmentTitle('GirlUp Project Awards For youth leaders (age 13 to 25) advancing gender justice in their communities. International |Up to $2.5k | Closes 31 October 2026'), 'GirlUp Project Awards');
  assert.equal(deriveSegmentTitle('Innova CFI – Fondo de Inversión en Innovación 👉 https://lnkd.in/e2kJ8j5s'), 'Innova CFI – Fondo de Inversión en Innovación');
});

test('extractAmountRange: k/M suffixes expand ("$2.5k" was parsed as 25)', () => {
  assert.equal(extractAmountRange('Up to $2.5k').amount_max, 2500);
  assert.equal(extractAmountRange('Prize of $150k').amount_max, 150000);
  assert.equal(extractAmountRange('Hasta USD 1.2M').amount_max, 1200000);
  assert.equal(extractAmountRange('Hasta AU$30.000').amount_max, 30000);
});

test('extractDeadline still reads "Closes 2 December 2026" style dates', () => {
  assert.equal(extractDeadline('Closes 2 December 2026').deadline, '2026-12-02');
});

test('eligibility checklists with ✅ bullets are NOT split into grants', () => {
  const checklist = '📢 Convocatoria Fondo Verde Juvenil 2026, hasta $20,000, cierra 10 dic 2026. Requisitos: ✅ Organización con personería jurídica y programas de fondos propios ✅ Experiencia comprobada en proyectos ambientales con jóvenes ✅ Presupuesto anual menor a un millón de dólares Aplica aquí https://fondoverde.org/aplica';
  assert.equal(segmentPostText(checklist), null);
  assert.equal(splitPostIntoRecords({ ...fx.tarbell_single, post_text: checklist, external_urls: [] }).length, 1);
});

test('✅ bullets that each carry their own amount/deadline DO split', () => {
  const list = 'Esta semana: ✅ Fondo Semillas, hasta $20,000, cierra 10 dic 2026 ✅ Premio Agua LAC, $5,000, deadline 15 January 2027 Más info en la web';
  assert.equal(segmentPostText(list).segments.length, 2);
});

test('REGRESSION: link-less sibling grants from one post (same LinkedIn page url) are not collapsed as duplicates', () => {
  const { grantsMatch, grantFingerprint } = require('../src/utils/grant-fingerprint');
  const r = splitPostIntoRecords(fx.host_three_grants);
  assert.equal(grantsMatch(r[0], r[1]), false);
  assert.equal(grantsMatch(r[1], r[2]), false);
  assert.equal(new Set(r.map(grantFingerprint)).size, 3);
  assert.ok(r.every(x => grantFingerprint(x).length > 3 && !grantFingerprint(x).startsWith('linkedin.com')));
});

test('the same link-less grant seen again (same title, LinkedIn url) is still recognised as a duplicate', () => {
  const { grantsMatch } = require('../src/utils/grant-fingerprint');
  const a = { title: 'Social Shifters MoveNow Social Innovation Challenge', url: 'https://www.linkedin.com/company/allyforaction/' };
  const b = { title: 'Social Shifters MoveNow Social Innovation Challenge', url: 'https://es.linkedin.com/company/allyforaction/' };
  assert.equal(grantsMatch(a, b), true);
});
