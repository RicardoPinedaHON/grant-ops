/**
 * Builds the Claude scoring prompt for a grant.
 * Called by Claude Code — no API key needed.
 */

function buildScoringPrompt(grant, profile, prescore) {
  const orgName = profile.organization.name;
  const orgSummary = buildOrgSummary(profile);
  const grantSummary = buildGrantSummary(grant, prescore);
  const gapsBlock = buildGapsBlock(profile);

  return `You are evaluating a grant opportunity for an NGO. Score this grant on THREE dimensions below.

## NGO Profile
${orgSummary}

## Known Gaps & Hard Limits (MUST factor into competitive_fit)
${gapsBlock}

## Grant Opportunity
${grantSummary}

## Rule-based pre-scores already calculated (out of max shown):
- Geographic eligibility: ${prescore.scores.geo.toFixed(2)} / 1.0
- Grant size match: ${prescore.scores.size.toFixed(2)} / 0.8
- Deadline feasibility: ${prescore.scores.deadline.toFixed(2)} / 0.7
- Org type eligibility: ${(prescore.scores.org_type ?? prescore.scores.language ?? 0).toFixed(2)} / 0.4
- Partnership: ${prescore.scores.partnership.toFixed(2)} / 0.3
- Pre-score subtotal: ${prescore.prescore.toFixed(2)} / 3.2

## Your task: Score the remaining THREE dimensions

**1. Mission alignment (0–1.2 points)**
Does this grant's focus area genuinely match the NGO's work?
- 1.2 = Perfect: grant explicitly funds this NGO's exact work — see its specific projects and focus areas above
- 0.9 = Strong: grant funds the broad theme (per primary_focus) in eligible geography
- 0.6 = Partial: adjacent work (e.g. public health, WASH, governance for an environmental org) with plausible bridge
- 0.3 = Weak: broad development grant, the NGO's focus area is a minor component
- 0.0 = No alignment
IMPORTANT: Do NOT score high just because a broad category (e.g. "environment") appears in both. Ask whether the NGO's SPECIFIC portfolio (its named projects above) matches what the funder actually funds.

**2. Competitive fit (–0.5 to 0.0 points)**
This is NOT about theme match — it's about whether this NGO can realistically WIN this grant given what the funder actually awards.
Ask yourself:
- Does the funder historically award organizations with technical profiles ${orgName} doesn't have? (see Known Gaps & Hard Limits above)
- Does the call have structural requirements ${orgName} can't meet as a direct applicant? (e.g. requires registration in a different country, a different type of lead applicant)
- Does the funder reward scale/evidence architecture ${orgName} doesn't yet have? (e.g. funds expecting RCTs or pathways to reach hundreds of thousands)
- Is there a technical domain gap that would make reviewers question the application?

Scoring:
- 0.0 = Strong competitive position: funder profile matches ${orgName} well
- -0.1 = Minor gap: adjacent experience, could build a case with creative framing
- -0.2 = Moderate gap: ${orgName} lacks key expected expertise but could apply in consortium or with a strong framing pivot
- -0.35 = Significant gap: funder typically awards organizations with a profile ${orgName} doesn't match
- -0.5 = Major gap: wrong technical domain entirely or a structural barrier (matches one of the Known Gaps above)

**3. Strategic fit adjustment (–0.2 to +0.1)**
Adjust for organizational relationship/capacity factors:
- +0.1 if funder is already in NGO's previous_funders list (prior relationship)
- +0.05 if grant explicitly targets youth-led or small NGOs matching this org's exact profile
- -0.1 if grant requires matching funds the NGO can't fully provide (over its matching_funds_max_percent)
- -0.1 if the grant window is very competitive (e.g., flagship programs with thousands of applicants and strong institutional bias)
- -0.2 if funder is fossil fuel company or structurally incompatible (see partner_exclusions)

**4. Which NGO project(s) is the best fit?**
List 1–3 project names from the profile that match best. Be honest — if no project fits well, say so.

**5. One-line application angle**
Only write this if total pre-score + your three scores is likely ≥ 3.8. Otherwise null.
Make it specific: name the project and the framing angle, not a generic "we can apply."

**6. Brutal reasoning**
In 2-3 sentences: what specifically helps AND what specifically hurts this application.
Name the concrete gap if there is one, referencing the Known Gaps & Hard Limits above where applicable.

Respond in this exact JSON format (no other text):
{
  "mission_alignment": <number 0.0-1.2>,
  "competitive_fit": <number -0.5 to 0.0>,
  "strategic_fit": <number -0.2 to 0.1>,
  "best_projects": ["project name 1"],
  "application_angle": "<one sentence or null>",
  "confidence": "<high|medium|low>",
  "reasoning": "<2-3 sentences: what helps AND what hurts, naming concrete gaps>"
}`;
}

