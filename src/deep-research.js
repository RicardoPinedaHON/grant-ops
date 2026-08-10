#!/usr/bin/env node
/**
 * deep-research.js
 *
 * Loads grants_scored.json, picks the best-scored grants NOT already
 * researched, and exposes them for Claude Code to deep-research live —
 * NO API KEY, NO third-party search API. Claude Code (this session) uses
 * its own WebSearch/WebFetch tools (or the Agent tool to run one research
 * subagent per grant) and then calls saveResearchResults() to persist.
 *
 * Usage: open this file in Claude Code and say "deep research the top grants"
 *   or:  node src/deep-research.js [--limit=5]   (prints instructions + prompts)
 *
 * Mirrors score-with-claude.js's design on purpose — same "prepare data,
 * expose a save function, let Claude Code do the actual work" pattern,
 * not a second architecture.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const yaml = require('yaml');
const { buildResearchPrompt } = require('./scorer/research-prompts');
const { loadResearchCache, saveResearchCache, getResearch, setResearch } = require('./tracker/index');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const SCORED_FILE = path.join(OUTPUT_DIR, 'grants_scored.json');
const PROFILE_PATH = path.join(process.cwd(), 'org-profile.yaml');

// .env isn't auto-loaded anywhere globally in this codebase (only notion-sync.js
// and email-outlook.js load it themselves) — needed here for the Notion backlog
// query below. Mirrors notion-sync.js's own loadEnv() exactly.
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/${endpoint}`,
      method,
      // agent: false — see the matching note in notion-sync.js's notionRequest;
      // prevents Node's default keep-alive agent from holding the process open.
      agent: false,
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const TIER_TO_RECOMMENDATION = {
  '🚀 Apply Now': 'APPLY_NOW', '⭐ Consider': 'CONSIDER', '👀 Monitor': 'MONITOR',
};
// Mirrors notion-sync.js's tierLabel() exactly, so a research result that
// changes the recommendation (e.g. a stale APPLY_NOW turning out to be
// closed) is reflected in Notion with the same tier vocabulary as the rest
// of the pipeline.
const TIER_TO_RECOMMENDATION_REVERSE = {
  APPLY_NOW: '🚀 Apply Now', CONSIDER: '⭐ Consider', MONITOR: '👀 Monitor',
  INELIGIBLE: '⛔ Ineligible', SKIP: '⏭ Skip',
};

function richText(prop) {
  return (prop?.rich_text || []).map(t => t.plain_text).join('') || null;
}

function parseAmount(amountStr) {
  if (!amountStr) return { amount_min: null, amount_max: null };
  const nums = amountStr.replace(/,/g, '').match(/\d+/g);
  if (!nums) return { amount_min: null, amount_max: null };
  if (nums.length >= 2) return { amount_min: parseInt(nums[0], 10), amount_max: parseInt(nums[1], 10) };
  return { amount_min: null, amount_max: parseInt(nums[0], 10) };
}

function notionPageToGrant(page) {
  const p = page.properties;
  const title = p.Name?.title?.[0]?.plain_text || '(untitled)';
  const { amount_min, amount_max } = parseAmount(richText(p.Amount));
  return {
    title,
    funder: richText(p.Funder) || title,
    source: richText(p.Source) || 'Notion (historical backlog)',
    url: p.URL?.url || null,
    country: richText(p.Country),
    themes: (p.Themes?.multi_select || []).map(t => t.name),
    amount_min, amount_max,
    deadline: p.Deadline?.date?.start || null,
    description: [
      richText(p['Application Angle']) ? `Application angle (from prior scoring): ${richText(p['Application Angle'])}` : null,
      richText(p['Best Projects']) ? `Best-fit Sustenta projects: ${richText(p['Best Projects'])}` : null,
      richText(p['Score Breakdown']) ? `Score breakdown: ${richText(p['Score Breakdown'])}` : null,
      richText(p['Deadline Note']) ? `Deadline note: ${richText(p['Deadline Note'])}` : null,
    ].filter(Boolean).join('\n'),
    type: 'grant',
    _notion_page_id: page.id,
  };
}

// Ricardo, 2026-08-09: local grants_scored.json only ever holds the CURRENT
// run's freshly-scanned grants (it's overwritten every scan) — it has no
// memory of grants scored well on a PAST run. Without this, "APPLY_NOW/
// CONSIDER/MONITOR get deep-researched automatically every 2 days" would
// only ever apply to that day's new arrivals and would never touch the
// backlog already sitting in Notion (78 grants, going back months, found
// when this was widened). Pulling directly from Notion — the durable
// record — is what actually makes the scheduled pipeline drain that
// backlog over time (still capped at `limit` per run for cost control).
async function fetchNotionBacklog(alreadyHaveFingerprints) {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DB_ID) return [];
  const out = [];
  let cursor;
  try {
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const resp = await notionRequest('POST', `databases/${process.env.NOTION_DB_ID}/query`, body);
      if (!resp.results) break;
      for (const page of resp.results) {
        const tierName = page.properties?.Tier?.select?.name;
        const recommendation = TIER_TO_RECOMMENDATION[tierName];
        const researched = page.properties?.['Deep Researched']?.checkbox ?? false;
        if (!recommendation || researched) continue;
        const grant = notionPageToGrant(page);
        if (alreadyHaveFingerprints.has(grant.url || grant.title)) continue;
        out.push({
          grant,
          scoring: {
            final_score: page.properties?.Score?.number ?? 0,
            recommendation,
            days_remaining: null,
          },
        });
      }
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);
  } catch (err) {
    console.error('Notion backlog query failed (continuing with local candidates only):', err.message);
  }
  return out;
}

// Ricardo, 2026-08-09: broadened from ['APPLY_NOW', 'CONSIDER'] — the rule+Claude
// scoring pipeline had gone over a month (since ~June 26) without producing a
// single APPLY_NOW/CONSIDER grant, which silently starved deep-research of any
// targets at all. Take a stab at MONITOR too, best-scored first, so real
// candidates aren't lost just because scoring runs conservative. SKIP/
// INELIGIBLE remain excluded — those are the ones "que no" (genuinely not
// worth the research cost: wrong geography, expired, too small, etc).
const RESEARCH_ELIGIBLE = ['APPLY_NOW', 'CONSIDER', 'MONITOR'];
const DEFAULT_LIMIT = 5;

if (!fs.existsSync(SCORED_FILE)) {
  console.error('grants_scored.json not found. Run scoring first (node src/run-scoring.js or score with Claude Code).');
  process.exit(1);
}

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : DEFAULT_LIMIT;

const scored = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
const profile = yaml.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const researchCache = loadResearchCache();

global.profile = profile;

/**
 * Claude Code calls this after researching all targets.
 * @param {Array} results — array of { grant, report, result } where:
 *   - report is the full human-readable text (Part 1 of the prompt's output)
 *   - result is the parsed JSON block (Part 2): { likelihood_percent,
 *     recommendation, appears_closed_or_expired, status_evidence,
 *     reopens_within_12mo, reopening_estimate, confidence, sources }
 */
