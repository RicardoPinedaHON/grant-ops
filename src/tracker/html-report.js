/**
 * html-report.js
 * Clean, minimal HTML dashboard. Light theme with Sustenta brand accent.
 */

'use strict';

const TIER_CONFIG = {
  APPLY_NOW: { label: 'Apply Now',  emoji: '🔥', accent: '#009966', light: '#f0fdf9', text: '#065f46' },
  CONSIDER:  { label: 'Consider',  emoji: '✅', accent: '#00b377', light: '#f0fdf4', text: '#166534' },
  MONITOR:   { label: 'Monitor',   emoji: '👀', accent: '#d97706', light: '#fffbeb', text: '#92400e' },
  SKIP:      { label: 'Skip',      emoji: '—',  accent: '#9ca3af', light: '#f9fafb', text: '#6b7280' },
};

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreBar(score, accent, max = 5) {
  const pct = Math.min((score / max) * 100, 100).toFixed(1);
  return `<div class="sbar-bg"><div class="sbar-fill" style="width:${pct}%;background:${accent}"></div></div>`;
}

function tagList(items) {
  return (items || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
}

function formatAmount(min, max) {
  if (!min && !max) return null;
  if (min && max) return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  if (max) return `Up to $${max.toLocaleString()}`;
  return `From $${min.toLocaleString()}`;
}

function formatDeadline(deadline, days) {
  if (!deadline) return { label: 'Rolling', urgent: false };
  if (days !== null) {
    if (days < 0)  return { label: 'Closed', urgent: false };
    if (days === 0) return { label: 'Closes today', urgent: true };
    if (days <= 14) return { label: `${deadline} · ${days}d left`, urgent: true };
    return { label: `${deadline} · ${days}d`, urgent: false };
  }
  return { label: deadline, urgent: false };
}

function chip(label, val) {
  if (val === undefined || val === null) return '';
  const v = Number(val);
  const opacity = v >= 0.7 ? '1' : v >= 0.35 ? '0.6' : '0.35';
  return `<span class="chip" style="opacity:${opacity}">${label}<b>${v.toFixed(2)}</b></span>`;
}

function grantCard(item) {
  const { grant, scoring } = item;
  const tier = TIER_CONFIG[scoring.recommendation] || TIER_CONFIG.SKIP;
  const amount = formatAmount(grant.amount_min, grant.amount_max);
  const dl = formatDeadline(grant.deadline, scoring.days_remaining);
  const showSource = grant.source && grant.source !== grant.funder;

  return `<div class="card">
  <div class="card-bar" style="background:${tier.accent}"></div>
  <div class="card-inner">

    <div class="card-top">
      <div class="card-score-col">
        <span class="score-big" style="color:${tier.accent}">${scoring.final_score.toFixed(1)}</span>
        <span class="score-sub">/5</span>
        ${scoreBar(scoring.final_score, tier.accent)}
        <span class="tier-pill" style="background:${tier.light};color:${tier.text}">${tier.emoji} ${tier.label}</span>
      </div>
      <div class="card-main-col">
        <h3 class="card-title">
          ${grant.url
            ? `<a href="${esc(grant.url)}" target="_blank" rel="noopener">${esc(grant.title)}</a>`
            : esc(grant.title)}
        </h3>
        <div class="meta-row">
          <span class="meta-funder">${esc(grant.funder)}</span>
          ${showSource ? `<span class="meta-sep">·</span><span class="meta-source">${esc(grant.source)}</span>` : ''}
          ${amount ? `<span class="meta-sep">·</span><span class="meta-amount">${esc(amount)}</span>` : ''}
          <span class="meta-sep">·</span>
          <span class="meta-deadline${dl.urgent ? ' meta-deadline--urgent' : ''}">⏰ ${esc(dl.label)}</span>
        </div>
      </div>
    </div>

    ${scoring.best_projects && scoring.best_projects.length ? `
    <div class="card-section">
      <span class="section-label">Best fit</span>
      <div class="tags">${tagList(scoring.best_projects)}</div>
    </div>` : ''}

    ${scoring.application_angle ? `
    <div class="card-section">
      <span class="section-label">Angle</span>
      <p class="angle-text">${esc(scoring.application_angle)}</p>
    </div>` : ''}

    ${scoring.reasoning ? `
    <div class="card-section">
      <p class="reasoning-text">${esc(scoring.reasoning)}</p>
    </div>` : ''}

    <div class="chips">
      ${chip('Geo ', scoring.scores.geo)}
      ${chip('Size ', scoring.scores.size)}
      ${chip('Deadline ', scoring.scores.deadline)}
      ${chip('Org type ', scoring.scores.org_type)}
      ${chip('Mission ', scoring.scores.mission_alignment)}
      ${chip('Strategic fit ', scoring.scores.strategic_fit)}
    </div>

  </div>
</div>`;
}

function section(tierKey, items) {
  if (!items.length) return '';
  const t = TIER_CONFIG[tierKey];
  return `<section class="tier-section" id="tier-${tierKey.toLowerCase()}">
  <div class="tier-header">
    <h2 class="tier-title" style="color:${t.accent}">${t.emoji} ${t.label}</h2>
    <span class="tier-count">${items.length}</span>
  </div>
  <div class="grant-list">
    ${items.map(grantCard).join('')}
  </div>
</section>`;
}

function buildHTML(scoredGrants, profile) {
  const date = new Date().toISOString().split('T')[0];
  const orgName = profile.organization.name;

  const valid  = scoredGrants.filter(g => g.scoring && g.scoring.final_score != null && !isNaN(g.scoring.final_score));
  const sorted = [...valid].sort((a, b) => b.scoring.final_score - a.scoring.final_score);
  const applyNow = sorted.filter(g => g.scoring.recommendation === 'APPLY_NOW');
  const consider = sorted.filter(g => g.scoring.recommendation === 'CONSIDER');
  const monitor  = sorted.filter(g => g.scoring.recommendation === 'MONITOR');
  const skip     = sorted.filter(g => g.scoring.recommendation === 'SKIP');

  const ACCENT = '#009966';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(orgName)} · Grants · ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;1,400&family=Sora:wght@700;800&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --accent: ${ACCENT};
  --bg: #ffffff;
  --surface: #f9fafb;
  --border: #e5e7eb;
  --text: #111827;
  --text-2: #6b7280;
  --text-3: #9ca3af;
  --radius: 0px;
  --font-body: 'Inter', -apple-system, sans-serif;
  --font-head: 'Sora', -apple-system, sans-serif;
}

