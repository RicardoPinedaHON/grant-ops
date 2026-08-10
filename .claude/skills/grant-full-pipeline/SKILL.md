---
name: grant-full-pipeline
description: Runs the entire Grant Ops cycle unattended — scan (all sources incl. LinkedIn) → rule-based score → Notion sync → deep-research the top-scored eligible grants → re-sync Notion with research tags. Built for the every-2-days scheduled run; also usable interactively.
---

# Grant Ops — Full Pipeline (autonomous)

This is the ONE skill the scheduled job (`run-full-pipeline.bat`, every 2 days)
invokes via `claude -p`. It chains every existing piece — nothing here
duplicates logic that already lives in scan.js / run-scoring.js /
deep-research.js / notion-sync.js.

**Ricardo's standing instruction (2026-08-07): when this runs on schedule, do
NOT ask for approval or pause for confirmation at any step. Proceed straight
through steps 1-5 autonomously.** This does not change how you behave in a
normal interactive conversation with him — only this unattended pipeline run.

**Critical (found by testing, 2026-08-07): this whole run is ONE headless
`claude -p` invocation — a single turn, no continuation after you stop.**
Run every command in this skill IN THE FOREGROUND and WAIT for it to finish
before moving to the next step or ending your turn. Do NOT background any
step (no `run_in_background`, no `start`, no `&`) — if you background a
long-running step and end your turn planning to "continue once it finishes,"
the process exits and nothing after that point ever runs. There is no
later turn. If a step is slow, that's fine — just wait for it.

## Steps — run in this exact order

1. `node src/cli.js run`
   Runs scan.js (fetches all sources, LinkedIn included automatically —
   config/sources.yaml's `linkedin.enabled: true` is permanent, no code
   changes needed to keep it running) → run-scoring.js (rule-based score +
   an immediate Notion sync that already tags any previously-cached deep
   research) → expand-now.js.

2. Run `node src/deep-research.js`. It prints `global.researchTargets` AND a
   `=== RESEARCH_TARGETS_JSON ===` marker followed by the same list as JSON
   (parse that straight from stdout — don't rely on cross-process access to
   the JS global, which only works if you're `require()`-ing the file in the
   same process) — grants that scored APPLY_NOW/CONSIDER/MONITOR (already
   sorted best-scored first — "empezando arriba desde los mejor puntuados")
   and have no cached research yet, capped at 5 per run for cost control.
   Candidates come from BOTH today's scan (grants_scored.json) AND the
   historical Notion backlog (grants already scored on a past run that never
   got researched — grants_scored.json only ever holds the current run's
   grants, so without this the backlog would never drain). If it prints
   "Nothing new to research", skip straight to step 5 (still worth a final
   sync in case step 1's rule-scoring changed anything).

3. For each target in `global.researchTargets`, spawn ONE subagent via the
   `Agent` tool (`subagent_type: "general-purpose"`, it needs
   WebSearch/WebFetch) using `target.research_prompt` verbatim as the
   prompt. Launch ALL targets' agents in the same message (multiple
   tool_use blocks) so they run concurrently. No third-party search API,
   no API key — WebSearch/WebFetch only (same rule as `grant-deep-research`).

4. Parse each subagent's trailing \`\`\`json block, then call
   `global.saveResearchResults([{ grant, report, result }, ...])` once with
   every result — e.g. `node -e "require('./src/deep-research.js');
   global.saveResearchResults([...])"` (this is a fresh process from step 2,
   so `require()` it again first; `saveResearchResults` is async — awaiting
   isn't required in the one-liner since Node won't exit while its promises
   are pending). This persists to `output/grants_research.json` and applies
   the timing-gate downgrade automatically (closed + not reopening within
   12 months → APPLY_NOW becomes CONSIDER). For any grant pulled from the
   Notion backlog (has `grant._notion_page_id`), it ALSO PATCHes that page
   directly (Deep Researched/Likelihood %/Research Status/Tier) — those
   grants aren't in `grants_scored.json`, so step 5 below never sees them.
   See `.claude/skills/grant-deep-research/SKILL.md` for the full contract
   if anything here is ambiguous — this step IS that skill's steps 1-4, just
   triggered automatically instead of on request.

5. Run `node src/notion-sync.js`. This re-reads `grants_scored.json` +
   the now-updated `grants_research.json` and pushes the fresh tier/
   `Deep Researched`/`Likelihood %`/`Research Status` tags for anything
   from TODAY'S scan that step 2-4 just researched. (Backlog-sourced research
   is already pushed to Notion directly by step 4, above — this sync only
   covers today's newly-scanned grants. Step 1 already synced once too —
   this second sync only matters when step 2-4 actually researched something
   new from today's batch.)

## After it's done

Write one short line to stdout summarizing the run (sources fetched, new
grants, new research results, final tier distribution) — this is what ends
up in `output/logs/pipeline_run.log` via the wrapping .bat's redirect.
Ricardo reads the log or the Notion board itself; do not wait for a reply.

## Guardrails (do not change without Ricardo's say)

- Deep research is capped at 5 new grants per run (`--limit=5` default in
  deep-research.js) — cost control. Raise only if Ricardo asks.
- APPLY_NOW/CONSIDER/MONITOR-scored grants get deep-researched, best-scored
  first (Ricardo, 2026-08-09 — widened from APPLY_NOW/CONSIDER only, after the
  scoring pipeline went over a month without producing a single APPLY_NOW/
  CONSIDER grant, which silently starved deep-research of any targets). SKIP/
  INELIGIBLE remain excluded — those are the ones genuinely not worth the
  research cost (wrong geography, expired, too small, etc).
- Research results are cached forever by grant fingerprint — never
  re-research an unchanged grant.
