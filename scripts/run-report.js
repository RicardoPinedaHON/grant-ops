#!/usr/bin/env node
'use strict';
/**
 * Per-run validation report: did the run work, which sources were consulted
 * (with links), and how many grants each one gave. Reads output/source_status.json
 * (written by scan.js) and the scored/research files. Writes
 *   output/run_report.md           full table with links
 *   output/run_report.json         same data
 *   output/run_report_whatsapp.txt short Spanish digest (what Hugo forwards)
 * and keeps the last 10 runs in output/source_status_history.json so a source
 * that suddenly returns 0 stands out. Never throws: exits 0 even on bad input.
 *
 *   node scripts/run-report.js
 */
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { buildRegistry } = require('../config/source-registry');

const MAX_AGE_H = 6;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function buildReport({ status, registry, history = [], scored = null, now = new Date() }) {
  const out = { generated_at: now.toISOString(), overall: 'ok', problems: [], sources: [], other_sources: [], totals: status?.totals || null };
  if (!status) {
    out.overall = 'failed';
    out.problems.push('No hay source_status.json: el scan no corrió o falló antes de terminar.');
    return out;
  }
  const ageH = (now - new Date(status.ran_at)) / 36e5;
  out.scan_ran_at = status.ran_at;
  if (ageH > MAX_AGE_H) out.problems.push(`El último scan fue hace ${Math.round(ageH)} h; esta corrida no lo actualizó.`);
  const prev = history.length ? history[history.length - 1].counts || {} : {};
  const used = new Set();

  for (const r of registry) {
    const grp = status.groups?.[r.group];
    const li = r.linkedinKey ? status.linkedin?.[r.linkedinKey] : null;
    let raw = 0, repeats = 0, queued = 0;
    for (const s of r.sources) {
      const b = status.by_source?.[s];
      if (b) { raw += b.raw; repeats += b.repeats; queued += b.queued; used.add(s); }
    }
    let state = 'ok', note = '';
    if (r.group === 'linkedin') {
      if (!li) { state = 'missing'; note = 'sin registro en esta corrida'; }
      else if (!li.ok) { state = 'failed'; note = li.error || 'falló'; }
      else { note = `${li.posts_visible} posts visibles, ${li.new_posts} nuevos, ${li.already_seen} ya vistos`; if (li.posts_visible === 0) state = 'empty'; }
    } else if (r.group.startsWith('api:')) {
      state = 'off';
    } else if (grp && !grp.ok) { state = 'failed'; note = grp.error || 'falló'; }
    else if (!grp) { state = 'missing'; note = 'sin registro en esta corrida'; }
    else if (r.sources.length && raw === 0) { state = 'empty'; note = 'sin resultados'; }
    if ((state === 'empty') && (prev[r.name] || 0) > 0) note += ` (antes: ${prev[r.name]})`;
    const fetched = li ? li.posts_visible || 0 : raw;
    out.sources.push({ name: r.name, group: r.group, urls: r.urls, state, fetched, new_posts: li ? li.new_posts : null, repeats, queued, note });
    if (state === 'failed') out.problems.push(`${r.name}: ${note}`);
    else if (state === 'empty' && (prev[r.name] || 0) > 0) out.problems.push(`${r.name}: 0 resultados (la corrida anterior dio ${prev[r.name]})`);
    else if (state === 'missing') out.problems.push(`${r.name}: no quedó registro de su estado`);
  }
  for (const [name, b] of Object.entries(status.by_source || {})) {
    if (!used.has(name)) out.other_sources.push({ name, ...b });
  }
  if (scored) out.scored = scored;
  out.overall = out.problems.some(p => /no hay source_status|falló|failed/i.test(p)) || out.sources.some(s => s.state === 'failed')
    ? (out.sources.every(s => s.state === 'failed') ? 'failed' : 'partial')
    : out.problems.length ? 'partial' : 'ok';
  return out;
}

const ICON = { ok: '✅', empty: '⚠️', failed: '❌', missing: '❓', off: '⏸' };
const LABEL = { ok: 'OK', partial: 'PARCIAL', failed: 'FALLÓ' };

