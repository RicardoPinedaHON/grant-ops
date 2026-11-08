const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('yaml');
const fs = require('fs');
const { buildReport, toMarkdown, toWhatsApp } = require('../scripts/run-report');
const { buildRegistry } = require('../config/source-registry');

const registry = [
  { name: 'WePropel', group: 'portals', sources: ['WePropel'], urls: ['https://www.wepropel.org/oportunidades'] },
  { name: 'LinkedIn: ONGLink', group: 'linkedin', sources: ['LinkedIn: ONGLink'], urls: ['https://www.linkedin.com/company/onglink/'], linkedinKey: 'ONGLink' },
  { name: 'MIT Solve', group: 'new-sources', sources: ['MIT Solve'], urls: ['https://solve.mit.edu/challenges'] },
];
const now = new Date('2026-11-09T11:30:00Z');
const base = () => ({
  ran_at: '2026-11-09T11:20:00Z',
  groups: { portals: { ok: true, count: 5 }, 'new-sources': { ok: true, count: 1 }, linkedin: { ok: true, count: 2 } },
  linkedin: { ONGLink: { ok: true, posts_visible: 8, new_posts: 3, already_seen: 5, opportunities: 2 } },
  by_source: { WePropel: { raw: 5, repeats: 2, queued: 3 }, 'MIT Solve': { raw: 1, repeats: 1, queued: 0 } },
  totals: { fetched: 6, already_seen: 3, new: 3, queued: 3 },
});

test('healthy run is ok and lists every source with its link', () => {
  const rep = buildReport({ status: base(), registry, now });
  assert.equal(rep.overall, 'ok');
  assert.equal(rep.sources.length, 3);
  assert.match(toMarkdown(rep), /\[link\]\(https:\/\/www\.wepropel\.org\/oportunidades\)/);
  assert.match(toWhatsApp(rep), /exitosa/);
});

test('a failed LinkedIn page and a failed group make the run partial with named problems', () => {
  const s = base();
  s.linkedin.ONGLink = { ok: false, error: 'login wall' };
  s.groups.portals = { ok: false, error: 'timeout' };
  const rep = buildReport({ status: s, registry, now });
  assert.equal(rep.overall, 'partial');
  assert.ok(rep.problems.some(p => /ONGLink.*login wall/.test(p)));
  assert.ok(rep.problems.some(p => /WePropel.*timeout/.test(p)));
});

test('a source that gave results last run and 0 now is flagged', () => {
  const s = base();
  s.by_source['MIT Solve'] = { raw: 0, repeats: 0, queued: 0 };
  const rep = buildReport({ status: s, registry, history: [{ counts: { 'MIT Solve': 1 } }], now });
  assert.ok(rep.problems.some(p => /MIT Solve.*0 resultados/.test(p)));
});

test('no source_status.json means failed, not a crash', () => {
  const rep = buildReport({ status: null, registry, now });
  assert.equal(rep.overall, 'failed');
  assert.match(toWhatsApp(rep), /fallida/);
});

test('every enabled LinkedIn and RSS source in sources.yaml is in the registry', () => {
  const cfg = yaml.parse(fs.readFileSync('config/sources.yaml', 'utf8'));
  const reg = buildRegistry(cfg);
  for (const s of cfg.linkedin.sources.filter(x => x.enabled !== false)) assert.ok(reg.some(r => r.linkedinKey === s.name), s.name);
  for (const s of cfg.rss.filter(x => x.enabled)) assert.ok(reg.some(r => r.name === s.name), s.name);
});
