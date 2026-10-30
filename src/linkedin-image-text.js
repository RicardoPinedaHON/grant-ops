#!/usr/bin/env node
'use strict';
/**
 * linkedin-image-text.js — pipeline step 1a-2: read the text of LinkedIn post
 * images, then fold the grants they list into this run's scoring batch.
 *
 *   node src/linkedin-image-text.js            list the images Claude must read
 *   node src/linkedin-image-text.js --apply    merge the transcriptions, re-split
 *                                              posts into grants, delete the images
 *
 * Runs between scan.js and score-with-claude.js. scan.js (with
 * linkedin.images.enabled: true) downloads each image post's pictures to
 * output/tmp_linkedin_images/ and queues the post in
 * output/linkedin_images_pending.json. A Claude Code session then Reads each
 * image file and writes output/linkedin_image_text.json as { "<key>": "text" }.
 * No OCR dependency and no API key — same "Claude reads it" contract as scoring.
 *
 * --apply never loses anything: a post whose image had no readable/funding text
 * keeps its caption-only record from scan.js; only posts whose merged text gives
 * a different set of grants get their record(s) replaced.
 */

const fs = require('fs');
const path = require('path');

const MARKER = '=== LINKEDIN_IMAGE_TARGETS_JSON ===';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function paths(cwd = process.cwd()) {
  const out = path.join(cwd, 'output');
  return {
    pending: path.join(out, 'linkedin_images_pending.json'),
    text: path.join(out, 'linkedin_image_text.json'),
    prescored: path.join(out, 'grants_prescored.json'),
  };
}

function listTargets(pending) {
  return pending.map(p => ({ key: p.key, source: p.source_name, caption: p.caption, files: p.files }));
}

/**
 * Pure core of --apply (everything external is injected, so it is unit-tested).
 *   pending      queue written by scan.js
 *   texts        { key: transcribed text }
 *   prescored    current grants_prescored.json items [{ grant, prescore, claude_prompt }]
 *   deps.split / deps.resolveLinks / deps.isOpportunity / deps.buildPrompt
 *   deps.isKnown / deps.markSeen   history helpers (already bound to history)
 * Returns { prescored, added, replaced, skipped }.
 */
async function applyImageText({ pending, texts, prescored, deps }) {
  const { mergeImageTextIntoPost } = require('./scrapers/linkedin-images');
  let items = [...prescored];
  const stats = { added: 0, replaced: 0, skipped: 0 };

  for (const entry of pending) {
    const text = (texts[entry.key] || '').trim();
    if (!text) { stats.skipped++; continue; }

    const merged = mergeImageTextIntoPost(entry.post, text);
    if (!deps.isOpportunity(merged.post_text)) { stats.skipped++; continue; }

    merged.external_urls = await deps.resolveLinks(merged.external_urls || []);
    const records = deps.split(merged);

    // Replace the caption-only record(s) scan.js already queued for this post.
    const fp = entry.post.fingerprint;
    const before = items.length;
    const removedIds = new Set();
    items = items.filter(it => {
      const same = it.grant && it.grant._linkedin && it.grant._linkedin.fingerprint === fp;
      if (same) removedIds.add(it.grant.id);
      return !same;
    });
    stats.replaced += before - items.length;

    for (const record of records) {
      record._from_image_text = true;
      if (!removedIds.has(record.id) && deps.isKnown(record)) continue;
      const result = deps.buildPrompt(record);
      if (!result) continue; // pre-filter says not worth scoring (geo/expired/news/low)
      items.push({ grant: record, prescore: result.prescore, claude_prompt: result.prompt });
      deps.markSeen(record);
      stats.added++;
    }
  }
  return { prescored: items, ...stats };
}

async function main() {
  const p = paths();
  const pending = readJson(p.pending, []);

  if (!process.argv.includes('--apply')) {
    if (!pending.length) {
      console.log('No LinkedIn image posts to read this run.');
      return;
    }
    console.log(`${pending.length} LinkedIn post(s) have images to read.\n`);
    console.log('For EACH post: use the Read tool on every file listed, then write');
    console.log('output/linkedin_image_text.json as { "<key>": "<text>" }.');
    console.log('Transcribe every visible grant name, funder, amount, deadline, eligibility and URL');
    console.log('verbatim — do not infer or add anything. Use "" if an image has no text about funding.\n');
    console.log(MARKER);
    console.log(JSON.stringify(listTargets(pending), null, 2));
    return;
  }

  const yaml = require('yaml');
  const profile = yaml.parse(fs.readFileSync(path.join(process.cwd(), 'org-profile.yaml'), 'utf8'));
  const { splitPostIntoRecords, resolveExternalLinks, isLikelyOpportunityPost } = require('./scrapers/linkedin');
  const { buildPromptForClaude } = require('./scorer/index');
  const { loadHistory, saveHistory, isKnown, markSeen } = require('./tracker/index');
  const { cleanupImageDir } = require('./scrapers/linkedin-images');

  const texts = readJson(p.text, {});
  const history = loadHistory();
  const prescored = readJson(p.prescored, []);

  const result = await applyImageText({
    pending, texts, prescored,
    deps: {
      split: splitPostIntoRecords,
      resolveLinks: resolveExternalLinks,
      isOpportunity: isLikelyOpportunityPost,
      buildPrompt: g => buildPromptForClaude(g, profile),
      isKnown: g => isKnown(g, history),
      markSeen: g => markSeen(g, history),
    },
  });

  fs.writeFileSync(p.prescored, JSON.stringify(result.prescored, null, 2));
  saveHistory(history);
  cleanupImageDir();
  fs.writeFileSync(p.pending, '[]');
  if (fs.existsSync(p.text)) fs.unlinkSync(p.text);

  console.log(`Image text applied: ${result.added} grant(s) added, ${result.replaced} caption-only record(s) replaced, ${result.skipped} post(s) with nothing to add. Temp images deleted.`);
  const { closeBrowser } = require('./scrapers/playwright-base');
  await closeBrowser();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { applyImageText, listTargets, MARKER };
