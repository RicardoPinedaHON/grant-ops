#!/usr/bin/env node
'use strict';
/**
 * Manual check for the LinkedIn image prototype (src/scrapers/linkedin-images.js).
 * Loads ONE public company page in a browser, lists which posts carry images,
 * and optionally downloads them to output/tmp_linkedin_images/ so Claude can
 * read them. Run it from the repo root:
 *
 *   node scripts/linkedin-image-prototype.js https://www.linkedin.com/company/allyforaction/
 *   node scripts/linkedin-image-prototype.js <url> --download   # also save the files
 *   node scripts/linkedin-image-prototype.js --cleanup          # delete the temp images
 *
 * This is the step that has NOT been verified against a live LinkedIn page: if
 * it prints "0 posts with images" for a page that visibly has flyers, the DOM
 * selectors in collectImagesForSource() need adjusting.
 */
const {
  collectImagesForSource, downloadImages, cleanupImageDir, TEMP_ROOT,
} = require('../src/scrapers/linkedin-images');
const { closeBrowser } = require('../src/scrapers/playwright-base');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--cleanup')) {
    cleanupImageDir();
    console.log(`Removed ${TEMP_ROOT}`);
    return;
  }
  const url = args.find(a => /^https?:\/\//.test(a));
  if (!url) {
    console.error('Usage: node scripts/linkedin-image-prototype.js <company-url> [--download] | --cleanup');
    process.exit(1);
  }

  const picked = await collectImagesForSource(url);
  console.log(`${picked.length} posts with images on ${url}`);
  for (const p of picked) {
    console.log(`- post ${p.key || '(no urn)'} | ${p.images.length} image(s) | "${p.textHead}"`);
  }
  if (args.includes('--download')) {
    for (const p of picked) {
      const files = await downloadImages(p.images, p.key || p.textHead.slice(0, 20));
      for (const f of files) console.log(`  saved ${f}`);
    }
    console.log(`\nRead those files, then run:  node scripts/linkedin-image-prototype.js --cleanup`);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => closeBrowser().then(() => process.exit()));
