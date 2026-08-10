#!/usr/bin/env node
'use strict';
/**
 * test-email-parse.js
 *
 * Fetches the most recent email from each configured sender, parses grants,
 * pre-scores them, writes to grants_prescored.json, then runs run-scoring.js
 * (which handles enrichment, final scoring, and Notion sync).
 *
 * Marks emails as read after parsing so the regular scan won't re-process them.
 *
 * Usage: node scripts/test-email-parse.js
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const yaml  = require('yaml');
const { execSync } = require('child_process');

// ── .env loader ───────────────────────────────────────────────────────────────
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { buildPromptForClaude } = require('../src/scorer/index');
const { loadHistory, saveHistory, markSeen } = require('../src/tracker/index');

// ── Token management ──────────────────────────────────────────────────────────
const TOKEN_PATH = path.join(process.cwd(), 'tokens', 'outlook-token.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) throw new Error('Not authenticated — run: node scripts/auth-outlook.js');
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

function saveToken(tok) { fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2)); }

async function refreshToken(tok) {
  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID, grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const updated = { ...tok, access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || tok.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000 };
  saveToken(updated); return updated;
}

async function getToken() {
  let tok = loadToken();
  if (tok.expires_at - Date.now() < 5 * 60 * 1000) tok = await refreshToken(tok);
  return tok;
}

async function graphGet(endpoint, at) {
  const res = await axios.get(`${GRAPH_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${at}` }, timeout: 20000 });
  return res.data;
}

async function graphPatch(endpoint, body, at) {
  await axios.patch(`${GRAPH_BASE}${endpoint}`, body,
    { headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, timeout: 10000 });
}

// ── HTML → plain text ─────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n').replace(/<\/tr>/gi, '\n').replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\n{3,}/g,'\n\n').trim();
}

// ── Grant parser (self-contained) ─────────────────────────────────────────────
const MONTH_NAMES = {
  january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
  september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function parseDeadline(str) {
  if (!str) return null;
  if (/rolling|open[-\s]ended|no\s+deadline|continuous/i.test(str)) return 'rolling';
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = str.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) { const mo=MONTH_NAMES[m[2].toLowerCase()]; if(mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  m = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) { const mo=MONTH_NAMES[m[1].toLowerCase()]; if(mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`; }
  return null;
}

function parseAmount(str) {
  if (!str) return { amount_min: null, amount_max: null };
  const s = str.replace(/,/g,'');
  const r = s.match(/([\d.]+)\s*[kK]?\s*[-–]\s*([\d.]+)\s*([kK]?)/);
  if (r) { const k1=/[kK]/.test(r[0].split(/[-–]/)[0])?1000:1,k2=r[3]?1000:1; return {amount_min:parseFloat(r[1])*k1,amount_max:parseFloat(r[2])*k2}; }
  const s2 = s.match(/([\d.]+)\s*([kK]?)/); if(s2){const v=parseFloat(s2[1])*(s2[2]?1000:1);return{amount_min:null,amount_max:v};}
  return { amount_min: null, amount_max: null };
}

function extractUrl(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/[^\s>"<)\]]+/);
  return m ? m[0].replace(/[.,;)>\]]+$/,'') : null;
}

function guessFunder(title) {
  const m = title.match(/^(.+?)\s+(?:Grant|Fund|Award|Program|Programme|Fellowship|Prize|Call|Scholarship)/i);
  return m ? m[1].trim() : title.split(/\s+/).slice(0,3).join(' ');
}

function parseGrantBlocks(text, source, emailDate) {
  const grants=[]; const seenUrls=new Set();
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const FIELD_RE=/^(funding|amount|award|eligibility|description|deadline|due\s*date|link|url)[:：]\s*/i;
  const GRANT_KEY=/deadline[:：]|funding[:：]|award[:：]/i;

  function isTitle(l){return !FIELD_RE.test(l)&&!/^\s*https?:\/\//.test(l)&&l.length>=6&&l.length<=220;}
  function fieldsFrom(parts){const f={};for(const p of parts){const m=p.match(/^([^:：]{1,30})[:：]\s*(.+)$/s);if(m)f[m[1].trim().toLowerCase()]=m[2].trim();}return f;}
  function build(title,fields){
    const url=extractUrl(fields.link||fields.url||'')||extractUrl(Object.values(fields).join(' '));
    if(url&&seenUrls.has(url))return null; if(url)seenUrls.add(url);
    const deadline=parseDeadline(fields.deadline||fields['due date']||'');
    const {amount_min,amount_max}=parseAmount(fields.funding||fields.amount||fields.award||'');
    const id=`email_${Buffer.from((url||title||'').slice(0,80)).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,20)}`;
    return { source, id, title:title.trim(), description:(fields.description||fields.eligibility||'').trim(),
      url:url||'', funder:guessFunder(title), deadline, amount_min, amount_max,
      country:null, themes:[], type:'email', fetched_at:emailDate||new Date().toISOString() };
  }

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(GRANT_KEY.test(line)&&/\|/.test(line)){
      const fields=fieldsFrom(line.split(/\s*\|\s*/));
      let title=null;
      for(let j=i-1;j>=Math.max(0,i-5);j--){if(isTitle(lines[j])){title=lines[j];break;}}
      if(!title)continue;
      const g=build(title,fields);if(g)grants.push(g);
      continue;
    }
    if(isTitle(line)&&i+1<lines.length){
      const bf={};let j=i+1;
      while(j<lines.length&&j<i+10&&FIELD_RE.test(lines[j])){
        const m=lines[j].match(/^([^:：]{1,30})[:：]\s*(.+)$/);if(m)bf[m[1].trim().toLowerCase()]=m[2].trim();j++;
      }
      if(Object.keys(bf).length>=2&&GRANT_KEY.test(Object.keys(bf).join('|'))){
        const g=build(line,bf);if(g){grants.push(g);i=j-1;}
      }
    }
  }
  return grants;
}