body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
}

/* ── Topbar ── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  background: #fff;
  border-bottom: 1px solid var(--border);
  padding: 0 2rem;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.topbar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar-logo {
  height: 24px;
  width: auto;
}
.topbar-name {
  font-family: var(--font-head);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: -0.01em;
}
.topbar-date { font-size: 0.75rem; color: var(--text-3); }

/* ── Page header ── */
.page-header {
  padding: 3rem 2rem 2rem;
  max-width: 900px;
  margin: 0 auto;
  border-bottom: 1px solid var(--border);
}
.page-header h1 {
  font-family: var(--font-head);
  font-size: 2rem;
  font-weight: 800;
  color: var(--text);
  letter-spacing: -0.03em;
  margin-bottom: 0.5rem;
}
.page-header p {
  font-size: 0.85rem;
  color: var(--text-2);
}

/* ── Summary numbers ── */
.summary-row {
  display: flex;
  gap: 2rem;
  padding: 1.5rem 2rem;
  max-width: 900px;
  margin: 0 auto;
  border-bottom: 1px solid var(--border);
}
.stat { text-align: left; }
.stat-num {
  font-family: var(--font-head);
  font-size: 1.75rem;
  font-weight: 800;
  line-height: 1;
}
.stat-lbl {
  font-size: 0.72rem;
  color: var(--text-3);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 2px;
}

/* ── Filter pills ── */
.filter-row {
  display: flex;
  gap: 6px;
  padding: 1.25rem 2rem;
  max-width: 900px;
  margin: 0 auto;
}
.filter-btn {
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 600;
  padding: 5px 14px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.12s;
  letter-spacing: 0.01em;
}
.filter-btn:hover { border-color: var(--accent); color: var(--accent); }
.filter-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

/* ── Content ── */
main {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 2rem 4rem;
}

/* ── Tier section ── */
.tier-section { margin-bottom: 3rem; }
.tier-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 1.5rem 0 0.75rem;
  border-top: 2px solid var(--border);
}
.tier-title {
  font-family: var(--font-head);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.tier-count {
  font-size: 0.72rem;
  color: var(--text-3);
  font-weight: 500;
}

/* ── Grant list ── */
.grant-list { display: flex; flex-direction: column; gap: 1px; background: var(--border); }

/* ── Card ── */
.card {
  display: flex;
  background: #fff;
  transition: background 0.1s;
}
.card:hover { background: #fafafa; }

.card-bar {
  width: 3px;
  flex-shrink: 0;
}

.card-inner {
  flex: 1;
  padding: 1.25rem 1.5rem;
}

.card-top {
  display: flex;
  gap: 1.25rem;
  align-items: flex-start;
  margin-bottom: 0.75rem;
}

.card-score-col {
  flex-shrink: 0;
  width: 70px;
  text-align: center;
}
.score-big {
  font-family: var(--font-head);
  font-size: 1.75rem;
  font-weight: 800;
  line-height: 1;
}
.score-sub { font-size: 0.7rem; color: var(--text-3); }

.sbar-bg {
  height: 3px;
  background: var(--border);
  margin: 5px 0 8px;
  overflow: hidden;
}
.sbar-fill { height: 100%; }

.tier-pill {
  display: inline-block;
  font-size: 0.62rem;
  font-weight: 700;
  padding: 2px 7px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.card-main-col { flex: 1; min-width: 0; }

.card-title {
  font-family: var(--font-head);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.35;
  margin-bottom: 0.35rem;
  letter-spacing: -0.01em;
}
.card-title a { color: inherit; text-decoration: none; }
.card-title a:hover { color: var(--accent); }

.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 0.73rem;
  color: var(--text-2);
}
.meta-funder { font-weight: 600; color: var(--text); }
.meta-sep { color: var(--text-3); }
.meta-amount { color: var(--accent); font-weight: 500; }
.meta-deadline { color: var(--text-2); }
.meta-deadline--urgent { color: #dc2626; font-weight: 600; }

/* ── Card sections ── */
.card-section { margin-top: 0.6rem; }

.section-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-3);
  display: block;
  margin-bottom: 3px;
}

.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  font-size: 0.68rem;
  font-weight: 500;
  background: #f3f4f6;
  color: var(--text);
  padding: 2px 8px;
  border: 1px solid var(--border);
}

