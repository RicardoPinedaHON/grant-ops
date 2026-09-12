/**
 * research-prompts.js
 *
 * Builds the deep-research prompt for a single grant — run by Claude Code
 * (via the Agent tool, no API key), not by any external API.
 *
 * Adapted from an external "grant-evaluator" skill design, with three changes
 * to fit this codebase:
 *   1. The org profile block is built from org-profile.yaml at run time
 *      (reuses buildOrgSummary/buildGapsBlock from ./prompts.js — the exact
 *      same helpers score-with-claude.js already uses), instead of being
 *      hardcoded text. Works for any org using Grant Ops, not just one.
 *   2. The final recommendation must use Grant Ops' EXISTING vocabulary
 *      (APPLY_NOW / CONSIDER / MONITOR / SKIP / INELIGIBLE) instead of a
 *      second parallel vocabulary, so reports don't end up with two
 *      different traffic-light systems.
 *   3. Timing gate (Ricardo, 2026-08-07): a grant that is a genuinely strong
 *      fit but is closed with no reopening expected within the next 12
 *      months must land on CONSIDER, never APPLY_NOW — APPLY_NOW means
 *      "act now," which is false if there's nothing to act on for a year.
 *      The subagent must still produce an educated guess on reopening
 *      timing rather than leaving it blank — "unknown" defaults to treating
 *      it as NOT confirmed within 12 months (the cautious default), same as
 *      Ricardo's "si realmente no estan abiertos ni para el proximo año."
 */

const { buildOrgSummary, buildGapsBlock, buildGrantSummary } = require('./prompts');