global.saveResearchResults = async function saveResearchResults(results) {
  const saved = [];

  for (const { grant, report, result } of results) {
    let recommendation = result.recommendation;
    let timingDowngraded = false;

    // Deterministic override — don't trust the subagent alone to apply this
    // (Ricardo, 2026-08-07): APPLY_NOW means "act now." If the call is
    // closed/expired AND our best educated guess says it won't reopen
    // within the next 12 months, that's not something to act on now — pull
    // it down to CONSIDER (good fit, just not urgent). Absent/unknown
    // reopens_within_12mo defaults to the cautious "false" per the prompt's
    // own instruction, so a missing field still triggers the downgrade
    // rather than silently skipping it. This only ever touches APPLY_NOW —
    // CONSIDER/MONITOR/SKIP/INELIGIBLE from the fit-based step pass through
    // untouched.
    const reopensSoon = result.reopens_within_12mo === true;
    if (result.appears_closed_or_expired && !reopensSoon && recommendation === 'APPLY_NOW') {
      recommendation = 'CONSIDER';
      timingDowngraded = true;
    }

    const entry = { ...result, recommendation, timing_downgraded: timingDowngraded, report };
    setResearch(grant, entry, researchCache);
    saved.push({ grant, entry });

    // Ricardo, 2026-08-09: grants pulled from the Notion backlog (see
    // fetchNotionBacklog above) aren't in this run's grants_scored.json, so
    // the normal notion-sync.js re-sync step (skill step 5) never sees them
    // and can't push the research fields itself. PATCH those pages directly,
    // right here, so backlog-sourced research actually lands in Notion.
    // Locally-scored grants (no _notion_page_id) are untouched here — they
    // flow through the existing notion-sync.js path as before.
    if (grant._notion_page_id && process.env.NOTION_TOKEN && process.env.NOTION_DB_ID) {
      try {
        const tierName = TIER_TO_RECOMMENDATION_REVERSE[recommendation] || '⏭ Skip';
        const researchStatus = entry.appears_closed_or_expired ? 'Closed'
          : (entry.status_evidence == null ? 'Could not confirm' : 'Open');
        const resp = await notionRequest('PATCH', `pages/${grant._notion_page_id}`, {
          properties: {
            'Deep Researched': { checkbox: true },
            'Likelihood %': { number: entry.likelihood_percent ?? null },
            'Research Status': { select: { name: researchStatus } },
            'Research Summary': { rich_text: [{ text: { content: (report || '').slice(0, 1900) } }] },
            Tier: { select: { name: tierName } },
          },
        });
        if (resp.object !== 'page') {
          console.error(`  [Notion PATCH failed] ${grant.title.slice(0, 60)} ->`, JSON.stringify(resp).slice(0, 300));
        }
      } catch (err) {
        console.error(`  [Notion PATCH error] ${grant.title.slice(0, 60)} ->`, err.message);
      }
    }
  }

  saveResearchCache(researchCache);

  const reportPath = appendResearchSection(saved);

  console.log(`\nSaved ${saved.length} research result(s) to output/grants_research.json`);
  console.log(`Appended research section to: ${reportPath}`);
  saved.forEach(({ grant, entry }) => {
    const flag = entry.timing_downgraded ? '  [TIMING DOWNGRADE: closed, not reopening within 12mo]' : '';
    console.log(`  ${entry.likelihood_percent}% ${entry.recommendation} — ${grant.title.slice(0, 60)}${flag}`);
  });

  return { researchFile: path.join(OUTPUT_DIR, 'grants_research.json'), reportPath };
};