.angle-text {
  font-size: 0.8rem;
  color: var(--text);
  line-height: 1.55;
}

.reasoning-text {
  font-size: 0.75rem;
  color: var(--text-2);
  line-height: 1.55;
  font-style: italic;
}

/* ── Score chips ── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.chip {
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 2px 7px;
}
.chip b { font-weight: 700; color: var(--text); }

/* ── Footer ── */
footer {
  text-align: center;
  padding: 2rem;
  font-size: 0.72rem;
  color: var(--text-3);
  border-top: 1px solid var(--border);
}
footer a { color: var(--accent); text-decoration: none; }

.tier-section.hidden { display: none; }

@media (max-width: 600px) {
  .topbar, .page-header, .summary-row, .filter-row, main { padding-left: 1rem; padding-right: 1rem; }
  .card-top { flex-direction: column; gap: 0.5rem; }
  .card-score-col { display: flex; align-items: center; gap: 0.75rem; width: auto; text-align: left; }
  .summary-row { flex-wrap: wrap; gap: 1rem; }
}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-brand">
    <img class="topbar-logo" src="https://www.sustentahonduras.org/logo.png" alt="Sustenta Honduras" onerror="this.style.display='none'">
    <span class="topbar-name">Grant Radar</span>
  </div>
  <span class="topbar-date">${date}</span>
</div>

<div class="page-header">
  <h1>${esc(orgName)}</h1>
  <p>Funding opportunities · ${date}</p>
</div>

<div class="summary-row">
  ${[
    { n: scoredGrants.length,                                            lbl: 'Analyzed',  c: '#111827' },
    { n: sorted.filter(g=>g.scoring.recommendation==='APPLY_NOW').length, lbl: 'Apply Now', c: '#009966' },
    { n: sorted.filter(g=>g.scoring.recommendation==='CONSIDER').length,  lbl: 'Consider',  c: '#00b377' },
    { n: sorted.filter(g=>g.scoring.recommendation==='MONITOR').length,   lbl: 'Monitor',   c: '#d97706' },
  ].map(s => `<div class="stat">
    <div class="stat-num" style="color:${s.c}">${s.n}</div>
    <div class="stat-lbl">${s.lbl}</div>
  </div>`).join('')}
</div>

<div class="filter-row">
  <button class="filter-btn active" onclick="filter('ALL',this)">All</button>
  <button class="filter-btn" onclick="filter('APPLY_NOW',this)">🔥 Apply Now</button>
  <button class="filter-btn" onclick="filter('CONSIDER',this)">✅ Consider</button>
  <button class="filter-btn" onclick="filter('MONITOR',this)">👀 Monitor</button>
  <button class="filter-btn" onclick="filter('SKIP',this)">— Low score (${skip.length})</button>
</div>

<main>
  ${section('APPLY_NOW', applyNow)}
  ${section('CONSIDER', consider)}
  ${section('MONITOR', monitor)}
  <section class="tier-section hidden" id="tier-skip">
    <div class="tier-header">
      <h2 class="tier-title" style="color:#9ca3af">— Low score / not actionable</h2>
      <span class="tier-count">${skip.length}</span>
    </div>
    <div class="grant-list">
      ${skip.map(grantCard).join('')}
    </div>
  </section>
</main>

<footer>
  <a href="https://sustentahonduras.org" target="_blank">sustentahonduras.org</a> · grant-ops · ${date}
</footer>

<script>
function filter(tier, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tier-section').forEach(s => {
    if (tier === 'ALL') {
      // ALL hides skip by default — it's opt-in only
      s.classList.toggle('hidden', s.id === 'tier-skip');
    } else {
      s.classList.toggle('hidden', s.id !== 'tier-' + tier.toLowerCase());
    }
  });
}
</script>
</body>
</html>`;
}

module.exports = { buildHTML };
