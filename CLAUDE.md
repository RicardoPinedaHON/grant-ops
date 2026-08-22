# Grant-Ops — Instructions for Claude Code

## What this project does

grant-ops is an AI-powered grant opportunity scanner for NGOs. It:
1. Fetches grant opportunities from multiple sources (RSS, Playwright scrapers,
   LinkedIn company pages, an Outlook inbox, static/rolling calls)
2. Pre-scores them using rule-based logic (geography, size, deadline, org type)
3. Uses Claude to score mission alignment, competitive fit, and strategic fit
   for every freshly-prefiltered grant, automatically, every cycle — this
   wasn't actually true until 2026-08-22 (see "Automated Claude scoring")
4. Runs a cheap near-miss validation gate on Skip-tier grants that scored
   within 0.5 of the Monitor floor — one plain page fetch of the funder's own
   site, re-judging fit against real text instead of a thin scraped
   description (src/near-miss-check.js — see "Near-miss validation" below)
5. Deep-researches the best-scored grants live (WebSearch/WebFetch) to confirm
   they're actually open and estimate reopening timing if closed
6. Syncs everything to a Notion database — **Notion, not the local HTML
   report, is where Ricardo actually reviews and tracks grants day to day.**
   The report files still get generated as a secondary/offline artifact.

Runs unattended every 2 days via Windows Task Scheduler (see "Automation"
below) — most of the time nobody is watching this run live.

## Primary commands

### Full pipeline (what the scheduled job runs)
```
node src/scan.js              ← fetches all sources, writes grants_prescored.json
node src/score-with-claude.js ← REAL Claude scoring for every item (see "Automated Claude scoring")
node src/notion-sync.js       ← pushes grants_scored.json + grants_research.json to Notion
node src/expand-now.js        ← expands newsletter digests (still manual-scorer.js internally)
node src/near-miss-check.js   ← re-judges borderline Skips against the funder's own page (see below)
node src/deep-research.js     ← prints research targets (see "Deep research" below)
```
This is exactly `.claude/skills/grant-full-pipeline/SKILL.md`'s 7-step sequence
— read that file for the authoritative step-by-step contract, including the
"do not background anything, this is one headless turn" constraint. Note this
is NOT the same as `node src/cli.js run` (below) — that command still exists
and still works, but as of 2026-08-22 the automated pipeline no longer uses
it, because its `run-scoring.js` step never gave real Claude judgment.

### Individual steps
```
node src/scan.js          ← fetches grants, pre-scores, saves grants_prescored.json
node src/run-scoring.js   ← CHEAP FALLBACK: rule-based scoring only (manual-scorer.js,
                             no AI, no real per-grant judgment) — used by `npm run score`
                             and `cli.js run`, NOT by the automated pipeline anymore
```

`score-with-claude.js` is the real AI-scoring path — see "Automated Claude
scoring" below and "How to score grants" for the exact contract. No API key
required; uses your existing Claude Code subscription. This is now used both
interactively ("score the grants") AND automatically by the scheduled
pipeline (`.claude/skills/grant-full-pipeline/SKILL.md` step 1b).

### Quick commands
- `npm run scan` — fetch new grants only (skips already-seen)
- `npm run scan:all` — re-fetch everything including already-seen grants
- `npm run score` — score grants already in output/grants_prescored.json
- `npm test` — 78 unit tests (LinkedIn parsing/dedup, amount/deadline
  extraction, login-wall detection, Outlook newsletter parsing, near-miss/
  research-staleness/selection-fairness logic, real-Claude-scoring prompt
  building, duplicate-of-already-researched detection). No network calls,
  no API keys needed.

## How to score grants (your task in score-with-claude.js)

After running scan.js, load `output/grants_prescored.json`. For each item:

1. Read `item.claude_prompt` — it contains the full scoring instructions
2. Evaluate the grant against the NGO profile as instructed
3. Return JSON with exactly these fields:
   ```json
   {
     "mission_alignment": 0.0-1.2,
     "competitive_fit": -0.5 to 0.0,
     "strategic_fit": -0.2 to 0.1,
     "best_projects": ["project name"],
     "application_angle": "one sentence or null",
     "confidence": "high|medium|low",
     "reasoning": "2-3 sentences: what specifically helps AND hurts",
     "_ineligible": true  // OPTIONAL — set this if the item isn't really an
                           // org-level grant at all (individual fellowship,
                           // internship, webinar/workshop, paid course ad,
                           // consultancy contract, vendor marketing post, an
                           // aggregator's own blog post about grants) — these
                           // slip past the pre-filter constantly from RSS/
                           // LinkedIn/email sources and forcing INELIGIBLE
                           // here is more honest than a low-but-nonzero score
   }
   ```
