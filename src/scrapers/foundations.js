'use strict';
/**
 * foundations.js
 * Scrapers for high-quality international grant sources:
 * - IAF (Inter-American Foundation)        — Honduras-direct, year-round
 * - UNDP GEF Small Grants Programme        — perfect fit, LAC/Honduras
 * - CEPF (Critical Ecosystem Partnership)  — Mesoamerica biodiversity hotspot
 * - Rainforest Trust                       — forest protection LAC
 * - Oak Foundation                         — environment LAC, accepts LOI
 * - HIVOS                                  — climate justice LAC
 */

const axios  = require('axios');
const { getPage, safeGoto } = require('./playwright-base');

const HEADERS = { 'User-Agent': 'grant-ops/1.0 (NGO monitoring tool; contact: grants@sustentahonduras.org)' };

// ─── IAF — Inter-American Foundation ─────────────────────────────────────────
async function fetchIAF() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://iaf.gov/apply-for-grant/', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(2000);

    const items = await page.evaluate(() => {
      const results = [];
      // IAF lists programs as sections/cards
      const sections = document.querySelectorAll(
        '.program-card, .grant-program, article, .entry-content section, .wp-block-group, h2, h3'
      );

      for (const el of Array.from(sections).slice(0, 30)) {
        const titleEl = el.tagName.match(/H[23]/) ? el : el.querySelector('h2, h3, h4');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 10) continue;

        const linkEl = el.querySelector('a') || (el.tagName === 'A' ? el : null);
        const text = el.textContent?.trim() || '';

        // Extract deadline pattern
        const deadlineMatch = text.match(/deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i)
          || text.match(/due\s+(?:by)?[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i)
          || text.match(/closes?\s+[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i);

        // Extract amount pattern
        const amountMatch = text.match(/\$[\d,]+(?:,000)?(?:\s*[-–]\s*\$[\d,]+)?/);

        results.push({
          title,
          url: linkEl?.href || 'https://iaf.gov/apply-for-grant/',
          description: text.slice(0, 500),
          deadline: deadlineMatch ? deadlineMatch[1] : null,
          amount: amountMatch ? amountMatch[0] : null,
        });
      }

      // Fallback: get all program links
      if (results.length === 0) {
        const links = document.querySelectorAll('a[href*="grant"], a[href*="apply"], a[href*="program"]');
        for (const a of Array.from(links).slice(0, 15)) {
          const title = a.textContent?.trim();
          if (title && title.length > 10) {
            results.push({ title, url: a.href, description: '', deadline: null, amount: null });
          }
        }
      }
      return results;
    });

    // Filter out navigation noise, language selectors, and news articles
    const GRANT_KEYWORDS = /grant|program|fund|apply|award|opportunit|call|eligib/i;
    const NOISE_PATTERNS = /^(english|español|português|kreyol|home|about|contact|search|menu|\s*$)/i;

    for (const item of items) {
      if (!item.title) continue;
      if (NOISE_PATTERNS.test(item.title)) continue;
      if (!GRANT_KEYWORDS.test(item.title + ' ' + item.description)) continue;
      if (item.title.length > 120) continue; // truncated nav text
      const amountMax = parseAmountMax(item.amount);
      grants.push({
        source: 'IAF',
        id: `iaf_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
        title: item.title,
        description: item.description || 'Inter-American Foundation grant for LAC grassroots organizations.',
        url: item.url,
        funder: 'Inter-American Foundation (IAF)',
        deadline: item.deadline ? parseDate(item.deadline) : null,
        amount_min: null,
        amount_max: amountMax,
        country: 'Honduras',
        themes: ['youth_empowerment', 'environmental_policy_advocacy', 'climate_action_mitigation'],
        type: 'foundation',
        fetched_at: new Date().toISOString(),
      });
    }
    console.log(`  [IAF] ${grants.length} programs found`);
  } catch (err) {
    console.warn(`  [IAF] Error: ${err.message}`);
  } finally {
    await page.close();
  }
  return grants;
}

// ─── UNDP GEF Small Grants Programme ─────────────────────────────────────────
async function fetchUNDPSGP() {
  const grants = [];
  const urls = [
    'https://sgp.undp.org/our-work/calls-for-proposals.html',
    'https://sgp.undp.org/resources/calls-for-proposals.html',
    'https://sgp.undp.org/',
  ];

  const page = await getPage();
  try {
    let loaded = false;
    for (const url of urls) {
      const ok = await safeGoto(page, url, 25000);
      if (ok) { loaded = true; break; }
    }
    if (!loaded) return grants;
    await page.waitForTimeout(2000);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll(
        '.call-card, .proposal-card, article, .news-item, .program-item, h2, h3, h4'
      );
      for (const el of Array.from(cards).slice(0, 25)) {
        const titleEl = el.tagName.match(/H[234]/) ? el : el.querySelector('h2, h3, h4');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 10) continue;
        const linkEl = el.querySelector('a');
        const text = el.textContent?.trim() || '';
        const deadlineMatch = text.match(/(?:deadline|closes?|due)[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
          || text.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
        results.push({
          title,
          url: linkEl?.href || 'https://sgp.undp.org/',
          description: text.slice(0, 500),
          deadline: deadlineMatch ? deadlineMatch[1] : null,
        });
      }
      return results;
    });

    if (items.length === 0) {
      // Add as standing entry — SGP Honduras has rolling applications
      grants.push({
        source: 'UNDP SGP',
        id: 'undp_sgp_honduras_standing',
        title: 'UNDP GEF Small Grants Programme — Honduras',
        description: 'The UNDP GEF Small Grants Programme provides grants up to $50,000 to community-based organizations and NGOs in Honduras working on biodiversity, climate change, land degradation, and chemicals. Supports indigenous peoples, youth, and women\'s groups. Applications reviewed year-round.',
        url: 'https://sgp.undp.org/our-work/calls-for-proposals.html',
        funder: 'UNDP / GEF Small Grants Programme',
        deadline: null,
        amount_min: 10000,
        amount_max: 50000,
        country: 'Honduras',
        themes: ['biodiversity', 'climate_action_mitigation', 'water_governance', 'indigenous_rights', 'youth_empowerment'],
        type: 'foundation',
        fetched_at: new Date().toISOString(),
      });
    } else {
      for (const item of items) {
        grants.push({
          source: 'UNDP SGP',
          id: `sgp_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
          title: item.title,
          description: item.description || 'UNDP GEF Small Grants Programme call for proposals.',
          url: item.url,
          funder: 'UNDP / GEF Small Grants Programme',
          deadline: item.deadline ? parseDate(item.deadline) : null,
          amount_min: 10000,
          amount_max: 50000,
          country: 'LAC',
          themes: ['biodiversity', 'climate_action_mitigation', 'indigenous_rights'],
          type: 'foundation',
          fetched_at: new Date().toISOString(),
        });
      }
    }
    console.log(`  [UNDP SGP] ${grants.length} items`);
  } catch (err) {
    console.warn(`  [UNDP SGP] Error: ${err.message}`);
  } finally {
    await page.close();
  }
  return grants;
}

