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
     "strategic_fit": -0.2 to 0.1,
     "best_projects": ["project name"],
     "application_angle": "one sentence or null",
     "confidence": "high|medium|low",
     "reasoning": "2-3 sentences"
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

**Apply strong scores (≥1.0 mission alignment) when:**
- Grant explicitly funds environmental monitoring, climate data, or air quality
- Grant targets youth-led organizations in LAC/Central America
- Grant supports indigenous community rights + environmental defense
- Grant funds circular economy or green jobs in developing countries

**Apply moderate scores (0.6–0.9) when:**
- Grant is broad climate/environment but not specifically monitoring/youth
- Grant is development-focused with clear environmental component
- Funder is already in Sustenta's network (SIDA, EU, UNDP, embassies)

**Downgrade when:**
- Grant is US-domestic only or requires US-based lead organization
- Grant requires >15% matching funds (org capacity limit)
- Application window is <15 days away

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
