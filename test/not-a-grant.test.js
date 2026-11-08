const test = require('node:test');
const assert = require('node:assert/strict');
const { prescoreGrant } = require('../src/scorer/rules');
const { combineScores } = require('../src/scorer/index');

const profile = { organization: { name: 'x' }, mission: { projects: [] }, geography: {} };
const flagsFor = title => {
  try { return prescoreGrant({ title, description: '', source: 'LinkedIn: x' }, profile).flags; }
  catch { return null; }
};

test('rules: thank-you posts, subscription ads and paid courses are NOT_A_GRANT', () => {
  for (const t of [
    'Thank you to everyone who joined our funding workshop',
    'ONGLink Latinoamérica — Premium subscription announcement',
    'Fundraising strategy course 2027',
    'Gracias por participar en nuestro taller de fondos',
    'Funds4impact Matchmaking Webinar — Better Politics Foundation Resilient Futures Call 2027',
    'HOST Fundraising Resource Directory',
    'UNFPA Global Internship',
    'Innpactia — CEO panel (not a grant)',
    'Turn.io Learning Sessions',
  ]) assert.deepEqual(flagsFor(t), ['NOT_A_GRANT'], t);
});

test('rules: real grants are not caught by NOT_A_GRANT', () => {
  for (const t of ['Youth Climate Fund 2026', 'Better Politics Fund — Resilient Futures Call', 'European Open Rivers Programme Project Grants', 'Resilience Fund for Women', 'Small Grants Programme']) {
    assert.ok(!(flagsFor(t) || []).includes('NOT_A_GRANT'), t);
  }
});

test('combineScores: _not_a_grant is carried through, absent otherwise', () => {
  const prescore = { prescore: 1, flags: [], daysRemaining: null, scores: {} };
  assert.equal(combineScores(prescore, { _ineligible: true, _not_a_grant: true }).not_a_grant, true);
  assert.equal(combineScores(prescore, { _ineligible: true }).not_a_grant, false);
});
