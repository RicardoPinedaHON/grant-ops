/**
 * Rule-based pre-scoring. Fast, no API calls.
 * Returns partial scores that Claude then refines.
 *
 * Hard INELIGIBLE filters run first. Any grant that clearly can't be
 * applied to by Sustenta Honduras gets score=0 + flag, no further scoring.
 */

// ── Countries / regions that make a grant explicitly NOT for LAC ─────────────
const NON_LAC_GEOS = [
  // Africa
  'africa', 'ghana', 'kenya', 'nigeria', 'ethiopia', 'tanzania', 'uganda', 'rwanda',
  'mozambique', 'angola', 'zambia', 'zimbabwe', 'mali', 'senegal', 'cameroon',
  'eswatini', 'swaziland', 'malawi', 'botswana', 'namibia', 'south africa',
  'kigali', 'nairobi', 'accra', 'lagos', 'addis ababa',
  // Asia / Pacific
  'asia', 'india', 'pakistan', 'bangladesh', 'vietnam', 'cambodia', 'myanmar',
  'indonesia', 'philippines', 'china', 'thailand', 'nepal', 'sri lanka',
  'pacific islands', 'oceania', 'papua new guinea',
  // Middle East
  'middle east', 'jordan', 'lebanon', 'morocco', 'egypt', 'tunisia', 'iraq', 'iran',
  // Europe (specific programs)
  'ukraine', 'moldova', 'albania', 'georgia', 'armenia', 'azerbaijan',
  'balkans', 'western balkans',
  // Other
  'arctic', 'antarctica',
];

const NON_LAC_PATTERN = new RegExp(
  `\\b(${NON_LAC_GEOS.map(g => g.replace(/[-\s]/g, '[-\\s]')).join('|')})\\b`, 'i'
);

const LAC_SIGNALS = /honduras|central america|latin america|latinoam[eé]rica|am[eé]rica latina|carib|mesoam[eé]rica|centroam[eé]rica|lac\b|global|worldwide|international|developing|oda|lmic/i;

// ── Patterns that disqualify for org-type reasons ────────────────────────────
const SCHOLARSHIP_ONLY = /\b(scholarship|beca[s]?|study grant|academic grant|travel grant|award for student|student fellowship|becas\s+para\s+estudiar|estudia en)\b/i;
const COURSE_NOT_GRANT = /\b(curso\s+de\s|webinar\s|certificaci[oó]n[:\s]|capacitaci[oó]n\s|clase\s+de\s|online course|training course|e-learning|mooc\b)\b/i;
const VC_ONLY          = /\b(venture capital|equity investment|seed funding for startup|startup equity|angel invest|vc fund)\b/i;
const NEWS_ARTICLE     = /^(how |why |what |when |the \w+ making |from |brazil's|china's|microfinance for|financing the)\b/i;
const CONFERENCE_EVENT = /\b(conference|summit|event|gala|forum|symposium|networking event)\b.*\b(call for|submission|abstract|speaker)\b/i;

// ── Hard-filter: returns flags that make grant INELIGIBLE ────────────────────
function checkIneligibility(grant) {
  const title = grant.title || '';
  const desc  = grant.description || '';
  const text  = `${title} ${desc}`;

  // 1. Wrong geography in TITLE (title explicitly names non-LAC place)
  if (NON_LAC_PATTERN.test(title) && !LAC_SIGNALS.test(title)) {
    return ['WRONG_GEOGRAPHY'];
  }

  // 2. Individual scholarship (not org grant) — detected in title
  if (SCHOLARSHIP_ONLY.test(title)) {
    return ['SCHOLARSHIP_ONLY'];
  }

  // 3. Course / certification / webinar (not a grant)
  if (COURSE_NOT_GRANT.test(title) && !/grant|fund|financ|award/i.test(title)) {
    return ['COURSE_NOT_GRANT'];
  }

  // 4. Venture capital / equity — NGOs can't apply
  if (VC_ONLY.test(text)) {
    return ['VC_ONLY'];
  }

  // 5. Pure news headline (no grant signal)
  if (NEWS_ARTICLE.test(title) && !/grant|fund|award|call|proposal|opportunit/i.test(text)) {
    return ['NEWS_ARTICLE'];
  }

  // 6. Conference call for papers / event registration
  if (CONFERENCE_EVENT.test(text)) {
    return ['CONFERENCE_NOT_GRANT'];
  }

  // 7. Entry is just a funder name with no specific opportunity (very short description, no dates/amounts/calls)
  if (
    title.length < 60 &&
    desc.length < 80 &&
    !grant.amount_max &&
    !grant.deadline &&
    !/grant|fund|apply|call|proposal|award|deadline|opportunit/i.test(text)
  ) {
    return ['NO_SPECIFIC_OPPORTUNITY'];
  }

  return [];
}