function buildOrgSummary(profile) {
  const projects = profile.mission.projects
    .map(p => `  - ${p.name} [${p.funding_urgency} urgency, status: ${p.status}]: ${p.description}`)
    .join('\n');

  return `Organization: ${profile.organization.name}
Country: ${profile.geography.country}
Team size: ${profile.organization.staff_size?.total || '~13'} people
Annual budget: ~$${profile.organization.annual_budget_usd.toLocaleString()}
Largest grant received: $${(profile.experience.largest_grant_received_usd || 51200).toLocaleString()}
Grant sweet spot: $${profile.capacity.grant_size_sweet_spot_min_usd.toLocaleString()}–$${profile.capacity.grant_size_sweet_spot_max_usd.toLocaleString()}
Years operating: ${profile.experience.years_operating}
Focus areas: ${profile.mission.primary_focus.join(', ')}
Previous funders: ${profile.experience.previous_funders.join(', ')}
Active projects:
${projects}`;
}

function buildGapsBlock(profile) {
  const ctx = profile.competitive_context;
  if (!ctx) return '(No gap context in profile)';

  const gaps = (ctx.hard_gaps || []).map(g => `  ⚠ ${g}`).join('\n');
  return `HARD GAPS (downgrade competitive_fit if grant triggers any of these):
${gaps}`;
}

function buildGrantSummary(grant, prescore) {
  const amount = grant.amount_max
    ? `$${grant.amount_min ? grant.amount_min.toLocaleString() + '–' : ''}${grant.amount_max.toLocaleString()}`
    : 'Amount not specified';

  const deadline = grant.deadline
    ? `${grant.deadline} (${prescore.daysRemaining !== null ? prescore.daysRemaining + ' days remaining' : 'TBD'})`
    : 'Rolling / not specified';

  return `Title: ${grant.title}
Funder: ${grant.funder}
Source: ${grant.source}
Amount: ${amount}
Deadline: ${deadline}
Geographic scope: ${grant.country || 'Not specified'}
Themes: ${(grant.themes || []).join(', ') || 'Not specified'}

Description:
${(grant.description || '').slice(0, 800)}${grant.description?.length > 800 ? '...' : ''}`;
}

// ── Near-miss validation gate ───────────────────────────────────────────────
/**
 * For grants that scored SKIP by a narrow margin, the original score was
 * almost always based on a thin one-line description (RSS/LinkedIn/portal
 * aggregators hand the scorer far less text than the hand-written entries
 * in foundations.js get). The scoring prompt's own "don't score high just
 * because a keyword matches" guard then defaults to doubt when it's denied
 * the detail that would show a real fit — a grant literally about PM2.5
 * monitoring can score near-zero on mission alignment if the description
 * never spells that out.
 *
 * This is the cheap fix: ONE page fetch of the funder's own URL (already
 * cached as `pageText` before this prompt is built — see near-miss-check.js),
 * then re-score using that instead of the thin scraped description. Much
 * cheaper than full deep research (which does live search + multi-page
 * fetches per grant) — this only ever re-runs the fit judgment, not the
 * open/closed/reopening investigation.
 */
function buildNearMissRecheckPrompt(grant, pageText, profile, prescore) {
  const orgSummary = buildOrgSummary(profile);
  const gapsBlock = buildGapsBlock(profile);

  return `A grant scored SKIP using only a thin scraped description. Before
that verdict stands, re-score mission alignment and competitive fit using
the funder's OWN page text below — the original description may simply
have been too shallow to show a real fit that the funder's page states
explicitly.

## NGO Profile
${orgSummary}

## Known Gaps & Hard Limits (MUST factor into competitive_fit)
${gapsBlock}

## Grant (as originally scraped)
Title: ${grant.title}
Funder: ${grant.funder}
Original (thin) description: ${(grant.description || '(none)').slice(0, 400)}

## Funder's own page text (fetched live, this is the real source)
${pageText.slice(0, 4000)}

## Original scores (for reference — you're re-doing these two, not accepting them)
Mission alignment was: ${prescore.originalMissionAlignment ?? 'unknown'} / 1.2
Competitive fit was: ${prescore.originalCompetitiveFit ?? 'unknown'} (–0.5 to 0.0)

## Your task
Re-score using the SAME rubric as normal scoring (mission_alignment 0–1.2,
competitive_fit –0.5 to 0.0) but now grounded in the funder's actual page
text instead of a thin scraped summary. Be honest in both directions — if
the funder's page confirms this really isn't a fit, the score should stay
low; don't inflate it just because this is a recheck. Only change the
verdict if the page text gives a concrete, specific reason to.

Respond in this exact JSON format (no other text):
{
  "mission_alignment": <number 0.0-1.2>,
  "competitive_fit": <number -0.5 to 0.0>,
  "changed": <true|false, whether your scores differ meaningfully from the original>,
  "reasoning": "<1-2 sentences: what the funder's own page shows that the thin description didn't, or confirms the original SKIP was right>"
}`;
}

module.exports = {
  buildScoringPrompt, buildOrgSummary, buildGapsBlock, buildGrantSummary,
  buildNearMissRecheckPrompt,
};
