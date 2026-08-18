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
  // ImpactShip-style titles are usually "Grant Title – Funder Name" — the
  // dash-separated suffix IS the funder and takes priority over the
  // Grant/Fund/Award keyword guess below, which otherwise grabs words from
  // the title itself (e.g. "Social & Criminal Justice Grants – Charles
  // Hayward Foundation" was guessing "Social & Criminal Justice", never
  // seeing the real funder after the dash).
  const dashSplit = title.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (dashSplit) return dashSplit[2].trim();
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

  const FIELD_RE     = /^(funding|amount|award|eligibility|description|deadline|due\s*date|link|url)[:：]\s*/i;
  // Unanchored twin of FIELD_RE, used to locate a field label wherever it
  // starts within a line (not just at position 0) — see the inline-title
  // check below.
  const FIELD_RE_ANY = /(funding|amount|award|eligibility|description|deadline|due\s*date|link|url)[:：]\s*/i;
  const GRANT_KEY    = /deadline[:：]|funding[:：]|award[:：]/i;

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
      // Occasionally the title lands on the SAME line as the first field
      // instead of its own line above (an HTML-to-text artifact — e.g.
      // "2027 RISK Award – ... Funding: Up to €100,000 | Eligibility: ...").
      // If so, split it off here rather than searching backward, which
      // would otherwise land on some unrelated earlier title and silently
      // drop this grant (while corrupting whichever title it borrowed).
      let effectiveLine = line;
      let inlineTitle = null;
      const firstField = line.match(FIELD_RE_ANY);
      if (firstField && firstField.index > 0) {
        const prefix = line.slice(0, firstField.index).trim();
        if (isTitle(prefix)) {
          inlineTitle = prefix;
          effectiveLine = line.slice(firstField.index);
        }
      }

      const parts = effectiveLine.split(/\s*\|\s*/);
      const fields = fieldsFromParts(parts);

      // Title: inline title takes priority; else nearest preceding non-field line
      let title = inlineTitle;
      if (!title) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (isTitle(lines[j])) { title = lines[j]; break; }
        }
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

// ── Format C: Funding Forward / Fast Forward (HubSpot template) ───────────────
/**
 * "Funding Forward" (ffwd.org / Fast Forward) sends a HubSpot newsletter with
 * no field labels at all — after htmlToText() it collapses into one dense
 * paragraph of entries shaped like:
 *
 *   [Region] Funder Name: Grant Title: Description sentence(s) ending in
 *   either "Apply by <Month Day>." / "Submit ... by <Month Day>." or
 *   "Applications accepted on a rolling basis."
 *
 * A second "UPCOMING DEADLINES" section repeats the same shape (sometimes
 * with an "Apply by <date> - " prefix before the bracket, which we just skip
 * since the same date is restated inside the sentence). Region tags seen so
 * far: [Global], [U.S.], [D.C.], [Southern U.S.], but any bracket contents
 * work — this only recognizes the shape, not a fixed tag list.
 */
const FF_REGION_MAP = {
  'u.s.': 'United States',
  'southern u.s.': 'United States',
  'd.c.': 'United States',
  'global': 'Global',
};