function toMarkdown(rep) {
  const L = [`# Reporte de corrida grant-ops — ${rep.generated_at.slice(0, 16).replace('T', ' ')}`, ''];
  L.push(`**Estado: ${ICON[rep.overall === 'ok' ? 'ok' : rep.overall === 'partial' ? 'empty' : 'failed']} ${LABEL[rep.overall]}**`, '');
  if (rep.totals) L.push(`Obtenidos: ${rep.totals.fetched} · ya vistos: ${rep.totals.already_seen} · nuevos: ${rep.totals.new} · pasaron a scoring: ${rep.totals.queued}`, '');
  if (rep.scored) L.push(`Scoring: ${Object.entries(rep.scored).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '');
  if (rep.problems.length) { L.push('## Problemas', ...rep.problems.map(p => `- ${p}`), ''); }
  L.push('## Fuentes consultadas', '', '| | Fuente | Obtenidos | Nuevos / en scoring | Nota | Link |', '|---|---|---|---|---|---|');
  for (const s of rep.sources) {
    const nw = s.new_posts != null ? `${s.new_posts} posts nuevos` : `${s.queued} en scoring (${s.repeats} repetidos)`;
    L.push(`| ${ICON[s.state]} | ${s.name} | ${s.fetched} | ${nw} | ${s.note || ''} | ${s.urls.map(u => /^https?:/.test(u) ? `[link](${u})` : u).join(' · ')} |`);
  }
  if (rep.other_sources.length) {
    L.push('', '## Otras fuentes con resultados (sin entrada en el registro)', ...rep.other_sources.map(o => `- ${o.name}: ${o.raw}`));
  }
  return L.join('\n') + '\n';
}

function toWhatsApp(rep) {
  const L = [`Grant-ops: corrida ${rep.overall === 'ok' ? 'exitosa ✅' : rep.overall === 'partial' ? 'con avisos ⚠️' : 'fallida ❌'}`];
  if (rep.totals) L.push(`${rep.totals.fetched} obtenidos, ${rep.totals.new} nuevos, ${rep.totals.queued} a scoring.`);
  const ok = rep.sources.filter(s => s.state === 'ok').length;
  L.push(`Fuentes: ${ok} de ${rep.sources.filter(s => s.state !== 'off').length} respondieron.`);
  const li = rep.sources.filter(s => s.group === 'linkedin');
  if (li.length) L.push(`LinkedIn: ${li.filter(s => s.state !== 'failed' && s.state !== 'missing').length} de ${li.length} páginas leídas, ${li.reduce((n, s) => n + (s.new_posts || 0), 0)} posts nuevos.`);
  if (rep.problems.length) L.push('Revisar:', ...rep.problems.slice(0, 6).map(p => `- ${p}`));
  L.push('Detalle con links: output/run_report.md');
  return L.join('\n') + '\n';
}

function main() {
  process.chdir(path.resolve(__dirname, '..'));
  const status = readJson('output/source_status.json');
  let cfg = {};
  try { cfg = yaml.parse(fs.readFileSync('config/sources.yaml', 'utf8')); } catch { /* registry falls back to static */ }
  const history = readJson('output/source_status_history.json', []);
  const scoredRaw = readJson('output/grants_scored.json', null);
  let scored = null;
  if (Array.isArray(scoredRaw)) {
    scored = {};
    for (const g of scoredRaw) { const k = g.scoring?.recommendation || '?'; scored[k] = (scored[k] || 0) + 1; }
  }
  const rep = buildReport({ status, registry: buildRegistry(cfg), history, scored });
  fs.writeFileSync('output/run_report.md', toMarkdown(rep));
  fs.writeFileSync('output/run_report.json', JSON.stringify(rep, null, 2));
  fs.writeFileSync('output/run_report_whatsapp.txt', toWhatsApp(rep));
  if (status && !history.some(h => h.ran_at === status.ran_at)) {
    const counts = Object.fromEntries(rep.sources.map(s => [s.name, s.fetched]));
    fs.writeFileSync('output/source_status_history.json', JSON.stringify([...history, { ran_at: status.ran_at, counts }].slice(-10), null, 2));
  }
  console.log(toWhatsApp(rep));
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(`run-report failed: ${err.message}`); }
  process.exit(0);
}

module.exports = { buildReport, toMarkdown, toWhatsApp };
