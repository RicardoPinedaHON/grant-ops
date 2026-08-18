---
name: grant-full-pipeline
description: Runs the entire Grant Ops cycle unattended — scan (all sources incl. LinkedIn) → rule-based score → Notion sync → near-miss validation gate for borderline Skips → deep-research the top-scored eligible grants → re-sync Notion with research tags. Built for the every-2-days scheduled run; also usable interactively.
---

# Grant Ops — Full Pipeline (autonomous)

This is the ONE skill the scheduled job (`run-full-pipeline.bat`, every 2 days)
invokes via `claude -p`. It chains every existing piece — nothing here
duplicates logic that already lives in scan.js / run-scoring.js /
deep-research.js / notion-sync.js.

**Ricardo's standing instruction (2026-08-07): when this runs on schedule, do
NOT ask for approval or pause for confirmation at any step. Proceed straight
through steps 1-7 autonomously.** This does not change how you behave in a
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

2. Run `node src/near-miss-check.js`. Added 2026-08-18 after an audit found
   real candidates (Halton "Indoor Environmental Quality Grants", GEF SGP CSO
   Challenge) permanently stuck at Skip with mission_alignment near zero —
   for grants literally about PM2.5/particulates, because they arrived via
   RSS/LinkedIn/portal aggregators with only a thin one-line description, not
   the funder's own text. This queries Notion directly for Skip-tier grants
   scoring within 0.5 of the Monitor floor, not yet checked, capped at 8/run,
   and does ONE plain page fetch per candidate (not live search, not a
   subagent-driven investigation — cheap on purpose). It prints
   `global.nearMissTargets` AND `=== NEAR_MISS_TARGETS_JSON ===`. If it prints
   "Nothing to check this run", skip to step 3.
   For each target, spawn ONE subagent (`general-purpose`, no web tools
   needed — the funder's page text is already included in `recheck_prompt`)
   using `target.recheck_prompt` verbatim, all in the same message so they
   run concurrently. Parse each subagent's trailing json block, then call
   `global.saveNearMissResults([{ grant, prescoreLike, result }, ...])` —
   e.g. `node -e "require('./src/near-miss-check.js');
   global.saveNearMissResults([...])"`. This PATCHes each Notion page
   directly with the re-derived score; anything that crosses the Monitor
   floor is now eligible for step 3 below, same run.

3. Run `node src/deep-research.js`. It prints `global.researchTargets` AND a
   `=== RESEARCH_TARGETS_JSON ===` marker followed by the same list as JSON
   (parse that straight from stdout — don't rely on cross-process access to
   the JS global, which only works if you're `require()`-ing the file in the
   same process) — grants that scored APPLY_NOW/CONSIDER/MONITOR and either
   have no cached research yet OR their research has gone stale (researched
   90+ days ago AND the score has since moved ≥0.5 — a verdict isn't trusted
   forever anymore, see `isResearchStale()` in `src/notion-client.js`),
   capped at 5 per run for cost control. Selection is pinned-first, then
   score+aging — NOT pure top-score-wins (that used to mean a modest but real
   scorer like a 2.55 could never win a slot against same-day 4.2-scorers, no
   matter how many cycles it waited): anything Ricardo has set `Status` to
   "Priority" on in Notion always gets one of up to 2 pinned slots regardless
   of score, and everything else is ranked by score PLUS a small bonus that
   grows the longer it's been waiting in the backlog (0 for today's fresh
   arrivals — this only helps things that keep losing to newer high scorers
   cycle after cycle). Candidates come from BOTH today's scan
   (grants_scored.json) AND the historical Notion backlog (grants already
   scored on a past run that never got researched — grants_scored.json only
   ever holds the current run's grants, so without this the backlog would
   never drain). If it prints "Nothing new to research", skip straight to
   step 6 (still worth a final sync in case step 1's rule-scoring or step 2's
   near-miss upgrades changed anything).

5. For each target in `global.researchTargets`, spawn ONE subagent via the
   `Agent` tool (`subagent_type: "general-purpose"`, it needs
   WebSearch/WebFetch) using `target.research_prompt` verbatim as the
   prompt. Launch ALL targets' agents in the same message (multiple
   tool_use blocks) so they run concurrently. No third-party search API,
   no API key — WebSearch/WebFetch only (same rule as `grant-deep-research`).

6. Parse each subagent's trailing \`\`\`json block, then call
   `global.saveResearchResults([{ grant, report, result }, ...])` once with
   every result — e.g. `node -e "require('./src/deep-research.js');
   global.saveResearchResults([...])"` (this is a fresh process from step 3,
   so `require()` it again first; `saveResearchResults` is async — awaiting
   isn't required in the one-liner since Node won't exit while its promises
   are pending). This persists to `output/grants_research.json` and applies
   the timing-gate downgrade automatically (closed + not reopening within
   12 months → APPLY_NOW becomes CONSIDER). For any grant pulled from the
   Notion backlog (has `grant._notion_page_id`), it ALSO PATCHes that page
   directly (Deep Researched/Likelihood %/Research Status/Tier, plus the
   staleness bookkeeping fields Last Researched/Researched At Score) — those
   grants aren't in `grants_scored.json`, so step 7 below never sees them.
   See `.claude/skills/grant-deep-research/SKILL.md` for the full contract
   if anything here is ambiguous — this step IS that skill's steps 1-4, just
   triggered automatically instead of on request.

7. Run `node src/notion-sync.js`. This re-reads `grants_scored.json` +
   the now-updated `grants_research.json` and pushes the fresh tier/
   `Deep Researched`/`Likelihood %`/`Research Status` tags for anything
   from TODAY'S scan that step 3-6 just researched. (Backlog-sourced research
   is already pushed to Notion directly by step 6, above — this sync only
   covers today's newly-scanned grants. Step 1 already synced once too —
   this second sync only matters when step 3-6 actually researched something
   new from today's batch.)

## After it's done

Write one short line to stdout summarizing the run (sources fetched, new
grants, new research results, final tier distribution) — this is what ends
up in `output/logs/pipeline_run.log` via the wrapping .bat's redirect.
Ricardo reads the log or the Notion board itself; do not wait for a reply.

## Guardrails (do not change without Ricardo's say)

- Deep research is capped at 5 new grants per run (`--limit=5` default in
  deep-research.js), near-miss checks at 8/run (`--limit=8` in
  near-miss-check.js) — cost control. Raise only if Ricardo asks.
- APPLY_NOW/CONSIDER/MONITOR-scored grants get deep-researched (Ricardo,
  2026-08-09 — widened from APPLY_NOW/CONSIDER only, after the scoring
  pipeline went over a month without producing a single APPLY_NOW/CONSIDER
  grant, which silently starved deep-research of any targets). Selection
  is pinned-first (`Status = Priority` in Notion), then score+aging —
  changed 2026-08-18 from pure top-score-wins, which let a real Monitor-tier
  candidate get permanently outranked by same-day high scorers no matter how
  many cycles it waited. SKIP/INELIGIBLE remain excluded from deep research
  specifically — those are the ones genuinely not worth the live-research
  cost (wrong geography, expired, too small, etc) — but SKIP grants scoring
  within 0.5 of the Monitor floor DO get the near-miss check (step 2), which
  is cheap enough to justify a second look before that verdict is final.
- Research results are cached, but not forever anymore (2026-08-18) — a
  result is trusted until it's both 90+ days old AND the formula score has
  since moved ≥0.5 (`isResearchStale()` in `src/notion-client.js`). An
  unchanged grant still never gets re-researched.