// ─── Build candidates (local scan + Notion backlog) and expose the target
// list. Async because of the Notion query — kept AFTER global.saveResearchResults
// is already assigned above (synchronously) so that a `node -e "require(...);
// global.saveResearchResults(...)"` invocation (skill step 4, run separately
// from step 2) never depends on this having finished. `node src/deep-
// research.js` run as a plain script (step 2) naturally waits for this to
// complete before the process exits, since Node doesn't exit while a promise
// is pending. ─────────────────────────────────────────────────────────────
(async () => {
  const localCandidates = scored
    .filter(item => RESEARCH_ELIGIBLE.includes(item.scoring.recommendation))
    .filter(item => !getResearch(item.grant, researchCache));

  const localFingerprints = new Set(localCandidates.map(i => i.grant.url || i.grant.title));
  const backlogCandidates = await fetchNotionBacklog(localFingerprints);

  const allEligible = [...localCandidates, ...backlogCandidates];
  const candidates = allEligible
    .sort((a, b) => b.scoring.final_score - a.scoring.final_score)
    .slice(0, limit);

  console.log(`\n=== Grant-Ops: Deep Research ===`);
  console.log(`Organization: ${profile.organization.name}`);
  console.log(`Eligible (${RESEARCH_ELIGIBLE.join('/')}) grants: ${allEligible.length} (${localCandidates.length} from today's scan, ${backlogCandidates.length} from Notion backlog)`);
  console.log(`Selected for this run (top ${limit}): ${candidates.length}`);

  if (!candidates.length) {
    console.log(`\nNothing new to research. Every ${RESEARCH_ELIGIBLE.join('/')} grant already has a cached research result.`);
    return;
  }

  console.log(`\nFor each item in global.researchTargets, use the research_prompt with live web`);
  console.log(`search + page fetches (WebSearch/WebFetch, or one Agent subagent per grant run`);
  console.log(`in parallel). Parse the trailing JSON block from each response, then call`);
  console.log(`global.saveResearchResults([{ grant, report, result }, ...]).\n`);

  const researchTargets = candidates.map(item => ({
    grant: item.grant,
    scoring: item.scoring,
    research_prompt: buildResearchPrompt(item.grant, profile, { daysRemaining: item.scoring.days_remaining }),
  }));

  researchTargets.forEach((t, i) => {
    console.log(`  [${i}] (${t.scoring.final_score.toFixed(2)} ${t.scoring.recommendation}) ${t.grant.title.slice(0, 70)}`);
  });

  global.researchTargets = researchTargets;

  // Printed explicitly (not just set on `global`) so this also works when
  // deep-research.js is run as a plain subprocess (`node src/deep-research.js`,
  // no `require()` in the same process) — the calling agent can parse
  // target.research_prompt straight out of captured stdout instead of relying
  // on cross-process access to a JS global, which doesn't exist.
  console.log('\n=== RESEARCH_TARGETS_JSON ===');
  console.log(JSON.stringify(researchTargets));
})();

function appendResearchSection(saved) {
  const date = new Date().toISOString().split('T')[0];
  const reportPath = path.join(OUTPUT_DIR, `research_${date}.md`);

  const lines = [`# Grant-Ops Deep Research — ${date}`, `**Organization:** ${profile.organization.name}`, ''];
  for (const { entry } of saved) {
    lines.push(entry.report, '', '---', '');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

module.exports = { RESEARCH_ELIGIBLE, DEFAULT_LIMIT };
