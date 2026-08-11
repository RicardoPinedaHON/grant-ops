# Grant-Ops — Instructions for Claude Code

## What this project does

grant-ops is an AI-powered grant opportunity scanner for NGOs. It:
1. Fetches grant opportunities from multiple sources (RSS, Playwright scrapers,
   LinkedIn company pages, an Outlook inbox, static/rolling calls)
2. Pre-scores them using rule-based logic (geography, size, deadline, org type)
3. Uses Claude to score mission alignment, competitive fit, and strategic fit
4. Deep-researches the best-scored grants live (WebSearch/WebFetch) to confirm
   they're actually open and estimate reopening timing if closed
5. Syncs everything to a Notion database — **Notion, not the local HTML
   report, is where Ricardo actually reviews and tracks grants day to day.**
   The report files still get generated as a secondary/offline artifact.

Runs unattended every 2 days via Windows Task Scheduler (see "Automation"
below) — most of the time nobody is watching this run live.

## Primary commands

### Full pipeline (what the scheduled job runs)
```
node src/cli.js run          ← scan.js -> run-scoring.js -> expand-now.js, chained
node src/deep-research.js    ← prints research targets (see "Deep research" below)
node src/notion-sync.js      ← pushes grants_scored.json + grants_research.json to Notion
```
This is exactly `.claude/skills/grant-full-pipeline/SKILL.md`'s 5-step sequence
— read that file for the authoritative step-by-step contract, including the
"do not background anything, this is one headless turn" constraint.

### Individual steps
```
node src/scan.js          ← fetches grants, pre-scores, saves grants_prescored.json
node src/run-scoring.js   ← rule-based scoring (fast, no AI key needed) + a Notion sync
```

`score-with-claude.js` is the AI-assisted path — open it inside Claude Code and say
"score the grants". Claude Code reads each `claude_prompt` field and scores natively.
No API key required; uses your existing Claude Code subscription.

