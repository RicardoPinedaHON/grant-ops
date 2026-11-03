#!/usr/bin/env node
'use strict';
/**
 * Read-only: pairs of Notion pages that look like the same grant but that
 * grantsMatch() does NOT treat as one (candidates for a manual merge, and for
 * new matching rules). Uses the local embedding server (Hugo's llama.cpp,
 * 127.0.0.1:18081) plus the vetoes and second signals in src/utils/embedding-match.js.
 *
 *   node scripts/audit-embedding-candidates.js            print the pairs
 *   node scripts/audit-embedding-candidates.js --write    also save output/embedding_candidates.json
 *                                                          (advisory file for the pipeline; always exits 0,
 *                                                          writes nothing when Notion or the server is unreachable)
 *
 * Also lists pages whose title carries scraper junk (line separators, mojibake).
 * Writes nothing: not Notion, not history.json, not output/.
 */
const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { notionRequest } = require('../src/notion-client');
const { findCandidates, cleanTitle } = require('../src/utils/embedding-match');

async function notionPages() {
  const dbId = process.env.NOTION_DB_ID;
  if (!dbId) throw new Error('NOTION_DB_ID is not set');
  const pages = [];
  let cursor;
  do {
    const res = await notionRequest('POST', `databases/${dbId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of res.results || []) {
      pages.push({
        title: p.properties?.Name?.title?.[0]?.plain_text || '',
        url: p.properties?.URL?.url || '',
        tier: p.properties?.Tier?.select?.name || '',
        id: p.id,
      });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages.filter(p => p.title);
}

async function main() {
  const pages = await notionPages();
  console.log(`${pages.length} Notion pages\n`);

  const junk = pages.filter(p => cleanTitle(p.title) !== p.title.normalize('NFKC').replace(/\s+/g, ' ').trim());
  console.log(`Titles with scraper junk: ${junk.length}`);
  for (const p of junk) console.log(`  ${JSON.stringify(p.title.slice(0, 70))}  ->  ${JSON.stringify(cleanTitle(p.title).slice(0, 70))}`);

  const found = await findCandidates(pages.map(p => ({ ...p, title: cleanTitle(p.title) })));
  if (!found) { console.log(`\nEmbedding server unreachable (${process.env.EMBED_URL || 'http://127.0.0.1:18081'}). Nothing compared.`); return; }

  if (process.argv.includes('--write')) {
    const file = path.join('output', 'embedding_candidates.json');
    const slim = x => ({ id: x.id, title: x.title, url: x.url, tier: x.tier });
    fs.writeFileSync(file, JSON.stringify({
      generated_at: new Date().toISOString(),
      pages: pages.length,
      note: 'Advisory only: pairs the rules did not match. Nothing was merged or changed.',
      candidates: found.map(f => ({ score: Number(f.score.toFixed(3)), why: f.why, a: slim(f.a), b: slim(f.b) })),
    }, null, 2));
    console.log(`Wrote ${file} (${found.length} candidates)`);
  }

  console.log(`\nPossible repeats the rules do not catch: ${found.length}`);
  for (const f of found) {
    const host = u => (u || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || '(no url)';
    console.log(`${f.score.toFixed(3)} [${f.why.join('; ')}]`);
    console.log(`   ${f.a.title.slice(0, 70)}  <${f.a.tier || '?'}, ${host(f.a.url)}>`);
    console.log(`   ${f.b.title.slice(0, 70)}  <${f.b.tier || '?'}, ${host(f.b.url)}>`);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`embedding audit skipped: ${err && err.message ? err.message : err}`);
  process.exit(process.argv.includes('--write') ? 0 : 1);   // advisory step: never fail a pipeline run
});
