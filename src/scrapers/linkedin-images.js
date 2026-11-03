'use strict';
/**
 * linkedin-images.js — PROTOTYPE: recover the grants that LinkedIn posts only
 * show inside an image (flyers, carousels, "5 convocatorias de la semana"
 * graphics).
 *
 * Why: the Jina Reader guest view returns images as "Image N: No alternative
 * text description" pointing at the company page, so the text on a flyer never
 * reaches the pipeline (and linkedin.js strips those lines as boilerplate).
 * Real image URLs only exist in the rendered DOM (media.licdn.com/dms/image/...).
 *
 * Flow (no API key, no OCR dependency — Claude reads the images itself):
 *   1. collectImagesForSource()  Playwright loads the PUBLIC company page, maps
 *                                post -> image URLs (by activity URN, else by
 *                                the post's opening text).
 *   2. downloadImages()          saves them under output/tmp_linkedin_images/<id>/
 *   3. (Claude Code session)     Reads each file and writes the visible text into
 *                                a transcriptions JSON  { "<postKey>": "text" }.
 *   4. mergeImageTextIntoPost()  appends that text to post_text; the normal
 *                                splitPostIntoRecords() then separates grants.
 *   5. cleanupImageDir()         deletes the temp images (only under the guarded
 *                                temp root) — nothing image-shaped is kept.
 *
 * STATUS: steps 2, 4, 5 and the URL filtering are unit-tested. Step 1 depends on
 * LinkedIn's guest DOM and has NOT been verified against a live page yet — see
 * scripts/linkedin-image-prototype.js, which exists to test exactly that on one
 * real company page before this is wired into the scheduled run. Off by default
 * (config: linkedin.images.enabled).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const TEMP_ROOT = path.join(process.cwd(), 'output', 'tmp_linkedin_images');
const MAX_IMAGES_PER_POST = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// ── URL / DOM filtering (pure) ───────────────────────────────────────────

// Post media lives under /dms/image/ with feedshare/sync style asset names.
// Logos, profile photos and the page cover use other prefixes.
const NOT_POST_MEDIA_PAT = /(company-logo|profile-displayphoto|profile-framedphoto|cover|background|logo_|\/aero-v1\/|static\.licdn\.com)/i;

function isPostImageUrl(url) {
  if (!url || !/^https:\/\/media\.licdn\.com\/dms\/image\//i.test(url)) return false;
  if (NOT_POST_MEDIA_PAT.test(url)) return false;
  return /(feedshare|\/sync\/|document-cover|articleshare|image-shrink|image-scale_\d{3,})/i.test(url);
}

function cleanText(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * domPosts: [{ urn, text, images: [{ src, alt, width, height }] }] as read from
 * the page. Returns [{ key, urn, images: [url...] }] limited to real post media
 * (>= 200px on the short side when dimensions are known).
 */
function pickPostImages(domPosts) {
  const out = [];
  for (const p of domPosts || []) {
    const seen = new Set();
    const images = [];
    for (const img of p.images || []) {
      if (!isPostImageUrl(img.src) || seen.has(img.src)) continue;
      const short = Math.min(img.width || 9999, img.height || 9999);
      if (short < 200) continue;
      seen.add(img.src);
      images.push(img.src);
      if (images.length >= MAX_IMAGES_PER_POST) break;
    }
    if (!images.length) continue;
    const urn = (p.urn || '').match(/(\d{15,})/);
    out.push({ key: urn ? urn[1] : null, urn: urn ? urn[1] : null, textHead: cleanText(p.text).slice(0, 80), textFull: cleanText(p.text), images });
  }
  return out;
}

/** Match a scraped post to DOM media by activity id first, else opening text. */
function matchPostToImages(post, picked) {
  const activityId = post.raw_metadata && post.raw_metadata.activity_id;
  if (activityId) {
    const hit = picked.find(p => p.urn === String(activityId));
    if (hit) return hit.images;
  }
  // The DOM card text starts with actor name / follower count / "2w", so the
  // caption is looked up INSIDE it rather than compared at the start.
  const head = cleanText(post.post_text).slice(0, 50);
  if (head.length >= 30) {
    const hit = picked.find(p => p.textFull && p.textFull.includes(head));
    if (hit) return hit.images;
  }
  return [];
}

// ── Collection (Playwright, public page only, unverified live) ───────────

async function collectImagesForSource(companyUrl, { timeout = 25000 } = {}) {
  const { getPage, safeGoto } = require('./playwright-base');
  const page = await getPage();
  try {
    if (!(await safeGoto(page, companyUrl, timeout))) return [];
    await page.waitForTimeout(2500);
    const domPosts = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-activity-urn], [data-id^="urn:li:activity"], article'));
      return cards.map(card => {
        const urn = card.getAttribute('data-activity-urn') || card.getAttribute('data-id') || '';
        const images = Array.from(card.querySelectorAll('img')).map(i => ({
          src: i.getAttribute('data-delayed-url') || i.currentSrc || i.src || '',
          alt: i.alt || '',
          width: i.naturalWidth || Number(i.getAttribute('width')) || 0,
          height: i.naturalHeight || Number(i.getAttribute('height')) || 0,
        }));
        return { urn, text: (card.innerText || '').slice(0, 400), images };
      });
    });
    return pickPostImages(domPosts);
  } catch (err) {
    console.warn(`  [LinkedIn images] ${companyUrl}: ${err.message}`);
    return [];
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

// ── Temp storage ─────────────────────────────────────────────────────────

function assertInsideTempRoot(dir, root = TEMP_ROOT) {
  const resolved = path.resolve(dir);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing to touch ${resolved}: outside ${base}`);
  }
  return resolved;
}

function extFor(contentType, url) {
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  const m = (url || '').match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

/** Download post images into <root>/<postKey>/. Returns saved file paths. */
async function downloadImages(urls, postKey, { root = TEMP_ROOT, http = axios } = {}) {
  const dir = assertInsideTempRoot(path.join(root, String(postKey).replace(/[^a-z0-9_-]/gi, '_')), root);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const url of urls.slice(0, MAX_IMAGES_PER_POST)) {
    try {
      const res = await http.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_IMAGE_BYTES });
      const type = String((res.headers && res.headers['content-type']) || '');
      if (!/^image\//i.test(type)) continue;
      const buf = Buffer.from(res.data);
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
      const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + extFor(type, url);
      const file = path.join(dir, name);
      fs.writeFileSync(file, buf);
      files.push(file);
    } catch (err) {
      console.warn(`  [LinkedIn images] download failed: ${err.message}`);
    }
  }
  return files;
}

function cleanupImageDir(root = TEMP_ROOT) {
  const resolved = assertInsideTempRoot(root, root === TEMP_ROOT ? TEMP_ROOT : root);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

// ── Merge transcribed image text back into a post ────────────────────────

/**
 * imageText: what Claude read off the image(s), plain text. Appended after the
 * caption so splitPostIntoRecords() sees one post whose list may live in the
 * image. Marks the post so downstream/Notion can tell the text came from an image.
 */
function mergeImageTextIntoPost(post, imageText) {
  const t = (imageText || '').replace(/\s+/g, ' ').trim();
  if (!t) return post;
  return {
    ...post,
    post_text: `${post.post_text} [Texto en imagen] ${t}`,
    _has_image_text: true,
    _image_text: t,
  };
}

module.exports = {
  TEMP_ROOT,
  isPostImageUrl,
  pickPostImages,
  matchPostToImages,
  collectImagesForSource,
  downloadImages,
  cleanupImageDir,
  assertInsideTempRoot,
  mergeImageTextIntoPost,
};
