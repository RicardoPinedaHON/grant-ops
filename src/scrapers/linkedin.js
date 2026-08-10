'use strict';
/**
 * linkedin.js — LinkedIn Public Source (Jina Reader, no login)
 *
 * Monitors a configurable list of LinkedIn company pages using ONLY the
 * public "guest view" of the company root page (e.g.
 * https://www.linkedin.com/company/<slug>/), fetched through Jina Reader
 * (https://r.jina.ai/<url>). This view exposes an "## Updates" section
 * with recent posts without requiring authentication.
 *
 * IMPORTANT — why the root page, not /posts/:
 * `/company/<slug>/posts/` and `/company/<slug>/about/` return LinkedIn's
 * login wall even through Jina Reader. `/company/<slug>/` (no suffix)
 * does not, and embeds the same recent-updates feed server-side. This was
 * verified manually before building this module — see test fixtures.
 *
 * NO login, cookies, browser session, or mcp-server-linkedin auth is used
 * anywhere in this file. Only anonymous HTTP GET through Jina Reader.
 *
 * Responsibilities (LinkedInPublicSource-equivalent):
 *   fetchCompanyPage()   — HTTP GET via Jina Reader
 *   extractUpdates()     — split the "## Updates" section into raw posts
 *   normalizePost()      — build the normalized post record
 *   fingerprintPost()    — stable sha256 identity for persistent dedup
 *   fetchLinkedInSources() — orchestrates all configured sources
 *
 * This module does NOT decide grant scoring/eligibility beyond a cheap
 * topical pre-filter (isLikelyOpportunityPost), exactly like the RSS
 * scraper's LAC/THEME_KEYWORDS pre-filter in rss.js. The authoritative
 * "is this really a fundable opportunity" decision remains the existing
 * rule-based classifier in scorer/rules.js (checkIneligibility, geo/size/
 * deadline scoring) plus, later, Claude scoring — this module only avoids
 * flooding that pipeline with obvious non-opportunity chatter.
 */

const axios = require('axios');
const crypto = require('crypto');
const { isPostSeen, markPostSeen } = require('../tracker/index');

const JINA_BASE = 'https://r.jina.ai/';
const DEFAULT_REQUEST_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 45000;

// ─────────────────────────────────────────────────────────────────────────
// Text normalization / fingerprinting
// ─────────────────────────────────────────────────────────────────────────

/** Unicode-normalize, lowercase, trim, collapse whitespace — used both for
 *  fingerprinting and for keyword matching. */