// ── Main prescore ────────────────────────────────────────────────────────────
function prescoreGrant(grant, profile) {
  const scores = {};
  const flags  = [];

  // Hard ineligibility check first
  const ineligibleFlags = checkIneligibility(grant);
  if (ineligibleFlags.length > 0) {
    flags.push(...ineligibleFlags);
    return {
      scores: { geo: 0, size: 0, deadline: 0, org_type: 0, partnership: 0 },
      prescore: 0,
      flags,
      daysRemaining: null,
    };
  }

  // --- Geographic eligibility (0–1.0) ---
  scores.geo = scoreGeography(grant, profile);
  if (scores.geo === 0) flags.push('INELIGIBLE_GEO');

  // --- Grant size match (0–0.8) ---
  scores.size = scoreSize(grant, profile);

  // --- Deadline feasibility (0–0.7) ---
  const { score: deadlineScore, daysRemaining } = scoreDeadline(grant);
  scores.deadline = deadlineScore;
  if (daysRemaining !== null && daysRemaining < 15) flags.push('DEADLINE_TOO_CLOSE');

  // --- Org type eligibility (0–0.4) ---
  scores.org_type = scoreOrgType(grant, profile);

  // --- Partnership requirements (0–0.3) ---
  scores.partnership = scorePartnership(grant, profile);

  const prescore = scores.geo + scores.size + scores.deadline + scores.org_type + scores.partnership;

  return {
    scores,
    prescore: Math.round(prescore * 100) / 100,
    flags,
    daysRemaining,
  };
}

function scoreGeography(grant, profile) {
  const country = profile.geography.country.toLowerCase();
  const willing = (profile.geography.willing_to_work_in || []).map(s => s.toLowerCase());
  const grantText = `${grant.title} ${grant.description} ${grant.country || ''}`.toLowerCase();
  const grantTextNorm = grantText.normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (grantText.includes(country)) return 1.0;
  if (willing.some(w => grantText.includes(w.split(' ')[0].toLowerCase()))) return 0.9;
  if (grantText.includes('central america') || grantText.includes('mesoamerica') ||
      grantTextNorm.includes('centroamerica') || grantTextNorm.includes('america central')) return 0.85;
  if (grantText.includes('latin america') || grantText.includes('lac') || grantText.includes('caribbean') ||
      grantTextNorm.includes('america latina') || grantTextNorm.includes('latinoamerica') ||
      grantTextNorm.includes('el caribe') || grant.country === 'LAC') return 0.75;
  if (grantText.includes('global') || grantText.includes('worldwide') || grantText.includes('international') ||
      grantText.includes('developing') || grantText.includes('oda') || grantText.includes('lmic')) return 0.6;

  // No geo mention — mildly penalize (don't reward vagueness)
  return 0.45;
}

