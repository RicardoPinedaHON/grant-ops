#!/usr/bin/env node
'use strict';
/**
 * Read-only audit: which of the grants extracted from LinkedIn are REPEATS?
 *
 *   node scripts/audit-linkedin-repeats.js                    all configured sources
 *   node scripts/audit-linkedin-repeats.js "Startup" "HOST"   only sources whose name contains one of these
 *   node scripts/audit-linkedin-repeats.js --embeddings       also list NEW records that look like a Notion page
 *                                                              or another new record (local embedding server;
 *                                                              prototype, see src/utils/embedding-match.js)
 *
 * Fetches the live pages with an EMPTY history (so nothing is skipped as "seen"),
 * splits posts into grants exactly like scan.js does, then classifies each:
 *   - repeat in this run   same grant listed again in another post (deduplicateGrants)
 *   - known in history     scan.js would skip it (isKnown: id / fingerprint alias)
 *   - already in Notion    a page for it exists (grantsMatch on title/url, as notion-sync does)
 *   - new                  would be scored
 * Writes nothing: not history.json, not Notion, not output/.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const { fetchLinkedInSources } = require('../src/scrapers/linkedin');
const { deduplicateGrants } = require('../src/scrapers/index');
const { closeBrowser } = require('../src/scrapers/playwright-base');
const { loadHistory, isKnown } = require('../src/tracker/index');
const { grantsMatch } = require('../src/utils/grant-fingerprint');
const { findCandidates, cleanTitle } = require('../src/utils/embedding-match');

async function notionPages() {
  const { notionRequest } = require('../src/notion-client');
  const dbId = process.env.NOTION_DB_ID;
  if (!dbId) return null;
  const pages = [];
  let cursor;
  do {
    const res = await notionRequest('POST', `databases/${dbId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of res.results || []) {
      pages.push({
        title: p.properties?.Name?.title?.[0]?.plain_text || '',
        url: p.properties?.URL?.url || '',
        tier: p.properties?.Tier?.select?.name || '',
        scan: p.properties?.['Scan Date']?.date?.start || '',
      });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages;
}

async function main() {
  const args = process.argv.slice(2);
  const useEmbeddings = args.includes('--embeddings');
  const filters = args.filter(a => !a.startsWith('--')).map(s => s.toLowerCase());
  const cfg = yaml.parse(fs.readFileSync(path.join(ROOT, 'config', 'sources.yaml'), 'utf8')).linkedin;
  const sources = (cfg.sources || []).filter(s => s.enabled !== false)
    .filter(s => !filters.length || filters.some(f => s.name.toLowerCase().includes(f)));
  console.log(`Auditing ${sources.length} LinkedIn source(s): ${sources.map(s => s.name).join(', ')}\n`);

  const { grants } = await fetchLinkedInSources({ ...cfg, request_delay_ms: 1500, images: { enabled: false }, sources }, {});
  await closeBrowser();

  // 1. repeats inside this run (same grant in a roundup AND its own post, or in two weekly bulletins)
  const unique = [];
  const rows = [];
  for (const g of grants) {
    const dupOf = unique.find(u => grantsMatch(g, u));
    if (dupOf) rows.push({ g, status: 'repeat in this run', of: dupOf.title });
    else { unique.push(g); rows.push({ g, status: null }); }
  }

  // 2 + 3. against history.json and Notion
  const history = loadHistory();
  const pages = await notionPages().catch(err => { console.warn(`(Notion not read: ${err.message})`); return null; });
  for (const row of rows) {
    if (row.status) continue;
    if (isKnown(row.g, history)) { row.status = 'known in history'; continue; }
    const page = pages && pages.find(p => grantsMatch(row.g, { title: p.title, url: p.url }));
    if (page) { row.status = 'already in Notion'; row.of = `${page.title} [${page.tier || '?'}${page.scan ? ', scanned ' + page.scan : ''}]`; continue; }
    row.status = 'NEW';
  }

  if (useEmbeddings) {
    const fresh = rows.filter(r => r.status === 'NEW').map(r => ({ ...r.g, title: cleanTitle(r.g.title) }));
    const known = (pages || []).map(p => ({ ...p, title: cleanTitle(p.title) }));
    const vsNotion = fresh.length && known.length ? await findCandidates(fresh, known) : [];
    const vsEachOther = fresh.length > 1 ? await findCandidates(fresh) : [];
    if (vsNotion === null || vsEachOther === null) console.log('\n(embedding server unreachable: http://127.0.0.1:18081)');
    else {
      console.log(`\nPossible repeats by embedding (rules did not match; review by hand): ${vsNotion.length + vsEachOther.length}`);
      for (const f of vsNotion) console.log(`  ${f.score.toFixed(3)} [${f.why.join('; ')}] "${f.a.title.slice(0, 50)}" ~ Notion "${f.b.title.slice(0, 50)}"`);
      for (const f of vsEachOther) console.log(`  ${f.score.toFixed(3)} [${f.why.join('; ')}] "${f.a.title.slice(0, 50)}" ~ new "${f.b.title.slice(0, 50)}"`);
    }
  }

  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  for (const { g, status, of } of rows) {
    console.log(`${pad(status, 19)} ${pad(g.source.replace('LinkedIn: ', ''), 18)} ${pad(g.title, 58)}${of ? '  ≈ ' + of.slice(0, 70) : ''}`);
  }
  const count = s => rows.filter(r => r.status === s).length;
  console.log(`\n${rows.length} grant records from ${sources.length} source(s):`);
  console.log(`  repeat in this run : ${count('repeat in this run')}`);
  console.log(`  known in history   : ${count('known in history')}`);
  console.log(`  already in Notion  : ${count('already in Notion')}${pages ? '' : ' (Notion not checked)'}`);
  console.log(`  NEW                : ${count('NEW')}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
