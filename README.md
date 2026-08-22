# grant-ops

AI-powered grant opportunity scanner for NGOs. Monitors 15+ sources — RSS,
Playwright scrapers, public LinkedIn company pages, an Outlook inbox, and
static/rolling calls — scores opportunities against your org profile,
deep-researches the best matches live, and syncs everything to a Notion
database (plus a self-contained HTML report). No API key required for any
of it — scoring and research both run inside your Claude Code session.

Region- and sector-agnostic by design — nothing in the codebase is tied to any one country or cause. Your org's focus areas, geography, grant-size range, and funder history all come from one `org-profile.yaml`, and sources come from one `config/sources.yaml`; swap either and the same pipeline works for a health NGO in Southeast Asia or a housing nonprofit in the US. See "Adapting for your NGO" below for how to point it at your own org.

---

## How it works

```
Sources → Scrapers → Pre-score (rules) → AI scoring → Near-miss gate → Deep research → Notion + HTML report
              ↓                                              ↑              ↑
     Newsletter digests                       One cheap page fetch    Live WebSearch/WebFetch,
     opened + expanded                        for borderline Skips,   only for the best-scored,
     into individual grants                   before that verdict     not-yet-researched grants
                                               is treated as final
```

1. **Fetches** grants from RSS feeds, Playwright scrapers, public LinkedIn
   company pages, an Outlook inbox folder, and hardcoded rolling calls
2. **Expands** newsletter digests — Playwright opens each issue and extracts
   the individual grant links inside
3. **Pre-scores** each grant on geography, size match, deadline, org-type
   eligibility, and partnership requirements — with a hard ineligibility
   filter (wrong geography, scholarship-only, course-not-grant, VC-only,
   news article, no specific opportunity, conference-not-grant)
4. **Scores** mission alignment, competitive fit, and strategic fit using
   Claude Code (no API key — runs inside your Claude Code session)
5. **Validates near-misses** — grants that scored Skip by a narrow margin
   often did so on a thin one-line scraped description, not the funder's
   own text. One plain page fetch re-judges fit against the real thing
   before that Skip is treated as final, cheaper than full deep research
6. **Deep-researches** the best-scored, not-yet-researched (or gone-stale)
   grants live — confirms whether a call is actually still open and, if
   closed, estimates when it's likely to reopen — again via Claude Code's
   own WebSearch/WebFetch, no third-party search API. Selection is
   pinned-first (mark anything `Priority` in Notion to guarantee it a slot)
   then score plus a small bonus for how long a grant's been waiting, not
   pure top-score-wins — otherwise a real but modest candidate can lose to
   fresh high scorers every single cycle, forever
7. **Syncs** everything to a Notion database (tier, score, research status,
   likelihood %) and outputs a self-contained HTML report with filters for
   each priority tier

---

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) (for AI scoring/research — uses your existing subscription, no API key needed)
- A Notion integration token + database ID if you want the Notion sync (optional — everything else works without it)

