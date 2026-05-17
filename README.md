# grant-ops

AI-powered grant opportunity scanner for NGOs. Monitors 10+ sources, scores opportunities against your org profile, expands newsletter digests into individual grants, and produces a visual HTML report — all without an API key.

Built for LAC/Honduras environmental and youth NGOs. Adaptable to any region or focus area.

---

## How it works

```
Sources → Scrapers → Pre-score (rules) → AI scoring → HTML report
              ↓
     Newsletter digests
     opened + expanded
     into individual grants
```

1. **Fetches** grants from Grants.gov, RSS feeds, USAID Honduras, IKI Small Grants, RECID, Gestionándote, and ImpactFunding Substack
2. **Expands** ImpactFunding newsletter digests — Playwright opens each issue and extracts the individual grant links inside
3. **Pre-scores** each grant on geography, size match, deadline, org-type eligibility, and partnership requirements
4. **Scores** mission alignment and strategic fit using Claude Code (no API key — runs inside your Claude Code session)
5. **Outputs** a self-contained HTML report with filters for each priority tier

---

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) (for AI scoring — uses your existing subscription, no API key needed)

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

---

## Usage

### Full pipeline (recommended)

```bash
npx grant-ops run
```

Runs scan → score → expand digests → opens the HTML report. That's it.

### Step by step

```bash
npx grant-ops scan      # fetch new grants from all sources
npx grant-ops score     # rule-based scoring (fast, no AI needed)
npx grant-ops expand    # expand ImpactFunding newsletter digests
npx grant-ops report    # open the latest HTML report in your browser
```

### NPM scripts (alternative)

```bash
npm run scan
npm run score
npm run expand
npm run report
npm run run
```

---

## HTML Report

The report opens directly in your browser — no server required. Features:

- Priority tiers: **Apply Now** · **Consider** · **Monitor** · **Skip**
- Filter by tier with one click
- Score breakdown bar per grant
- Application angle for strong matches (≥3.5 score)
- Best-fit project callout
- Skip section hidden by default (accessible via filter)

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
| Strategic fit | 0.1 | Claude Code |
| **Total** | **4.5** | |

**Thresholds:** ≥4.2 Apply now · 3.5–4.1 Consider · 2.8–3.4 Monitor · <2.8 Skip

---

## Grant sources

| Source | Type | Region focus |
|---|---|---|
| Grants.gov | Free API | US bilateral / international |
| USAID Honduras | Scraper | Honduras |
| IKI Small Grants | Scraper | Global climate |
| ImpactFunding Substack | RSS + Playwright digest expansion | Global, curated |
| PhilanthropyNewsDigest | RSS | US foundations |
| RECID | Scraper | LAC Spanish |
| Gestionándote | Scraper | LAC Spanish |
| fundsforNGOs | Scraper | LAC/environment (Cloudflare-limited) |

---

## Adapting for your NGO

1. Run `npx grant-ops init` — the wizard creates a valid `org-profile.yaml` for your org
2. Optionally edit `config/sources.yaml` to enable/disable sources or add new RSS feeds
3. Run `npx grant-ops run`

No code changes needed. The scoring prompt reads your profile dynamically — focus areas, geography, grant size range, and previous funders all feed into the AI evaluation.

**Adding sources for other regions:**

Edit `config/sources.yaml`:
- Africa: add AWDF, African Philanthropy Forum, TrustAfrica RSS
- Asia: add Asia Foundation, Ford Foundation Asia page
- Global: Bond UK RSS already covers international

---

## Weekly automation (Windows)

Set up automatic weekly scans with Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\path\to\grant-ops\run-weekly.bat"' -WorkingDirectory 'C:\path\to\grant-ops'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName 'GrantOps Weekly Scan' -Action $action -Trigger $trigger -Settings $settings -Force
```

Logs are written to `logs/weekly.log`.

---

## AI scoring without an API key

grant-ops uses Claude Code (the CLI/desktop app) as its AI engine. Instead of calling the Anthropic API, it loads grant data into a Claude Code session and scores natively using your existing subscription.

To score grants:
1. Run `npx grant-ops scan` to fetch and pre-score
2. Open the project in Claude Code
3. Ask Claude: "score the grants" — it reads `output/grants_prescored.json` and scores each one

For fully automated scoring (used by `npx grant-ops score` and `npx grant-ops run`), a rule-based scorer in `src/scorer/manual-scorer.js` handles all grants without any AI call. The Claude Code session is used for reviewing and re-scoring edge cases interactively.

---

## File structure

```
grant-ops/
├── src/
│   ├── cli.js              # CLI entry point
│   ├── init-wizard.js      # Interactive org setup
│   ├── scan.js             # Fetch + pre-score
│   ├── run-scoring.js      # Rule-based scoring pipeline
│   ├── expand-now.js       # Digest expansion (standalone)
│   ├── score-with-claude.js # Claude Code session scorer
│   ├── scorer/
│   │   ├── rules.js        # Pre-scoring rules
│   │   ├── manual-scorer.js # Hardcoded scoring logic
│   │   ├── prompts.js      # Claude prompt builder
│   │   └── index.js        # Score combiner
│   ├── scrapers/
│   │   ├── index.js        # Orchestrator
│   │   ├── digest-expander.js # Playwright digest opener
│   │   ├── rss.js          # RSS feeds
│   │   ├── grantsgov.js    # Grants.gov API
│   │   └── ...             # Other scrapers
│   └── tracker/
│       ├── index.js        # Output writers (TSV, MD)
│       └── html-report.js  # HTML report generator
├── config/
│   └── sources.yaml        # Source URLs + config
├── org-profile.yaml        # Your org (gitignored)
├── org-profile.example.yaml
├── run-weekly.bat          # Windows automation
└── output/                 # Generated reports (gitignored)
```

---

## License

MIT
