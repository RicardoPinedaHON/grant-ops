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
  // Startup Networks re-lists other funders' grants under /links/link/<id>-<slug>.
  'startupnetworks.co.uk',
]);

// Hosts where "same domain" proves nothing about the grant, for grantsMatch() ONLY.
// Deliberately NOT part of AGGREGATOR_DOMAINS: that list also feeds grantFingerprint(), the
// persisted Notion/history identity key, and changing it would re-key existing grants.
//  - link shorteners and form/file hosts: one short domain fronts thousands of unrelated pages
//  - grant-news and listing sites (Fondos y Convocatorias posts opinion pieces and workshops;
//    ONGLink lists dozens of unrelated programs): everything on them used to match everything
const SAME_SITE_PROVES_NOTHING = new Set([
  'bit.ly','tinyurl.com','t.co','buff.ly','ow.ly','cutt.ly','rb.gy','is.gd','goo.gl',
  'docs.google.com','drive.google.com','forms.gle','forms.office.com',
  'fondosyconvocatorias.com.mx','onglink.org',
]);

function isAggregatorDomain(domain) {
  return AGGREGATOR_DOMAINS.has(domain) || /(^|\.)linkedin\.com$/.test(domain || '');
}

const GENERIC_ACRONYMS = new Set([
  'SDG','SDGS','NGO','NGOS','CSO','CBO','UN','EU','US','USA','AI','ICT',
  'GHG','CO2','COP','HIV','AIDS','LGBTQ','CEO','CFO','CTO','PMO',
  // Spanish: ordinary words and generic terms that all-caps headlines turn into "acronyms"
  'ONG','ONGS','OSC','PARA','CON','DEL','LOS','LAS','UNA','POR','SUS','MAS','QUE',
]);