---

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/grant-ops
cd grant-ops
npm install
npx playwright install chromium
```

**First time? Run the interactive wizard:**

```bash
npx grant-ops init
```

This asks you ~15 questions and creates your `org-profile.yaml`. You can also copy `org-profile.example.yaml` and fill it in manually.

Copy `.env.example` to `.env` and fill in `NOTION_TOKEN`/`NOTION_DB_ID` (Notion sync), `BRAVE_SEARCH_KEY` (optional deadline/amount enrichment), `GRAPH_CLIENT_ID`/`GRAPH_TENANT_ID` (optional Outlook inbox scanning — run `node scripts/auth-outlook.js` once to authenticate), and `JINA_API_KEY` (optional — only needed if the LinkedIn source hits Jina Reader's anonymous rate limit; a free key at [jina.ai/reader](https://jina.ai/reader) fixes it, no payment required).

---

## Usage

### Full pipeline (recommended)

```bash
npx grant-ops run
```

Runs scan → score → expand digests. For the near-miss gate, deep research,
and Notion sync too, see `node src/near-miss-check.js`,
`node src/deep-research.js`, and `node src/notion-sync.js`, or just ask
Claude Code to run the full cycle — it knows the sequence from `CLAUDE.md`.

### Step by step

```bash
npx grant-ops scan      # fetch new grants from all sources
npx grant-ops score     # rule-based scoring (fast, no AI needed)
npx grant-ops expand    # expand newsletter digests
npx grant-ops report    # open the latest HTML report in your browser
```

```bash
node src/deep-research.js   # find + prep research prompts for top-scored grants
node src/notion-sync.js     # push scored + researched grants to Notion
```

### NPM scripts (alternative)

```bash
npm run scan
npm run score
npm run expand
npm run report
npm run run
npm test        # unit tests — no network, no API keys
```

---

## HTML Report

The report opens directly in your browser — no server required. Features:

- Priority tiers: **Apply Now** · **Consider** · **Monitor** · **Skip** · **Ineligible**
- Filter by tier with one click
- Score breakdown bar per grant
- Application angle for strong matches
- Best-fit project callout
- Skip/Ineligible sections hidden by default (accessible via filter)

This is a secondary/offline artifact — if you've set up the Notion sync,
Notion is the day-to-day interface (it also carries deep-research status,
which the HTML report doesn't surface as richly).

---

## Scoring dimensions

| Dimension | Max | Method |
|---|---|---|
| Geographic eligibility | 1.0 | Rules |
| Grant size match | 0.8 | Rules |
| Deadline feasibility | 0.7 | Rules |
| Org type eligibility | 0.4 | Rules |
| Partnership requirements | 0.3 | Rules |
| Mission alignment | 1.2 | Claude Code |
| Competitive fit | -0.5 to 0.0 | Claude Code |
| Strategic fit | -0.2 to 0.1 | Claude Code |
| **Total (max)** | **~4.4** | |

**Thresholds:** ≥3.8 Apply Now · ≥3.2 Consider · ≥2.5 Monitor · else Skip.
Any hard-ineligibility flag forces Ineligible regardless of score.

Competitive fit exists to catch grants that are thematically on-topic but
structurally the wrong shape for your org — e.g. a reef-conservation fund
when you have no coastal portfolio, or an innovation fund requiring
scale/RCT evidence a small NGO can't produce. See `CLAUDE.md`'s "theme
match ≠ competitive fit" section for the full worked examples.

---

## Grant sources

`src/scrapers/index.js::fetchAllGrants()` runs 9 source groups in sequence
(Playwright ones sequential on purpose — see "never parallelize scraping"
in `CLAUDE.md`'s troubleshooting section):

| # | Group | Module(s) | Config | Notes |
|---|---|---|---|---|
| 1 | API sources | `reliefweb.js`, `grantsgov.js` | `apis:` in sources.yaml | Both currently disabled pending an API key/scraper fix — see the `enabled:` comments in sources.yaml |
| 2 | RSS feeds | `rss.js` | `rss:` in sources.yaml | ImpactFunding Substack, Bond UK, Devex, Climate Policy Initiative, Terra Viva Grants, etc. — global, not LAC-specific |
| 3 | fundsforNGOs | `fundsforngos.js` | hardcoded URLs | Cloudflare-limited — see troubleshooting |
| 4 | Spanish aggregators + USAID/Grants.gov | `spanish-aggregators.js`, `usaid-grantsgov.js` | hardcoded URLs | This is the one group tied to a specific geography by construction |
| 5 | Foundations | `foundations.js` | hardcoded | IAF, UNDP SGP, CEPF, Rainforest Trust — all global/multi-country funders |
| 6 | Multi-opportunity sources | `new-sources.js` | hardcoded | MAR Fund, HeroX, IDB, Mercociudades + static entries |
| 7 | Portal scrapers | `portals.js` | hardcoded | WePropel, EasyGrant, Leaders of Today |
| 8 | Outlook inbox | `email-outlook.js` | `.env` (Microsoft Graph) | Scans a folder of forwarded grant newsletters |
| 9 | LinkedIn company pages | `linkedin.js` | `linkedin:` in sources.yaml | Public guest-view only via Jina Reader, no login/auth |

Most of these are global or multi-country funders, not LAC-specific — the
geography filtering happens downstream in scoring (`org-profile.yaml`
matched against each grant's country/region), not in the scraper layer.
Only group 4 is hardcoded to a specific region by construction; everything
else pulls in whatever the source publishes and lets scoring decide what's
relevant to your org.

Add a **LinkedIn** or **RSS** source by appending an entry under
`linkedin.sources`/`rss` in `config/sources.yaml` — no code changes needed.
Adding a new hardcoded-URL group (3-7 above) means writing a small scraper
module with the same `fetch<Name>()` shape and wiring it into
`fetchAllGrants()` — more work, but each module is self-contained (see any
of the existing ones for the pattern).

---

## Adapting for your NGO

1. Run `npx grant-ops init` — the wizard creates a valid `org-profile.yaml` for your org
2. Optionally edit `config/sources.yaml` to enable/disable sources or add new RSS/LinkedIn feeds
3. Run `npx grant-ops run`

No code changes needed. The scoring prompt reads your profile dynamically — focus areas, geography, grant size range, and previous funders all feed into the AI evaluation.

**Adding sources for other regions:**

Edit `config/sources.yaml`:
- Africa: add AWDF, African Philanthropy Forum, TrustAfrica RSS
- Asia: add Asia Foundation, Ford Foundation Asia page
- Global: Bond UK RSS already covers international

---

## Automation (Windows)

The production setup runs the full pipeline — scan, score, deep-research,
Notion sync — unattended every 2 days via Windows Task Scheduler, invoking
`claude -p` with `.claude/skills/grant-full-pipeline/SKILL.md` as its
instructions (that skill has the full no-pause, no-backgrounding contract
for the headless run).

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\path\to\grant-ops\run-full-pipeline.bat" -WorkingDirectory "C:\path\to\grant-ops"
$trigger = New-ScheduledTaskTrigger -Once -At "<next reasonable time>" -RepetitionInterval (New-TimeSpan -Days 2) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "GrantOps Full Pipeline" -Action $action -Trigger $trigger
```