// ─── CEPF — Critical Ecosystem Partnership Fund ───────────────────────────────
async function fetchCEPF() {
  const grants = [];
  const page = await getPage();
  try {
    const ok = await safeGoto(page, 'https://www.cepf.net/grants/apply-for-grant', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(2000);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll(
        '.hotspot-card, .grant-card, .call-item, article, .content-block, h2, h3'
      );
      for (const el of Array.from(cards).slice(0, 20)) {
        const titleEl = el.tagName.match(/H[23]/) ? el : el.querySelector('h2, h3');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 10) continue;
        const linkEl = el.querySelector('a');
        const text = el.textContent?.trim() || '';
        const deadlineMatch = text.match(/(?:deadline|closes?|due)[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
        const amountMatch = text.match(/\$[\d,]+(?:,000)?(?:\s*[-–]\s*\$[\d,]+)?/);
        results.push({ title, url: linkEl?.href || '', description: text.slice(0, 500), deadline: deadlineMatch?.[1], amount: amountMatch?.[0] });
      }
      return results;
    });

    if (items.length === 0) {
      // Mesoamerica is always a CEPF hotspot — add standing entry
      grants.push({
        source: 'CEPF',
        id: 'cepf_mesoamerica_standing',
        title: 'CEPF Small Grants — Mesoamerica Biodiversity Hotspot',
        description: 'The Critical Ecosystem Partnership Fund (CEPF) funds civil society organizations protecting the Mesoamerica biodiversity hotspot, which includes Honduras. Grants up to $20,000 for small organizations (seed funding) and up to $500,000 for larger projects. Focus: forests, indigenous territories, pollinators, threatened species.',
        url: 'https://www.cepf.net/grants/apply-for-grant',
        funder: 'Critical Ecosystem Partnership Fund (CEPF)',
        deadline: null,
        amount_min: 5000,
        amount_max: 500000,
        country: 'Honduras',
        themes: ['biodiversity', 'indigenous_rights', 'environmental_policy_advocacy'],
        type: 'foundation',
        fetched_at: new Date().toISOString(),
      });
    } else {
      for (const item of items) {
        grants.push({
          source: 'CEPF',
          id: `cepf_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
          title: item.title,
          description: item.description,
          url: item.url || 'https://www.cepf.net/grants/apply-for-grant',
          funder: 'Critical Ecosystem Partnership Fund (CEPF)',
          deadline: item.deadline ? parseDate(item.deadline) : null,
          amount_min: 5000,
          amount_max: parseAmountMax(item.amount) || 500000,
          country: 'Honduras',
          themes: ['biodiversity', 'indigenous_rights'],
          type: 'foundation',
          fetched_at: new Date().toISOString(),
        });
      }
    }
    console.log(`  [CEPF] ${grants.length} items`);
  } catch (err) {
    console.warn(`  [CEPF] Error: ${err.message}`);
  } finally {
    await page.close();
  }
  return grants;
}

// ─── Rainforest Trust ─────────────────────────────────────────────────────────
async function fetchRainforestTrust() {
  const grants = [];
  const page = await getPage();
  try {
    const ok = await safeGoto(page, 'https://www.rainforesttrust.org/get-involved/apply-for-funding/', 25000);
    if (!ok) return grants;
    await page.waitForTimeout(1500);

    const items = await page.evaluate(() => {
      const results = [];
      const headings = document.querySelectorAll('h2, h3');
      for (const h of Array.from(headings)) {
        const title = h.textContent?.trim();
        if (!title || title.length < 8) continue;
        // Get surrounding paragraph text
        let desc = '';
        let el = h.nextElementSibling;
        while (el && !el.tagName.match(/H[123]/)) {
          desc += ' ' + (el.textContent?.trim() || '');
          el = el.nextElementSibling;
        }
        const deadlineMatch = desc.match(/([A-Za-z]+ \d{1,2}(?:\s*[•·]\s*[A-Za-z]+ \d{1,2})*)/);
        const amountMatch = desc.match(/\$[\d,]+(?:,000)?(?:\s*[-–]\s*\$[\d,]+)?/);
        results.push({ title, description: desc.trim().slice(0, 500), deadline: deadlineMatch?.[1], amount: amountMatch?.[0] });
      }
      return results.filter(r => r.description.length > 20);
    });

    for (const item of items) {
      grants.push({
        source: 'Rainforest Trust',
        id: `rt_${Buffer.from(item.title).toString('base64').slice(0, 20)}`,
        title: `Rainforest Trust — ${item.title}`,
        description: item.description,
        url: 'https://www.rainforesttrust.org/get-involved/apply-for-funding/',
        funder: 'Rainforest Trust',
        deadline: item.deadline ? parseDate(item.deadline) : null,
        amount_min: null,
        amount_max: parseAmountMax(item.amount),
        country: 'LAC',
        themes: ['biodiversity', 'indigenous_rights'],
        type: 'foundation',
        fetched_at: new Date().toISOString(),
      });
    }

    if (grants.length === 0) {
      grants.push({
        source: 'Rainforest Trust',
        id: 'rt_standing',
        title: 'Rainforest Trust — Feasibility & Protected Area Awards',
        description: 'Rainforest Trust funds conservation projects in Central America including Honduras. Two grant types: Feasibility Awards (study funding for new protected areas) and Protected Area Creation Awards (full project funding). Supports indigenous and community-led conservation. Deadlines: March 1, July 1, October 1.',
        url: 'https://www.rainforesttrust.org/get-involved/apply-for-funding/',
        funder: 'Rainforest Trust',
        deadline: null,
        amount_min: null,
        amount_max: null,
        country: 'LAC',
        themes: ['biodiversity', 'indigenous_rights'],
        type: 'foundation',
        fetched_at: new Date().toISOString(),
      });
    }
    console.log(`  [Rainforest Trust] ${grants.length} items`);
  } catch (err) {
    console.warn(`  [Rainforest Trust] Error: ${err.message}`);
  } finally {
    await page.close();
  }
  return grants;
}

// ─── IAF GovGrants open listings ─────────────────────────────────────────────
async function fetchIAFGovGrants() {
  const grants = [];
  try {
    // IAF posts open grants on grants.gov too — fetch via API
    const res = await axios.get(
      'https://api.grants.gov/v2/api/search',
      {
        params: {
          keyword: 'Latin America Honduras Caribbean',
          oppStatuses: 'posted',
          agencies: 'IAF',
          rows: 25,
          sortBy: 'openDate|desc',
        },
        headers: HEADERS,
        timeout: 15000,
      }
    );
    const opportunities = res.data?.oppHits || [];
    for (const opp of opportunities) {
      grants.push({
        source: 'IAF / Grants.gov',
        id: `iaf_gov_${opp.id}`,
        title: opp.title || '',
        description: opp.synopsis || opp.description || '',
        url: `https://www.grants.gov/search-results-detail/${opp.id}`,
        funder: 'Inter-American Foundation (IAF)',
        deadline: opp.closeDate ? new Date(opp.closeDate).toISOString().split('T')[0] : null,
        amount_min: opp.awardFloor ? parseInt(opp.awardFloor) : null,
        amount_max: opp.awardCeiling ? parseInt(opp.awardCeiling) : null,
        country: 'LAC',
        themes: ['youth_empowerment', 'environmental_policy_advocacy'],
        type: 'api',
        fetched_at: new Date().toISOString(),
      });
    }
    console.log(`  [IAF/Grants.gov] ${grants.length} items`);
  } catch (err) {
    console.warn(`  [IAF/Grants.gov] Error: ${err.message}`);
  }
  return grants;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str) return null;
  try {
    // Handle "March 1 • July 1 • October 1" — take the next upcoming date
    const parts = str.split(/[•·,]/);
    for (const part of parts) {
      const d = new Date(part.trim() + (part.includes(String(new Date().getFullYear())) ? '' : ` ${new Date().getFullYear()}`));
      if (!isNaN(d) && d > new Date()) return d.toISOString().split('T')[0];
    }
    const d = new Date(str);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  } catch (_) {}
  return null;
}

function parseAmountMax(str) {
  if (!str) return null;
  const nums = str.replace(/,/g, '').match(/\d+/g);
  if (!nums) return null;
  return Math.max(...nums.map(Number));
}

async function fetchFoundations() {
  const all = [];
  const sources = [
    { fn: fetchIAF,          name: 'IAF'            },
    { fn: fetchUNDPSGP,      name: 'UNDP SGP'       },
    { fn: fetchCEPF,         name: 'CEPF'           },
    { fn: fetchRainforestTrust, name: 'Rainforest Trust' },
    { fn: fetchIAFGovGrants, name: 'IAF/Grants.gov' },
  ];

  for (const { fn, name } of sources) {
    try {
      const grants = await fn();
      all.push(...grants);
    } catch (err) {
      console.warn(`  [Foundations] ${name} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return all;
}

module.exports = { fetchFoundations };
