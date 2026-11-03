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

const STARTUP_ROUNDUP = "🚨 Up to £175,000, €100,000 & £5,000 – 4 Funding Opportunities You Don't Want to Miss! We've rounded up 4 opportunities worth exploring! 👇 👩💼 1. Up to €100,000 – European Prize for Women Innovators 2027 Cash prizes recognising outstanding women entrepreneurs developing innovative businesses. ✅ Female founders and co-founders ✅ Eligible entrepreneurs across Europe, including the UK 💰 Prizes up to €100,000 📅 Deadline: 1 December 2026 🔗 https://lnkd.in/erXzUxkH 🤖 2. Up to £175,000 – Innovate UK Frontier AI: SME Champions Grant funding for UK businesses developing advanced artificial intelligence technologies. ✅ UK-registered startups and SMEs ✅ Businesses developing genuinely innovative AI technologies 💰 Up to £175,000 📅 Deadline: 11 November 2026 🔗 https://lnkd.in/dHPYqkau 🚀 3. Up to £5,000 – Horizon Europe Springboard Scheme Funding to help UK organisations prepare competitive European research and innovation proposals. ✅ UK businesses and research organisations 💰 Up to £5,000 📅 Deadline: 2 February 2027 (rolling) 🔗 https://lnkd.in/dMmFRwY9 💜 4. Up to £5,000 – Sir Bernard & Lady Schreier Foundation Grants supporting UK charities delivering essential mental health services. ✅ UK-registered mental health charities 💰 £500–£5,000 📅 Deadline: Rolling Applications 🔗 https://lnkd.in/dHSFsXr8 ⏰ Don't miss these funding opportunities! 📢 Know someone who could benefit? Tag them below or this post! #GrantFunding#StartupFunding";

const STARTUP_SINGLE = "🚀 Up to £175,000 for UK AI Startups & SMEs – APPLY NOW! Innovate UK is offering grants of up to £175,000 through its Frontier AI: SME Champions, Phase 1 competition. 👥 Who Can Apply? ✅ UK-registered micro, small and medium-sized businesses ✅ AI and machine learning startups ✅ Companies with a clear route to commercialisation 💡 What Innovations Are Supported? 🏥 AI in Healthcare – Predictive healthcare. 🧬 Advanced Materials – AI-powered materials discovery. 💰 What's Available? 🔹 Up to £175,000 for micro and small businesses 🔹 Up to £150,000 for medium-sized businesses 🔹 £3.1 million total funding available 🔹 Up to 70% of eligible costs covered 📋 Important Requirements ✔️ Projects must have eligible costs between £150,000 and £250,000. ✔️ Applicants must apply independently. 📅 Deadline: 11 November 2026, 11am UK Time 🚨 APPLICATIONS OPEN – APPLY NOW! 🔗 https://lnkd.in/dHPYqkau 📢 Know a UK startup? Tag them below #StartupFunding";

test('Startup Networks roundup: the numbered items win over the ✅ requirement bullets (4 grants, not 8+)', () => {
  const seg = segmentPostText(STARTUP_ROUNDUP);
  assert.equal(seg.kind, 'numbered');
  assert.equal(seg.segments.length, 4);
  assert.deepEqual(seg.segments.map(s => deriveSegmentTitle(s.text)), [
    'European Prize for Women Innovators 2027',
    'Innovate UK Frontier AI: SME Champions',
    'Horizon Europe Springboard Scheme',
    'Sir Bernard & Lady Schreier Foundation',
  ]);
  assert.ok(!/Don.t miss|Know someone/.test(seg.segments[3].text));
});

test('a single-grant post full of ✅/🔹/✔️ feature bullets is NOT split (each bullet is one fact, not a grant)', () => {
  assert.equal(segmentPostText(STARTUP_SINGLE), null);
  assert.equal(splitPostIntoRecords({ ...fx.tarbell_single, post_text: STARTUP_SINGLE, external_urls: [] }).length, 1);
});

test('REGRESSION (Startup Networks, 2026-11-03): a roundup whose first item is "1. $7,800 – Name" is split by its numbering, not by the ✅ bullets', () => {
  const text = '🚨 Up to €180,000, $7,800 in Business Support! We\'ve rounded up 4 opportunities worth exploring this November! 👇 ' +
    '🚀 1. $7,800 – Sellars Company Growth Grant Free professional support for US small businesses. ✅ US-registered small businesses ✅ 12 months of contracting guidance 💰 $7,800 in services 📅 Deadline: 20 November 2026 🔗 https://lnkd.in/aaa ' +
    '🌍 2. Up to €180,000 – Irish Aid Grants 2027 Funding for global citizenship education. ✅ Irish-based charities ✅ Schools 💰 €10,000–€180,000 📅 Final application: 9 December 2026 🔗 https://lnkd.in/bbb ' +
    '🎓 3. Education Funding & Partnerships – Dubai Cares Partnership opportunities for education. ✅ Registered NGOs ✅ Projects supporting children 💰 Funding varies 📅 No fixed deadline 🔗 https://lnkd.in/ccc ' +
    '💜 4. Up to $5,000 – National Fund for Women Monthly microgrants for US individuals. ✅ US citizens aged 18+ ✅ Membership required ($15 annually) 💰 $100–$5,000 📅 Monthly deadline: 22nd 🔗 https://lnkd.in/ddd';
  const seg = segmentPostText(text);
  assert.equal(seg.kind, 'numbered');
  assert.equal(seg.segments.length, 4);
  assert.deepEqual(seg.segments.map(s => deriveSegmentTitle(s.text)), [
    'Sellars Company Growth Grant', 'Irish Aid Grants 2027', 'Education Funding & Partnerships – Dubai Cares', 'National Fund for Women']);
});

test('REGRESSION (all-sources run 2026-11-03): "Fund" inside a name is not cut as a verb; math-bold titles are normalised', () => {
  const wphf = "Women's Peace & Humanitarian Fund (WPHF) Call for Proposals For local civil society organisations supporting women's participation and leadership in climate security and climate justice initiatives. Haiti | $2.5k to $30k | Closes 26 October 2026";
  assert.equal(deriveSegmentTitle(wphf), "Women's Peace & Humanitarian Fund (WPHF) Call for Proposals");
  assert.equal(deriveSegmentTitle('Up to $5,000 – National Fund for Women Monthly microgrants supporting eligible US individuals with financial challenges and personal goals and more words to pass 100'), 'National Fund for Women');
  const bold = String.fromCodePoint(0x1d40c, 0x1d408, 0x1d413) + ' ' + String.fromCodePoint(0x1d412, 0x1d428, 0x1d425, 0x1d42f, 0x1d41e) + ' Global Health Challenge 🔗 https://lnkd.in/x';
  assert.equal(deriveSegmentTitle(bold), 'MIT Solve Global Health Challenge');
  // "X Funds early-stage ventures" still cuts at the verb
  assert.equal(deriveSegmentTitle('Acme Climate Accelerator Funds early-stage ventures building tools for coastal communities across Latin America and the Caribbean region'), 'Acme Climate Accelerator');
});