Two prerequisites the task won't work without:
1. **This project folder must be trusted** — run `claude` here once,
   interactively, and accept the trust dialog. Without that,
   `.claude/settings.json`'s permission allow-list is silently ignored in
   headless (`claude -p`) mode and every command auto-denies with no prompt
   to approve it. Hand-editing `~/.claude.json` does not reliably work.
2. **Only run this on one machine at a time** against a given cloud-synced
   copy of the project (OneDrive, Dropbox, etc.) — `output/history.json`
   isn't a database, and two machines writing it concurrently silently
   lose each other's dedup state.

Logs go to `logs/pipeline_run.log` (top-level summary per run) and
`output/logs/scan_*.log` / `scoring_*.log` (full per-grant audit trail —
what was fetched, what was filtered and why, what got queued for scoring).

`run-weekly.bat` (scan + score + expand only, no deep-research/Notion sync)
still exists for a lighter-weight setup if you don't want the full cycle.

---

## AI scoring & research without an API key

grant-ops uses Claude Code (the CLI/desktop app) as its AI engine for both
scoring and deep research. Instead of calling the Anthropic API directly, it
loads grant data into a Claude Code session and works natively using your
existing subscription — WebSearch/WebFetch for research, no third-party
search API either.

To score grants:
1. Run `npx grant-ops scan` to fetch and pre-score
2. Open the project in Claude Code
3. Ask Claude: "score the grants" — it reads `output/grants_prescored.json` and scores each one

To validate near-misses (grants that scored Skip on a thin description):
1. Run `node src/near-miss-check.js` — it fetches each candidate's funder page and prints recheck prompts
2. Ask Claude Code to re-judge fit against that real text (no web search needed, the page text is included)
3. Anything that crosses the Monitor floor becomes eligible for real deep research next

