const fs = require('fs');
const path = require('path');
const { buildHTML } = require('./html-report');
const { grantFingerprint } = require('../utils/grant-fingerprint');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const TSV_FILE = path.join(OUTPUT_DIR, 'grants.tsv');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.json');
const RESEARCH_FILE = path.join(OUTPUT_DIR, 'grants_research.json');

const TSV_HEADERS = [
  'score', 'recommendation', 'title', 'funder', 'source',
  'amount_range', 'deadline', 'days_remaining', 'best_projects',
  'application_angle', 'confidence', 'geo_score', 'mission_score',
  'flags', 'url', 'fetched_at',
];

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function isKnown(grant, history) {
  if (history[grant.id]) return true;
  // Also check by fingerprint — catches same grant with different ID across sources/runs
  const fp = grantFingerprint(grant);
  return fp.length > 3 && !!history[`fp:${fp}`];
}

function markSeen(grant, history) {
  const entry = {
    title: grant.title,
    first_seen: new Date().toISOString(),
    url: grant.url,
  };
  history[grant.id] = entry;
  // Store fingerprint alias so the same grant under a different ID is recognized
  const fp = grantFingerprint(grant);
  if (fp.length > 3) {
    history[`fp:${fp}`] = { grant_id: grant.id, title: grant.title, first_seen: entry.first_seen };
  }
}

// ── Post-level dedup (LinkedIn and any other raw-content source) ───────────
// Same history.json storage as grant dedup above, different key namespace
// (`li:<fingerprint>`) so the two identity spaces never collide. This is
// deliberately generic content-fingerprint dedup — not grant-specific — so
// it persists across runs through the exact same loadHistory/saveHistory
// calls scan.js already makes, with no parallel storage.
function isPostSeen(fingerprint, history) {
  return !!history[`li:${fingerprint}`];
}

function markPostSeen(fingerprint, meta, history) {
  history[`li:${fingerprint}`] = { ...meta, first_seen: new Date().toISOString() };
}

// ── Deep-research cache — same JSON-file storage pattern, own file since a
// research result is a large object (full report), not a small "seen" flag.
// Keyed by grantFingerprint() (falls back to grant.id when the fingerprint
// is too weak/empty) so re-running a scan never pays for the same grant's
// research twice, across runs, sources, or scan.js dedup churn.
function researchKey(grant) {
  const fp = grantFingerprint(grant);
  return fp.length > 3 ? `fp:${fp}` : `id:${grant.id}`;
}