function ffExtractDeadline(desc, emailDate) {
  if (/applications?\s+accepted\s+on\s+a\s+rolling\s+basis|rolling\s+basis/i.test(desc)) return 'rolling';
  const m = desc.match(/(?:apply|submit(?:\s+(?:a\s+)?(?:concept\s+note|letter\s+of\s+inquiry|loi))?)\s+by\s+([A-Za-z]+)\s+(\d{1,2})/i);
  if (!m) return null;
  const mo = MONTH_NAMES[m[1].toLowerCase()];
  if (!mo) return null;
  const day = parseInt(m[2], 10);
  const refDate = emailDate ? new Date(emailDate) : new Date();
  let year = refDate.getUTCFullYear();
  // If this date would fall more than ~2 months before the email date, the
  // newsletter almost certainly means next year (e.g. a January newsletter
  // mentioning a "December" deadline for the following cycle).
  const candidate = new Date(Date.UTC(year, mo - 1, day));
  if (candidate.getTime() < refDate.getTime() - 60 * 24 * 60 * 60 * 1000) year += 1;
  return `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Description text that mentions a dollar figure as applicant-eligibility
// criteria ("organizations with annual budgets between $750K and $3M") isn't
// the award amount — exclude $ matches whose nearby context looks like that.
const FF_NOT_AWARD_CONTEXT = /budget|revenue|\bFTE\b|annual operating/i;

function ffExtractAmounts(desc) {
  const matches = [...desc.matchAll(/[$€]\s?([\d][\d,.]*)\s?([KkMm])?/g)]
    .filter(m => !FF_NOT_AWARD_CONTEXT.test(desc.slice(Math.max(0, m.index - 40), m.index)))
    .map(m => {
      const mult = /m/i.test(m[2] || '') ? 1_000_000 : /k/i.test(m[2] || '') ? 1000 : 1;
      return parseFloat(m[1].replace(/,/g, '')) * mult;
    })
    .filter(n => !isNaN(n));
  if (matches.length === 0) return { amount_min: null, amount_max: null };
  if (matches.length === 1) return { amount_min: null, amount_max: matches[0] };
  return { amount_min: Math.min(...matches), amount_max: Math.max(...matches) };
}

// A colon-delimited segment right after "[Tag] " is a second header segment
// (a distinct grant title, e.g. "Stanley 1913: Creators Fund: Seeks...")
// only if it doesn't itself read like the start of the description sentence.
const FF_DESCRIPTION_STARTER = /^(seeks?|supports?|invites?|offers?|provides?|funds?|awards?|selected|applications?|submit|open|includes?|eligible|grants?|brings?)\b/i;

function ffSplitHeader(block) {
  const seg1 = block.match(/^([^:\n]{2,90}?):\s*/);
  if (!seg1) return null;
  const rest1 = block.slice(seg1[0].length);
  const seg2 = rest1.match(/^([^:\n]{2,90}?):\s*/);
  if (seg2 && !FF_DESCRIPTION_STARTER.test(seg2[1]) && !/\.\s/.test(seg2[1])) {
    return { funder: seg1[1].trim(), title: seg2[1].trim(), description: rest1.slice(seg2[0].length).trim() };
  }
  return { funder: seg1[1].trim(), title: seg1[1].trim(), description: rest1.trim() };
}

// Boilerplate/footer sections use the same "[Tag]"-free prose, but a block
// can still run into them when it's the last bracket in the email — cut the
// description off at the first one of these rather than including them.
const FF_STOP_MARKERS = /TECH NONPROFIT SHOUTOUTS|Have something to share\?|Fast Forward,\s*\d/;

function parseFundingForwardBlocks(text, source, emailDate) {
  const grants = [];
  const seen = new Set();
  const brackets = [...text.matchAll(/\[([^\]\n]{2,30})\]/g)];

  for (let i = 0; i < brackets.length; i++) {
    const tag = brackets[i][1];
    const start = brackets[i].index + brackets[i][0].length;
    let end = i + 1 < brackets.length ? brackets[i + 1].index : text.length;
    const stop = text.slice(start, end).search(FF_STOP_MARKERS);
    if (stop !== -1) end = start + stop;

    const block = text.slice(start, end).trim();
    const parsed = block ? ffSplitHeader(block) : null;
    if (!parsed || !parsed.description) continue;

    const key = `${parsed.funder}::${parsed.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const country = FF_REGION_MAP[tag.trim().toLowerCase()] || tag.trim();
    const deadline = ffExtractDeadline(parsed.description, emailDate);
    const { amount_min, amount_max } = ffExtractAmounts(parsed.description);
    // extractUrl() covers the rare case the newsletter inlines a bare URL;
    // this template mostly uses "More info here"-style link text with the
    // real target only in the <a href>, which htmlToText() strips — grants
    // without a resolvable URL still get created (id falls back to title).
    const url = extractUrl(parsed.description);

    grants.push({
      source,
      id: buildId(url, `${parsed.funder}: ${parsed.title}`),
      title: parsed.title,
      description: parsed.description.slice(0, 500),
      url: url || '',
      funder: parsed.funder,
      deadline,
      amount_min,
      amount_max,
      country,
      themes: [],
      type: 'email',
      fetched_at: emailDate || new Date().toISOString(),
    });
  }

  return grants;
}

function isFundingForwardSender(sender) {
  return /ffwd\.org|fast forward|funding forward/i.test(sender || '');
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
    const grants = isFundingForwardSender(sender)
      ? parseFundingForwardBlocks(text, source, msg.receivedDateTime)
      : parseGrantBlocks(text, source, msg.receivedDateTime);

    console.log(`    "${(msg.subject || '').slice(0, 60)}" → ${grants.length} grant(s)`);
    allGrants.push(...grants);

    // Mark as read so we don't re-process next run
    try {
      await graphPatch(`/me/messages/${msg.id}`, { isRead: true }, token.access_token);
    } catch (_) { /* non-critical */ }
  }

  return allGrants;
}

module.exports = { fetchEmailGrants, parseGrantBlocks, parseFundingForwardBlocks, isFundingForwardSender };
