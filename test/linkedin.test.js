'use strict';
/**
 * Tests for the LinkedIn public source (src/scrapers/linkedin.js).
 *
 * Uses Node's built-in test runner (node:test) — no new dependency needed.
 * Run with: npm test
 *
 * None of these tests hit LinkedIn live. Network access is mocked at the
 * axios.get layer using sanitized fixtures captured from a real, public,
 * unauthenticated Jina Reader fetch of https://www.linkedin.com/company/onglink/
 * (see test/fixtures/). The one live end-to-end check against real LinkedIn
 * is done separately, manually, per the project's delivery notes — not here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const li = require('../src/scrapers/linkedin');
const tracker = require('../src/tracker/index');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const COMPANY_PAGE_MD = fs.readFileSync(path.join(FIXTURES_DIR, 'onglink-company-page.md'), 'utf8');
const LOGIN_WALL_MD = fs.readFileSync(path.join(FIXTURES_DIR, 'onglink-posts-loginwall.md'), 'utf8');
// A second live fetch of the SAME url a few hours later returned a
// different markup shape (richer: per-post permalink + activity ID +
// occasional reaction count, vs. the leaner shape above with none of that).
// LinkedIn's guest-view HTML is not guaranteed stable — this fixture is a
// regression test for that, found while building this module.
const COMPANY_PAGE_V2_MD = fs.readFileSync(path.join(FIXTURES_DIR, 'onglink-company-page-v2.md'), 'utf8');

const SOURCE_CFG = { name: 'ONGLink', url: 'https://www.linkedin.com/company/onglink/', enabled: true };

// ── 1. Text normalization ───────────────────────────────────────────────────

test('normalizeText: unicode-normalizes, lowercases, trims, collapses whitespace', () => {
  const input = '  Hola   Mundo\n\tCooperación  ';
  const out = li.normalizeText(input);
  assert.equal(out, 'hola mundo cooperación');
});

test('normalizeForMatch: additionally strips diacritics for keyword matching', () => {
  assert.equal(li.normalizeForMatch('Cooperación Financiación'), 'cooperacion financiacion');
});

// ── 2. Fingerprint determinism ──────────────────────────────────────────────

test('fingerprintPost: same source + same text -> same fingerprint', () => {
  const a = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Hello world');
  const b = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Hello world');
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex
});

test('fingerprintPost: is insensitive to trailing slash / case / whitespace in source', () => {
  const a = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Hello world');
  const b = li.fingerprintPost('HTTPS://WWW.LINKEDIN.COM/company/onglink', 'Hello world');
  assert.equal(a, b);
});

test('fingerprintPost: different post text -> different fingerprint', () => {
  const a = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Post A text');
  const b = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Post B text');
  assert.notEqual(a, b);
});

test('fingerprintPost: same text on a different source -> different fingerprint', () => {
  const a = li.fingerprintPost('https://www.linkedin.com/company/onglink/', 'Same text');
  const b = li.fingerprintPost('https://www.linkedin.com/company/other/', 'Same text');
  assert.notEqual(a, b);
});

test('fingerprintPost: whitespace-only differences normalize to the same fingerprint', () => {
  const a = li.fingerprintPost('https://x.com/company/foo/', 'Hello   world');
  const b = li.fingerprintPost('https://x.com/company/foo/', '  hello world  ');
  assert.equal(a, b);
});

// ── 3. Post parsing against the real fixture ────────────────────────────────

test('extractUpdates: parses all 8 posts visible on the real fixture', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.equal(posts.length, 8);
  assert.deepEqual(posts.map(p => p.published_relative), ['18m', '2h', '8h', '1d', '1d', '2d', '3d', '5d']);
});

test('extractUpdates: captures hashtags and external (non-LinkedIn) links per post', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  const reece = posts[1];
  assert.ok(reece.hashtags.includes('#ONGLink') === false); // sanity: this post's own hashtag set
  assert.ok(reece.hashtags.some(h => h.toLowerCase().includes('fondosparaong')));
  assert.ok(reece.external_urls.some(u => u.original_url.includes('lnkd.in/dwZRts2K')));
});

test('extractUpdates: returns [] when there is no "## Updates" section', () => {
  assert.deepEqual(li.extractUpdates('# Some other page\n\nNo updates here.'), []);
});

// Regression tests for the "richer" markup shape (per-post permalink with
// activity ID, occasional reaction count) — a real bug found during
// development: the parser silently returned 0 posts against this shape.
test('extractUpdates: parses the alternate ("richer") markup shape with post permalinks', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_V2_MD);
  assert.equal(posts.length, 10);
  assert.ok(posts.every(p => p.raw_text.length > 0));
});

test('extractUpdates: captures the post permalink + activity ID when the richer shape exposes them', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_V2_MD);
  assert.ok(posts[1].post_url.includes('linkedin.com/posts/'));
  assert.ok(/^\d+$/.test(posts[1].activity_id));
});

test('extractUpdates: never leaks raw markdown link/image syntax into stored post_text', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_V2_MD);
  for (const p of posts) {
    assert.doesNotMatch(p.raw_text, /!?\[[^\]]*\]\([^)]*\)/, `leaked markdown in: ${p.raw_text.slice(0, 80)}`);
  }
});

// ── 4. Opportunity classification (positive + negative fixtures) ───────────

test('classification: Reece Foundation Grant Program -> positive', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.ok(posts[1].raw_text.includes('Reece Foundation'));
  assert.equal(li.isLikelyOpportunityPost(posts[1].raw_text), true);
});

test('classification: Open Technology Fund Internet Freedom Fund -> positive', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.ok(posts[3].raw_text.includes('Open Technology Fund'));
  assert.equal(li.isLikelyOpportunityPost(posts[3].raw_text), true);
});

test('classification: training/capacitación callout -> negative', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.ok(posts[0].raw_text.includes('actividades de formación'));
  assert.equal(li.isLikelyOpportunityPost(posts[0].raw_text), false);
});

test('classification: ONGLink paid posting service ad -> negative', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.ok(posts[2].raw_text.includes('Inversión'));
  assert.equal(li.isLikelyOpportunityPost(posts[2].raw_text), false);
});

test('classification: paid fundraising course ad -> negative', () => {
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  assert.ok(posts[4].raw_text.includes('curso virtual'));
  assert.equal(li.isLikelyOpportunityPost(posts[4].raw_text), false);
});

test('classification: generic hashtags (e.g. #Cooperación) alone do not trigger a false positive', () => {
  // Regression test for a real bug found during development: hashtag noise
  // must not leak into the keyword classifier.
  assert.equal(li.isLikelyOpportunityPost('Un post cualquiera sin señales. #Cooperación #ONG #LATAM'), false);
});

test('classification: "difundir/difunde" must not false-positive on the "fund" substring', () => {
  // Regression test for a real bug found during development: plain substring
  // matching of "fund" matched inside the Spanish word "difundir".
  assert.equal(li.isLikelyOpportunityPost('Ayúdanos a difundir este mensaje a la comunidad.'), false);
});

// ── 5. Persistent post-level dedup (via src/tracker/index.js, same history.json) ──

test('isPostSeen/markPostSeen: unseen fingerprint is not seen until marked', () => {
  const history = {};
  const fp = 'abc123';
  assert.equal(tracker.isPostSeen(fp, history), false);
  tracker.markPostSeen(fp, { source_name: 'Test' }, history);
  assert.equal(tracker.isPostSeen(fp, history), true);
});

test('isPostSeen/markPostSeen: dedup survives a JSON round-trip (simulates history.json persistence)', () => {
  const history = {};
  tracker.markPostSeen('fp-x', { source_name: 'Test' }, history);
  const reloaded = JSON.parse(JSON.stringify(history));
  assert.equal(tracker.isPostSeen('fp-x', reloaded), true);
});

test('isPostSeen/markPostSeen: does not collide with grant-level history keys', () => {
  const history = { grant_123: { title: 'Some grant' }, 'fp:xyz': { title: 'Some grant' } };
  assert.equal(tracker.isPostSeen('xyz', history), false); // grant fp: namespace, not li: namespace
  tracker.markPostSeen('xyz', { source_name: 'Test' }, history);
  assert.equal(tracker.isPostSeen('xyz', history), true);
  assert.ok(history.grant_123); // untouched
});

// ── 6. fetchLinkedInSources orchestration (axios mocked — no live network) ─

function mockAxiosGetSequence(t, responses) {
  let call = 0;
  t.mock.method(axios, 'get', async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    if (r.error) throw r.error;
    return { data: r.data };
  });
}

test('fetchLinkedInSources: a failing source does not abort the others (resilience)', async (t) => {
  mockAxiosGetSequence(t, [
    { error: new Error('ECONNRESET simulated network failure') },
    { data: COMPANY_PAGE_MD },
  ]);

  const config = {
    enabled: true,
    request_delay_ms: 0,
    sources: [
      { name: 'BrokenOrg', url: 'https://www.linkedin.com/company/broken/', enabled: true },
      { name: 'ONGLink', url: 'https://www.linkedin.com/company/onglink/', enabled: true },
    ],
  };
  const history = {};
  const { grants, metrics } = await li.fetchLinkedInSources(config, history);

  assert.equal(metrics.sourcesConfigured, 2);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.successful, 1);
  assert.ok(grants.length > 0);
  assert.ok(grants.every(g => g.source === 'LinkedIn: ONGLink'));
});

test('fetchLinkedInSources: a login-wall response is treated as a failure, not zero posts', async (t) => {
  mockAxiosGetSequence(t, [{ data: LOGIN_WALL_MD }]);

  const config = {
    enabled: true,
    request_delay_ms: 0,
    sources: [{ name: 'ONGLink', url: 'https://www.linkedin.com/company/onglink/posts/', enabled: true }],
  };
  const { grants, metrics } = await li.fetchLinkedInSources(config, {});

  assert.equal(metrics.failed, 1);
  assert.equal(metrics.successful, 0);
  assert.equal(grants.length, 0);
});

test('fetchLinkedInSources: disabled config returns empty result without making any request', async (t) => {
  let called = false;
  t.mock.method(axios, 'get', async () => { called = true; return { data: '' }; });

  const { grants, metrics } = await li.fetchLinkedInSources({ enabled: false, sources: [SOURCE_CFG] }, {});
  assert.equal(called, false);
  assert.equal(grants.length, 0);
  assert.equal(metrics.sourcesConfigured, 0);
});

// ── 7. THE critical acceptance test: persistent dedup across two runs ──────
// Mirrors the exact scenario from the spec: run 1 sees A..H (8 posts) and
// processes all of them; run 2 sees the SAME page (nothing new published)
// and must report 0 new posts, 8 already-seen, and create zero duplicate
// opportunities — proving dedup persists via the shared history object
// (the same one scan.js loads/saves as history.json).

test('fetchLinkedInSources: second run against an unchanged page yields zero new posts and zero duplicate opportunities', async (t) => {
  t.mock.method(axios, 'get', async () => ({ data: COMPANY_PAGE_MD }));

  const config = {
    enabled: true,
    request_delay_ms: 0,
    sources: [SOURCE_CFG],
  };
  const history = {}; // shared across both "runs", exactly like scan.js's loadHistory()/saveHistory()

  const run1 = await li.fetchLinkedInSources(config, history);
  assert.equal(run1.metrics.postsFetched, 8);
  assert.equal(run1.metrics.newPosts, 8);
  assert.equal(run1.metrics.alreadySeen, 0);
  assert.equal(run1.metrics.opportunitiesDetected, 5); // Reece, OTF, Cosecha Colectiva, WFP, Progettomondo
  const firstRunOpportunityCount = run1.grants.length;

  const run2 = await li.fetchLinkedInSources(config, history); // same history object, simulating persistence
  assert.equal(run2.metrics.postsFetched, 8);
  assert.equal(run2.metrics.newPosts, 0, 'no post should be re-processed as new');
  assert.equal(run2.metrics.alreadySeen, 8, 'all 8 posts should be recognized as already seen');
  assert.equal(run2.metrics.opportunitiesDetected, 0, 'no duplicate opportunities should be created');
  assert.equal(run2.grants.length, 0);
  assert.ok(firstRunOpportunityCount > 0);
});

test('fetchLinkedInSources: only genuinely new posts are processed when some posts persist across runs (F,G,A,B,C,D,E scenario)', async (t) => {
  // Run 1: page shows posts A-E (using 5 posts sliced from the fixture).
  const posts = li.extractUpdates(COMPANY_PAGE_MD);
  const fivePosts = posts.slice(0, 5); // A..E
  const sevenPosts = [posts[5], posts[6], ...fivePosts]; // F, G, A, B, C, D, E (F/G new, rest repeated)

  function markdownFromPosts(selected) {
    // Rebuild a minimal "## Updates" section from selected raw posts so
    // extractUpdates() can re-parse them deterministically for this test.
    const body = selected.map(p => {
      const tagLinks = p.hashtags.map(h => `[${h}](https://www.linkedin.com/signup/cold-join?session_redirect=x)`).join('');
      return `*   [](https://bo.linkedin.com/company/onglink)3,441 followers\n\n${p.published_relative}  ${p.raw_text.replace(/#\S+/g, '')}${tagLinks}`;
    }).join('\n');
    return `Title: ONGLink | LinkedIn\n\nMarkdown Content:\n## Updates\n\n${body}\n\n## Join now\n`;
  }

  let call = 0;
  const responses = [markdownFromPosts(fivePosts), markdownFromPosts(sevenPosts)];
  t.mock.method(axios, 'get', async () => ({ data: responses[call++] }));

  const config = { enabled: true, request_delay_ms: 0, sources: [SOURCE_CFG] };
  const history = {};

  const run1 = await li.fetchLinkedInSources(config, history);
  assert.equal(run1.metrics.newPosts, 5);
  assert.equal(run1.metrics.alreadySeen, 0);

  const run2 = await li.fetchLinkedInSources(config, history);
  assert.equal(run2.metrics.newPosts, 2, 'only F and G should be processed as new');
  assert.equal(run2.metrics.alreadySeen, 5, 'A-E should be skipped as already seen');
});

// ── 8. Amount / deadline extraction sanity (best-effort heuristics) ────────

test('extractAmountRange: parses a "Hasta AU$X" ceiling amount', () => {
  const { amount_min, amount_max, currency } = li.extractAmountRange('Financiamiento: Hasta AU$30.000 por proyecto');
  assert.equal(amount_max, 30000);
  assert.equal(amount_min, null);
  assert.equal(currency, 'AUD');
});

test('extractAmountRange: parses an "Entre X y Y" range', () => {
  const { amount_min, amount_max, currency } = li.extractAmountRange('Entre USD 10.000 y USD 900.000 por proyecto');
  assert.equal(amount_min, 10000);
  assert.equal(amount_max, 900000);
  assert.equal(currency, 'USD');
});

test('extractDeadline: recognizes rolling/permanent calls', () => {
  assert.deepEqual(li.extractDeadline('Convocatoria abierta de forma permanente (Rolling Basis).'), {
    deadline: 'rolling', deadline_type: 'rolling',
  });
});

test('extractDeadline: recognizes a Spanish full date', () => {
  const { deadline, deadline_type } = li.extractDeadline('Fecha límite: 7 de agosto de 2026, hasta las 18:00.');
  assert.equal(deadline, '2026-08-07');
  assert.equal(deadline_type, 'fixed');
});

// ── 9. Login-wall detection ─────────────────────────────────────────────────

test('isLoginWall: detects the real login-wall fixture', () => {
  assert.equal(li.isLoginWall(LOGIN_WALL_MD), true);
});

test('isLoginWall: does not flag the real company-page fixture', () => {
  assert.equal(li.isLoginWall(COMPANY_PAGE_MD), false);
});
