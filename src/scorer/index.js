const { prescoreGrant } = require('./rules');
const { buildScoringPrompt } = require('./prompts');

/**
 * Scores grants in two stages:
 * 1. Rule-based pre-score (fast, no API)
 * 2. Claude AI scoring for mission alignment + strategic fit
 *
 * When running via Claude Code, Claude itself calls scoreWithClaude()
 * using its native capabilities — no API key needed.
 */

const SKIP_THRESHOLD = 1.5;
// Recalibrated after adding competitive_fit (-0.5 to 0.0) dimension.
// competitive_fit brings max possible from ~4.5 → 4.0 for well-matched grants.
// A grant needs both strong thematic alignment AND realistic win probability for APPLY_NOW.
const RECOMMEND_THRESHOLD = 3.8;
const CONSIDER_THRESHOLD = 3.2;

// Flags that make a grant INELIGIBLE (not just Skip, a hard NO)
const INELIGIBLE_FLAGS = [
  'WRONG_GEOGRAPHY', 'SCHOLARSHIP_ONLY', 'COURSE_NOT_GRANT',
  'VC_ONLY', 'NEWS_ARTICLE', 'CONFERENCE_NOT_GRANT',
  'NO_SPECIFIC_OPPORTUNITY', 'INELIGIBLE_GEO',
];

function scoreGrantRules(grant, profile) {
  const prescore = prescoreGrant(grant, profile);
  return prescore;
}

function buildPromptForClaude(grant, profile) {
  const prescore = prescoreGrant(grant, profile);

  if (prescore.flags.includes('INELIGIBLE_GEO')) {
    return null;
  }
  // Skip expired grants
  if (prescore.daysRemaining !== null && prescore.daysRemaining < 0) {
    return null;
  }
  if (prescore.prescore < SKIP_THRESHOLD) {
    return null;
  }
  // Skip obvious news articles that aren't grant calls
  if (isNewsArticle(grant)) {
    return null;
  }

  return {
    prompt: buildScoringPrompt(grant, profile, prescore),
    prescore,
  };
}

function combineScores(prescore, claudeResponse) {
  const missionAlignment = claudeResponse.mission_alignment || 0;
  const competitiveFit = claudeResponse.competitive_fit ?? 0; // -0.5 to 0.0
  const strategicFit = claudeResponse.strategic_fit || 0;
  const total = prescore.prescore + missionAlignment + competitiveFit + strategicFit;
  const finalScore = Math.min(Math.round(total * 100) / 100, 5.0);

  let recommendation;
  if (claudeResponse._ineligible || prescore.flags.some(f => INELIGIBLE_FLAGS.includes(f))) {
    recommendation = 'INELIGIBLE';
  } else if (prescore.flags.includes('DEADLINE_TOO_CLOSE')) {
    recommendation = 'SKIP';
  } else if (finalScore >= RECOMMEND_THRESHOLD) {
    recommendation = 'APPLY_NOW';
  } else if (finalScore >= CONSIDER_THRESHOLD) {
    recommendation = 'CONSIDER';
  } else if (finalScore >= 2.5) {
    recommendation = 'MONITOR';
  } else {
    recommendation = 'SKIP';
  }

  return {
    final_score: finalScore,
    recommendation,
    scores: {
      ...prescore.scores,
      mission_alignment: missionAlignment,
      competitive_fit: competitiveFit,
      strategic_fit: strategicFit,
    },
    flags: prescore.flags,
    best_projects: claudeResponse.best_projects || [],
    application_angle: claudeResponse.application_angle || null,
    confidence: claudeResponse.confidence || 'medium',
    reasoning: claudeResponse.reasoning || '',
    days_remaining: prescore.daysRemaining,
  };
}

function scoreWithoutClaude(grant, profile) {
  const prescore = prescoreGrant(grant, profile);
  const estimatedMission = estimateMissionAlignment(grant, profile);
  const total = prescore.prescore + estimatedMission;

  let recommendation = 'REVIEW_MANUALLY';
  if (prescore.flags.includes('INELIGIBLE_GEO')) recommendation = 'SKIP';
  else if (total >= RECOMMEND_THRESHOLD) recommendation = 'LIKELY_GOOD';
  else if (total < 2.0) recommendation = 'SKIP';

  return {
    final_score: Math.min(Math.round(total * 100) / 100, 5.0),
    recommendation,
    scores: { ...prescore.scores, mission_alignment: estimatedMission, strategic_fit: 0 },
    flags: [...prescore.flags, 'RULE_BASED_ONLY'],
    best_projects: [],
    application_angle: null,
    confidence: 'low',
    reasoning: 'Scored using rules only — run full scan with Claude Code for AI analysis.',
    days_remaining: prescore.daysRemaining,
  };
}

function estimateMissionAlignment(grant, profile) {
  const maxWeight = 1.2;
  const text = `${grant.title} ${grant.description}`.toLowerCase();
  const focusKeywords = profile.mission.primary_focus.flatMap(f => f.split('_'));
  const projectKeywords = profile.mission.projects.flatMap(p => p.tags);
  const allKeywords = [...new Set([...focusKeywords, ...projectKeywords])];

  const matches = allKeywords.filter(kw => text.includes(kw.toLowerCase())).length;
  const ratio = Math.min(matches / 5, 1); // Saturate at 5 keyword matches
  return Math.round(maxWeight * ratio * 100) / 100;
}

// Patterns that indicate a news report rather than a grant call
const NEWS_PATTERNS = [
  /\bupdate\b.*\d{4}/i,
  /\boperational update\b/i,
  /\bsituation report\b/i,
  /\bflash appeal\b/i,
  /\b101:\s+an explainer\b/i,
  /\bmonthly bulletin\b/i,
  /\bnational society\b.*\bupdate\b/i,
];

const GRANT_SIGNALS = [
  /call for proposal/i, /request for application/i, /rfp\b/i, /rfa\b/i,
  /grant[s]?\s+(?:program|opportunity|call|fund)/i,
  /fund[s]?\s+for\s+ngo/i,
  /small grant/i, /fellowship/i, /award.*application/i,
  /convocatoria/i, /beca/i, /fondo/i, /oportunidad/i,
];

function isNewsArticle(grant) {
  const text = `${grant.title} ${grant.description}`.toLowerCase();
  const hasNewsPattern = NEWS_PATTERNS.some(p => p.test(grant.title));
  const hasGrantSignal = GRANT_SIGNALS.some(p => p.test(text));
  // If it looks like a news report AND has no grant signals, skip it
  if (hasNewsPattern && !hasGrantSignal) return true;
  // If description is empty and title has no grant signal, and it's from ReliefWeb reports, skip
  if (!grant.description && !hasGrantSignal && grant.url?.includes('/report/')) return true;
  return false;
}

module.exports = {
  scoreGrantRules,
  buildPromptForClaude,
  combineScores,
  scoreWithoutClaude,
  isNewsArticle,
  SKIP_THRESHOLD,
  RECOMMEND_THRESHOLD,
  CONSIDER_THRESHOLD,
};
