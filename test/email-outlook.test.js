'use strict';
/**
 * Tests for the Outlook email source (src/scrapers/email-outlook.js),
 * specifically parseFundingForwardBlocks() — the parser added 2026-08-12
 * after discovering the "Funding Forward" (ffwd.org) newsletter, the only
 * sender ever seen in the "Grant Newsletters" folder, had produced ZERO
 * grants across every scheduled run since setup. Root cause: its HubSpot
 * template doesn't match the "Deadline: X | Funding: Y" field-label shape
 * parseGrantBlocks() expects (that shape fits ImpactShip/Terra Viva, not
 * this sender) — see git log for the incident.
 *
 * Uses Node's built-in test runner (node:test) — no new dependency needed.
 * Run with: npm test
 *
 * Fixture is the plain-text result of htmlToText() on a real "Funding
 * Forward" newsletter body (test/fixtures/funding-forward-sample.txt) —
 * captured live via Microsoft Graph, HTML boilerplate/styles stripped,
 * sender/subject are public marketing content with no PII.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseFundingForwardBlocks, isFundingForwardSender, parseGrantBlocks } = require('../src/scrapers/email-outlook');

const SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'funding-forward-sample.txt'),
  'utf8'
);
const EMAIL_DATE = '2026-08-08T13:01:14Z';

// Excerpt of a real ImpactShip newsletter (2026-06-24) — kept because it
// exposed two real bugs in the pre-existing parseGrantBlocks() Format-A path
// (this parser predates this fix, so these are regression tests, not new
// coverage for new code): a title glued onto its first field on the same
// line ("2027 RISK Award – ... Funding: ...") caused the backward
// title-search to borrow an unrelated preceding title instead, which BOTH
// dropped the RISK Award grant AND created a phantom duplicate of whatever
// title it borrowed; and guessFunder() ignored the "Title – Funder" dash
// convention entirely, picking words out of the title instead.
const IMPACTSHIP_SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'impactship-sample.txt'),
  'utf8'
);
const IMPACTSHIP_DATE = '2026-06-24T15:51:53Z';

test('isFundingForwardSender: recognizes the ffwd.org sender by name or address', () => {
  assert.equal(isFundingForwardSender('hello@ffwd.org'), true);
  assert.equal(isFundingForwardSender('Fast Forward'), true);
  assert.equal(isFundingForwardSender('Terra Viva Grants'), false);
  assert.equal(isFundingForwardSender(undefined), false);
});

test('parseFundingForwardBlocks: extracts every grant-shaped entry from a real newsletter, not zero', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  // 7 in the main list + 3 unique upcoming-deadline entries + 1 event = 11.
  // The old parser (built for ImpactShip/Terra Viva field labels) got 0.
  assert.equal(grants.length, 11);
});

test('parseFundingForwardBlocks: splits "Funder: Title: description" into separate fields', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const stanley = grants.find(g => g.funder === 'Stanley 1913');
  assert.ok(stanley);
  assert.equal(stanley.title, 'Creators Fund');
  assert.equal(stanley.deadline, '2026-09-13');
  assert.equal(stanley.amount_max, 50000);
});

test('parseFundingForwardBlocks: falls back to funder-as-title when there is no separate title segment', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const kellogg = grants.find(g => g.funder === 'W.K. Kellogg Foundation');
  assert.ok(kellogg);
  assert.equal(kellogg.title, 'W.K. Kellogg Foundation');
  assert.equal(kellogg.deadline, 'rolling');
});

test('parseFundingForwardBlocks: does not mistake applicant-eligibility budget figures for the award amount', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const thirdPlateau = grants.find(g => g.funder === 'Third Plateau');
  assert.ok(thirdPlateau);
  // Description says "annual budgets between $750K and $3M" (eligibility,
  // not an award) and states no actual grant amount — must stay null, not
  // pick up $750K/$3M.
  assert.equal(thirdPlateau.amount_min, null);
  assert.equal(thirdPlateau.amount_max, null);
});

test('parseFundingForwardBlocks: does not bleed one entry\'s dollar figures into an adjacent entry', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const gitlab = grants.find(g => g.funder === 'GitLab Foundation');
  const civicHealth = grants.find(g => g.funder === 'Civic Health Project AI for Civic Cohesion Fellowship');
  assert.ok(gitlab);
  assert.ok(civicHealth);
  assert.equal(gitlab.amount_max, 500000);
  assert.equal(civicHealth.amount_max, 10000);
});

test('parseFundingForwardBlocks: deadlines in the "UPCOMING DEADLINES" section parse despite the "Apply by <date> - " prefix before the bracket', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const gitlab = grants.find(g => g.funder === 'GitLab Foundation');
  assert.equal(gitlab.deadline, '2026-08-12');
});

test('parseFundingForwardBlocks: maps region tags to a country/geography field', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const stanley = grants.find(g => g.funder === 'Stanley 1913');
  const belfer = grants.find(g => g.funder === '92NY Belfer Center');
  assert.equal(stanley.country, 'Global');
  assert.equal(belfer.country, 'United States');
});

test('parseFundingForwardBlocks: excludes footer/shoutout boilerplate from the trailing entry\'s description', () => {
  const grants = parseFundingForwardBlocks(SAMPLE, 'Email: Fast Forward', EMAIL_DATE);
  const googleEvent = grants.find(g => g.funder === 'Google.org DC Changemakers Forum');
  assert.ok(googleEvent);
  assert.ok(!googleEvent.description.includes('TECH NONPROFIT SHOUTOUTS'));
  assert.ok(!googleEvent.description.includes('Mobile Pathways'));
});

test('parseGrantBlocks: guessFunder() prefers the "Title – Funder" dash suffix over keyword-guessing from the title', () => {
  const grants = parseGrantBlocks(IMPACTSHIP_SAMPLE, 'Email: ImpactShip', IMPACTSHIP_DATE);
  const charlesHayward = grants.find(g => g.title.startsWith('Social & Criminal Justice'));
  const netZero = grants.find(g => g.title.startsWith('CliFi Story Grant'));
  const thirdWave = grants.find(g => g.title.startsWith('Mobilize Power Fund'));
  assert.equal(charlesHayward.funder, 'Charles Hayward Foundation');
  assert.equal(netZero.funder, 'Net Zero Institute');
  assert.equal(thirdWave.funder, 'Third Wave Fund');
});

test('parseGrantBlocks: a title glued onto its first field on the same line is still recognized, not dropped', () => {
  const grants = parseGrantBlocks(IMPACTSHIP_SAMPLE, 'Email: ImpactShip', IMPACTSHIP_DATE);
  const riskAward = grants.find(g => g.title.startsWith('2027 RISK Award'));
  assert.ok(riskAward, 'RISK Award entry must not be dropped');
  assert.equal(riskAward.deadline, '2026-07-31');
  assert.equal(riskAward.amount_max, 100000);
});

test('parseGrantBlocks: an inline-titled entry does not create a phantom duplicate of the preceding title', () => {
  const grants = parseGrantBlocks(IMPACTSHIP_SAMPLE, 'Email: ImpactShip', IMPACTSHIP_DATE);
  const socialShifters = grants.filter(g => g.title.startsWith('Social Shifters'));
  assert.equal(socialShifters.length, 1);
  assert.equal(socialShifters[0].deadline, '2026-08-31');
});