function normalizeText(text) {
  return (text || '')
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Strip diacritics on top of normalizeText — used only for keyword matching
 *  so "cooperación" and "financiación" match ASCII keyword stems. */
function normalizeForMatch(text) {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * fingerprint = sha256(canonical_source + "|" + normalized_text)
 * canonical_source should be a stable identifier for the company page
 * (we use the source URL, lowercased and trimmed of trailing slash).
 */
function canonicalizeSourceUrl(url) {
  return (url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function fingerprintPost(canonicalSource, postText) {
  const normalized = normalizeText(postText);
  const payload = `${canonicalizeSourceUrl(canonicalSource)}|${normalized}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// Relative-time parsing (LinkedIn only exposes "18m" / "2h" / "1d" / "3w"...)
// ─────────────────────────────────────────────────────────────────────────

const RELATIVE_UNIT_MS = {
  m: 60 * 1000, min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
  h: 60 * 60 * 1000, hr: 60 * 60 * 1000, hrs: 60 * 60 * 1000, hour: 60 * 60 * 1000, hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000, months: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000, yr: 365 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000, years: 365 * 24 * 60 * 60 * 1000,
};

/** Parse a leading relative-time token ("18m", "2h", "1d", "3w"...) from the
 *  start of a raw post chunk. Returns { relative, ms, rest } or null. */
function parseLeadingRelativeTime(chunk) {
  const m = (chunk || '').match(/^\s*(\d+)\s*(mo|min|mins|minute|minutes|hrs|hr|hours|hour|days|day|weeks|week|years|year|yr|m|h|d|w|y)\b\.?/i);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const unitMs = RELATIVE_UNIT_MS[unit];
  if (!unitMs) return null;
  return {
    relative: `${value}${unit}`,
    ms: value * unitMs,
    rest: chunk.slice(m[0].length),
  };
}

/** Best-effort absolute estimate — NOT an official LinkedIn timestamp.
 *  Computed as detectedAt - relativeDelta. */
function estimatePublishedAt(relativeMs, detectedAtIso) {
  if (relativeMs == null) return null;
  const detected = new Date(detectedAtIso);
  return new Date(detected.getTime() - relativeMs).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────
// fetchCompanyPage — HTTP GET through Jina Reader, no auth
// ─────────────────────────────────────────────────────────────────────────

async function fetchCompanyPage(companyUrl, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  const target = `${JINA_BASE}${companyUrl}`;
  const headers = { 'User-Agent': 'grant-ops/1.0 (NGO grant monitoring tool)' };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }
  const res = await axios.get(target, { timeout, headers, responseType: 'text' });
  return res.data;
}

/** LinkedIn's guest view redirects unauthenticated requests to a login wall
 *  for some sub-paths (e.g. /posts/, /about/). Detect that so the caller
 *  can treat it as "blocked", not as "zero posts". */
function isLoginWall(markdown) {
  if (!markdown) return false;
  const head = markdown.slice(0, 400);
  return /title:\s*linkedin login/i.test(head) ||
    (/sign in/i.test(head) && /forgot password/i.test(markdown) && !/##\s*updates/i.test(markdown));
}

// ─────────────────────────────────────────────────────────────────────────
// extractUpdates — split the "## Updates" section into raw post chunks
// ─────────────────────────────────────────────────────────────────────────

// LinkedIn's public guest-view markup for the SAME url is not stable: two
// fetches of https://www.linkedin.com/company/onglink/ a few hours apart
// returned different shapes for the per-post "actor block" — confirmed
// empirically while building this module (see test/fixtures/, both kept as
// regression fixtures). Both boundary patterns are tried:
//   (a) a per-post permalink, e.g.
//       [](https://es.linkedin.com/posts/onglink_...-activity-7491...-UCRM)
//       — the richer shape; also yields a real post URL + activity ID.
//   (b) the plain actor line: "*   [](avatar-link)3,441 followers"
//       — the leaner shape, no permalink available.
const POST_BOUNDARY_PATTERN = new RegExp(
  '\\*\\s*\\n?\\[\\]\\((https?:\\/\\/[a-z]{2,3}\\.linkedin\\.com\\/posts\\/[^)]*?-activity-(\\d+)-[^)]*)\\)' +
  '|\\*\\s+\\[[^\\]]*\\]\\([^)]+\\)[\\d.,]+\\s*followers?',
  'gi'
);

function extractUpdatesSection(markdown) {
  const startMatch = markdown.match(/##\s*Updates\b/i);
  if (!startMatch) return '';
  const start = startMatch.index + startMatch[0].length;
  const rest = markdown.slice(start);
  // Stop at the next top-level "## " heading (e.g. "Join now...", "Similar pages")
  const endMatch = rest.match(/\n##\s+/);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

/** Locate each per-post "actor block" boundary in the Updates section,
 *  capturing the post permalink + activity ID when that shape is present. */
function findPostBoundaries(section) {
  const boundaries = [];
  let m;
  POST_BOUNDARY_PATTERN.lastIndex = 0;
  while ((m = POST_BOUNDARY_PATTERN.exec(section))) {
    boundaries.push({
      start: m.index,
      end: m.index + m[0].length,
      postUrl: m[1] || null,
      activityId: m[2] || null,
    });
  }
  return boundaries;
}

/** Extract markdown links/images ([label](url) and ![label](url)) from a
 *  chunk, classify them into hashtags vs. external links, and return the
 *  "readable" plain text with link syntax collapsed to just the label. */
function parseLinksAndPlainText(chunk) {
  const hashtags = [];
  const externalUrls = [];
  const seenExternal = new Set();

  const plainText = chunk.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (whole, label, url) => {
    const isLinkedInHost = /(^|\/\/)([\w-]+\.)*linkedin\.com/i.test(url);
    const isHashtag = label.trim().startsWith('#');

    if (isHashtag) {
      const tag = label.trim();
      if (!hashtags.includes(tag)) hashtags.push(tag);
      return label; // keep the "#Tag" text inline in the readable post text
    }

    if (!isLinkedInHost && url && !seenExternal.has(url)) {
      seenExternal.add(url);
      externalUrls.push({ original_url: url, resolved_url: null });
    }

    return label || '';
  });

  return { plainText, hashtags, externalUrls };
}

// UI chrome that Jina's extraction sometimes leaves behind as visible text
// once markdown link/image syntax is flattened (guest-view-only labels:
// "Report this post", follower counts, image alt text, share/react CTAs).
// Best-effort cleanup — not guaranteed to catch every future label LinkedIn
// introduces, but keeps stored post_text free of the common ones observed.
const BOILERPLATE_PATTERNS = [
  /view organization page for [^.]*?(?=\s{2,}|$)/gi,
  /image \d+:?[^.]*?(?=\s{2,}|$)/gi,
  /\b(?:like|comment|share)\b(?=\s|$)/gi,
  /[\d,]+\s+followers?/gi,
  /…\s*more|\.\.\.\s*more/gi,
];

// Removed as a whole markdown list item (bullet + link), BEFORE the generic
// link-flattening pass — otherwise the leading "*" bullet marker is left
// behind as stray visible text once the link itself is flattened away.
const REPORT_POST_LIST_ITEM = /\n?[ \t]*\*[ \t]+\[report this post\]\([^)]*\)\n?/gi;

function stripBoilerplate(text) {
  let out = text;
  for (const pattern of BOILERPLATE_PATTERNS) out = out.replace(pattern, ' ');
  return out;
}

/** Opportunistic reaction count — LinkedIn's guest view sometimes renders it
 *  as "[![img](..) 4](...social-actions-reactions...)". Only populated when
 *  actually present; null otherwise (never guessed). */
function extractReactionsCount(rawChunk) {
  const m = rawChunk.match(/\]\s*(\d+)\]\([^)]*social-actions-reactions[^)]*\)/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractUpdates(markdown) {
  const section = extractUpdatesSection(markdown);
  if (!section.trim()) return [];

  const boundaries = findPostBoundaries(section);
  if (!boundaries.length) return [];

  const posts = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const chunkEnd = i + 1 < boundaries.length ? boundaries[i + 1].start : section.length;
    const rawChunk = section.slice(boundary.end, chunkEnd);

    // The relative-time token may not be at position 0 — the richer shape
    // has a full actor image link + actor name link + follower count before
    // it (easily 300+ chars: "[![Image 4: View organization page for
    // ONGLink](...)](...)[ONGLink](...) \n3,441 followers\n\n 18m"). Search
    // for it within a generous leading window rather than anchoring at 0.
    const timeMatch = rawChunk.match(/(\d+)\s*(mo|min|mins|minute|minutes|hrs|hr|hours|hour|days|day|weeks|week|years|year|yr|m|h|d|w|y)\b\.?/i);
    if (!timeMatch || timeMatch.index > 600) continue; // not a real post chunk

    const leading = parseLeadingRelativeTime(rawChunk.slice(timeMatch.index));
    if (!leading) continue;

    const reactionsCount = extractReactionsCount(rawChunk);
    const withoutReportLink = leading.rest.replace(REPORT_POST_LIST_ITEM, '\n');
    const { plainText, hashtags, externalUrls } = parseLinksAndPlainText(withoutReportLink);
    const cleaned = stripBoilerplate(plainText)
      // Safety net: strip any markdown link/image syntax that survived the
      // flatten pass above (observed on nested "reshare of someone else's
      // post" cards, where LinkedIn's markup embeds a second actor block —
      // rare, best-effort cleanup rather than a fully modeled repost shape).
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ');
    const text = normalizeText(cleaned).length ? cleaned.trim().replace(/\s+/g, ' ') : '';
    if (!text) continue;

    posts.push({
      published_relative: leading.relative,
      published_relative_ms: leading.ms,
      raw_text: text,
      hashtags,
      external_urls: externalUrls,
      post_url: boundary.postUrl,
      activity_id: boundary.activityId,
      reactions_count: reactionsCount,
    });
  }
  return posts;
}

// ─────────────────────────────────────────────────────────────────────────
// mentioned_organizations — best-effort heuristic (documented limitation:
// only catches "Capitalized Words + Foundation/Fund/Program/..." patterns;
// misses funder names without that suffix, e.g. "Progettomondo").
// ─────────────────────────────────────────────────────────────────────────

const ORG_SUFFIX_PATTERN = /\b((?:[A-ZÁÉÍÓÚÑÜ][\wÁÉÍÓÚÑÜáéíóúñü'’.-]*\s+){0,4}(?:Foundation|Fund|Fondo|Program|Programa|Accelerator|Initiative|Academy|Fellowship|Trust))\b/g;

const LEADING_ARTICLE_PATTERN = /^(el|la|los|las|the|a|an)\s+/i;

function extractMentionedOrganizations(text) {
  const found = new Set();
  let m;
  ORG_SUFFIX_PATTERN.lastIndex = 0;
  while ((m = ORG_SUFFIX_PATTERN.exec(text))) {
    const org = m[1].trim().replace(/\s+/g, ' ').replace(LEADING_ARTICLE_PATTERN, '');
    if (org.split(' ').length >= 2) found.add(org);
  }

  // The prefix quantifier is greedy, so two adjacent org-like phrases (e.g.
  // "Grant Program" followed by "Reece Foundation" in the same sentence) can
  // get swallowed into one noisy match ("Grant Program La Reece Foundation").
  // Drop any match that fully contains a shorter, cleaner match — best-effort,
  // not a general NLP fix.
  const all = [...found].sort((a, b) => a.length - b.length);
  const deduped = [];
  for (const org of all) {
    if (deduped.some(kept => org.includes(kept))) continue;
    deduped.push(org);
  }
  return deduped;
}

// ─────────────────────────────────────────────────────────────────────────
// resolveLnkdIn — follow lnkd.in short-link redirects via plain HTTP, no
// login. Non-fatal: any failure just leaves resolved_url as null.
// ─────────────────────────────────────────────────────────────────────────

async function resolveLnkdInUrl(url, { timeout = 15000 } = {}) {
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 10,
      headers: { 'User-Agent': 'grant-ops/1.0 (NGO grant monitoring tool)' },
      validateStatus: () => true,
    });
    return res.request?.res?.responseUrl || res.request?.responseURL || null;
  } catch (_) {
    return null;
  }
}

async function resolveExternalLinks(externalUrls) {
  const resolved = [];
  for (const link of externalUrls) {
    if (/^https?:\/\/(www\.)?lnkd\.in\//i.test(link.original_url)) {
      const resolvedUrl = await resolveLnkdInUrl(link.original_url);
      resolved.push({ ...link, resolved_url: resolvedUrl });
    } else {
      resolved.push(link);
    }
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────
// normalizePost — builds the normalized post record (this task's data model)
// ─────────────────────────────────────────────────────────────────────────

function normalizePost(rawPost, sourceCfg, detectedAtIso) {
  const canonicalSource = canonicalizeSourceUrl(sourceCfg.url);
  const fingerprint = fingerprintPost(canonicalSource, rawPost.raw_text);

  return {
    source: 'linkedin',
    source_name: sourceCfg.name,
    source_url: sourceCfg.url,
    post_text: rawPost.raw_text,
    published_relative: rawPost.published_relative,
    // Best-effort estimate only — LinkedIn's public guest view does not expose
    // an official timestamp, only a rounded relative label. NOT authoritative.
    published_estimated_at: estimatePublishedAt(rawPost.published_relative_ms, detectedAtIso),
    detected_at: detectedAtIso,
    external_urls: rawPost.external_urls,
    hashtags: rawPost.hashtags,
    mentioned_organizations: extractMentionedOrganizations(rawPost.raw_text),
    fingerprint,
    raw_metadata: {
      canonical_source: canonicalSource,
      // Opportunistic — only present when LinkedIn's guest-view render
      // happens to expose them for this fetch. Never guessed/invented when
      // absent (see extractUpdates/extractReactionsCount).
      post_url: rawPost.post_url || null,
      activity_id: rawPost.activity_id || null,
      reactions_count: rawPost.reactions_count ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Opportunity pre-filter — cheap topical signal, NOT the final classifier.
// Final classification still happens in scorer/rules.js (checkIneligibility,
// geo/size/deadline scoring) exactly like every other source.
// ─────────────────────────────────────────────────────────────────────────

const POSITIVE_KEYWORDS = [
  'grant', 'grant program', 'funding', 'fund', 'call for proposals',
  'call for applications', 'convocatoria', 'financiamiento', 'subvencion',
  'subvenciones', 'fondo', 'fondos', 'cooperacion', 'fellowship',
  'challenge fund', 'request for proposals', 'rfp', 'eoi',
  'expression of interest',
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matching (with an optional trailing "s" for plurals) is
// required here — plain substring matching on a short token like "fund"
// false-positives inside common Spanish words such as "difundir"/"difunde"
// ("to broadcast"), which appear constantly in this domain and are
// otherwise unrelated to funding.
const POSITIVE_KEYWORD_PATTERNS = POSITIVE_KEYWORDS.map(
  kw => new RegExp(`\\b${escapeRegExp(kw)}s?\\b`, 'i')
);

// Self-promotional / paid-advertising signal observed in false positives
// (ONGLink's own paid posting service, WIÑAY Academy course ad): a pricing
// line of the form "Inversión: <amount>". This is a narrow, documented
// heuristic — not general fuzzy matching — and may need broadening if other
// pages advertise paid services with different wording.
const SELF_PROMO_AD_PATTERN = /\binversion:\s*(bolivia|bs\.?|\$|usd|dolares|eur|euros)/i;

// ONGLink (and presumably other pages) append 10-20 hashtags to almost every
// post, including generic ones like #Cooperación or #TercerSector that don't
// signal an actual grant. Matching keywords against the raw text would let
// those hashtags alone flip a plain announcement into a false-positive
// "opportunity" — so classification runs against the BODY text only, with
// hashtag tokens stripped. Hashtags are still preserved verbatim in the
// normalized post record (post.hashtags) for storage/display.
function stripHashtags(text) {
  return (text || '').replace(/#[\p{L}\p{N}_]+/gu, ' ');
}

function isLikelyOpportunityPost(text) {
  const norm = normalizeForMatch(stripHashtags(text));
  const hasPositiveSignal = POSITIVE_KEYWORD_PATTERNS.some(re => re.test(norm));
  if (!hasPositiveSignal) return false;
  if (SELF_PROMO_AD_PATTERN.test(norm)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Best-effort extraction of amount / deadline / eligibility / geography.
// These feed the standard grant object's existing fields (amount_min/max,
// deadline) plus a few additive, non-breaking extra fields. Documented as
// best-effort — "intenta extraer", not guaranteed complete.
// ─────────────────────────────────────────────────────────────────────────

const CURRENCY_PREFIXES = [
  { re: /au\$/i, code: 'AUD' },
  { re: /a\$/i, code: 'AUD' },
  { re: /us\$/i, code: 'USD' },
  { re: /usd/i, code: 'USD' },
  { re: /eur/i, code: 'EUR' },
  { re: /€/, code: 'EUR' },
  { re: /£/, code: 'GBP' },
  { re: /gbp/i, code: 'GBP' },
  { re: /\$/, code: 'USD' },
];

function detectCurrency(snippet) {
  for (const { re, code } of CURRENCY_PREFIXES) {
    if (re.test(snippet)) return code;
  }
  return null;
}

function parseAmountNumber(str) {
  // Amounts here never carry meaningful cents — strip both "." and ","
  // (used interchangeably as thousands separators in ES/EN posts) and parse
  // as an integer, e.g. "30.000" -> 30000, "900,000" -> 900000.
  const digits = (str || '').replace(/[.,]/g, '');
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_TOKEN = '(?:AU\\$|A\\$|US\\$|USD|EUR|€|£|GBP|\\$)';

function extractAmountRange(text) {
  // "Entre USD 10.000 y USD 900.000" / "Between $10,000 and $900,000"
  const rangeRe = new RegExp(`(?:entre|between)\\s+(${CURRENCY_TOKEN})\\s*([\\d.,]+)\\s+(?:y|and)\\s+(${CURRENCY_TOKEN})?\\s*([\\d.,]+)`, 'i');
  let m = text.match(rangeRe);
  if (m) {
    const min = parseAmountNumber(m[2]);
    const max = parseAmountNumber(m[4]);
    const currency = detectCurrency(m[1] || m[3] || '');
    if (min != null && max != null) return { amount_min: min, amount_max: max, currency };
  }

  // "Hasta AU$30.000" / "Up to $500,000"
  const upToRe = new RegExp(`(?:hasta|up to)\\s+(${CURRENCY_TOKEN})\\s*([\\d.,]+)`, 'i');
  m = text.match(upToRe);
  if (m) {
    const max = parseAmountNumber(m[2]);
    const currency = detectCurrency(m[1]);
    if (max != null) return { amount_min: null, amount_max: max, currency };
  }

  // Bare "$50,000" fallback
  const bareRe = new RegExp(`(${CURRENCY_TOKEN})\\s*([\\d.,]{3,})`, 'i');
  m = text.match(bareRe);
  if (m) {
    const amt = parseAmountNumber(m[2]);
    const currency = detectCurrency(m[1]);
    if (amt != null && amt > 100) return { amount_min: null, amount_max: amt, currency };
  }

  return { amount_min: null, amount_max: null, currency: null };
}

const ROLLING_PATTERN = /\brolling\b|\bpermanente\b|\btodo el a[nñ]o\b|\bcualquier momento del a[nñ]o\b/i;

const SPANISH_MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

function extractDeadline(text) {
  if (ROLLING_PATTERN.test(text)) {
    return { deadline: 'rolling', deadline_type: 'rolling' };
  }

  // "7 de agosto de 2026"
  let m = text.match(/(\d{1,2})\s+de\s+([A-Za-zñÑ]+)\s+de\s+(\d{4})/i);
  if (m) {
    const month = SPANISH_MONTHS[m[2].toLowerCase()];
    if (month != null) {
      const d = new Date(Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10)));
      if (!isNaN(d)) return { deadline: d.toISOString().split('T')[0], deadline_type: 'fixed' };
    }
  }

  // "Month DD, YYYY" / "DD Month YYYY"
  const monthNamePattern = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  m = text.match(new RegExp(`${monthNamePattern}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i')) ||
      text.match(new RegExp(`(\\d{1,2})\\s+${monthNamePattern}\\s+(\\d{4})`, 'i'));
  if (m) {
    const d = new Date(m[0]);
    if (!isNaN(d)) return { deadline: d.toISOString().split('T')[0], deadline_type: 'fixed' };
  }

  return { deadline: null, deadline_type: 'unknown' };
}

function extractSnippetAfter(text, markers, maxLen = 200) {
  for (const marker of markers) {
    const idx = text.search(marker);
    if (idx === -1) continue;
    const afterMarkerMatch = text.slice(idx).match(marker);
    const start = idx + afterMarkerMatch[0].length;
    // Stop at the next emoji-ish bullet marker or after maxLen chars.
    const rest = text.slice(start, start + maxLen);
    const stop = rest.search(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    return (stop > 5 ? rest.slice(0, stop) : rest).trim();
  }
  return null;
}

const ELIGIBILITY_MARKERS = [
  /dirigido a:/i, /¿qui[eé]nes pueden postular\?/i, /qui[eé]nes pueden postular:/i, /eligible applicants?:/i,
];
const GEOGRAPHY_MARKERS = [
  /cobertura:/i, /coverage:/i, /geographic (?:scope|coverage):/i,
];

// ─────────────────────────────────────────────────────────────────────────
// Turn a normalized post + extraction into the SAME grant object shape used
// by every other source (see scrapers/rss.js). No parallel model.
// ─────────────────────────────────────────────────────────────────────────

function deriveTitle(text) {
  // Prefer text up to the first "|" (common LinkedIn convocatoria pattern:
  // "Convocatoria abierta ... | Reece Foundation – Grant Program"), else up
  // to the first sentence-ish boundary, capped at 140 chars.
  const stripped = text.replace(/^[\p{Emoji_Presentation}\u2600-\u27BF\s]+/u, '').trim();
  const pipeIdx = stripped.indexOf('|');
  if (pipeIdx > 10 && pipeIdx < 160) return stripped.slice(0, pipeIdx).trim();
  const sentenceMatch = stripped.match(/^.{20,140}?[.!?](?:\s|$)/);
  if (sentenceMatch) return sentenceMatch[0].trim();
  return stripped.slice(0, 140).trim();
}

function postToGrantRecord(post) {
  const { amount_min, amount_max, currency } = extractAmountRange(post.post_text);
  const { deadline, deadline_type } = extractDeadline(post.post_text);
  const eligibility = extractSnippetAfter(post.post_text, ELIGIBILITY_MARKERS);
  const geography = extractSnippetAfter(post.post_text, GEOGRAPHY_MARKERS);
  const title = deriveTitle(post.post_text);
  const funder = post.mentioned_organizations[0] || post.source_name;

  // Prefer a real external link (the actual convocatoria URL) over the
  // LinkedIn post itself, per spec. Fall back to the post's own permalink
  // (when LinkedIn's render happened to expose one) before the generic
  // company page URL.
  const preferredExternal = post.external_urls.find(u => !/^mailto:/i.test(u.original_url));
  const url = (preferredExternal && (preferredExternal.resolved_url || preferredExternal.original_url)) ||
    post.raw_metadata.post_url || post.source_url;

  return {
    // ── standard grant-ops fields (read by scorer/rules.js, tracker/index.js, etc.) ──
    source: `LinkedIn: ${post.source_name}`,
    id: `li_${post.fingerprint.slice(0, 24)}`,
    title,
    description: post.post_text,
    url,
    funder,
    deadline,
    amount_min,
    amount_max,
    country: geography,
    themes: post.hashtags.map(h => h.replace(/^#/, '').toLowerCase()),
    type: 'linkedin',
    fetched_at: post.detected_at,

    // ── additive opportunity fields (namespaced so nothing existing breaks) ──
    opportunity_name: title,
    summary: post.post_text,
    currency,
    deadline_type,
    eligibility,
    geography,
    thematic_areas: post.hashtags.map(h => h.replace(/^#/, '')),
    source_url: post.source_url,
    external_urls: post.external_urls,
    detected_at: post.detected_at,
    // Opportunistic — only populated when LinkedIn's guest-view render
    // exposed a post permalink/activity ID/reaction count for this fetch.
    post_url: post.raw_metadata.post_url,
    post_urn: post.raw_metadata.activity_id,
    reactions_count: post.raw_metadata.reactions_count,

    // ── full normalized post, preserved for traceability/debugging ──
    _linkedin: post,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration — fetchLinkedInSources(config, history)
// ─────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * @param {object} linkedinConfig  config.linkedin from sources.yaml
 * @param {object} history         the SAME history object scan.js loads/saves
 *                                 (loadHistory/saveHistory) — post-level dedup
 *                                 is persisted through it exactly like grant
 *                                 dedup, no parallel storage.
 */
async function fetchLinkedInSources(linkedinConfig, history) {
  const metrics = {
    sourcesConfigured: 0,
    successful: 0,
    failed: 0,
    postsFetched: 0,
    newPosts: 0,
    alreadySeen: 0,
    opportunitiesDetected: 0,
  };
  const grants = [];

  if (!linkedinConfig || linkedinConfig.enabled === false) {
    return { grants, metrics };
  }

  const sources = (linkedinConfig.sources || []).filter(s => s.enabled !== false);
  metrics.sourcesConfigured = sources.length;
  const requestDelayMs = linkedinConfig.request_delay_ms ?? DEFAULT_REQUEST_DELAY_MS;

  for (let i = 0; i < sources.length; i++) {
    const cfg = sources[i];
    if (i > 0) await sleep(requestDelayMs); // polite, sequential, no concurrent hammering

    try {
      const markdown = await fetchCompanyPage(cfg.url);
      if (isLoginWall(markdown)) {
        throw new Error('LinkedIn returned a login wall for this URL (public guest view blocked)');
      }

      const detectedAtIso = new Date().toISOString();
      const rawPosts = extractUpdates(markdown);
      metrics.postsFetched += rawPosts.length;

      for (const rawPost of rawPosts) {
        const post = normalizePost(rawPost, cfg, detectedAtIso);

        if (isPostSeen(post.fingerprint, history)) {
          metrics.alreadySeen++;
          continue;
        }

        // Mark seen immediately — regardless of opportunity classification —
        // so non-opportunity posts are not reprocessed on future runs either.
        markPostSeen(post.fingerprint, {
          source_name: cfg.name,
          source_url: cfg.url,
          published_relative: post.published_relative,
          title_snippet: post.post_text.slice(0, 80),
        }, history);
        metrics.newPosts++;

        if (isLikelyOpportunityPost(post.post_text)) {
          metrics.opportunitiesDetected++;
          // Only resolve lnkd.in redirects for posts we actually keep —
          // keeps request volume low, per the "no agressive scraping" rule.
          post.external_urls = await resolveExternalLinks(post.external_urls);
          grants.push(postToGrantRecord(post));
        }
      }

      metrics.successful++;
      console.log(`  [LinkedIn] ${cfg.name}: ${rawPosts.length} posts visible, ${metrics.newPosts} new so far`);
    } catch (err) {
      metrics.failed++;
      console.warn(`  [LinkedIn] ${cfg.name} failed: ${err.message}`);
      // Resilience: one failing source does not abort the others.
      continue;
    }
  }

  console.log(
    `  [LinkedIn] sources: ${metrics.sourcesConfigured} | successful: ${metrics.successful} | failed: ${metrics.failed} | ` +
    `posts fetched: ${metrics.postsFetched} | new: ${metrics.newPosts} | already seen: ${metrics.alreadySeen} | ` +
    `opportunities: ${metrics.opportunitiesDetected}`
  );

  return { grants, metrics };
}

module.exports = {
  fetchLinkedInSources,
  // exported for tests
  normalizeText,
  normalizeForMatch,
  fingerprintPost,
  canonicalizeSourceUrl,
  parseLeadingRelativeTime,
  estimatePublishedAt,
  isLoginWall,
  extractUpdatesSection,
  extractUpdates,
  extractMentionedOrganizations,
  isLikelyOpportunityPost,
  extractAmountRange,
  extractDeadline,
  normalizePost,
  postToGrantRecord,
  fetchCompanyPage,
  resolveLnkdInUrl,
  resolveExternalLinks,
};
