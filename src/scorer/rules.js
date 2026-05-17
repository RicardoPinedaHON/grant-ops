/**
 * Rule-based pre-scoring. Fast, no API calls.
 * Returns partial scores that Claude then refines.
 */

function prescoreGrant(grant, profile) {
  const scores = {};
  const flags = [];

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
  // Rewards grants that explicitly target youth-led or local/national NGOs (Sustenta's profile)
  // Penalizes grants requiring INGO lead, Northern org, or US-based org
  scores.org_type = scoreOrgType(grant, profile);

  // --- Partnership requirements (0–0.3) ---
  scores.partnership = scorePartnership(grant, profile);

  const prescore = scores.geo + scores.size + scores.deadline + scores.org_type + scores.partnership;

  return {
    scores,
    prescore: Math.round(prescore * 100) / 100,
    flags,
    daysRemaining: daysRemaining,
  };
}

function scoreGeography(grant, profile) {
  const country = profile.geography.country.toLowerCase();
  const willing = (profile.geography.willing_to_work_in || []).map(s => s.toLowerCase());
  const grantText = `${grant.title} ${grant.description} ${grant.country || ''}`.toLowerCase();
  // Normalize accented Spanish characters for matching
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

  // No geo mention — don't penalize heavily, let Claude assess
  return 0.55;
}

function scoreSize(grant, profile) {
  const maxWeight = 0.8;
  const { grant_size_min_usd: min, grant_size_max_usd: max,
          grant_size_sweet_spot_min_usd: sweetMin, grant_size_sweet_spot_max_usd: sweetMax } = profile.capacity;

  let grantMax = grant.amount_max;
  let grantMin = grant.amount_min;

  // Try to extract amount from title if not in structured fields
  if (!grantMax && !grantMin) {
    const titleText = `${grant.title} ${grant.description}`;
    const m = titleText.match(/(?:hasta|up to|award.*?)\s*(?:USD?|EUR?|\$|€)\s*([\d.,]+)\s*(?:k\b|mil\b|thousand)?/i) ||
              titleText.match(/(?:USD?|EUR?|\$|€)\s*([\d.,]+)\s*(?:k\b|mil\b|thousand)?/i);
    if (m) {
      let amt = parseFloat(m[1].replace(/,/g, '.').replace(/\./g, ''));
      // Handle European number format (85.000 = 85000)
      if (m[1].includes('.') && !m[1].includes(',')) amt = parseFloat(m[1].replace(/\./g, ''));
      if (/k\b|mil\b|thousand/i.test(m[0])) amt *= 1000;
      if (amt > 100) grantMax = amt;
    }
  }

  // No amount info — neutral score
  if (!grantMax && !grantMin) return maxWeight * 0.7;

  const amount = grantMax || grantMin;

  if (amount < min) return maxWeight * 0.4; // Too small
  if (amount > max * 5) return maxWeight * 0.2; // Way too large for direct application
  if (amount > max) return maxWeight * 0.5; // Large but possible via INGO intermediary
  if (amount >= sweetMin && amount <= sweetMax) return maxWeight * 1.0; // Sweet spot
  if (amount >= min && amount < sweetMin) return maxWeight * 0.75;
  if (amount > sweetMax && amount <= max) return maxWeight * 0.85;

  return maxWeight * 0.7;
}

function scoreDeadline(grant) {
  const maxWeight = 0.7;

  if (!grant.deadline) return { score: maxWeight * 0.8, daysRemaining: null }; // Rolling/unknown

  const deadline = new Date(grant.deadline);
  const now = new Date();
  const daysRemaining = Math.floor((deadline - now) / (1000 * 60 * 60 * 24));

  if (daysRemaining < 0) return { score: 0, daysRemaining }; // Already closed
  if (daysRemaining < 15) return { score: maxWeight * 0.2, daysRemaining };
  if (daysRemaining < 30) return { score: maxWeight * 0.5, daysRemaining };
  if (daysRemaining < 60) return { score: maxWeight * 0.8, daysRemaining };
  return { score: maxWeight * 1.0, daysRemaining };
}

function scoreOrgType(grant, profile) {
  const maxWeight = 0.4;
  const grantText = `${grant.title} ${grant.description}`.toLowerCase();

  // Hard disqualifiers — Sustenta can't lead as an INGO or US-based org
  if (/\bingo\s+lead|\bnorthern\s+(ngo|partner)|us[-\s]based\s+org|501\(c\)|us\s+nonprofit/.test(grantText)) {
    return maxWeight * 0.1;
  }

  // Strong positive — explicitly targets youth-led organizations
  const isYouthLed = /youth[-\s]led|youth[-\s]run|liderada[s]?\s+por\s+j[oó]venes|organizaci[oó]n\s+juvenil/.test(grantText);
  if (isYouthLed) return maxWeight * 1.0;

  // Positive — explicitly local/national NGO, civil society, community org
  const isLocalNGO = /local\s+(ngo|org|civil)|national\s+(ngo|org)|community[-\s]based|cso|organizaci[oó]n\s+local|sociedad\s+civil|ong\s+local/.test(grantText);
  if (isLocalNGO) return maxWeight * 0.95;

  // Mild positive — Southern orgs, developing country orgs
  const isSouthern = /southern\s+(ngo|org|partner)|global\s+south|pa[ií]ses\s+en\s+desarrollo/.test(grantText);
  if (isSouthern) return maxWeight * 0.9;

  // Neutral — no org type signal mentioned (most grants)
  return maxWeight * 0.75;
}

function scorePartnership(grant, profile) {
  const maxWeight = 0.3;
  const grantText = `${grant.title} ${grant.description}`.toLowerCase();

  if (/lead partner|consortium lead|northern partner|northern ngo/.test(grantText)) return maxWeight * 0.4;
  if (/partnership required|must partner/.test(grantText)) return maxWeight * 0.7;
  if (/partnership optional|can partner|may partner/.test(grantText)) return maxWeight * 0.95;
  return maxWeight * 1.0; // No partnership requirement mentioned
}

module.exports = { prescoreGrant };
