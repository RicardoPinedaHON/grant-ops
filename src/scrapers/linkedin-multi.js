'use strict';
/**
 * linkedin-multi.js — pure helpers for posts that announce SEVERAL grants.
 *
 * Why this exists (Ricardo, 2026-10-30): the old splitter in linkedin.js only
 * fired when a post said "N fondos/convocatorias" AND carried 2+ external
 * links. Two live failures:
 *   - HOST (Ally for Action) listed 3 grants as "➜ Name For youth... | $ |
 *     Closes <date>" with no per-grant links -> stored as ONE record titled
 *     "Global Grant"; the other two grants were never scored.
 *   - Innpactia listed 5 grants plus a "Regístrate" link -> the sign-up page
 *     became a bogus 5th record while real grants were titled with raw
 *     lnkd.in URLs.
 *
 * Everything here is text-in / data-out, no network, so it is unit-testable.
 * Record building stays in linkedin.js (postToGrantRecord) to avoid a cycle.
 */

// ── Link classification ──────────────────────────────────────────────────

// Words that, right before a link, mean "this link is a CTA to the poster's
// own platform", not a grant.
const JUNK_CONTEXT_PAT =
  /(reg[ií]strate|suscr[ií]be|sign\s*up|subscribe|newsletter|bolet[ií]n|funding bulletin|resource directory|directorio de recursos|fundraising resource|comparte|share this|follow us|s[ií]guenos|m[aá]s oportunidades|more opportunities|[uú]nete|join us|whatsapp|escr[ií]benos|cont[aá]ctanos|agenda tu)/i;

