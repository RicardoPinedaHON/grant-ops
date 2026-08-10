/**
 * Builds the Claude scoring prompt for a grant.
 * Called by Claude Code — no API key needed.
 */

function buildScoringPrompt(grant, profile, prescore) {
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
- 1.2 = Perfect: grant explicitly funds this NGO's exact work (air quality monitoring, circular economy waste valorization, indigenous forest protection, youth-led climate action in Honduras/LAC)
- 0.9 = Strong: grant funds the broad theme (climate, environment, youth) in eligible geography
- 0.6 = Partial: adjacent work (public health, WASH, governance) with plausible bridge
- 0.3 = Weak: broad development grant, environment is a minor component
- 0.0 = No alignment
IMPORTANT: Do NOT score high just because "environment" appears in both. Ask whether the NGO's SPECIFIC portfolio (air quality sensors, circular economy, forest monitoring, youth research) matches what the funder actually funds.

**2. Competitive fit (–0.5 to 0.0 points)**
This is NOT about theme match — it's about whether this NGO can realistically WIN this grant given what the funder actually awards.
Ask yourself:
- Does the funder historically award organizations with technical profiles Sustenta doesn't have? (marine biology, agribusiness, internet infrastructure, academic research, scale-at-millions level)
- Does the call have structural requirements Sustenta can't meet as a direct applicant? (AECID = Spanish NGO, some US programs require US-based lead)
- Does the funder reward scale/evidence architecture Sustenta doesn't yet have? (DIV, GIF, MIT Solve expect RCTs or pathways to reach hundreds of thousands)
- Is there a technical domain gap that would make reviewers question the application? (reef conservation expertise, fisheries management, commercial supply chains)

Scoring:
- 0.0 = Strong competitive position: funder profile matches Sustenta well (small embassy grants, bilateral youth funds, locally-led community grants, environmental monitoring)
- -0.1 = Minor gap: adjacent experience, could build a case with creative framing
- -0.2 = Moderate gap: Sustenta lacks key expected expertise but could apply in consortium or with a strong framing pivot
- -0.35 = Significant gap: funder typically awards organizations with profile Sustenta doesn't match (e.g., marine science, commercial agrifood, large-scale implementers)
- -0.5 = Major gap: wrong technical domain entirely or structural barrier (e.g., coral reef fund for an org with no coastal work, or requires Spanish NGO registration)

**3. Strategic fit adjustment (–0.2 to +0.1)**
Adjust for organizational relationship/capacity factors:
- +0.1 if funder is already in NGO's previous_funders list (prior relationship)
- +0.05 if grant explicitly targets youth-led or small NGOs in Sustenta's exact profile
- -0.1 if grant requires matching funds the NGO can't fully provide (>15%)
- -0.1 if the grant window is very competitive (e.g., flagship programs with thousands of applicants and strong institutional bias)
- -0.2 if funder is fossil fuel company or structurally incompatible

**4. Which NGO project(s) is the best fit?**
List 1–3 project names from the profile that match best. Be honest — if no project fits well, say so.

**5. One-line application angle**
Only write this if total pre-score + your three scores is likely ≥ 3.8. Otherwise null.
Make it specific: name the project and the framing angle, not generic "Sustenta can apply."

**6. Brutal reasoning**
In 2-3 sentences: what specifically helps AND what specifically hurts this application.
Name the concrete gap if there is one (e.g., "MAR Fund explicitly requires coastal/marine management experience — Sustenta has none and would compete against actual marine conservation organizations").

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

module.exports = { buildScoringPrompt, buildOrgSummary, buildGapsBlock, buildGrantSummary };