function buildResearchPrompt(grant, profile, prescore) {
  const orgSummary = buildOrgSummary(profile);
  const gapsBlock = buildGapsBlock(profile);
  const grantSummary = buildGrantSummary(grant, prescore || { daysRemaining: null });

  return `You are a grant research specialist doing DEEP, LIVE research on one funding
opportunity for the organization profiled below. You have live web search and
page-fetch access. Use it — do not rely on the description alone.

## Organization profile
${orgSummary}

## Known gaps (weigh heavily — thematic overlap alone is not enough)
${gapsBlock}

## Grant opportunity to research
${grantSummary}

## What to actually do
1. Search for the funder's own website / program page for this specific call.
   Read it directly (fetch the page, don't guess from the search snippet).
2. Confirm whether the call is CURRENTLY OPEN. Funders sometimes leave old
   posts up after a round closes, or a "rolling" call turns out to run on
   an annual cycle that's currently shut. State clearly whether you found
   evidence the round is open, closed, or you couldn't determine it.
   If it's closed (or you can't confirm it's open), give your best educated
   guess for WHEN it next opens — based on past cycles, funder announcements,
   or typical annual timing for this kind of program. Do not leave this
   blank just because you lack a confirmed date; reason from whatever
   evidence you found (e.g. "closed rounds have historically reopened each
   Q1, so likely within ~12 months") and say explicitly that it's an
   estimate. Only if you found genuinely nothing to reason from — no past
   cycle, no funder statement, no pattern — should you call it truly
   unknown, and even then default to assuming it will NOT reopen within 12
   months (the cautious assumption, not the optimistic one).

   **A concrete date is REQUIRED — "rolling" is the rare exception, not the
   default** (Ricardo, 2026-09-12: found live that the vast majority of
   already-researched grants had a solid prose estimate in this exact
   section, "~Q1 2027" or similar, that never made it into the actual
   Deadline field — everything just sat on "Rolling" regardless). Apply
   this priority order, and produce a real \`best_deadline_date\` for the
   JSON below no matter which branch you land in:
   a. OPEN with a stated deadline -> that exact date. confidence: "confirmed".
   b. CLOSED, and you found evidence of a recurring cycle (funder states
      "opens annually every [month]", or 2+ past rounds cluster around the
      same month/day) -> estimate the NEXT occurrence (same month/day,
      next plausible year). confidence: "estimated_annual".
   c. CLOSED, no annual pattern evidence, but you found the LAST actual
      past round's deadline -> use THAT past date as-is (do not advance
      it to a future year you can't justify). confidence: "historical".
      This is deliberately not "rolling" — a known past fixed date is real
      information a blank/rolling field throws away.
   d. Only when the funder's OWN language explicitly states no fixed
      cycle ("aceptamos propuestas todo el año", "rolling basis", "accepted
      year-round") -> "rolling". confidence: "rolling". This should be
      genuinely rare: most grants have fixed dates, even if you have to
      dig for last year's to find one.
3. Find 5-10 past grantees, winners, or finalists of this specific program
   (not the funder's other programs). For each, note: organization type,
   country/region, project focus, approximate stage/size, amount if found,
   and your best guess at why they were selected. If you truly cannot find
   any past grantees after a real search, say so explicitly — do not invent
   examples.
4. From the funder's own language (RFP, guidelines, past annual reports,
   press releases about winners), separate STATED priorities from what the
   funder ACTUALLY appears to fund in practice.
5. Check the organization above against the eligibility checklist you'd
   expect for this kind of program (legal status, org age, budget size,
   geography, sector, project stage, co-financing, reporting burden,
   language/format of application) — flag anything that is a hard blocker
   vs. soft/negotiable.
6. Estimate how competitive this call likely is (applicant pool size if
   knowable, selectivity signals, whether it favors flagship/known
   organizations).

## Output — two parts, in this exact order

### Part 1: human-readable report (use this exact structure)

GRANT EVALUATION: [Grant name]
Funder: [Name] | Amount: [Amount] | Deadline: [Deadline]

LIKELIHOOD: [X]% — [one sentence on why]

STATUS CHECK
[Open / Closed / Could not confirm] — [evidence, with a source URL]
REOPENING ESTIMATE (only if closed/unconfirmed): [your educated guess of
when it next opens, and the reasoning/evidence behind that guess — e.g.
"~Q1 2027, based on the last 3 cycles opening every January"]

STRENGTHS
- [specific strength]
- [specific strength]

GAPS
- [honest gap]
- [honest gap]

PAST GRANTEE PATTERNS
- [pattern 1, with example org(s)]
- [pattern 2]
- [how the org above compares]

FUNDER LANGUAGE INSIGHTS
- Stated vs actual: [...]
- Real priority: [...]
- Open doors: [...]
- Red flags: [...]

FOLLOW-UP STRATEGY
1. [immediate action]
2. [reframe or angle to strengthen fit]
3. [next step]

SOURCES
- [url]
- [url]

### Part 2: a single fenced json block, nothing after it, with EXACTLY these
keys (used for automated tracking — keep it terse, the prose above is where
the detail belongs):

\`\`\`json
{
  "likelihood_percent": <integer 0-100>,
  "recommendation": "<APPLY_NOW|CONSIDER|MONITOR|SKIP|INELIGIBLE>",
  "appears_closed_or_expired": <true|false>,
  "status_evidence": "<one sentence, or null if status could not be confirmed>",
  "reopens_within_12mo": <true|false>,
  "reopening_estimate": "<one sentence educated guess + reasoning, or null only if currently open>",
  "best_deadline_date": "<REQUIRED, per the priority order above: a real YYYY-MM-DD (confirmed current, estimated-next-cycle, or last-known-historical), or the literal word rolling only in the rare case the funder explicitly states no fixed cycle. Never null.>",
  "deadline_confidence": "<confirmed|estimated_annual|historical|rolling — matches whichever branch produced best_deadline_date above>",
  "confidence": "<high|medium|low>",
  "sources": ["<url>", "..."]
}
\`\`\`

## How to map likelihood % to recommendation (use this exactly)

Step 1 — start from likelihood % (Ricardo, 2026-09-11 — lowered thresholds so
genuinely-open, plausible-fit opportunities surface as CONSIDER/APPLY_NOW
instead of getting buried at MONITOR):
- 40-100%  -> APPLY_NOW
- 20-39%   -> CONSIDER
- 10-19%   -> MONITOR (unless the funder is not strategically worth tracking, then SKIP)
- 0-9%     -> SKIP
- Hard structural disqualifier found (wrong legal status, wrong country, etc.) -> INELIGIBLE regardless of %

Step 2 — timing gate (apply AFTER step 1, only when step 1 produced
APPLY_NOW): APPLY_NOW means "act now." If the call is closed/expired AND
your educated reopening estimate is NOT within the next 12 months
(\`reopens_within_12mo: false\`) — including genuinely-unknown cases, which
default to false per the cautious assumption above — downgrade the
recommendation to CONSIDER even though the fit itself is strong. Note in
FOLLOW-UP STRATEGY that this is a timing downgrade, not a fit problem, and
say when to revisit. Never apply this downgrade to CONSIDER/MONITOR/SKIP/
INELIGIBLE — it only ever pulls APPLY_NOW down to CONSIDER, nothing else.

Be candid. A grant can be thematically related but structurally wrong — ask
who actually wins this, and whether the organization above genuinely looks
like that. Do not inflate fit to be encouraging. Past grantee patterns matter
more than the funder's mission statement.`;
}

module.exports = { buildResearchPrompt };