// ── Senders to scan ───────────────────────────────────────────────────────────
const SENDERS = [
  'hello@ffwd.org',
  'impactship@mail.beehiiv.com',
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n📧  Email Grant Parser — Test Run\n');

  const tok     = await getToken();
  const profile = yaml.parse(fs.readFileSync(path.join(process.cwd(), 'org-profile.yaml'), 'utf8'));
  const history = loadHistory();

  const allGrants = [];

  for (const sender of SENDERS) {
    console.log(`  Fetching latest email from ${sender}...`);
    let msg;
    try {
      const data = await graphGet(
        `/me/messages?$search=${encodeURIComponent(`"from:${sender}"`)}&$top=5&$select=id,subject,from,receivedDateTime,body`,
        tok.access_token
      );
      // $search doesn't guarantee order — pick the most recent
      const msgs = (data.value || []).sort((a, b) =>
        new Date(b.receivedDateTime) - new Date(a.receivedDateTime)
      );
      msg = msgs[0];
    } catch (err) {
      console.warn(`    ⚠  Failed to fetch: ${err.message}`); continue;
    }

    if (!msg) { console.log('    No emails found from this sender.'); continue; }

    console.log(`    Subject: "${msg.subject}"`);
    const source = `Email: ${msg.from?.emailAddress?.name || sender}`;
    const text   = htmlToText(msg.body?.content || '');
    const grants = parseGrantBlocks(text, source, msg.receivedDateTime);
    console.log(`    → ${grants.length} grant(s) parsed`);

    if (grants.length > 0) {
      allGrants.push(...grants);
      // Mark as read so regular scan skips it
      try {
        await graphPatch(`/me/messages/${msg.id}`, { isRead: true }, tok.access_token);
        console.log('    ✓ Marked as read');
      } catch (_) {}
    }
  }

  if (allGrants.length === 0) {
    console.log('\n⚠  No grants extracted from these emails.');
    console.log('   The emails may use a non-standard format. Check the email content.\n');
    return;
  }

  console.log(`\n  Total grants parsed: ${allGrants.length}`);

  // Pre-score them (same as scan.js does)
  const OUTPUT_DIR = path.join(process.cwd(), 'output');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const prescored = [];
  for (const grant of allGrants) {
    const result = buildPromptForClaude(grant, profile);
    if (!result) continue;
    prescored.push({ grant, prescore: result.prescore, claude_prompt: result.prompt });
    markSeen(grant, history);
  }

  console.log(`  ${prescored.length} passed pre-filter\n`);

  if (prescored.length === 0) {
    console.log('  All grants were filtered out (geographic ineligibility or below threshold).\n');
    return;
  }

  // Write to grants_prescored.json (append to existing if present)
  let existing = [];
  const prescoredPath = path.join(OUTPUT_DIR, 'grants_prescored.json');
  if (fs.existsSync(prescoredPath)) {
    try { existing = JSON.parse(fs.readFileSync(prescoredPath, 'utf8')); } catch (_) {}
  }

  // Deduplicate by grant id
  const existingIds = new Set(existing.map(e => e.grant.id));
  const newItems    = prescored.filter(p => !existingIds.has(p.grant.id));
  const merged      = [...existing, ...newItems];
  fs.writeFileSync(prescoredPath, JSON.stringify(merged, null, 2));

  console.log(`  Added ${newItems.length} new grant(s) to grants_prescored.json`);
  console.log('  Running scoring + Notion sync...\n');

  saveHistory(history);

  // Run the existing scoring pipeline
  execSync('node src/run-scoring.js', { stdio: 'inherit', cwd: process.cwd() });
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