function loadResearchCache() {
  if (!fs.existsSync(RESEARCH_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveResearchCache(cache) {
  ensureOutputDir();
  fs.writeFileSync(RESEARCH_FILE, JSON.stringify(cache, null, 2));
}

function getResearch(grant, cache) {
  return cache[researchKey(grant)] || null;
}

function setResearch(grant, result, cache) {
  cache[researchKey(grant)] = {
    ...result,
    grant_title: grant.title,
    grant_url: grant.url,
    researched_at: new Date().toISOString(),
  };
}

function saveTSV(scoredGrants) {
  ensureOutputDir();

  // Sort by score descending
  const sorted = [...scoredGrants].sort((a, b) => b.scoring.final_score - a.scoring.final_score);

  const lines = [TSV_HEADERS.join('\t')];

  for (const item of sorted) {
    const { grant, scoring } = item;
    if (!scoring || scoring.final_score == null || isNaN(scoring.final_score)) continue;
    const amountRange = formatAmount(grant.amount_min, grant.amount_max);
    const row = [
      scoring.final_score.toFixed(2),
      scoring.recommendation,
      sanitize(grant.title),
      sanitize(grant.funder),
      grant.source,
      amountRange,
      grant.deadline || 'Rolling',
      scoring.days_remaining !== null ? scoring.days_remaining : '',
      (scoring.best_projects || []).join(' | '),
      sanitize(scoring.application_angle || ''),
      scoring.confidence,
      scoring.scores.geo?.toFixed(2) || '',
      scoring.scores.mission_alignment?.toFixed(2) || '',
      (scoring.flags || []).join(' '),
      grant.url,
      grant.fetched_at,
    ];
    lines.push(row.join('\t'));
  }

  fs.writeFileSync(TSV_FILE, lines.join('\n'), 'utf8');
  return TSV_FILE;
}

function saveMarkdownReport(scoredGrants, profile) {
  ensureOutputDir();
  const date = new Date().toISOString().split('T')[0];
  const reportFile = path.join(OUTPUT_DIR, `report_${date}.md`);

  const valid  = scoredGrants.filter(g => g.scoring && g.scoring.final_score != null && !isNaN(g.scoring.final_score));
  const sorted = [...valid].sort((a, b) => b.scoring.final_score - a.scoring.final_score);
  const applyNow = sorted.filter(g => g.scoring.recommendation === 'APPLY_NOW');
  const consider = sorted.filter(g => g.scoring.recommendation === 'CONSIDER');
  const monitor = sorted.filter(g => g.scoring.recommendation === 'MONITOR');

  const lines = [
    `# Grant-Ops Report — ${date}`,
    `**Organization:** ${profile.organization.name}`,
    `**Grants analyzed:** ${scoredGrants.length}`,
    `**Apply now:** ${applyNow.length} | **Consider:** ${consider.length} | **Monitor:** ${monitor.length}`,
    '',
  ];

  if (applyNow.length) {
    lines.push('## 🔥 Apply Now (score ≥ 4.2)');
    lines.push('');
    for (const item of applyNow) appendGrantBlock(lines, item);
  }

  if (consider.length) {
    lines.push('## ✅ Consider (score 3.5–4.1)');
    lines.push('');
    for (const item of consider) appendGrantBlock(lines, item);
  }

  if (monitor.length) {
    lines.push('## 👀 Monitor (score 2.8–3.4)');
    lines.push('');
    for (const item of monitor.slice(0, 10)) appendGrantBlock(lines, item); // Cap at 10
  }

  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');
  return reportFile;
}

function saveHTMLReport(scoredGrants, profile) {
  ensureOutputDir();
  const date = new Date().toISOString().split('T')[0];
  const htmlFile = path.join(OUTPUT_DIR, `report_${date}.html`);
  const html = buildHTML(scoredGrants, profile);
  fs.writeFileSync(htmlFile, html, 'utf8');
  return htmlFile;
}

function appendGrantBlock(lines, { grant, scoring }) {
  const amount = formatAmount(grant.amount_min, grant.amount_max);
  const deadline = grant.deadline
    ? `${grant.deadline}${scoring.days_remaining !== null ? ` (${scoring.days_remaining} days)` : ''}`
    : 'Rolling';

  lines.push(`### ${scoring.final_score.toFixed(1)} — ${grant.title}`);
  lines.push(`**Funder:** ${grant.funder} | **Source:** ${grant.source}`);
  lines.push(`**Amount:** ${amount} | **Deadline:** ${deadline}`);
  if (scoring.best_projects?.length) {
    lines.push(`**Best fit projects:** ${scoring.best_projects.join(', ')}`);
  }
  if (scoring.application_angle) {
    lines.push(`**Angle:** ${scoring.application_angle}`);
  }
  if (scoring.reasoning) {
    lines.push(`> ${scoring.reasoning}`);
  }
  lines.push(`🔗 ${grant.url}`);
  lines.push('');
}

function formatAmount(min, max) {
  if (!min && !max) return 'Not specified';
  if (min && max) return `$${min.toLocaleString()}–$${max.toLocaleString()}`;
  if (max) return `Up to $${max.toLocaleString()}`;
  return `From $${min.toLocaleString()}`;
}

function sanitize(str) {
  return (str || '').replace(/\t/g, ' ').replace(/\n/g, ' ').trim();
}

module.exports = {
  saveTSV, saveMarkdownReport, saveHTMLReport, loadHistory, saveHistory, isKnown, markSeen,
  isPostSeen, markPostSeen,
  loadResearchCache, saveResearchCache, getResearch, setResearch,
};
