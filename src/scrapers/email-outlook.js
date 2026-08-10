'use strict';
/**
 * email-outlook.js
 *
 * Scans the "Grant Newsletters" Outlook folder via Microsoft Graph API.
 * Parses structured newsletter HTML (ImpactShip, Terra Viva, etc.) and
 * returns individual grant objects in the same format as all other scrapers.
 *
 * One-time setup: node scripts/auth-outlook.js
 * Required .env vars: GRAPH_CLIENT_ID, GRAPH_TENANT_ID, GRAPH_EMAIL_FOLDER
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const TOKEN_PATH = path.join(process.cwd(), 'tokens', 'outlook-token.json');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── .env loader (no dotenv dep needed) ───────────────────────────────────────
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

// ── Token management ──────────────────────────────────────────────────────────
function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

function saveToken(tok) {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2));
}

async function refreshAccessToken(tok) {
  const tenantId = process.env.GRAPH_TENANT_ID || 'common';
  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id:     process.env.GRAPH_CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: tok.refresh_token,
      scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const updated = {
    ...tok,
    access_token:  res.data.access_token,
    refresh_token: res.data.refresh_token || tok.refresh_token,
    expires_at:    Date.now() + res.data.expires_in * 1000,
  };
  saveToken(updated);
  return updated;
}

async function getValidToken() {
  let tok = loadToken();
  if (!tok) return null;
  if (tok.expires_at - Date.now() < 5 * 60 * 1000) tok = await refreshAccessToken(tok);
  return tok;
}

// ── Graph API helpers ─────────────────────────────────────────────────────────
async function graphGet(endpoint, accessToken) {
  const res = await axios.get(`${GRAPH_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });
  return res.data;
}

async function graphPatch(endpoint, body, accessToken) {
  await axios.patch(`${GRAPH_BASE}${endpoint}`, body, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

async function findFolderId(folderName, accessToken) {
  const data = await graphGet('/me/mailFolders?$top=100', accessToken);
  const folder = (data.value || []).find(
    f => f.displayName.toLowerCase() === folderName.toLowerCase()
  );
  return folder ? folder.id : null;
}

// ── HTML → plain text ─────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Deadline parser ───────────────────────────────────────────────────────────
const MONTH_NAMES = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function parseDeadline(str) {
  if (!str) return null;
  str = str.trim();
  if (/rolling|open[-\s]ended|no\s+deadline|continuous|year[-\s]round/i.test(str)) return 'rolling';
  // ISO: 2026-06-30
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  // "30 June 2026" or "30 Jun 2026"
  m = str.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mo = MONTH_NAMES[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  // "June 30, 2026" or "June 30 2026"
  m = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // DD/MM/YYYY
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

// ── Amount parser ─────────────────────────────────────────────────────────────
function parseAmount(str) {
  if (!str) return { amount_min: null, amount_max: null };
  const s = str.replace(/,/g, '');
  const rangeM = s.match(/([\d.]+)\s*[kK]?\s*[-–]\s*([\d.]+)\s*([kK]?)/);
  if (rangeM) {
    const k1 = /[kK]/.test(rangeM[0].split(/[-–]/)[0]) ? 1000 : 1;
    const k2 = rangeM[3] ? 1000 : 1;
    return { amount_min: parseFloat(rangeM[1]) * k1, amount_max: parseFloat(rangeM[2]) * k2 };
  }
  const singleM = s.match(/([\d.]+)\s*([kK]?)/);
  if (singleM) {
    const val = parseFloat(singleM[1]) * (singleM[2] ? 1000 : 1);
    return { amount_min: null, amount_max: val };
  }
  return { amount_min: null, amount_max: null };
}

// ── URL extractor ─────────────────────────────────────────────────────────────
function extractUrl(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/[^\s>"<)\]]+/);
  return m ? m[0].replace(/[.,;)>\]]+$/, '') : null;
}

// ── Grant ID builder ──────────────────────────────────────────────────────────
function buildId(url, title) {
  const key = (url || title || '').slice(0, 80);
  return `email_${Buffer.from(key).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
}

// ── Title → funder heuristic ──────────────────────────────────────────────────
function guessFunder(title) {
  const m = title.match(/^(.+?)\s+(?:Grant|Fund|Award|Program|Programme|Fellowship|Prize|Call|Scholarship)/i);
  return m ? m[1].trim() : title.split(/\s+/).slice(0, 3).join(' ');
}

// ── Core grant block parser ───────────────────────────────────────────────────
/**
 * Recognizes two newsletter formats:
 *
 * Format A (pipe-separated, ImpactShip style):
 *   Title Line
 *   Funding: X | Eligibility: Y | Description: Z | Deadline: D | Link: URL
 *
 * Format B (field-per-line, Terra Viva style):
 *   Title Line
 *   Funding: X
 *   Eligibility: Y
 *   Deadline: D
 *   Link: URL
 */
