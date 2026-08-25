---
name: grant-full-pipeline
description: Runs the entire Grant Ops cycle unattended — scan (all sources incl. LinkedIn) → REAL Claude scoring for every freshly-prefiltered grant → Notion sync → near-miss validation gate for borderline Skips → deep-research the top-scored eligible grants → re-sync Notion with research tags. Built for the every-2-days scheduled run; also usable interactively.
---

# Grant Ops — Full Pipeline (autonomous)

This is the ONE skill the scheduled job (`run-full-pipeline.bat`, every 2 days)
invokes via `claude -p`. It chains every existing piece — nothing here
duplicates logic that already lives in scan.js / score-with-claude.js /
deep-research.js / notion-sync.js.

**2026-08-22 — real Claude scoring is now step 1, not `node src/cli.js run`.**
An audit that day found the automated pipeline had ALWAYS scored via
`run-scoring.js` → `manual-scorer.js` — a hardcoded/keyword fallback that
returns literal boilerplate like *"Grant from newsletter but no strong
thematic match with Sustenta's focus areas"* for anything outside its
hardcoded funder list. The real per-grant reasoning engine
(`src/scorer/prompts.js`'s `buildScoringPrompt`, with the full NGO profile +
hard-gaps rubric) only ever ran when Ricardo manually said "score the
grants" — the scheduled job silently skipped it every single cycle, for as
long as it had existed. `manual-scorer.js`/`run-scoring.js`/`cli.js run`
still exist and still work (for `npm run score`, other users of this tool
without a live Claude session, etc.) — just don't use them for THIS
automated run anymore. See CLAUDE.md's "Automated Claude scoring" section
for the full incident writeup.

Fixed 2026-08-25: `expand-now.js` (step 1d below) used to score newly
digest-expanded grants internally via `manual-scorer.js`, not real judgment
— digest volume had been low/zero on most runs, which is why it slipped
through the first fix. It now builds real `claude_prompt`s the same way
step 1b does, and needs the same kind of driver-script step to persist.

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

1. Four sub-steps — scan, REAL Claude scoring, sync, expand:

   **1a.** Run `node src/scan.js`. Fetches all 9 source groups (LinkedIn
   included automatically — `config/sources.yaml`'s `linkedin.enabled: true`
   is permanent) and writes `output/grants_prescored.json`, one entry per
   grant with a `.claude_prompt` field ready for real scoring. Does NOT
   score or touch Notion itself.
      - If LinkedIn shows 0/7 (or otherwise all-failed) sources succeeding,
        that's a known transient failure pattern specifically tied to this
        script firing right at the top of the hour (Jina Reader shared-IP
        congestion at popular cron times — confirmed 2026-08-22 by testing
        the identical code minutes later at a non-round time and getting
        7/7). This is *why* the schedule was moved to 5:17am instead of
        5:00am — don't assume LinkedIn is actually broken just because one
        run failed; do flag it if it fails at 5:17 too, since that would
        mean the theory is wrong.

   **1b.** Run `node src/score-with-claude.js`. Prints `Grants to score: N`
   and the list of titles with prompts. Read `output/grants_prescored.json`
   yourself (or use `global.prescored`, set if you `require()` this file
   directly rather than running it as a subprocess) — for EVERY item with a
   `claude_prompt`, actually read that prompt and produce genuine per-grant
   judgment: `{ mission_alignment, competitive_fit, strategic_fit,
   best_projects, application_angle, confidence, reasoning }`. Set
   `_ineligible: true` on anything that isn't really an org-level grant at
   all (an internship, an individual fellowship, a webinar/workshop, a paid
   course ad, a consultancy contract, a vendor marketing post, an
   aggregator's own blog post about grants in general — these show up
   constantly from RSS/LinkedIn/email sources and the pre-filter doesn't
   catch all of them). This is the whole point of this step — do not paste
   in placeholder/generic reasoning; if two grants are actually different,
   their reasoning should read differently.
      Since this needs a second process to persist (same reason every
      other step here does): write a small temp script (e.g.
      `save-scores-temp.js` at the repo root) that does
      `const { scoreOneGrant, saveScoredGrants } = require('./src/score-with-claude.js')`,
      loads `grants_prescored.json` and `org-profile.yaml` itself, maps your
      responses array through `scoreOneGrant(item, response)`, and calls
      `saveScoredGrants(scored, profile)` — then `node save-scores-temp.js`
      and delete the temp file afterward. (`global.saveResults`/
      `global.scoreOne` only exist when this file is run directly as the
      main module, not when `require()`'d from a driver script — use the
      exported `scoreOneGrant`/`saveScoredGrants` functions instead, they're
      the same underlying logic.)

   **1c.** Run `node src/notion-sync.js`. Pushes the real-scored
   `grants_scored.json` (plus any previously-cached deep research) to
   Notion.

   **1d.** Run `node src/expand-now.js`. Opens any ImpactFunding digest
   items found in `grants_scored.json`, extracts individual grants, and (if
   any survive the pre-filter) writes `output/grants_prescored_digest.json`
   with a real `claude_prompt` per item — same contract as step 1b, just a
   separate small batch. If it prints "nothing to expand" or "nothing
   passed the pre-filter", there's nothing more to do here — move on to
   step 2.
      For every item with a `claude_prompt`, read it and produce genuine
      judgment the same way you did in 1b (same JSON shape, same
      `_ineligible` convention). Then persist with a temp driver script the
      same way as 1b:
      `const { scoreOneGrant, mergeAndSave } = require('./src/expand-now.js')`,
      load `grants_prescored_digest.json` + the just-updated
      `grants_scored.json` + `org-profile.yaml` yourself, filter
      `grants_scored.json` down to non-`ImpactFunding Substack` entries
      (`nonDigestScored`), map your responses through
      `scoreOneGrant(item, response)`, and call
      `mergeAndSave(nonDigestScored, scoredGrants, profile)` — or, if you're
      running this interactively in the same process expand-now.js already
      ran in, just call `global.saveExpandedResults(scoredGrants)` directly
      (it does the same merge, then exits). This step's results get pushed
      to Notion by step 1c already having run before it, plus the final
      sync in step 7 — expand-now.js itself doesn't call notion-sync.js.

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
