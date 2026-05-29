'use strict';
/**
 * portals.js
 * Grant portal scrapers for:
 *   - WePropel         (https://www.wepropel.org/oportunidades)
 *   - EasyGrant        (https://app.easygrant.io/lists/discover)
 *   - Leaders of Today (https://www.leadersoftoday.com/opportunities)
 */

const { getPage, safeGoto } = require('./playwright-base');

// ── Date helpers ──────────────────────────────────────────────────────────────
const MONTH_MAP = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
  ene:'01',enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',
  junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',
  noviembre:'11',diciembre:'12',ago:'08',
};

function parseDeadline(str) {
  if (!str) return null;
  str = str.trim();
  if (/rolling|open[-\s]ended|no\s+deadline|year[-\s]round|continuous|abiertas?\s+todo/i.test(str)) return 'rolling';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // DD/M/YYYY or DD/MM/YYYY (WePropel format: "31/5/2026")
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

  // "12 JUL 2026" or "31 May 2026"
  m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mo = MONTH_MAP[m[2].toLowerCase().slice(0,3)];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2,'0')}`;
  }

  // "May 31, 2026" or "May 31 2026"
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = MONTH_MAP[m[1].toLowerCase().slice(0,3)];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2,'0')}`;
  }

  // "Jun 26, 2026" anywhere in string
  m = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) {
    const mo = MONTH_MAP[m[1].toLowerCase().slice(0,3)];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2,'0')}`;
  }

  const d = new Date(str);
  if (!isNaN(d) && d.getFullYear() >= 2024) return d.toISOString().split('T')[0];
  return null;
}

function parseAmount(str) {
  if (!str) return { amount_min: null, amount_max: null };
  const s = str.replace(/[,\s]/g, '');
  const range = s.match(/[€$£]?([\d]+(?:\.\d+)?)[kK]?[-–]([\d]+(?:\.\d+)?)[kK]?/);
  if (range) {
    let a = parseFloat(range[1]), b = parseFloat(range[2]);
    if (/k/i.test(str)) { a *= 1000; b *= 1000; }
    if (a >= 100 && b >= 100) return { amount_min: Math.round(Math.min(a,b)), amount_max: Math.round(Math.max(a,b)) };
  }
  const single = s.match(/[€$£]?([\d]+(?:\.\d+)?)[kK]?/);
  if (single) {
    let n = parseFloat(single[1]);
    if (/k/i.test(str)) n *= 1000;
    if (n >= 100 && n < 100_000_000) return { amount_min: null, amount_max: Math.round(n) };
  }
  return { amount_min: null, amount_max: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * WePropel concatenates title + funder in the same heading text node.
 * e.g. "Her Ocean 2026-2027 Acceleration ProgramMAR Fund"
 *       "Chat for Health AcceleratorTurn.io"
 *       "National Endowment for DemocracyNational Endowment for Democracy"
 * Splits at the first camelCase boundary: [a-z\d][A-Z] with no space.
 */
function splitWePropelTitleFunder(raw) {
  if (!raw) return { title: '', funder: '' };
  raw = raw.trim();
  // Case 1: duplicate suffix (title repeated as funder)
  for (let i = Math.floor(raw.length * 0.4); i < Math.floor(raw.length * 0.7); i++) {
    if (raw.slice(i) === raw.slice(0, i).trim() || raw.startsWith(raw.slice(i).slice(0, 15))) {
      return { title: raw.slice(0, i).trim(), funder: raw.slice(i).trim() };
    }
  }
  // Case 2: split at first lowercase/digit→Uppercase boundary (no space between)
  // Require at least 12 chars before the split point
  const splitRe = /^(.{12,}?)([a-z\d])([A-Z][a-zA-Z])/;
  const m = raw.match(splitRe);
  if (m) {
    return { title: (m[1] + m[2]).trim(), funder: (m[3] + raw.slice(m[1].length + m[2].length + m[3].length)).trim() };
  }
  return { title: raw.slice(0, 90).trim(), funder: '' };
}

// ── WePropel ──────────────────────────────────────────────────────────────────
// Page structure: each opportunity has an "Aplica aquí" external link,
// preceded by amount block ("USD/EUR X,XXX"), "Aplica hasta DD/M/YYYY",
// and above that: title, funder, type, categories, description, countries.
async function fetchWePropel() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://www.wepropel.org/oportunidades', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(4000);

    // Scroll to load all (up to 80 opportunities shown)
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1000);
    }

    const items = await page.evaluate(() => {
      const results = [];
      // Each grant card contains an "Aplica aquí" external link — use that as anchor
      const applyLinks = [...document.querySelectorAll('a[href]')].filter(a =>
        a.href &&
        !a.href.includes('wepropel.org') &&
        a.href.startsWith('http') &&
        (a.textContent?.trim().toLowerCase().includes('aplica') ||
         a.textContent?.trim().toLowerCase().includes('apply') ||
         a.closest('[class]')?.textContent?.includes('Aplica aquí'))
      );

      // Also grab every external href that lives inside a card-like container
      const allExternal = [...document.querySelectorAll('a[href]')].filter(a =>
        a.href && !a.href.includes('wepropel.org') && a.href.startsWith('http')
      );

      const seen = new Set();
      const candidates = [...applyLinks, ...allExternal].filter(a => {
        if (seen.has(a.href)) return false;
        seen.add(a.href);
        return true;
      });

      for (const link of candidates.slice(0, 60)) {
        // Walk up to find the card container (usually a large div/section)
        let card = link.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!card) break;
          const text = card.innerText || '';
          // Good card: has a title-like heading AND (amount OR deadline)
          if (text.length > 200 &&
              (card.querySelector('h2,h3,h4,[class*="title"]') ||
               text.match(/^\S{5,}/m)) &&
              (text.match(/USD|EUR|\$|€/) || text.match(/Aplica\s+hasta|deadline/i))) {
            break;
          }
          card = card.parentElement;
        }
        if (!card) continue;

        const text = card.innerText || '';
        if (text.length < 80) continue;

        // Title: first heading in card
        const titleEl = card.querySelector('h2,h3,h4,[class*="title"]');
        let title = titleEl?.textContent?.trim();

        // Fallback: first non-trivial line of text
        if (!title || title.length < 5) {
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10);
          title = lines[0] || '';
        }
        if (!title || title.length < 5) continue;

        // Funder: typically the second line or a sibling element after title
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const titleIdx = lines.findIndex(l => l === title || title.includes(l.slice(0,20)));
        const funder = titleIdx >= 0 && lines[titleIdx + 1] ? lines[titleIdx + 1] : '';

        // Deadline: "Aplica hasta DD/M/YYYY" or "31/5/2026"
        const dlMatch = text.match(/Aplica\s+hasta\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)
          || text.match(/([A-Za-z]+\s+\d{1,2},?\s*\d{4})/);
        const deadline_raw = dlMatch ? dlMatch[1] : null;

        // Amount: "USD 100,000" or "EUR 1,000,000" or "$ 750,000"
        const amtMatch = text.match(/(?:USD|EUR|CHF)\s*([\d,]+)/i)
          || text.match(/\$\s*([\d,]+)/);
        const amount_raw = amtMatch ? amtMatch[0] : null;

        // Country: listed near end of card
        const countryMatch = text.match(/^(Argentina|Honduras|México|Belice|Guatemala|Colombia|Brasil|Perú|Chile|Global|LAC|América Latina)[\s,]/m)
          || text.match(/(Honduras|Central America|Latin America|Global)/i);
        const country_raw = countryMatch ? countryMatch[1] : 'LAC';

        // Description: largest paragraph
        const descEl = card.querySelector('p');
        const description = descEl?.textContent?.trim().slice(0, 500) || '';

        results.push({ title, url: link.href, description, funder, deadline_raw, amount_raw, country_raw });
      }

      // Final dedup by URL
      const seenUrls = new Set();
      return results.filter(r => {
        if (!r.url || seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      });
    });

    for (const item of items) {
      const { amount_min, amount_max } = parseAmount(item.amount_raw);
      const { title: cleanedTitle, funder: extractedFunder } = splitWePropelTitleFunder(item.title);
      // Use extracted funder if scraper funder looks like garbage (too long or contains digits/amounts)
      const funder = (item.funder && item.funder.length < 60 && !/\d{4,}/.test(item.funder))
        ? item.funder
        : extractedFunder;
      grants.push({
        id:          `wp_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
        title:       cleanedTitle || item.title,
        url:         item.url,
        description: item.description || '',
        funder:      funder || '',
        source:      'WePropel',
        country:     item.country_raw || 'LAC',
        themes:      [],
        deadline:    parseDeadline(item.deadline_raw),
        amount_min,
        amount_max,
      });
    }
    console.log(`    WePropel: ${grants.length} grants`);
  } catch (err) {
    console.warn(`  [WePropel] Error: ${err.message}`);
  }
  return grants;
}

