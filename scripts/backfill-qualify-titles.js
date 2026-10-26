'use strict';
/**
 * One-off backfill (Ricardo, 2026-10-26): give already-synced Notion pages
 * the same funder-qualified titles that new grants now get from
 * applyExtractionCorrections() (src/utils/title-naming.js).
 *
 *   node scripts/backfill-qualify-titles.js            # dry run, prints the plan
 *   node scripts/backfill-qualify-titles.js --apply    # PATCH the page titles
 *
 * Every applied rename is appended to output/title_renames.json with the old
 * title, so any of them can be reverted by hand. Only the Name property is
 * touched — the Fingerprint property (the page's dedup identity) is not.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { notionRequest } = require('../src/notion-client');
const { qualifyTitle } = require('../src/utils/title-naming');

const APPLY = process.argv.includes('--apply');
const LOG = path.join(ROOT, 'output', 'title_renames.json');

// Titles checked by hand where the stored Funder is really the program/channel.
const LEAVE_AS_IS = new Set(['Ventra Capital']);

const txt = (p, k) => (p.properties[k]?.rich_text || []).map(t => t.plain_text).join('');

async function fetchAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const r = await notionRequest('POST', `databases/${dbId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    if (!r.results) throw new Error(JSON.stringify(r).slice(0, 300));
    rows.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return rows;
}

(async () => {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const dbId = /NOTION_DB_ID=(.*)/.exec(env)[1].trim();
  const plan = [];
  for (const p of await fetchAll(dbId)) {
    const old = (p.properties.Name?.title || []).map(t => t.plain_text).join('');
    if (LEAVE_AS_IS.has(old.trim())) continue;
    const next = qualifyTitle(old.trim(), txt(p, 'Funder'), txt(p, 'Source'));
    if (next && next !== old.trim()) plan.push({ id: p.id, oldTitle: old, newTitle: next });
  }
  console.log(`${plan.length} rename(s) ${APPLY ? 'to apply' : '(dry run)'}:`);
  for (const x of plan) console.log(`  "${x.oldTitle.trim()}"  ->  "${x.newTitle}"`);
  if (!APPLY) return;

  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
  for (const x of plan) {
    const res = await notionRequest('PATCH', `pages/${x.id}`, {
      properties: { Name: { title: [{ text: { content: x.newTitle.slice(0, 200) } }] } },
    });
    const ok = !!res.id;
    if (!ok) console.error(`  ✗ ${x.oldTitle}: ${res.message || 'unknown error'}`);
    log.push({ ...x, appliedAt: new Date().toISOString(), notionResult: ok ? 'patched' : 'failed' });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log(`Done. Log: output/title_renames.json`);
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