4. Use `scoreOneGrant(item, yourResponse)` from `src/score-with-claude.js`
   (wraps `combineScores` — same thing, this is what has test coverage)
5. Collect all results into `scoredGrants` array
6. Call `saveScoredGrants(scoredGrants, profile)` — writes `grants_scored.json`
   plus the TSV/Markdown/HTML reports in one call (see "Automated Claude
   scoring" below for how this actually gets invoked headlessly, since
   `global.scoreOne`/`global.saveResults` only exist when this file runs as
   the main module — a driver script needs the exported functions instead)

Tiers (src/scorer/index.js): `final_score` ≥ 3.8 → APPLY_NOW, ≥ 3.2 → CONSIDER,
≥ 2.5 → MONITOR, else SKIP. Any hard-ineligibility flag (wrong geography,
scholarship-only, course-not-grant, VC-only, news article, no specific
opportunity, conference-not-grant) forces INELIGIBLE regardless of score —
`_ineligible: true` above is the AI-scoring-time equivalent of those
rule-based flags, for cases only visible once you actually read the grant.

## Automated Claude scoring

Added/fixed 2026-08-22. Until this date, the scheduled pipeline had **never
once** used real Claude judgment to score a grant — `.claude/skills/grant-
full-pipeline/SKILL.md`'s step 1 ran `node src/cli.js run`, which chains
`run-scoring.js` → `manual-scorer.js`, a hardcoded/keyword-heuristic fallback
that returns the literal string `"Grant from newsletter but no strong
thematic match with Sustenta's focus areas."` for anything outside its
hardcoded funder list. That's what every single automated cycle produced,
silently, for as long as the scheduled job had existed — caught live when
Ricardo asked why results felt slow/low-quality and a manual re-scoring pass
of that day's 19 grants immediately surfaced a real $300K Australia-LAC
environmental program (COALAR) at MONITOR with a genuine application angle,
and correctly flagged 6 of the 19 as not-actually-grants (an internship, an
individual fellowship, a webinar, a paid course ad, a consultancy contract,
a vendor marketing post) that the cheap scorer had left as generic low-score
SKIPs instead.

The fix: the pipeline's step 1 now runs `scan.js` alone (not `cli.js run`),
then `score-with-claude.js` for real per-grant judgment on every item, then
`notion-sync.js`, then `expand-now.js` — see the SKILL.md for the exact
sub-steps (1a-1d) including the "write a temp driver script, since
`require()`-ing this file from another process doesn't get you the
interactive-session globals" mechanics. `run-scoring.js`/`manual-scorer.js`/
`cli.js run` are unchanged and still valid for other uses (`npm run score`,
someone using this tool without a live Claude session) — they're just no
longer what the automated cycle uses.

**Known residual gap**: `expand-now.js` still scores newly digest-expanded
grants via `manual-scorer.js` internally, not this real pass. Digest volume
has been low-to-zero on most runs so far ("nothing to expand" is the common
case), so this wasn't fixed in the same pass — don't assume digest-expanded
grants got real judgment until this is addressed too.

## Near-miss validation