// ── EasyGrant ─────────────────────────────────────────────────────────────────
// Cards have class "rounded-2xl border border-slate-200/80 ..."
// Text pattern per card: [NEW] [DD MMM YYYY] [Type] [$amount] Title  Funder  ...desc  Track with EasyGrant
async function fetchEasyGrant() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://app.easygrant.io/lists/discover', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(6000);

    // Scroll to load all cards
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(600);
    }

    const items = await page.evaluate(() => {
      const results = [];

      // EasyGrant uses rounded-2xl border cards in a grid
      const cards = [...document.querySelectorAll('div.rounded-2xl, div[class*="rounded-2xl"]')]
        .filter(el => {
          const t = el.innerText || '';
          return t.includes('Track with EasyGrant') && t.length > 50;
        });

      // Fallback: grid children
      let cardList = cards;
      if (cardList.length === 0) {
        const grid = document.querySelector('.grid');
        if (grid) cardList = [...grid.children];
      }

      for (const card of cardList.slice(0, 150)) {
        const text = (card.innerText || '').trim();
        if (!text || text.length < 30) continue;

        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

        let title = '', funder = '', deadline_raw = null, amount_raw = null, description = '';
        let trackIdx = lines.findIndex(l => /track with easygrant/i.test(l));
        if (trackIdx < 0) trackIdx = lines.length;

        const contentLines = lines.slice(0, trackIdx);

        for (let i = 0; i < contentLines.length; i++) {
          const line = contentLines[i];

          // Skip meta lines
          if (/^(NEW|Funding|Programmes?|Fellowship|Accelerator|Bootcamp|Competition)$/i.test(line)) continue;

          // Deadline: "12 JUL 2026" or "29 MAY 2026"
          if (!deadline_raw && /^\d{1,2}\s+[A-Z]{3}\s+\d{4}$/.test(line)) {
            deadline_raw = line; continue;
          }
          // Also "29 MAY 2026" in Spanish months
          if (!deadline_raw && /^\d{1,2}\s+[A-ZÁÉÍÓÚ]{3,}\s+\d{4}$/i.test(line)) {
            deadline_raw = line; continue;
          }

          // Amount: "$10,000" or "€20,000"
          if (!amount_raw && /^[€$£][\d,]+/.test(line)) {
            amount_raw = line; continue;
          }

          // Title: first substantial non-meta line
          if (!title && line.length >= 8 && !/^[€$£\d]/.test(line)) {
            title = line; continue;
          }

          // Funder: line right after title
          if (title && !funder && line.length >= 3 && !/^[€$£\d]/.test(line) && line !== title) {
            funder = line; continue;
          }
        }

        if (!title || title.length < 5) continue;

        // Description: everything between funder and "Track with EasyGrant"
        const funderIdx = contentLines.lastIndexOf(funder);
        if (funderIdx >= 0 && funderIdx + 1 < contentLines.length) {
          description = contentLines.slice(funderIdx + 1).join(' ').slice(0, 500);
        }

        const linkEl = card.querySelector('a[href]');
        results.push({
          title, url: linkEl?.href || '', funder, description, deadline_raw, amount_raw,
        });
      }

      // Dedup by title
      const seen = new Set();
      return results.filter(r => {
        if (!r.title || seen.has(r.title)) return false;
        seen.add(r.title);
        return true;
      });
    });

    for (const item of items) {
      const { amount_min, amount_max } = parseAmount(item.amount_raw);
      const urlOrTitle = item.url || item.title;
      grants.push({
        id:          `eg_${Buffer.from(urlOrTitle).toString('base64').slice(0, 20)}`,
        title:       item.title,
        url:         item.url || 'https://app.easygrant.io/lists/discover',
        description: item.description || '',
        funder:      item.funder || '',
        source:      'EasyGrant',
        country:     'Global',
        themes:      [],
        deadline:    parseDeadline(item.deadline_raw),
        amount_min,
        amount_max,
      });
    }
    console.log(`    EasyGrant: ${grants.length} grants`);
  } catch (err) {
    console.warn(`  [EasyGrant] Error: ${err.message}`);
  }
  return grants;
}