// Institutions that run MANY programs. Sharing "UNICEF" or "MIT" says nothing about
// whether two titles are the same grant ("UNICEF Femtech Ventures" vs "UNICEF Venture
// Fund" vs "UNICEF Bolivia consultancy"; two different MIT Solve challenges — all merged
// by the shared-acronym rule, found 2026-11-03). A program acronym (YCJF, SGP) still
// identifies a grant; these only count together with real word overlap.
const INSTITUTION_ACRONYMS = new Set([
  'UNICEF','UNDP','UNEP','UNFPA','UNESCO','UNHCR','UNIDO','UNOPS','UNCTAD','UNAIDS','UNODC','OCHA','OHCHR',
  'FAO','WHO','WFP','IFAD','ILO','IOM','ITU','WIPO','OECD','OAS','OEA',
  'USAID','FCDO','DFID','GIZ','AFD','SIDA','NORAD','JICA','KOICA','DANIDA','EIB','EBRD','IFC','IDB','CAF',
  'GEF','GCF','IUCN','WWF','CEPF','IKI','MIT','NASA','NSF','NIH','USDA','NEA','NEH','EPA','UKRI','CIFF',
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

// Scraped titles sometimes use Unicode look-alikes ("𝐌𝐈𝐓 𝐒𝐨𝐥𝐯𝐞", fullwidth, ligatures) that
// every \w / [a-z] test reads as nothing, so the same grant in two posts never matched.
const fold = t => String(t || '').normalize('NFKC');

function extractYear(title) {
  const m = (title || '').match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

function extractAcronyms(title) {
  const t = fold(title);
  // A headline written in capitals ("CONVOCATORIA INTERNACIONAL PARA ONG") has no acronyms:
  // every word looks like one.
  // Only for real headlines (3+ capitalised words): "STEM K-12" is a short name, not shouting.
  if (!/[a-z]/.test(t) && (t.match(/\b[A-Z]{3,}\b/g) || []).length >= 3) return [];
  return (t.match(/\b[A-Z]{3,}\b/g) || [])
    .filter(ac => !GENERIC_ACRONYMS.has(ac));
}

// Acronyms that identify a program (not just an institution that has many).
function programAcronyms(title) {
  return extractAcronyms(title).filter(ac => !INSTITUTION_ACRONYMS.has(ac));
}

function titleWords(title) {
  return fold(title)
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
  const acA = programAcronyms(a.title || ''), acB = programAcronyms(b.title || '');
  if (acA.some(ac => acB.includes(ac))) return false;
  // The titles alone already agree ("Relx Environmental Challenge 2025" vs "RELX
  // Environmental Challenge", relx.com, different paths — a live-confirmed repeat):
  // path words must not dilute that into "different program".
  const tA = new Set(titleWords(a.title || '')), tB = new Set(titleWords(b.title || ''));
  const tShared = [...tA].filter(w => tB.has(w)).length, tUnion = new Set([...tA, ...tB]).size;
  if (tA.size >= 2 && tB.size >= 2 && tShared / tUnion >= 0.8) return false;
  const wa = new Set(titleWords(a.title || '').concat(pa.split(/[\/-]/).filter(w => w.length >= 4 && !TITLE_STOP.has(w))));
  const wb = new Set(titleWords(b.title || '').concat(pb.split(/[\/-]/).filter(w => w.length >= 4 && !TITLE_STOP.has(w))));
  const shared = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return !(union && shared / union >= 0.5);
}

// "GirlUp Project Awards" vs "Girl Up Project Awards 2026": same title once
// spaces, punctuation, diacritics and the year are gone. Compound-word spelling
// differences defeat word-overlap matching (found by the LinkedIn repeat audit,
// 2026-10-30). Short titles are excluded to avoid accidental collisions.
function squashTitle(title) {
  return fold(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b20\d{2}\b/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}

// Acronym <-> spelled-out name for funders whose programs show up both ways
// ("UNEP Small Grants Program 2026" vs "UN Environment Programme Small Grants
// Programme"). Deliberately small; add entries as real pairs are found. A match
// through this table also requires the REST of the title to agree, so
// "UNEP Finance Initiative" is not treated as "UNEP Small Grants".
const ACRONYM_EXPANSIONS = [
  ['UNEP', /\b(?:united nations|un) environment(?:al)? programme?\b/i],
  ['GEF', /\bglobal environment(?:al)? facility\b/i],
  ['UNDP', /\bunited nations development programme?\b/i],
  ['GCF', /\bgreen climate fund\b/i],
  ['IDB', /\binter-?american development bank\b/i],
  ['IUCN', /\binternational union for conservation of nature\b/i],
  ['FAO', /\bfood and agriculture organization\b/i],
  ['IKI', /\binternational climate initiative\b/i],
];
const GLOSSARY_ACRONYMS = new Set(ACRONYM_EXPANSIONS.map(([ac]) => ac));
const RESIDUAL_FILLER = new Set(['the','and','for','of','to','in','call','grant','grants','fund','funds','program','programme','programa','initiative','award','awards']);

function expandKnownAcronyms(title) {
  let t = title || '';
  for (const [ac, re] of ACRONYM_EXPANSIONS) t = t.replace(re, ac);
  return t;
}

function residualWords(title, acronyms) {
  return new Set((title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b20\d{2}\b/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !RESIDUAL_FILLER.has(w) && !acronyms.some(ac => ac.toLowerCase() === w)));
}

function yearsCompatible(a, b) {
  const yearA = extractYear(a.title), yearB = extractYear(b.title);
  return !(yearA && yearB && yearA !== yearB);
}

// Sibling programs of one funder whose titles differ by a single distinctive
// word, which word-overlap matching reads as the same grant. Confirmed
// 2026-11-03 (web check): Social Shifters "Global Innovation Challenge" (up to
// $15k, closes Aug 31) and the Allianz x Social Shifters "MoveNow Social
// Innovation Challenge" (up to $90k, closes Dec 18) are separate calls with
// separate applications. Add entries only for pairs confirmed to be distinct.
const PROGRAM_VARIANT_TOKENS = ['movenow'];

// Title AND url: the Notion page "Allianz Social Shifters 2026" is the MoveNow
// call only by its url (leadersoftoday.com/.../allianz-movenow-...-2026).
function variantTokens(grant) {
  const t = squashTitle(grant.title) + cleanUrl(grant.url).replace(/[^a-z0-9]/g, '');
  return PROGRAM_VARIANT_TOKENS.filter(tok => t.includes(tok));
}

function differentVariants(a, b) {
  const va = variantTokens(a), vb = variantTokens(b);
  return va.length !== vb.length || va.some(tok => !vb.includes(tok));
}

const UNINFORMATIVE_URL = /^(?:(?:[\w-]+\.)*linkedin\.com|(?:bit\.ly|tinyurl\.com|t\.co|buff\.ly|ow\.ly|cutt\.ly|rb\.gy|is\.gd|goo\.gl))(?:\/|$)/;

function grantsMatch(a, b) {
  const ua = cleanUrl(a.url), ub = cleanUrl(b.url);
  // Identical LinkedIn page urls say nothing about the grant (see above), and neither
  // does one link shortener shared by several posts (every Funds4impact post carried
  // bit.ly/CursoVirtual2026, a course ad, and all of them matched each other).
  if (ua && ub && ua === ub && !UNINFORMATIVE_URL.test(ua)) return true;
  if (sameHostDifferentProgram(a, b)) return false;
  if (differentVariants(a, b)) return false;

  const da = urlDomain(a.url), db = urlDomain(b.url);
  if (da && db && da === db && da.length > 0 && !isAggregatorDomain(da) && !SAME_SITE_PROVES_NOTHING.has(da)) {
    // Same funder site — but different annual rounds (different years) are different grants
    const yearA = extractYear(a.title), yearB = extractYear(b.title);
    if (yearA && yearB && yearA !== yearB) return false;
    return true;
  }

  // Spelled-out vs acronym form of a known funder (see ACRONYM_EXPANSIONS).
  const ea = expandKnownAcronyms(a.title), eb = expandKnownAcronyms(b.title);
  if (ea !== a.title || eb !== b.title) {
    const shared = extractAcronyms(ea).filter(ac => GLOSSARY_ACRONYMS.has(ac) && extractAcronyms(eb).includes(ac));
    if (shared.length && yearsCompatible(a, b)) {
      const ra = residualWords(ea, shared), rb = residualWords(eb, shared);
      if (ra.size === rb.size && [...ra].every(w => rb.has(w))) return true;
    }
  }

  const sqA = squashTitle(a.title), sqB = squashTitle(b.title);
  if (sqA.length >= 12 && sqA === sqB && yearsCompatible(a, b)) return true;

  const acA = programAcronyms(a.title || '');
  const acB = programAcronyms(b.title || '');
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
  squashTitle, yearsCompatible, differentVariants, variantTokens,
  AGGREGATOR_DOMAINS, isAggregatorDomain, GENERIC_ACRONYMS, TITLE_STOP, INSTITUTION_ACRONYMS, programAcronyms,
};
