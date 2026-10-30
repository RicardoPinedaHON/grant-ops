'use strict';

// Shared utility for fuzzy grant identity — used by dedup and history tracker.

const AGGREGATOR_DOMAINS = new Set([
  'reliefweb.int','devex.com','fundsforngos.org','wepropel.org',
  // 'easygrant.org' and 'leadersoftoday.org' were both WRONG (confirmed
  // 2026-08-25, live) — the real domains those scrapers actually use are
  // app.easygrant.io and www.leadersoftoday.com (see portals.js). Because
  // urlDomain() only strips a literal "www." prefix (not "app."), the
  // entry has to be the exact subdomain "app.easygrant.io", not just
  // "easygrant.io". This silently broke the whole point of listing them:
  // grantsMatch() and grantFingerprint() both treat two grants on the same
  // NON-aggregator domain as automatically the same grant, so two
  // completely unrelated EasyGrant-hosted listings ("Hispanic Impact Fund"
  // / Austin Community Foundation, and "Global Innovation Challenge 2026"
  // / Social Shifters) were being matched as duplicates purely because
  // EasyGrant hosts thousands of unrelated grants under one shared domain
  // with different list IDs in the path — caught live when
  // filterAlreadyResearchedDuplicates() (deep-research.js) nearly skipped
  // a genuinely different grant as a false-positive duplicate.
  'app.easygrant.io','terra-viva-grants.org','mail.beehiiv.com',
  'substack.com','opportunitydesk.org','opportunitytracker.ug',
  'leadersoftoday.com','undp.org','globalgiving.org','gestionandote.org',
  // lnkd.in is LinkedIn's own URL shortener — every post on every LinkedIn
  // page redirects through this ONE domain regardless of funder, so treating
  // it as a "same domain = same grant" signal (the non-aggregator branch in
  // grantsMatch) would collapse unrelated LinkedIn-sourced grants into one.
  'lnkd.in',
  // linkedin.com itself: link-less LinkedIn posts fall back to the company
  // page url, so every such grant shared one fingerprint ("linkedin.com||")
  // and exact-url equality — the 2nd and 3rd grant of a post (and any later
  // link-less post) were dropped as duplicates of the first. A LinkedIn page
  // url identifies the poster, never the grant. Subdomains (es.linkedin.com)
  // are covered by isAggregatorDomain().
  'linkedin.com',
]);

function isAggregatorDomain(domain) {
  return AGGREGATOR_DOMAINS.has(domain) || /(^|\.)linkedin\.com$/.test(domain || '');
}

const GENERIC_ACRONYMS = new Set([
  'SDG','SDGS','NGO','NGOS','CSO','CBO','UN','EU','US','USA','AI','ICT',
  'GHG','CO2','COP','HIV','AIDS','LGBTQ','CEO','CFO','CTO','PMO',
]);

const TITLE_STOP = new Set([
  'grant','grants','fund','funds','the','a','an','for','of','to','in','at',
  'from','program','programme','initiative','award','awards','fellowship',
  'fellowships','call','challenge','opportunity','opportunities','support',
  'project','projects','round','open','new','special','international','national',
  'global','small','and','or','with','by','on','its','this','that','are','was',
  'para','del','los','las','una','por','con','sobre','hacia','este','esta',
  'accion','fondos',
]);

function cleanUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url.trim());
    return (u.hostname.replace(/^www\./, '') + u.pathname)
      .replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/[?#].*/, '').replace(/\/$/, '');
  }
}

function urlDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function urlPathSegments(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean); } catch { return []; }
}

