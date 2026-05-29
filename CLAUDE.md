# Grant-Ops — Instructions for Claude Code

## What this project does

grant-ops is an AI-powered grant opportunity scanner for NGOs. It:
1. Fetches grant opportunities from multiple sources (APIs, RSS feeds, web scraping)
2. Pre-scores them using rule-based logic (geography, size, deadline, language)
3. Uses Claude to score mission alignment and strategic fit
4. Outputs a prioritized list of grants with application angles

## Primary commands

### Full scan + score (most common)
```
node src/scan.js          ← fetches grants, pre-scores, saves grants_prescored.json
node src/run-scoring.js   ← rule-based scoring (fast, no AI key needed)
```

Then open `output/report_YYYY-MM-DD.html` in any browser — that's your visual dashboard.

`score-with-claude.js` is the AI-assisted path — open it inside Claude Code and say
"score the grants". Claude Code reads each `claude_prompt` field and scores natively.
No API key required; uses your existing Claude Code subscription.

### Quick commands
- `npm run scan` — fetch new grants only (skips already-seen)
- `npm run scan:all` — re-fetch everything including already-seen grants
- `npm run score` — score grants already in output/grants_prescored.json

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

## File locations

- `org-profile.yaml` — NGO profile (never committed, in .gitignore)
- `config/sources.yaml` — grant sources configuration
- `output/grants_raw.json` — all fetched grants before scoring
- `output/grants_prescored.json` — grants with prompts ready for Claude
- `output/grants_scored.json` — final scored grants
- `output/grants.tsv` — spreadsheet-ready output
- `output/report_YYYY-MM-DD.md` — human-readable prioritized report

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