function parseGrantBlocks(text, source, emailDate) {
  const grants   = [];
  const lines    = text.split('\n').map(l => l.trim()).filter(Boolean);
  const seenUrls = new Set();

  const FIELD_RE  = /^(funding|amount|award|eligibility|description|deadline|due\s*date|link|url)[:：]\s*/i;
  const GRANT_KEY = /deadline[:：]|funding[:：]|award[:：]/i;

  function isTitle(line) {
    return (
      !FIELD_RE.test(line) &&
      !/^\s*https?:\/\//.test(line) &&
      line.length >= 6 &&
      line.length <= 220
    );
  }

  function fieldsFromParts(parts) {
    const f = {};
    for (const part of parts) {
      const m = part.match(/^([^:：]{1,30})[:：]\s*(.+)$/s);
      if (m) f[m[1].trim().toLowerCase()] = m[2].trim();
    }
    return f;
  }

  function buildFromFields(title, fields) {
    const linkRaw  = fields.link || fields.url || '';
    const url      = extractUrl(linkRaw) || extractUrl(Object.values(fields).join(' '));
    if (url && seenUrls.has(url)) return null;
    if (url) seenUrls.add(url);

    const deadline = parseDeadline(fields.deadline || fields['due date'] || '');
    const { amount_min, amount_max } = parseAmount(
      fields.funding || fields.amount || fields.award || ''
    );
    const description = fields.description || fields.eligibility || '';

    return {
      source,
      id:          buildId(url, title),
      title:       title.trim(),
      description: description.trim(),
      url:         url || '',
      funder:      guessFunder(title),
      deadline,
      amount_min,
      amount_max,
      country:     null,
      themes:      [],
      type:        'email',
      fetched_at:  emailDate || new Date().toISOString(),
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Format A: pipe-separated detail line ─────────────────────────────────
    if (GRANT_KEY.test(line) && /\|/.test(line)) {
      const parts = line.split(/\s*\|\s*/);
      const fields = fieldsFromParts(parts);

      // Title: nearest preceding non-field line
      let title = null;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (isTitle(lines[j])) { title = lines[j]; break; }
      }
      if (!title) continue;

      const g = buildFromFields(title, fields);
      if (g) grants.push(g);
      continue;
    }

    // ── Format B: field-per-line block ────────────────────────────────────────
    if (isTitle(line) && i + 1 < lines.length) {
      // Peek ahead: collect consecutive field lines
      const blockFields = {};
      let j = i + 1;
      while (j < lines.length && j < i + 10 && FIELD_RE.test(lines[j])) {
        const m = lines[j].match(/^([^:：]{1,30})[:：]\s*(.+)$/);
        if (m) blockFields[m[1].trim().toLowerCase()] = m[2].trim();
        j++;
      }
      if (Object.keys(blockFields).length >= 2 && GRANT_KEY.test(Object.keys(blockFields).join('|'))) {
        const g = buildFromFields(line, blockFields);
        if (g) {
          grants.push(g);
          i = j - 1; // skip past the block
        }
      }
    }
  }

  return grants;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function fetchEmailGrants() {
  loadEnv();

  const clientId   = process.env.GRAPH_CLIENT_ID;
  const folderName = process.env.GRAPH_EMAIL_FOLDER || 'Grant Newsletters';

  if (!clientId) {
    console.warn('  [Email] GRAPH_CLIENT_ID not set — skipping email scan');
    return [];
  }

  let token;
  try {
    token = await getValidToken();
  } catch (err) {
    console.warn(`  [Email] Token refresh failed: ${err.message}`);
    return [];
  }

  if (!token) {
    console.warn('  [Email] Not authenticated — run: node scripts/auth-outlook.js');
    return [];
  }

  let folderId;
  try {
    folderId = await findFolderId(folderName, token.access_token);
  } catch (err) {
    console.warn(`  [Email] Could not list mail folders: ${err.message}`);
    return [];
  }

  if (!folderId) {
    console.warn(`  [Email] Folder "${folderName}" not found — create it in Outlook and add forwarding rules`);
    return [];
  }

  let messages;
  try {
    const data = await graphGet(
      `/me/mailFolders/${folderId}/messages` +
      `?$filter=isRead eq false&$top=50` +
      `&$select=id,subject,from,receivedDateTime,body`,
      token.access_token
    );
    messages = data.value || [];
  } catch (err) {
    console.warn(`  [Email] Failed to fetch messages: ${err.message}`);
    return [];
  }

  if (messages.length === 0) {
    console.log(`  [Email] No unread messages in "${folderName}"`);
    return [];
  }

  console.log(`  [Email] Processing ${messages.length} newsletter(s)...`);

  const allGrants = [];
  for (const msg of messages) {
    const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown';
    const source = `Email: ${sender}`;
    const text   = htmlToText(msg.body?.content || '');
    const grants = parseGrantBlocks(text, source, msg.receivedDateTime);

    console.log(`    "${(msg.subject || '').slice(0, 60)}" → ${grants.length} grant(s)`);
    allGrants.push(...grants);

    // Mark as read so we don't re-process next run
    try {
      await graphPatch(`/me/messages/${msg.id}`, { isRead: true }, token.access_token);
    } catch (_) { /* non-critical */ }
  }

  return allGrants;
}

module.exports = { fetchEmailGrants };