// Funder sites like solve.mit.edu/challenges/<slug> host MANY distinct
// programs under one domain. A deep path (2+ segments) identifies the
// program; a shallow one (/apply, /how-to-apply) is just a page of one
// program, so those stay collapsible by domain+year like before.
function programPathKey(url) {
  const segs = urlPathSegments(url);
  if (segs.length < 2) return '';
  return segs.join('/').toLowerCase().replace(/\b20\d{2}\b/g, '').replace(/-{2,}/g, '-').replace(/-\//g, '/').replace(/\/-/g, '/').replace(/-$/, '');
}

function extractYear(title) {
  const m = (title || '').match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

function extractAcronyms(title) {
  return (title.match(/\b[A-Z]{3,}\b/g) || [])
    .filter(ac => !GENERIC_ACRONYMS.has(ac));
}

function titleWords(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b\d{4}\b/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !TITLE_STOP.has(w));
}

// True when both URLs sit on the same non-aggregator host but point at
// different deep program pages AND the titles give no evidence they are the
// same grant (no shared acronym, <50% distinctive-word overlap). Confirmed
// live 2026-10-30: "2027 Global Health Challenge" and "2027 Global Economic
// Prosperity Challenge" (both solve.mit.edu/challenges/...) were collapsed as
// duplicates, so the second one was silently dropped.
function sameHostDifferentProgram(a, b) {
  const da = urlDomain(a.url), db = urlDomain(b.url);
  if (!da || da !== db || isAggregatorDomain(da)) return false;
  const pa = programPathKey(a.url), pb = programPathKey(b.url);
  if (!pa || !pb || pa === pb) return false;
  const acA = extractAcronyms(a.title || ''), acB = extractAcronyms(b.title || '');
  if (acA.some(ac => acB.includes(ac))) return false;
  const wa = new Set(titleWords(a.title || '').concat(pa.split(/[\/-]/).filter(w => w.length >= 4 && !TITLE_STOP.has(w))));
  const wb = new Set(titleWords(b.title || '').concat(pb.split(/[\/-]/).filter(w => w.length >= 4 && !TITLE_STOP.has(w))));
  const shared = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return !(union && shared / union >= 0.5);
}

function grantsMatch(a, b) {
  const ua = cleanUrl(a.url), ub = cleanUrl(b.url);
  // Identical LinkedIn page urls say nothing about the grant (see above).
  if (ua && ub && ua === ub && !/^([\w-]+\.)*linkedin\.com(\/|$)/.test(ua)) return true;
  if (sameHostDifferentProgram(a, b)) return false;

  const da = urlDomain(a.url), db = urlDomain(b.url);
  if (da && db && da === db && da.length > 0 && !isAggregatorDomain(da)) {
    // Same funder site — but different annual rounds (different years) are different grants
    const yearA = extractYear(a.title), yearB = extractYear(b.title);
    if (yearA && yearB && yearA !== yearB) return false;
    return true;
  }

  const acA = extractAcronyms(a.title || '');
  const acB = extractAcronyms(b.title || '');
  const sharedAc = acA.filter(ac => acB.includes(ac));
  if (sharedAc.length > 0) {
    const yearA = extractYear(a.title), yearB = extractYear(b.title);
    if (yearA && yearB && yearA !== yearB) return false;
    return true;
  }

  const wa = new Set(titleWords(a.title || ''));
  const wb = new Set(titleWords(b.title || ''));
  if (wa.size >= 3 && wb.size >= 3) {
    const shared = [...wa].filter(w => wb.has(w)).length;
    const union  = new Set([...wa, ...wb]).size;
    if (shared / union >= 0.60) {
      const yearA = extractYear(a.title), yearB = extractYear(b.title);
      if (yearA && yearB && yearA !== yearB) return false;
      return true;
    }
  }

  // Short-title exact match (Ricardo, 2026-09-12 — confirmed live: "Stanley
  // 1913 Creators Fund" vs "Stanley 1913 Creators Fund – 2026 Program", a
  // real duplicate across EasyGrant and the funder's own site, has only 2
  // significant words each after stopword/year stripping — under the
  // general >= 3 branch above, too short to ever qualify no matter how
  // identical). Requiring EXACT set equality (not just >= 0.60 overlap)
  // for these short 2-word cases avoids the false-positive risk a looser
  // threshold would introduce (e.g. "Youth Climate Fund" / "Youth Climate
  // Prize" sharing 2 of 3 words at 67% — clearly different programs).
  // Known remaining gap, NOT covered by this: an acronym-only name vs its
  // fully-spelled-out official name sharing zero literal tokens (e.g. "GEF
  // SGP CSO Challenge" vs "Global Environment Facility - Small Grants
  // Program - CSO Challenge Program") — that needs an acronym-expansion
  // glossary, out of scope here.
  if (wa.size === 2 && wb.size === 2 && wa.size === wb.size) {
    const shared = [...wa].filter(w => wb.has(w)).length;
    if (shared === 2) {
      const yearA = extractYear(a.title), yearB = extractYear(b.title);
      if (yearA && yearB && yearA !== yearB) return false;
      return true;
    }
  }

  return false;
}

// Stable fingerprint for cross-scan identity (includes year so 2026 ≠ 2027 rounds).
// For non-aggregator domains, uses domain+year only (any variant of the same grant on the
// same funder site in the same year collapses to one key).
// For aggregator-sourced grants (no stable domain), falls back to title words.
function grantFingerprint(grant) {
  const domain = urlDomain(grant.url || '');
  const isAgg  = !domain || isAggregatorDomain(domain);
  const year   = extractYear(grant.title || '') || '';

  if (!isAgg) {
    // Same funder site + same year = same grant (small funders have 1 active round/year)
    // NOTE: this format is the persisted Notion identity key — do NOT change it
    // (CLAUDE.md, "Duplicate-of-already-researched filter"). Hosts with many
    // programs are told apart by grantsMatch()/isKnown() via sameHostDifferentProgram().
    return `${domain}||${year}`;
  }

  // Aggregator or no domain: use acronym + title words + year
  const acronyms = extractAcronyms(grant.title || '');
  const words    = titleWords(grant.title || '').slice(0, 5);
  const textPart = [...acronyms.slice(0, 2), ...words].slice(0, 5).join('-');

  const fp = `|${textPart}|${year}`;
  return fp.length > 3 ? fp : '';
}

module.exports = {
  cleanUrl, urlDomain, extractYear, extractAcronyms,
  titleWords, grantsMatch, grantFingerprint, sameHostDifferentProgram, programPathKey,
  AGGREGATOR_DOMAINS, isAggregatorDomain, GENERIC_ACRONYMS, TITLE_STOP,
};
