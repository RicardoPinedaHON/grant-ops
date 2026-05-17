const fs = require('fs');
const path = require('path');
const { buildHTML } = require('./html-report');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const TSV_FILE = path.join(OUTPUT_DIR, 'grants.tsv');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.json');

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
  return !!history[grant.id];
}

function markSeen(grant, history) {
  history[grant.id] = {
    title: grant.title,
    first_seen: new Date().toISOString(),
    url: grant.url,
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

module.exports = { saveTSV, saveMarkdownReport, saveHTMLReport, loadHistory, saveHistory, isKnown, markSeen };
