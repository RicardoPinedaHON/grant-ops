/**
 * Builds the Claude scoring prompt for a grant.
 * Called by Claude Code — no API key needed.
 */

function buildScoringPrompt(grant, profile, prescore) {
  const orgSummary = buildOrgSummary(profile);
  const grantSummary = buildGrantSummary(grant, prescore);

  return `You are evaluating a grant opportunity for an NGO. Score this grant on the two dimensions below.

## NGO Profile
${orgSummary}

## Grant Opportunity
${grantSummary}

## Rule-based pre-scores already calculated (out of max shown):
- Geographic eligibility: ${prescore.scores.geo.toFixed(2)} / 1.0
- Grant size match: ${prescore.scores.size.toFixed(2)} / 0.8
- Deadline feasibility: ${prescore.scores.deadline.toFixed(2)} / 0.7
- Org type eligibility: ${(prescore.scores.org_type ?? prescore.scores.language ?? 0).toFixed(2)} / 0.4
- Partnership: ${prescore.scores.partnership.toFixed(2)} / 0.3
- Pre-score subtotal: ${prescore.prescore.toFixed(2)} / 3.2

## Your task: Score the remaining two dimensions

**1. Mission alignment (0–1.2 points)**
Does this grant's focus area genuinely match the NGO's work?
- 1.2 = Perfect: grant explicitly funds this NGO's exact work (air quality, circular economy, indigenous forest protection, youth climate action)
- 0.9 = Strong: grant funds the broad theme (environment, climate, youth)
- 0.6 = Partial: grant funds adjacent work (public health, WASH, governance) with plausible connection
- 0.3 = Weak: broad development grant with small environmental component
- 0.0 = No alignment

**2. Strategic fit bonus/penalty (–0.2 to +0.1)**
Adjust for:
- +0.1 if funder is already in NGO's network or has prior relationship (check previous_funders)
- +0.05 if grant explicitly targets youth-led or small NGOs
- -0.1 if grant requires matching funds the NGO can't fully provide (>15%)
- -0.2 if funder is fossil fuel company or incompatible partner

**3. Which NGO project(s) is the best fit?**
List 1–3 project names from the profile that match best.

**4. One-line application angle**
If score >= 3.5, write one sentence on the strongest angle for this NGO to use in the application.

Respond in this exact JSON format (no other text):
{
  "mission_alignment": <number 0-1.2>,
  "strategic_fit": <number -0.2 to 0.1>,
  "best_projects": ["project name 1", "project name 2"],
  "application_angle": "<one sentence or null if score too low>",
  "confidence": "<high|medium|low>",
  "reasoning": "<2-3 sentences explaining your scores>"
}`;
}

function buildOrgSummary(profile) {
  const projects = profile.mission.projects
    .map(p => `  - ${p.name} [${p.funding_urgency} urgency]: ${p.description}`)
    .join('\n');

  return `Organization: ${profile.organization.name}
Country: ${profile.geography.country}
Focus areas: ${profile.mission.primary_focus.join(', ')}
Annual budget: ~$${profile.organization.annual_budget_usd.toLocaleString()}
Grant sweet spot: $${profile.capacity.grant_size_sweet_spot_min_usd.toLocaleString()}–$${profile.capacity.grant_size_sweet_spot_max_usd.toLocaleString()}
Previous funders: ${profile.experience.previous_funders.join(', ')}
Active projects:
${projects}`;
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

module.exports = { buildScoringPrompt };
