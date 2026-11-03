'use strict';

// PROTOTYPE (read-only tooling, not wired into scan/notion-sync). Proposes
// "possible repeat" pairs using the local embedding server that Hugo already
// runs (llama.cpp + embeddinggemma, 127.0.0.1:18081). It never decides on its
// own: title similarity alone cannot tell "Youth Climate Fund" from "Youth
// Climate Prize" (0.87) or Social Shifters MoveNow from Global Innovation (0.74)
// — measured 2026-11-03 against 461 Notion pages. A pair is proposed only when
// the rules did NOT already match it, no rule vetoes it, AND a second signal
// agrees (same funder site, one title contained in the other, or near-identical
// vectors). Server down -> embedTexts() returns null and callers fall back to
// the rule-based grantsMatch() alone.

const {
  grantsMatch, extractYear, urlDomain, isAggregatorDomain, sameHostDifferentProgram,
  squashTitle, yearsCompatible, differentVariants, variantTokens,
} = require('./grant-fingerprint');

const DEFAULT_URL = process.env.EMBED_URL || 'http://127.0.0.1:18081/v1/embeddings';
const THRESHOLD = 0.80;   // below this a pair is never proposed
const MARKER_FLOOR = 0.5; // a shared program marker (e.g. movenow) is evidence by itself; titles may differ a lot (0.63 measured)
const STRONG = 0.95;      // vectors this close are a signal on their own
const BATCH = 16;

// Scraped titles carry U+2028/zero-width chars and UTF-8-read-as-Latin-1 junk
// ("SDGâ€¨Action"), which splits one title into different squash keys.
const cc = (...codes) => String.fromCharCode(...codes);
// "\u00e2\u20ac" + one more char is how a UTF-8 line separator reads when decoded as Latin-1.
const MOJIBAKE_RE = new RegExp(cc(0xe2, 0x20ac) + '[' + cc(0x80) + '-' + cc(0xbf, 0x2013) + '-' + cc(0x203a, 0x2122) + ']?', 'g');
const MOJIBAKE_APOSTROPHE_RE = new RegExp(cc(0xe2, 0x20ac, 0x2122), 'g');
const INVISIBLE_RE = new RegExp('[' + cc(0x2028, 0x2029, 0x200b) + '-' + cc(0x200d, 0xfeff) + ']', 'g');

function cleanTitle(title) {
  return (title || '')
    .replace(MOJIBAKE_APOSTROPHE_RE, "'")
    .replace(MOJIBAKE_RE, ' ')
    .replace(INVISIBLE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Embed texts through the local server. Returns vectors in order, or null if it is unreachable. */
async function embedTexts(texts, { url = DEFAULT_URL, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const out = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts.slice(i, i + BATCH), model: 'embeddinggemma' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()).data || [];
      if (data.length !== texts.slice(i, i + BATCH).length) return null;
      for (const d of data) out.push(d.embedding);
    }
  } catch { return null; }
  return out;
}

// One title contained in the other once squashed ("Whitley Awards 2027" in
// "2027 Whitley Awards — Conservación…"). Needs 12+ chars so short names do not collide.
function titleContained(a, b) {
  const sa = squashTitle(cleanTitle(a.title)), sb = squashTitle(cleanTitle(b.title));
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  return short.length >= 12 && long.includes(short);
}

function sameFunderSite(a, b) {
  const da = urlDomain(a.url), db = urlDomain(b.url);
  return !!da && da === db && !isAggregatorDomain(da);
}

/**
 * Why (if at all) a pair that the rules did not match should still be reviewed.
 * Returns { score, why } or null. `score` is the cosine of the two title vectors.
 */
function classifyPair(a, b, score) {
  const marker = variantTokens(a);   // both carry the same sibling-program marker (title or url)
  if (score < (marker.length ? MARKER_FLOOR : THRESHOLD)) return null;
  if (grantsMatch(a, b)) return null;                 // rules already agree: nothing to add
  if (!yearsCompatible(a, b)) return null;            // 2025 vs 2026 rounds
  if (differentVariants(a, b)) return null;           // confirmed sibling programs
  if (sameHostDifferentProgram(a, b)) return null;    // two programs on one funder site
  const why = [];
  if (marker.length) why.push(`same program marker (${marker.join(', ')})`);
  if (sameFunderSite(a, b)) why.push('same funder site');
  if (titleContained(a, b)) why.push('one title contains the other');
  if (score >= STRONG) why.push(`near-identical vectors (${score.toFixed(2)})`);
  return why.length ? { score, why } : null;
}

/**
 * Candidate "possible repeat" pairs. `left` against `right`, or every pair inside
 * `left` when `right` is omitted. Items are { title, url, ... }.
 * Returns null when the embedding server is unavailable.
 */
async function findCandidates(left, right, opts = {}) {
  const embed = opts.embed || (texts => embedTexts(texts, opts));
  const all = right ? [...left, ...right] : left;
  const vecs = await embed(all.map(g => cleanTitle(g.title)));
  if (!vecs) return null;
  const vl = vecs.slice(0, left.length), vr = right ? vecs.slice(left.length) : vl;
  const found = [];
  for (let i = 0; i < left.length; i++) {
    for (let j = right ? 0 : i + 1; j < (right ? right.length : left.length); j++) {
      const target = right ? right[j] : left[j];
      const hit = classifyPair(left[i], target, cosine(vl[i], vr[j]));
      if (hit) found.push({ a: left[i], b: target, ...hit });
    }
  }
  return found.sort((x, y) => y.score - x.score);
}

module.exports = { cleanTitle, cosine, embedTexts, classifyPair, findCandidates, THRESHOLD, STRONG };