// ── Leaders of Today ──────────────────────────────────────────────────────────
// Beta JS platform. Cards show: FEATURED | Title | Location | Deadline
async function fetchLeadersOfToday() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://www.leadersoftoday.com/opportunities', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(5000);

    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(800);
    }

    const items = await page.evaluate(() => {
      const results = [];

      // Try to find opportunity cards — the page shows cards with deadline text
      // Structure: [FEATURED?] Title | Location | Deadline date | BROWSE OPPORTUNITIES
      const allLinks = [...document.querySelectorAll('a[href*="/opportunities/"]')];

      for (const link of allLinks) {
        const card = link.closest('div, li, article, section') || link.parentElement;
        if (!card) continue;

        const text = (card.innerText || '').trim();
        if (text.length < 10) continue;

        const title = link.textContent?.trim() || text.split('\n')[0]?.trim();
        if (!title || title.length < 5 ||
            /browse opportunities|sign up|login|home|about/i.test(title)) continue;

        // Deadline: "Jun 26, 2026" or "May 31, 2026"
        const dlMatch = text.match(/([A-Za-z]+\s+\d{1,2},?\s*\d{4})/);
        const deadline_raw = dlMatch ? dlMatch[1] : null;

        // Amount in card text
        const amtMatch = text.match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?/);

        // Country/location
        const locMatch = text.match(/\n(Global|Regional|International|[A-Z][a-z]+(,\s*[A-Z][a-z]+)*)\s*\n/);

        results.push({
          title,
          url: link.href,
          description: '',
          funder: '',
          deadline_raw,
          amount_raw: amtMatch ? amtMatch[0] : null,
          country_raw: locMatch ? locMatch[1] : 'Global',
        });
      }

      // Fallback: any card containing a deadline date
      if (results.length === 0) {
        const cards = [...document.querySelectorAll('[class*="card"],[class*="opportunity"],[class*="item"]')]
          .filter(el => el.innerText?.match(/\d{4}/) && el.innerText?.length > 30);

        for (const card of cards.slice(0, 30)) {
          const text = (card.innerText || '').trim();
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          const title = lines.find(l =>
            l.length > 8 &&
            !/^(FEATURED|Global|Location|Deadline|BROWSE|LOGIN|SIGN)/i.test(l)
          );
          if (!title) continue;

          const dlMatch = text.match(/([A-Za-z]+\s+\d{1,2},?\s*\d{4})/);
          const linkEl = card.querySelector('a[href]');

          results.push({
            title,
            url: linkEl?.href || 'https://www.leadersoftoday.com/opportunities',
            description: '',
            funder: '',
            deadline_raw: dlMatch ? dlMatch[1] : null,
            amount_raw: null,
            country_raw: 'Global',
          });
        }
      }

      const seen = new Set();
      return results.filter(r => {
        if (!r.title || seen.has(r.title)) return false;
        seen.add(r.title);
        return true;
      });
    });

    for (const item of items) {
      const { amount_min, amount_max } = parseAmount(item.amount_raw);
      grants.push({
        id:          `lot_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
        title:       item.title,
        url:         item.url || 'https://www.leadersoftoday.com/opportunities',
        description: item.description || '',
        funder:      item.funder || '',
        source:      'Leaders of Today',
        country:     item.country_raw || 'Global',
        themes:      ['Youth', 'Leadership', 'Fellowship'],
        deadline:    parseDeadline(item.deadline_raw),
        amount_min,
        amount_max,
      });
    }
    console.log(`    Leaders of Today: ${grants.length} grants`);
  } catch (err) {
    console.warn(`  [Leaders of Today] Error (beta): ${err.message}`);
  }
  return grants;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function fetchPortals() {
  const grants = [];

  try {
    grants.push(...(await fetchWePropel()));
  } catch (err) {
    console.warn(`    WePropel failed: ${err.message}`);
  }

  await sleep(1500);

  try {
    grants.push(...(await fetchEasyGrant()));
  } catch (err) {
    console.warn(`    EasyGrant failed: ${err.message}`);
  }

  await sleep(1500);

  try {
    grants.push(...(await fetchLeadersOfToday()));
  } catch (err) {
    console.warn(`    Leaders of Today failed: ${err.message}`);
  }

  return grants;
}

module.exports = { fetchPortals, fetchWePropel, fetchEasyGrant, fetchLeadersOfToday };