const JUNK_PATH_PAT = /(\/auth\/|\/log-?in\b|\/signin\b|\/sign-in\b|\/register\b|\/signup\b|\/sign-up\b)/i;
const JUNK_HOSTS = new Set(['shorturl.at', 'linktr.ee', 'api.whatsapp.com', 'wa.me', 'chat.whatsapp.com', 'calendly.com']);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function stripQuery(url) {
  return (url || '').replace(/[?#].*$/, '');
}

// Text that identifies a link inside the flattened post text: the anchor
// label when LinkedIn kept one, else the URL itself (Innpactia/lnkd.in posts
// print the URL as the anchor).
function linkKeys(link) {
  const keys = [];
  const label = (link.label || '').trim();
  if (label.length >= 4) keys.push(label);
  const orig = stripQuery(link.original_url);
  if (orig) keys.push(orig);
  return keys;
}

function locateLink(text, link) {
  for (const key of linkKeys(link)) {
    const idx = text.indexOf(key);
    if (idx !== -1) return { idx, len: key.length };
  }
  return null;
}

/**
 * Mark each external link as junk (the poster's own sign-up/newsletter/login/
 * root page, WhatsApp, link-in-bio) or a candidate opportunity link.
 * Returns a new array; never drops links (kept for traceability).
 */
function classifyLinks(post) {
  const text = post.post_text || '';
  const sourceSlug = ((post.source_url || '').match(/\/company\/([^/]+)/i) || [])[1] || '';
  const slugToken = sourceSlug.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const sourceNameToken = (post.source_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  return (post.external_urls || []).map(link => {
    const url = link.resolved_url || link.original_url || '';
    const host = hostOf(url);
    let junk = null;

    if (/^mailto:/i.test(url)) junk = 'mailto';
    else if (JUNK_HOSTS.has(host)) junk = 'link-in-bio-or-chat';
    else if (JUNK_PATH_PAT.test(url)) junk = 'login-or-signup-page';
    else {
      const hostToken = host.replace(/[^a-z0-9]/g, '');
      const ownHost = (slugToken.length >= 4 && hostToken.includes(slugToken)) ||
        (sourceNameToken.length >= 4 && hostToken.includes(sourceNameToken));
      let path = '/';
      try { path = new URL(url).pathname; } catch { /* keep '/' */ }
      const isRoot = path === '/' || path === '';
      if (ownHost && (isRoot || JUNK_CONTEXT_PAT.test(url))) junk = 'own-site-root';
      else if (ownHost && /resourcedirectory|resource-directory|directorio/i.test(url)) junk = 'own-resource-page';
    }

    if (!junk) {
      const at = locateLink(text, link);
      if (at) {
        const before = text.slice(Math.max(0, at.idx - 70), at.idx);
        if (JUNK_CONTEXT_PAT.test(before)) junk = 'cta-context';
      }
    }
    return { ...link, junk };
  });
}

// ── Text-list segmentation ───────────────────────────────────────────────

const KEYCAP = '[0-9#*]\\uFE0F?\\u20E3';
const ARROWS = '[➜➔➤▶►→]\\uFE0F?';
const BULLETS = '[🔹🔸🔶🔷▪▫◆■●•✅☑✔]\\uFE0F?';
// "➡️" doubles as a CTA marker ("➡️ ¿Buscas más oportunidades?"), so it is
// only accepted as an item marker when it repeats like the others.
const MARKER_KINDS = [
  { name: 'keycap', re: new RegExp(KEYCAP, 'gu') },
  { name: 'arrow', re: new RegExp(ARROWS, 'gu') },
  { name: 'bullet', re: new RegExp(BULLETS, 'gu') },
  { name: 'right-arrow-emoji', re: /➡️?/gu },
];

// Where the list ends and the poster's call-to-action / footer begins.
const TAIL_CUT_PAT = new RegExp(
  '\\s(?:Looking for|¿?Buscas|Buscas|Podr[aá]s|Explora|Sign up|Suscr[ií]b|Reg[ií]strate|Follow|S[ií]guenos|Comparte|Share|' +
  'Para m[aá]s|M[aá]s info|Read more|Learn more|Visit|Visita|Don.t miss|Know someone|Tag (?:them|a|someone)|📥|🌟|🔎|📲|📣|📢|📩|🔔|👇|⏰)|\\s#[\\p{L}\\p{N}_]',
  'u'
);

const GRANT_WORD_PAT =
  /\b(grant|grants|fund|fondo|fondos|prize|premio|award|awards|challenge|fellowship|beca|becas|programa|program|programme|convocatoria|accelerator|acelerador|aceleradora|studio|cohort|competition|competencia|initiative|iniciativa|call|catalyst|subvenci[oó]n)\b/i;
const MONEY_PAT = /(?:[$€£]|USD|EUR|GBP)\s?\d|\b\d[\d.,]*\s?(?:k|m)\b\s*(?:usd|eur)?/i;
const DEADLINE_CUE_PAT = /\b(closes?|cierra|deadline|fecha l[ií]mite|hasta el|plazo|due)\b/i;

// `strict` (✅/•/➡️ style bullets) is how eligibility checklists are written
// too ("✅ ONG con programas de fondos propios"), so a grant word alone is not
// enough there — the item needs a link, an amount or a deadline cue.
function looksLikeGrantSegment(seg, strict = false) {
  if (seg.length < 20) return false;
  if (strict) {
    // Feature bullets ("🔹 Up to £5,000 per organisation", "🔹 Applications
    // assessed on a rolling basis") carry one fact each. A grant item carries its
    // own link, or an amount AND a deadline.
    return /https?:\/\//.test(seg) || (MONEY_PAT.test(seg) && DEADLINE_CUE_PAT.test(seg));
  }
  return /https?:\/\//.test(seg) || MONEY_PAT.test(seg) || DEADLINE_CUE_PAT.test(seg) || GRANT_WORD_PAT.test(seg);
}

const STRICT_KINDS = new Set(['bullet', 'right-arrow-emoji']);

// "1. Name 2. Name 3. Name" / "1) Name ..." — only accepted for a strictly
// consecutive 1..N sequence, so amounts/dates ("2. 5 dic") never qualify.
function findNumberedMarkers(text) {
  const re = /(?:^|\s)(\d{1,2})[.)]\s+(?=[A-ZÁÉÍÓÚÑ0-9$€£])/g;
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push({ n: parseInt(m[1], 10), start: m.index + (m[0].length - m[0].trimStart().length), end: m.index + m[0].length });
  const seq = [];
  let expect = 1;
  for (const h of hits) {
    if (h.n === expect) { seq.push(h); expect++; }
  }
  return seq.length >= 2 ? seq : null;
}

// Outermost structure wins, not the most frequent glyph: a roundup with items
// "1. … 2. …" whose every item carries ✅ requirement bullets has MORE ✅ than
// items (Startup Networks, 2026-10-30). Order = how likely the marker is to
// number the grants themselves rather than describe one grant.
const KIND_PRIORITY = ['numbered', 'keycap', 'arrow', 'right-arrow-emoji', 'bullet'];

function findMarkers(text) {
  const byKind = {};
  for (const kind of MARKER_KINDS) {
    const hits = [];
    let m;
    kind.re.lastIndex = 0;
    while ((m = kind.re.exec(text))) hits.push({ start: m.index, end: m.index + m[0].length });
    if (hits.length >= 2 && hits.length <= 15) byKind[kind.name] = hits;
  }
  const numbered = findNumberedMarkers(text);
  if (numbered) byKind.numbered = numbered;
  const kind = KIND_PRIORITY.find(k => byKind[k]);
  return kind ? { kind, hits: byKind[kind] } : null;
}

/**
 * Split a post's flattened text into one segment per listed grant.
 * Returns null unless at least 2 segments each look like a grant.
 *   { kind, header, segments: [{ text, start, end }] }
 */
function segmentPostText(text) {
  const t = (text || '').trim();
  if (t.length < 60) return null;
  const found = findMarkers(t);
  if (!found) return null;

  const { hits, kind } = found;
  const header = t.slice(0, hits[0].start).trim();
  const raw = hits.map((h, i) => ({
    start: h.end,
    end: i + 1 < hits.length ? hits[i + 1].start : t.length,
  }));

  // Trim the footer/CTA off the last segment (and hashtags off any segment).
  const last = raw[raw.length - 1];
  const lastText = t.slice(last.start, last.end);
  const cut = lastText.slice(20).search(TAIL_CUT_PAT);
  if (cut !== -1) last.end = last.start + 20 + cut;

  const segments = raw
    .map(r => ({ text: t.slice(r.start, r.end).trim(), start: r.start, end: r.end }))
    .map(s => ({ ...s, text: s.text.replace(/\s#[\p{L}\p{N}_].*$/u, '').trim() }))
    .filter(s => looksLikeGrantSegment(s.text, STRICT_KINDS.has(kind)));

  if (segments.length < 2) return null;
  return { kind, header, segments };
}

// ── Titles ───────────────────────────────────────────────────────────────

const DESCRIPTION_START_PAT =
  /\s(?:Cash prizes|Prizes|Grants|Grant funding|Funding|Fellowships|Support|Awards|Financiaci[oó]n|Apoyo)\s+(?:for|to|supporting|recognising|recognizing|helping|that|available|para|que)\b/;
const MONEY_PREFIX_PAT = /^(?:(?:Up to|Hasta|Prizes? up to|From|Desde)\s+)?(?:[$€£]|USD|EUR|GBP)\s?[\d.,]+\s?[kKmM]?\s*[–—-]\s+/;
// Blurbs that open without a lead word ("Sellars Company Growth Grant Free professional support…").
const BLURB_START_PAT = /\s(?:Free\s+(?:[a-z]+\s+)?(?:support|training|mentoring|mentorship|services)|Partnership opportunities|Monthly\s+micro-?grants|Opportunities\s+(?:for|to))\b/;

function deriveSegmentTitle(segText) {
  // Name ends where the link/👉 starts; descriptive blurbs are cut at the
  // first " For <audience>" / " Para ..." / " | " / ": " so a 3-line blurb
  // doesn't become the title. "Up to €100,000 – <Name>" keeps only <Name>.
  let head = segText.split(/👉|🔗|https?:\/\//)[0].trim().replace(MONEY_PREFIX_PAT, '');
  const descAt = head.search(DESCRIPTION_START_PAT);
  if (descAt > 8) head = head.slice(0, descAt);
  const blurbAt = head.search(BLURB_START_PAT);
  if (blurbAt > 8) head = head.slice(0, blurbAt);
  head = head.split(/\s[✅💰📅]/u)[0];
  if (head.length > 100) {
    const cutAt = head.search(/\s(?:For|Para|Dirigido|Open to|Supports?|Funds?|Empowers?)\s|\s\|\s|:\s/);
    if (cutAt > 5) head = head.slice(0, cutAt);
  }
  head = head.slice(0, 120).replace(/[\s\-–—:|,;]+$/u, '').trim();
  return head;
}

// ── Link -> segment assignment ───────────────────────────────────────────

/** Attach each non-junk link to the segment whose text contains it. */
function assignLinksToSegments(text, segments, classifiedLinks) {
  const perSegment = segments.map(() => []);
  const unassigned = [];
  for (const link of classifiedLinks) {
    if (link.junk) continue;
    const at = locateLink(text, link);
    const segIdx = at ? segments.findIndex(s => at.idx >= s.start && at.idx < s.end) : -1;
    if (segIdx >= 0) perSegment[segIdx].push(link);
    else unassigned.push(link);
  }
  return { perSegment, unassigned };
}

module.exports = {
  classifyLinks,
  segmentPostText,
  deriveSegmentTitle,
  assignLinksToSegments,
  locateLink,
  hostOf,
};
