'use strict';
// Funder-qualified titles (Ricardo, 2026-10-26): newsletter/digest sources
// hand us program names that mean nothing on their own ("Introductory
// Grants", "Fall Grant Cycle", "STEM K-12", "Community Grants"). In Notion
// those rows are impossible to tell apart. When a title is generic AND the
// funder is known for certain, the title becomes "<Funder> — <Program>".
// A funder we cannot trust (an aggregator's own name, or nothing) is never
// guessed: the title is left alone rather than given a wrong prefix.

const STOP = new Set([
  'the', 'of', 'and', 'for', 'de', 'la', 'el', 'los', 'las', 'y', 'para', 'en', 'del',
  'fund', 'fondo', 'foundation', 'fundacion', 'fundación', 'trust', 'inc', 'org',
]);

// Words that carry no identity on their own — a title made only of these
// (plus numbers/years) is generic no matter how many words it has.
const GENERIC_WORDS = new Set([
  'grant', 'grants', 'program', 'programme', 'programa', 'programas', 'call', 'calls',
  'convocatoria', 'cycle', 'round', 'fall', 'spring', 'summer', 'winter', 'annual',
  'general', 'community', 'communities', 'introductory', 'small', 'large', 'open',
  'application', 'applications', 'funding', 'fellowship', 'fellowships', 'award',
  'awards', 'challenge', 'initiative', 'opportunity', 'opportunities', 'fondo', 'fondos',
  'new', 'cycle', 'grantmaking', 'impact', 'partners', 'catalyst', 'stem', 'k12',
  'apply', 'now', 'cohort', 'prize', 'prizes', 'support', 'capital', 'seed',
]);

function words(s) {
  return (String(s || '').toLowerCase().match(/[a-záéíóúñü0-9]+/g) || []);
}

function significant(s) {
  return words(s).filter(w => w.length > 2 && !STOP.has(w));
}

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñü]/g, '');

function funderAppearsIn(title, funder) {
  const fw = significant(funder);
  if (!fw.length) return true; // nothing to qualify with
  const tw = new Set(words(title));
  if (fw.some(w => tw.has(w))) return true;
  // Scrapers sometimes store the funder as a domain-style run-together
  // ("sparkplugfoundation") — compare with spaces/punctuation removed too.
  const st = squash(title), sf = squash(funder);
  return st.includes(sf) || sf.includes(st);
}

// Identity words = what is left after dropping stopwords, generic program
// vocabulary, bare numbers/years. "Fall Grant Cycle" -> [] ; "Partners
// Fellowship" -> [] ; "Cities Deliver" -> ["cities","deliver"] (kept:
// distinctive enough to keep without a prefix — but see ≤2 rule below).
function identityWords(title) {
  return words(title).filter(w =>
    w.length > 2 && !STOP.has(w) && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w));
}

function isGenericTitle(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  return identityWords(t).length <= 1;
}

// funder is trusted only when it is not just the name of the channel the
// grant came through (e.g. "Leaders of Today Opportunities" posting about
// someone else's grant, or a newsletter's own name).
function funderIsReliable(funder, source) {
  const f = String(funder || '').trim();
  if (f.length < 3) return false;
  // Garbled or multi-funder values ("A | B", "UNDP, EU, UK, Finland") and
  // description-length strings are not one funder name — don't prefix.
  if (/[|,;]/.test(f) || f.length > 45 || words(f).length > 6) return false;
  const fw = significant(f);
  if (!fw.length) return false;
  const sw = new Set(significant(source));
  if (fw.every(w => sw.has(w))) return false; // funder == the channel
  return true;
}

function qualifyTitle(title, funder, source) {
  const t = String(title || '').trim();
  if (!t || !isGenericTitle(t)) return t;
  if (!funderIsReliable(funder, source)) return t;
  if (funderAppearsIn(t, funder)) return t;
  return `${String(funder).trim()} — ${t}`;
}

module.exports = { isGenericTitle, funderIsReliable, qualifyTitle, identityWords };