Added 2026-08-18 after an audit (prompted by Ricardo pasting a Monday.com/
Notion cross-check that found six real candidates going nowhere) traced why:
`Halton "Indoor Environmental Quality Grants"` and `GEF SGP CSO Challenge`
were both stuck at SKIP with `mission_alignment` near zero, for grants
literally about PM2.5/particulates — Sustenta's core focus area. Cause: they
arrived via RSS/LinkedIn/portal aggregators, which hand the scorer a thin
one-line description (only `foundations.js`'s hand-written entries get the
funder's real text) — and the scoring prompt's own "don't score high just
because a keyword matches" guard then defaults to doubt when it's denied the
detail that would show the real fit. Since SKIP was permanently excluded
from deep research, there was no mechanism to ever revisit that verdict.

`src/near-miss-check.js` is the fix, and it's deliberately NOT deep research:
it queries Notion directly (not `grants_scored.json` — by the time this
stage runs, every SKIP-tier grant from today's scan is already a Notion page
too, so one query reaches both today's arrivals and the existing backlog)
for Skip-tier grants scoring within 0.5 of the Monitor floor
(`MONITOR_THRESHOLD` in `src/scorer/index.js`) that haven't been checked yet,
capped at 8/run. For each, it does ONE plain HTTPS GET of the funder's own
URL (`fetchPageText` — no Playwright, no WebFetch tool call; this needs to
run cheaply inside the headless pipeline too) and re-judges ONLY
mission_alignment/competitive_fit against that real text via
`buildNearMissRecheckPrompt` (`src/scorer/prompts.js`) — not open/closed
status, not funder history, none of what makes full deep research
expensive. `buildSyntheticPrescore()` reconstructs an equivalent prescore
object from Notion's stored "Score Breakdown" text so the recheck reuses
`combineScores()` — the exact same combining logic as normal scoring —
instead of a parallel formula that could drift out of sync with it.
Read `=== NEAR_MISS_TARGETS_JSON ===` from stdout, answer each
`recheck_prompt` (subagents are fine, no web tools needed), then call
`global.saveNearMissResults([{ grant, prescoreLike, result }, ...])`.
Anything that crosses the Monitor floor is now eligible for deep research,
same run. A candidate whose URL fails to fetch gets marked checked anyway
(cost control — no infinite retry on a permanently-broken link) and just
stays SKIP.

## Deep research

`src/deep-research.js` picks APPLY_NOW/CONSIDER/MONITOR grants that either
have no cached research yet, OR whose research has gone stale
(`isResearchStale()` in `src/notion-client.js`: researched 90+ days ago AND
the formula score has since moved ≥0.5 — added 2026-08-18 after finding a
grant sitting at 4.21 with its Notion Tier still pinned to an old MONITOR
verdict; a research result used to be trusted forever, which is how that
happened). Capped at 5/run for cost control, and exposes them for Claude
Code to research live with WebSearch/WebFetch — no third-party search API,
no API key.

**Duplicate-of-already-researched filter** (added 2026-08-22): the same real
program routinely gets scraped from its own site AND from an aggregator
repost under a completely different domain — confirmed live, "Youth Climate
Justice Fund (YCJF) 2026" (ycjf.org) and "Fondos de YCJF..."
(gestionandote.org) are the same funder, but `grantFingerprint()` gives them
structurally incompatible identity keys (domain-based vs. acronym/title-
based — see `src/utils/grant-fingerprint.js`), so they were never recognized
as duplicates and both got independently deep-researched the same day,
wasting a research slot. Fixing `grantFingerprint()` itself was ruled out —
it's the persisted Notion identity key for the whole ~350-page database, and
changing its format would make every existing page look "new" on its next
sync and mass-duplicate them. Instead, `fetchNotionBacklog()` collects every
already-researched grant's `{title, url}` while it scans the database
anyway, and `filterAlreadyResearchedDuplicates()` cross-checks new
candidates against that list with the looser, pairwise `grantsMatch()`
(shared acronym or ≥60% title-word overlap, still year-aware) before they're
ever offered as research targets. Live-confirmed catching "RELX
Environmental Challenge" as a dupe of the already-researched "Relx
Environmental Challenge 2025" the same day this shipped. Known pre-existing
gap in `grantsMatch()` itself, not fixed: if two different years' rounds
scrape to the EXACT same URL (a funder reusing one "how to apply" page
year-round), the exact-URL-match check short-circuits before the
year-differentiation logic runs, so they'd incorrectly match — see
`test/deep-research.test.js`'s comment on this.

Candidates come from **two places, merged**: today's freshly-scanned
`grants_scored.json`, AND a live query against the Notion database for
past-scored grants that were never researched (or are stale per above).
This second source matters — `grants_scored.json` is overwritten every scan
and has no memory of past runs, so without the Notion query the scheduled
job would only ever research that day's brand-new arrivals and the
historical backlog would never drain. (This surfaced a real 78-grant
backlog on 2026-08-09 that had been sitting in Notion, scored well, for
weeks with zero research — see git log for the fix.)

**Selection is pinned-first, then score+aging — not pure top-score-wins**
(changed 2026-08-18: the same audit found `CTCN/AFCIA` at 2.55 and a
non-duplicate `Social Shifters` row at 2.5, both genuinely Monitor-eligible,
both permanently starved because they were competing against same-day
4.2-scorers every single cycle — no number of cycles waiting ever let them
win a slot). Up to `PINNED_SLOTS` (2) candidates whose Notion `Status` is
manually set to `"Priority"` always get a slot regardless of score — that's
how Ricardo tells the pipeline "I already know this one matters." Everything
else is ranked by `final_score + agingBonus(scanDate)`
(`src/notion-client.js`) — a small bonus that grows the longer a backlog
grant has been waiting, capped at +1.0. Local same-day candidates get zero
bonus; aging only helps things that keep losing to newer arrivals cycle
after cycle, it doesn't help a fresh grant jump the queue on day one.

Run it, then read `=== RESEARCH_TARGETS_JSON ===` from stdout (not the JS
`global.researchTargets` — that only works if you `require()` the file in
the same process, which the scan step and the save step don't share). Spawn
one `general-purpose` Agent per target (parallel, same message) using
`target.research_prompt` verbatim, then call
`global.saveResearchResults([{ grant, report, result }, ...])` via a fresh
`node -e "require('./src/deep-research.js'); global.saveResearchResults([...])"`.
It's async — you don't need to explicitly await it in the one-liner, Node
won't exit while it's pending. Grants sourced from the Notion backlog (they
carry `grant._notion_page_id`) get PATCHed to Notion directly inside
`saveResearchResults`, since `notion-sync.js`'s normal re-sync only ever
looks at `grants_scored.json` and would never see them.

See `.claude/skills/grant-deep-research/SKILL.md` for the full interactive
contract (same mechanism, triggered on request instead of automatically).

## Scoring guidance

**The most important rule: theme match ≠ competitive fit.** A grant can be
thematically related but structurally wrong. Always ask: "Who actually wins
this grant, and does this org look like that organization?"

All of the org-specific substance that used to live in this section — focus
areas, which grants deserve strong vs. moderate mission scores, exact
competitive_fit penalties per funder type, strategic_fit adjustments — now
lives entirely in `org-profile.yaml`'s `competitive_context` block
(`realistic_win_profile`, `hard_gaps`, `structural_flags`). That file is
gitignored and per-org by design; `src/scorer/prompts.js::buildGapsBlock()`
reads it and injects it straight into the Claude scoring prompt, so it's
already live for every scoring run — nothing here needs to duplicate it.

If you're scoring interactively and want to see the actual hard gaps/flags
in effect, read `org-profile.yaml` directly rather than this file.

## Sources

`src/scrapers/index.js::fetchAllGrants()` is the real map — 9 source groups,
run in the numbered order below (Playwright ones sequential, deliberately —
see "never parallelize scraping" in Troubleshooting). Only groups 2 and 9
are actually driven by `config/sources.yaml`; everything else is a
self-contained module with its own hardcoded URL list. Don't assume
sources.yaml is the whole picture — most of the real source list lives in
code, not YAML:

1. `reliefweb.js` / `grantsgov.js` — API sources, config under `apis:` in
   sources.yaml, both currently `enabled: false` (ReliefWeb needs a free
   `appname` registration; Grants.gov RSS was deprecated)
2. `rss.js` — feeds under `rss:` in sources.yaml (ImpactFunding Substack,
   Bond UK, Devex, Climate Policy Initiative, Terra Viva Grants, etc.) —
   global, not LAC-specific
3. `fundsforngos.js` — hardcoded URLs, Cloudflare-limited (see Troubleshooting)
4. `spanish-aggregators.js` + `usaid-grantsgov.js` — hardcoded URLs; **this
   is the one group actually tied to a specific geography by construction**
5. `foundations.js` — IAF, UNDP SGP, CEPF, Rainforest Trust; hardcoded,
   all global/multi-country funders, not LAC-only
6. `new-sources.js` — MAR Fund, HeroX, IDB, Mercociudades + static entries; hardcoded
7. `portals.js` — WePropel, EasyGrant, Leaders of Today; hardcoded. Distinct
   from any LinkedIn company page of the same name — don't confuse the two
   when reading logs, they're unrelated sources that happen to share a name
8. `email-outlook.js` — scans a folder of forwarded grant newsletters via
   Microsoft Graph; one-time setup via `node scripts/auth-outlook.js` (see
   `.env.example` for the required vars)
9. `linkedin.js` — public company pages via Jina Reader, **no login/auth,
   guest-view only** — fetch the company ROOT page (`/company/<slug>/`),
   never `/posts/` or `/about/` (those hit LinkedIn's login wall even
   through Jina Reader). Config under `linkedin:` in sources.yaml; add an
   org by appending a `sources:` entry — no code changes needed

Geography/theme relevance is a **scoring** concern (`org-profile.yaml`
matched per-grant in `src/scorer/rules.js`), not a scraping-layer
restriction — swapping `org-profile.yaml` for a different org/region
changes what scores well without touching any scraper. Only group 4 above
is hardcoded to a region; adding a new group in the same shape (a
`fetch<Name>()` function returning grant objects, wired into
`fetchAllGrants()`) works for any source, any region.

## Automation

Two scheduled jobs, both every 2 days, both Windows Task Scheduler tasks
invoking `claude -p`:

1. **"GrantOps Full Pipeline"** (`run-full-pipeline.bat`) at **5:17am** —
   `.claude/skills/grant-full-pipeline/SKILL.md`'s scan → real Claude
   scoring → Notion sync → near-miss gate → deep-research → re-sync
   sequence, with **no pauses for confirmation** (Ricardo's standing
   instruction, scoped to this unattended run only — normal interactive
   sessions still ask as usual).
2. **"GrantOps Pipeline Validate"** (`run-pipeline-validate.bat`) at
   **7:17am**, 2 hours later — `.claude/skills/grant-pipeline-validate/
   SKILL.md` checks whether job 1 actually completed (it can hang after
   finishing its real work — see Troubleshooting) and finishes it if not.

Both were moved off the top of the hour on 2026-08-22 (was 5:00am) after
confirming LinkedIn's Jina Reader calls fail specifically at round cron
times (shared-IP congestion) but work fine minutes later with identical
code — an off-minute schedule avoids that congestion window entirely.

Both skills' own file headers explain why every step must run in the
foreground with nothing backgrounded: each is a single headless turn with
no continuation, so a backgrounded step never finishes.

**Trust prerequisite**: `.claude/settings.json`'s permission allow-list only
takes effect in headless (`claude -p`) mode if this project folder has
already been marked trusted via an *interactive* `claude` session (run
`claude` here once, accept the trust dialog). Hand-editing
`~/.claude.json`'s `hasTrustDialogAccepted` field does NOT reliably work —
the live process reverts it. This is a real, previously-hit failure mode
when migrating this project to a new machine, not a hypothetical.

**Do not run this pipeline from two machines against the same cloud-synced
project folder at once.** `output/history.json` (dedup state) is a plain
JSON file, not a database — two processes writing it around the same time
silently lose each other's writes, producing confusing/inconsistent "new
grants found" counts across runs. If migrating to a new always-on machine,
delete the old machine's scheduled task once the new one is confirmed
working, don't run both.

## File locations

- `org-profile.yaml` — NGO profile (never committed, in .gitignore)
- `config/sources.yaml` — grant sources configuration (see "Sources" above)
- `output/grants_raw.json` — all fetched grants before scoring (overwritten every scan)
- `output/grants_prescored.json` — grants with prompts ready for Claude (overwritten every scan)
- `output/grants_scored.json` — final scored grants from the CURRENT run only
  (overwritten every scan — it is NOT a historical record; Notion is)
- `output/grants_research.json` — deep-research cache, keyed by grant
  fingerprint (`src/utils/grant-fingerprint.js`), accumulates forever
- `output/grants.tsv` — spreadsheet-ready output
- `output/report_YYYY-MM-DD.md` / `.html` — human-readable prioritized report
  (secondary artifact — Notion is the primary interface, see top of this file)
- `output/research_YYYY-MM-DD.md` — deep-research write-ups, appended per run
- `output/logs/scan_*.log`, `output/logs/scoring_*.log` — structured
  per-run audit trail (`src/logger.js`): raw counts by source, every
  filter decision with its reason, what got queued for scoring
- `logs/pipeline_run.log` — top-level log the scheduled `.bat` writes to
  (start/end timestamps + the final summary line the pipeline prints)

## For other NGOs using this tool

If someone other than Sustenta Honduras is using this:
1. They should have their own `org-profile.yaml` (copy from `org-profile.example.yaml`)
2. The scoring logic in `src/scorer/prompts.js` reads the profile dynamically
3. No changes to code are needed — only the YAML changes per organization

## Adapting sources for other regions

Edit `config/sources.yaml`:
- For Africa: add AWDF, African Philanthropy Forum, TrustAfrica RSS
- For Asia: add Asia Foundation, Ford Foundation Asia grants page
- For global: all current sources + Bond UK RSS already covers global

## Troubleshooting

- **`npm test` silently overwrites real `output/` files**: `score-with-claude.js`
  and `tracker/index.js` compute `OUTPUT_DIR` as a module-load-time constant
  (`path.join(process.cwd(), 'output')`) — this happened for real 2026-08-22,
  when a test did `process.chdir(tmpDir)` expecting `saveScoredGrants()` to
  write there; it didn't, because `OUTPUT_DIR` was already baked in from the
  first `require()`, so the test silently clobbered the REAL project's
  `output/grants_scored.json` with dummy fixture data, which then flowed
  into a live deep-research run as a fake "$4.0 APPLY_NOW" candidate before
  anyone noticed. The fix in `test/score-with-claude.test.js` mocks
  `fs.writeFileSync` instead of `chdir`-ing — if you're tempted to write a
  new test for anything in `tracker/index.js` or `score-with-claude.js` that
  touches disk, do NOT rely on `process.chdir()` to redirect it; mock `fs`
  instead, or you will have the same bug again. Restoring real data after
  this kind of corruption: `output/grants_prescored.json` is untouched by
  the scoring step, so re-running the same scoring pass against it (or
  re-deriving from Notion, which usually still has the pre-corruption sync)
  is the recovery path — check file mtimes to confirm what's actually stale
  before assuming anything is lost.
- **fundsforNGOs returns 403**: Site has Cloudflare. Try running scan at a different time or reducing scraping frequency.
- **Grants.gov API timeout**: Normal — retry with `npm run scan`
- **Empty RSS feed**: Check if the RSS URL is still active in `config/sources.yaml`
- **Playwright fails**: Run `npx playwright install chromium` to reinstall browser
- **LinkedIn scraping asks for a "paid API" / mentions Jina**: this is Jina
  Reader (`r.jina.ai`), the anonymous fetcher `src/scrapers/linkedin.js`
  uses to read public company pages — not something grant-ops itself
  requires payment for. No key is needed for normal/light use; the message
  only shows up once you hit Jina's anonymous per-IP rate limit. Fix: get a
  FREE key (no payment) at https://jina.ai/reader and set `JINA_API_KEY` in
  `.env` (documented in `.env.example`), or just set `linkedin.enabled:
  false` in `config/sources.yaml` and skip LinkedIn entirely — every other
  source still works. (Undocumented until 2026-08-21 — a friend of
  Ricardo's hit this with no explanation anywhere in the repo.)
- **A LinkedIn source shows 0 posts every run**: check for a login-wall — the
  guest-view root page occasionally still redirects; `isLoginWall()` in
  `src/scrapers/linkedin.js` should catch it and log a `[LinkedIn] <name>
  failed:` line, but that line only appears in raw stdout, not in
  `output/logs/scan_*.log` (a known gap — the structured logger doesn't
  currently surface per-source LinkedIn failures, only counts of ≥1).
- **A scan's "FILTERED [reason]" log line looks wrong / everything says the
  same reason**: that log is built from `prescore.flags` in `scan.js` — if
  it starts looking suspiciously uniform again, check that
  `src/scorer/index.js`'s `module.exports` still exports `SKIP_THRESHOLD`
  and `isNewsArticle` (this broke once already — see git log 2026-08-09 —
  and silently mislabeled every low-score grant as `NEWS_ARTICLE`).
- **Notion sync, run-scoring, or deep-research process hangs after finishing
  its real work**: `agent: false` is set on the Notion `https.request()`
  calls to avoid Node's default keep-alive agent holding the process open,
  but this has reproduced multiple times since (2026-08-18, 2026-08-22)
  despite that fix — not conclusively root-caused yet (Playwright's
  `closeBrowser()` and the Brave Search client are other suspects). In the
  unattended scheduled run this is serious: everything after the stuck step
  silently never runs. The "GrantOps Pipeline Validate" task (see
  Automation) exists specifically to catch and recover from this 2 hours
  later — check `logs/pipeline_run.log` for its "Validation check:" entries
  if a cycle looks like it produced less than expected.