### Quick commands
- `npm run scan` — fetch new grants only (skips already-seen)
- `npm run scan:all` — re-fetch everything including already-seen grants
- `npm run score` — score grants already in output/grants_prescored.json
- `npm test` — 34 unit tests (LinkedIn parsing/dedup, amount/deadline
  extraction, login-wall detection). No network calls, no API keys needed.

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
     "reasoning": "2-3 sentences: what specifically helps AND hurts"
   }
   ```
4. Use `combineScores(item.prescore, yourResponse)` from `src/scorer/index.js`
5. Collect all results into `scoredGrants` array
6. Call `saveMarkdownReport(scoredGrants, profile)` and `saveTSV(scoredGrants)`

Tiers (src/scorer/index.js): `final_score` ≥ 3.8 → APPLY_NOW, ≥ 3.2 → CONSIDER,
≥ 2.5 → MONITOR, else SKIP. Any hard-ineligibility flag (wrong geography,
scholarship-only, course-not-grant, VC-only, news article, no specific
opportunity, conference-not-grant) forces INELIGIBLE regardless of score.

## Deep research

`src/deep-research.js` picks the best-scored APPLY_NOW/CONSIDER/MONITOR
grants that don't have cached research yet (capped at 5/run for cost
control) and exposes them for Claude Code to research live with
WebSearch/WebFetch — no third-party search API, no API key.

Candidates come from **two places, merged**: today's freshly-scanned
`grants_scored.json`, AND a live query against the Notion database for
past-scored grants that were never researched. This second source matters —
`grants_scored.json` is overwritten every scan and has no memory of past
runs, so without the Notion query the scheduled job would only ever research
that day's brand-new arrivals and the historical backlog would never drain.
(This surfaced a real 78-grant backlog on 2026-08-09 that had been sitting
in Notion, scored well, for weeks with zero research — see git log for the
fix.)

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

The NGO (Sustenta Honduras) focuses on:
- **Air quality monitoring** — PM2.5 network, 18 departments, policy advocacy
- **Circular economy** — waste valorization, green jobs in rural Honduras
- **Indigenous forest protection** — La Mosquitia, early warning systems
- **Youth climate leadership** — youth-led research, decarbonization strategy
- **Water governance** — municipal networks, watershed management

### The most important rule: theme match ≠ competitive fit

A grant can be thematically related but structurally wrong. Always ask:
**"Who actually wins this grant, and does Sustenta look like that organization?"**

**Apply strong mission scores (≥1.0) AND competitive_fit 0.0 when:**
- Grant explicitly funds air quality monitoring, PM2.5, environmental data networks
- Grant explicitly targets youth-led organizations in LAC/Honduras — Sustenta qualifies as youth-led
- Grant supports indigenous community rights + environmental defenders in Mesoamerica
- Grant funds circular economy or green jobs in developing countries (small NGO track)
- Funder is already in Sustenta's network (SIDA, EU, UNDP, embassies) — prior relationship = advantage

**Apply moderate mission scores (0.6–0.9) when:**
- Grant is broad climate/environment, not specifically monitoring/youth
- Grant is development-focused with clear environmental component

**competitive_fit penalties — apply these hard:**
- **-0.5 (MAR Fund, reef/coastal funds):** Grant requires coastal/marine/reef conservation experience. Sustenta has NO coastal portfolio. Would compete against actual marine biology organizations.
- **-0.35 to -0.4 (DIV, GIF, MIT Solve, innovation scale funds):** Funder requires proven scale (reaching thousands+), RCTs, cost-effectiveness data, or "innovation packaging." Sustenta is 13 people with $51K max grant — structurally not this profile.
- **-0.35 (AECID, Spanish cooperation as lead):** Structural barrier — requires Spanish ONGD registration. Sustenta can only be local partner, not lead applicant.
- **-0.3 (agrifood/commercial supply chain funds):** GAFSP, DDF, commodity traceability programs favor commercial agribusiness actors. Not Sustenta's world.
- **-0.2 (US Embassy PDS / public diplomacy):** Only fits if the proposal centers a visible U.S.-Honduras collaboration element. Generic climate proposal would be weak.
- **-0.2 (large institutional calls >$500K needing consortium):** Sustenta can participate but needs a strong lead partner — downgrade solo application scoring.

**strategic_fit adjustments:**
- +0.1 if funder already in previous_funders list
- +0.05 if call explicitly targets small NGOs or youth-led organizations
- -0.1 if matching funds required >15%
- -0.1 if grant is highly competitive with strong institutional bias (Solve, Echoing Green — hundreds of applicants, bias toward established names)

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

The scheduled job (`run-full-pipeline.bat`, registered as the Windows Task
"GrantOps Full Pipeline", every 2 days) invokes `claude -p` with
`.claude/skills/grant-full-pipeline/SKILL.md` as the instructions — that
skill chains scan → score → deep-research → Notion sync with **no pauses for
confirmation** (Ricardo's standing instruction, scoped to this unattended
run only — normal interactive sessions still ask as usual). Its own file
header explains why every step must run in the foreground with nothing
backgrounded: this is a single headless turn with no continuation, so a
backgrounded step never finishes.

**Trust prerequisite**: `.claude/settings.json`'s permission allow-list only
takes effect in headless (`claude -p`) mode if this project folder has
already been marked trusted via an *interactive* `claude` session (run
`claude` here once, accept the trust dialog). Hand-editing
`~/.claude.json`'s `hasTrustDialogAccepted` field does NOT reliably work —
the live process reverts it. This is a real, previously-hit failure mode
when migrating this project to a new machine, not a hypothetical.

**Do not run this pipeline from two machines against the same OneDrive-synced
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

- **fundsforNGOs returns 403**: Site has Cloudflare. Try running scan at a different time or reducing scraping frequency.
- **Grants.gov API timeout**: Normal — retry with `npm run scan`
- **Empty RSS feed**: Check if the RSS URL is still active in `config/sources.yaml`
- **Playwright fails**: Run `npx playwright install chromium` to reinstall browser
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
- **Notion sync or deep-research process hangs after finishing its real
  work**: both scripts pass `agent: false` on their `https.request()` calls
  to Notion to avoid Node's default keep-alive agent holding the process
  open. If you see this again despite that fix, it wasn't conclusively
  reproduced/confirmed as the root cause — worth a closer look.