To deep-research the best matches:
1. Run `node src/deep-research.js` — it prints the top not-yet-researched (or gone-stale) candidates and their research prompts
2. Ask Claude Code to research them (spawns one subagent per grant, in parallel)
3. Results are cached and synced to Notion — trusted until they're 90+ days old AND the score has moved a lot, not forever

For fully automated rule-based scoring (used by `npx grant-ops score` and `npx grant-ops run`), `src/scorer/manual-scorer.js` handles all grants without any AI call — Claude Code is for the higher-fidelity mission/competitive/strategic scoring pass and for deep research specifically.

---

## File structure

```
grant-ops/
├── src/
│   ├── cli.js                  # CLI entry point
│   ├── init-wizard.js          # Interactive org setup
│   ├── scan.js                 # Fetch + pre-score + structured audit log
│   ├── run-scoring.js          # Rule-based scoring pipeline
│   ├── expand-now.js           # Digest expansion (standalone)
│   ├── score-with-claude.js    # Claude Code session scorer
│   ├── near-miss-check.js      # Cheap re-check of borderline Skips against the funder's own page
│   ├── deep-research.js        # Deep-research target selection (pinned+aging) + Notion backlog + save
│   ├── notion-sync.js          # Push scored/researched grants to Notion
│   ├── notion-client.js        # Shared Notion read helpers + staleness/aging logic
│   ├── logger.js               # Structured per-run audit log (output/logs/)
│   ├── scorer/
│   │   ├── rules.js            # Pre-scoring rules + hard ineligibility filter
│   │   ├── manual-scorer.js    # Hardcoded scoring logic
│   │   ├── prompts.js          # Claude scoring prompt builder
│   │   ├── research-prompts.js # Claude deep-research prompt builder
│   │   └── index.js            # Score combiner, tier thresholds
│   ├── scrapers/
│   │   ├── index.js            # Orchestrator — fetchAllGrants(), 9 source groups
│   │   ├── digest-expander.js  # Playwright digest opener
│   │   ├── linkedin.js         # Public LinkedIn company-page scraper
│   │   ├── email-outlook.js    # Outlook inbox newsletter scanner
│   │   ├── rss.js              # RSS feeds
│   │   ├── grantsgov.js        # Grants.gov API (currently disabled)
│   │   ├── reliefweb.js        # ReliefWeb API (currently disabled)
│   │   ├── fundsforngos.js     # fundsforNGOs scraper
│   │   ├── spanish-aggregators.js # Spanish-language aggregator sites
│   │   ├── usaid-grantsgov.js  # USAID + Grants.gov scraping fallback
│   │   ├── foundations.js      # IAF, UNDP SGP, CEPF, Rainforest Trust
│   │   ├── new-sources.js      # MAR Fund, HeroX, IDB, Mercociudades + static
│   │   ├── portals.js          # WePropel, EasyGrant, Leaders of Today
│   │   └── playwright-base.js  # Shared Playwright helpers (getPage, safeGoto)
│   ├── tracker/
│   │   ├── index.js            # Output writers (TSV, MD, research cache)
│   │   └── html-report.js      # HTML report generator
│   └── utils/
│       └── grant-fingerprint.js # Shared grant-identity/dedup logic
├── scripts/
│   ├── auth-outlook.js         # One-time Microsoft Graph OAuth setup
│   └── test-email-parse.js
├── test/                       # Unit tests (no network, no API keys)
├── .claude/skills/
│   ├── grant-full-pipeline/    # The unattended-scheduled-job skill
│   └── grant-deep-research/    # The interactive deep-research skill
├── config/
│   └── sources.yaml            # Source URLs + config (RSS, LinkedIn, scrapers, portals)
├── org-profile.yaml            # Your org (gitignored)
├── org-profile.example.yaml
├── run-full-pipeline.bat       # Scheduled job entry point (every 2 days)
├── run-weekly.bat              # Lighter-weight scan+score-only automation
└── output/                     # Generated reports + research cache (gitignored)
```

---

## License

MIT