function scoreSize(grant, profile) {
  const maxWeight = 0.8;
  const { grant_size_min_usd: min, grant_size_max_usd: max,
          grant_size_sweet_spot_min_usd: sweetMin, grant_size_sweet_spot_max_usd: sweetMax } = profile.capacity;

  let grantMax = grant.amount_max;
  let grantMin = grant.amount_min;

  if (!grantMax && !grantMin) {
    const titleText = `${grant.title} ${grant.description}`;
    const m = titleText.match(/(?:hasta|up to|award.*?)\s*(?:USD?|EUR?|\$|€)\s*([\d.,]+)\s*(?:k\b|mil\b|thousand)?/i) ||
              titleText.match(/(?:USD?|EUR?|\$|€)\s*([\d.,]+)\s*(?:k\b|mil\b|thousand)?/i);
    if (m) {
      let amt = parseFloat(m[1].replace(/,/g, '.').replace(/\./g, ''));
      if (m[1].includes('.') && !m[1].includes(',')) amt = parseFloat(m[1].replace(/\./g, ''));
      if (/k\b|mil\b|thousand/i.test(m[0])) amt *= 1000;
      if (amt > 100) grantMax = amt;
    }
  }

  if (!grantMax && !grantMin) return maxWeight * 0.65; // Unknown — slightly below neutral

  const amount = grantMax || grantMin;

  if (amount < min) return maxWeight * 0.4;
  if (amount > max * 5) return maxWeight * 0.2;
  if (amount > max) return maxWeight * 0.5;
  if (amount >= sweetMin && amount <= sweetMax) return maxWeight * 1.0;
  if (amount >= min && amount < sweetMin) return maxWeight * 0.75;
  if (amount > sweetMax && amount <= max) return maxWeight * 0.85;

  return maxWeight * 0.65;
}

function scoreDeadline(grant) {
  const maxWeight = 0.7;

  if (!grant.deadline || grant.deadline === 'rolling') {
    return { score: maxWeight * 0.75, daysRemaining: null }; // Rolling — slight downweight vs firm date
  }

  const deadline      = new Date(grant.deadline);
  const now           = new Date();
  const daysRemaining = Math.floor((deadline - now) / (1000 * 60 * 60 * 24));

  if (daysRemaining < 0)  return { score: 0, daysRemaining };
  if (daysRemaining < 15) return { score: maxWeight * 0.2, daysRemaining };
  if (daysRemaining < 30) return { score: maxWeight * 0.5, daysRemaining };
  if (daysRemaining < 60) return { score: maxWeight * 0.8, daysRemaining };
  return { score: maxWeight * 1.0, daysRemaining };
}

function scoreOrgType(grant, profile) {
  const maxWeight = 0.4;
  const grantText = `${grant.title} ${grant.description}`.toLowerCase();

  if (/\bingo\s+lead|\bnorthern\s+(ngo|partner)|us[-\s]based\s+org|501\(c\)|us\s+nonprofit/.test(grantText)) {
    return maxWeight * 0.1;
  }

  const isYouthLed = /youth[-\s]led|youth[-\s]run|liderada[s]?\s+por\s+j[oó]venes|organizaci[oó]n\s+juvenil/.test(grantText);
  if (isYouthLed) return maxWeight * 1.0;

  const isLocalNGO = /local\s+(ngo|org|civil)|national\s+(ngo|org)|community[-\s]based|cso|organizaci[oó]n\s+local|sociedad\s+civil|ong\s+local/.test(grantText);
  if (isLocalNGO) return maxWeight * 0.95;

  const isSouthern = /southern\s+(ngo|org|partner)|global\s+south|pa[ií]ses\s+en\s+desarrollo/.test(grantText);
  if (isSouthern) return maxWeight * 0.9;

  return maxWeight * 0.75;
}

function scorePartnership(grant, profile) {
  const maxWeight = 0.3;
  const grantText = `${grant.title} ${grant.description}`.toLowerCase();

  if (/lead partner|consortium lead|northern partner|northern ngo/.test(grantText)) return maxWeight * 0.4;
  if (/partnership required|must partner/.test(grantText)) return maxWeight * 0.7;
  if (/partnership optional|can partner|may partner/.test(grantText)) return maxWeight * 0.95;
  return maxWeight * 1.0;
}

module.exports = { prescoreGrant };
