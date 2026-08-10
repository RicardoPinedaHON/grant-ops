---
name: grant-deep-research
description: Deep-research the best-scored Grant Ops opportunities with live web search — funder verification, past grantees, open/closed status, honest likelihood. No API key, no third-party search API — uses Claude Code's own WebSearch/WebFetch and the Agent tool only.
---

# Grant Ops — Deep Research

Runs AFTER scoring (`output/grants_scored.json` must exist). Only researches
grants that already scored `APPLY_NOW` or `CONSIDER` — this is the expensive,
high-signal step, not a first pass. Results are cached forever by grant
fingerprint (`output/grants_research.json`), so re-running never re-researches
a grant that hasn't changed.

## When to use this

- Ricardo says "investiga los top grants", "haz deep research", "dame el research
  de los mejores grants", or similar, after a scan+score cycle.
- Do NOT run this on grants that scored `MONITOR`, `SKIP`, or `INELIGIBLE` —
  the existing rule+Claude scoring already filtered those out for a reason.

## Steps

1. Run `node src/deep-research.js` (optionally `--limit=N`, default 5). It
   prints `global.researchTargets` — an array of `{ grant, scoring,
   research_prompt }`. If it says "Nothing new to research", stop — tell
   Ricardo everything eligible is already cached.

2. For each target, spawn ONE research subagent using the `Agent` tool with
   `research_prompt` as the prompt, `subagent_type: "general-purpose"` (it
   needs WebSearch/WebFetch). Launch all targets' agents in the SAME message
   (multiple tool_use blocks) so they run concurrently — do not do them one
   at a time.

   Do NOT use Exa, Brave Search, or any other third-party search API for
   this — only the subagent's own WebSearch/WebFetch tools. That is the
   entire point of this module: no API key, no separate billing, uses the
   same Claude Code session Ricardo is already paying for.

3. Each subagent's final answer contains two parts (the prompt asks for this
   exact structure): a human-readable report, then a fenced \`\`\`json block
   with `likelihood_percent`, `recommendation`, `appears_closed_or_expired`,
   `status_evidence`, `reopens_within_12mo`, `reopening_estimate`,
   `confidence`, `sources`. Parse the JSON block out of each agent's
   returned text. Keep the human-readable report text verbatim — don't
   rewrite or summarize it, it's what goes in the saved report.

   The prompt requires an educated guess on reopening timing even when the
   subagent can't confirm a date — a blank/missing `reopens_within_12mo`
   is not acceptable; if an agent's response omits it, that's a sign the
   prompt or the agent needs fixing, not something to paper over here.

4. Call `global.saveResearchResults([{ grant, report, result }, ...])` with
   one entry per target (`grant` = the same object from `researchTargets`,
   `report` = the human-readable text, `result` = the parsed JSON). This
   function already applies the timing-gate rule automatically (Ricardo,
   2026-08-07): a grant that is closed/expired AND not expected to reopen
   within 12 months gets pulled from APPLY_NOW down to CONSIDER — good fit,
   just not urgent. It never touches CONSIDER/MONITOR/SKIP/INELIGIBLE from
   the fit-based step. You don't need to apply this yourself.

5. Summarize for Ricardo: for each researched grant, one line with
   likelihood %, final recommendation (after any timing downgrade), and
   whether it got downgraded (`entry.timing_downgraded`). Point him at the
   saved `output/research_YYYY-MM-DD.md` for the full reports.

## Iterating on this skill

This is explicitly a work-in-progress subagent Ricardo wants refined over
time. If a research result looks shallow, wrong, or hallucinated (e.g. past
grantees that don't check out, a status claim with no real source), that's a
signal to improve `src/scorer/research-prompts.js` — tighten the instructions,
not just this run's answer. Ask Ricardo what was wrong before assuming.

## What this does NOT do (yet)

No application drafting, no Monday.com board sync, no form-filling. This is
evaluation only — deciding if and how urgently to act, not acting. That would
be a separate, later skill (an "orchestrator"), only if Ricardo asks for it.
