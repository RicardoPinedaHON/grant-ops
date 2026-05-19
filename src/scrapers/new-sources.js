'use strict';
/**
 * new-sources.js
 * High-signal grant portals that publish MULTIPLE opportunities regularly.
 *
 * Scrapers (Playwright):
 *   - Mercociudades Portal de Oportunidades (weekly LAC updates)
 *   - MAR Fund convocatorias (Honduras-specific, up to $50k)
 *   - HeroX environmental challenges (20-40 live competitions)
 *   - IDB/BID calls for proposals (regional development bank)
 *
 * Static entries (annual programs with known cycles):
 *   - MAR Fund 19th call          Aug-Sep 2026, $30k-$50k, Honduras/Mesoamerica
 *   - Youth Climate Justice Fund  Jan 2027, $20k-$40k, youth-led
 *   - Youth4Climate 2027          Jan 2027, $30k, UNDP-backed
 *   - Canada CFLI Honduras        Q1 2027, CAD $35k-$45k
 *   - Echoing Green Fellowship    Opens Sep 2026, $90k
 */

const { getPage, safeGoto } = require('./playwright-base');

// ─── Mercociudades ────────────────────────────────────────────────────────────
async function fetchMercociudades() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://mercociudades.org/convocatoria/', 25000);
    if (!ok) {
      // Try alternate URL
      const ok2 = await safeGoto(page, 'https://mercociudades.org/oportunidades/', 20000);
      if (!ok2) return grants;
    }
    await page.waitForTimeout(2500);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('article, .post, .entry, .convocatoria, li.item');
      for (const card of Array.from(cards).slice(0, 30)) {
        const titleEl = card.querySelector('h1, h2, h3, h4, .title, .entry-title');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 10) continue;

        const linkEl = card.querySelector('a[href]') || titleEl.closest('a');
        const dateEl = card.querySelector('.date, time, .fecha, .published');
        const descEl = card.querySelector('p, .excerpt, .description');

        // Extract deadline from text
        const text = card.textContent || '';
        const deadlineMatch = text.match(/fecha\s+l[ií]mite[:\s]+([^\n|,]+)/i)
          || text.match(/deadline[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i)
          || text.match(/cierre[:\s]+([^\n|,]+\d{4})/i);

        const amountMatch = text.match(/\$[\d,]+(?:,000)?(?:\s*[-–]\s*\$[\d,]+)?/)
          || text.match(/USD\s*[\d,]+(?:,000)?/i);

        results.push({
          title,
          url: linkEl?.href || 'https://mercociudades.org/oportunidades/',
          description: descEl?.textContent?.trim() || '',
          deadline: deadlineMatch ? deadlineMatch[1].trim() : null,
          amount_text: amountMatch ? amountMatch[0] : null,
          date_posted: dateEl?.textContent?.trim() || null,
        });
      }

      // Fallback: grab all heading links on the page
      if (results.length === 0) {
        document.querySelectorAll('h2 a, h3 a, .entry-title a').forEach(a => {
          const title = a.textContent?.trim();
          if (title && title.length > 10) {
            results.push({ title, url: a.href, description: '', deadline: null, amount_text: null });
          }
        });
      }

      return results;
    });

    for (const item of items) {
      if (!item.title) continue;
      grants.push({
        title:       item.title,
        url:         item.url,
        description: item.description || '',
        funder:      'Mercociudades',
        source:      'Mercociudades',
        country:     'LAC',
        themes:      ['Regional Development', 'Environment', 'Climate', 'Youth'],
        deadline:    null, // enricher will fill in
        amount_max:  null,
        amount_min:  null,
      });
    }
  } catch (err) {
    console.warn(`  Mercociudades scraper error: ${err.message}`);
  }
  return grants;
}

// ─── MAR Fund ────────────────────────────────────────────────────────────────
async function fetchMARFund() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://marfund.org/en/convocatorias/', 25000);
    if (!ok) {
      await safeGoto(page, 'https://marfund.org/convocatorias/', 20000);
    }
    await page.waitForTimeout(2500);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('article, .post, .grant-call, .entry, li');
      for (const card of Array.from(cards).slice(0, 20)) {
        const titleEl = card.querySelector('h1, h2, h3, h4, .title');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 8) continue;

        const linkEl = card.querySelector('a[href]');
        const text   = card.textContent || '';

        const deadlineMatch = text.match(/(?:deadline|fecha\s+límite|cierre)[:\s]+([^\n,]+\d{4})/i);
        const amountMatch   = text.match(/\$[\d,]+(?:,000)?(?:\s*[-–]\s*\$[\d,]+)?/);

        results.push({
          title,
          url:         linkEl?.href || 'https://marfund.org/en/convocatorias/',
          description: text.slice(0, 400).trim(),
          deadline:    deadlineMatch ? deadlineMatch[1].trim() : null,
          amount_text: amountMatch ? amountMatch[0] : null,
        });
      }
      return results;
    });

    for (const item of items) {
      if (!item.title) continue;
      grants.push({
        title:       item.title,
        url:         item.url,
        description: item.description || '',
        funder:      'MAR Fund',
        source:      'MAR Fund',
        country:     'Honduras / Mesoamerica',
        themes:      ['Marine Conservation', 'Coastal Ecosystems', 'Climate Resilience', 'Biodiversity'],
        deadline:    null,
        amount_max:  50000,
        amount_min:  30000,
      });
    }
  } catch (err) {
    console.warn(`  MAR Fund scraper error: ${err.message}`);
  }
  return grants;
}

// ─── HeroX Environmental Challenges ─────────────────────────────────────────
async function fetchHeroX() {
  const page = await getPage();
  const grants = [];
  try {
    // HeroX hosts prizes, so we filter for environmental/climate themes
    const ok = await safeGoto(page,
      'https://www.herox.com/crowdsourcing-projects?q=environment+climate&sort=mostRecent', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(4000);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('[class*="challenge-card"], [class*="ChallengeCard"], article, .challenge-item');

      for (const card of Array.from(cards).slice(0, 25)) {
        const titleEl = card.querySelector('h1, h2, h3, [class*="title"], [class*="Title"]');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 8) continue;

        const linkEl = card.querySelector('a[href]');
        const prizeEl = card.querySelector('[class*="prize"], [class*="Prize"], [class*="award"], [class*="Award"]');
        const dateEl  = card.querySelector('[class*="deadline"], [class*="Deadline"], time');
        const descEl  = card.querySelector('p, [class*="description"]');

        results.push({
          title,
          url:         linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://www.herox.com' + linkEl.getAttribute('href')) : 'https://www.herox.com',
          description: descEl?.textContent?.trim() || '',
          prize_text:  prizeEl?.textContent?.trim() || null,
          deadline:    dateEl?.textContent?.trim() || null,
        });
      }
      return results;
    });

    const ENV_KEYWORDS = /environ|climat|sustain|water|energy|air|waste|biodiv|forest|ocean|carbon|recycl|green|eco\b/i;

    for (const item of items) {
      if (!item.title) continue;
      if (!ENV_KEYWORDS.test(item.title + ' ' + item.description)) continue;

      // Parse prize amount if present
      let amount_max = null;
      if (item.prize_text) {
        const m = item.prize_text.match(/\$?([\d,]+)(?:K|k|,000)?/);
        if (m) {
          let amt = parseInt(m[1].replace(/,/g, ''), 10);
          if (/k/i.test(item.prize_text) || item.prize_text.includes(',000')) amt *= 1;
          if (amt > 100 && amt < 10000000) amount_max = amt;
        }
      }

      grants.push({
        title:       item.title,
        url:         item.url,
        description: item.description || '',
        funder:      'HeroX',
        source:      'HeroX',
        country:     'Global',
        themes:      ['Innovation Challenge', 'Environment', 'Climate', 'Sustainability'],
        deadline:    null,
        amount_max,
        amount_min:  null,
      });
    }
  } catch (err) {
    console.warn(`  HeroX scraper error: ${err.message}`);
  }
  return grants;
}

// ─── IDB/BID Calls for Proposals ─────────────────────────────────────────────
async function fetchIDB() {
  const page = await getPage();
  const grants = [];
  try {
    const ok = await safeGoto(page, 'https://www.iadb.org/en/calls-for-proposals', 30000);
    if (!ok) return grants;
    await page.waitForTimeout(3000);

    const items = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('article, .call-item, [class*="call"], li.item, .listing-item');
      for (const card of Array.from(cards).slice(0, 30)) {
        const titleEl = card.querySelector('h1, h2, h3, h4, .title, a');
        if (!titleEl) continue;
        const title = titleEl.textContent?.trim();
        if (!title || title.length < 8) continue;

        const linkEl = card.querySelector('a[href]');
        const text   = card.textContent || '';
        const deadlineMatch = text.match(/(?:deadline|due)[:\s]+([A-Za-z]+ \d{1,2},?\s*\d{4})/i);

        results.push({
          title,
          url:         linkEl?.href || 'https://www.iadb.org/en/calls-for-proposals',
          description: text.slice(0, 400).trim(),
          deadline:    deadlineMatch ? deadlineMatch[1].trim() : null,
        });
      }
      return results;
    });

    const LAC_ENV_KEYWORDS = /environment|climate|water|waste|energy|biodiv|sustain|innovation|youth|community|forest|Honduras|Central America|Latin America/i;

    for (const item of items) {
      if (!item.title) continue;
      if (!LAC_ENV_KEYWORDS.test(item.title + ' ' + item.description)) continue;

      grants.push({
        title:       item.title,
        url:         item.url,
        description: item.description || '',
        funder:      'Inter-American Development Bank',
        source:      'IDB/BID',
        country:     'LAC',
        themes:      ['Development', 'Environment', 'Climate', 'Innovation'],
        deadline:    null,
        amount_max:  null,
        amount_min:  null,
      });
    }
  } catch (err) {
    console.warn(`  IDB scraper error: ${err.message}`);
  }
  return grants;
}

// ─── Static annual entries ────────────────────────────────────────────────────
function getStaticEntries() {
  return [
    {
      title:       'MAR Fund 19th Call for Proposals — Mesoamerican Reef Conservation',
      url:         'https://marfund.org/en/convocatorias/',
      description: 'Annual grants for marine and coastal conservation projects in Honduras, Belize, Guatemala, and Mexico. Covers reef restoration, climate resilience, sustainable fisheries, waste management, and youth/community initiatives. Up to $1,000 proposal development assistance available.',
      funder:      'MAR Fund',
      source:      'MAR Fund',
      country:     'Honduras',
      themes:      ['Marine Conservation', 'Climate Resilience', 'Biodiversity', 'Community'],
      deadline:    '2026-09-09', // Based on 18th call closing Sep 9, 2025; 19th expected Aug-Sep 2026
      amount_max:  50000,
      amount_min:  30000,
    },
    {
      title:       'Youth Climate Justice Fund 2027 Grant Round',
      url:         'https://youthclimatejusticefund.org/apply/',
      description: 'Annual grants for youth-led climate justice organizations globally. Local-level groups receive $20,000; national-level groups receive $40,000. No legal registration required. Applications in Spanish accepted. Focus on intersectional climate justice, not just environmental conservation.',
      funder:      'Youth Climate Justice Fund',
      source:      'Youth Climate Justice Fund',
      country:     'Global',
      themes:      ['Climate Justice', 'Youth-Led', 'Social Justice', 'Grassroots'],
      deadline:    '2027-02-28', // Annual cycle typically Jan-Feb; 2026 round closed Feb
      amount_max:  40000,
      amount_min:  20000,
    },
    {
      title:       'Youth4Climate 2027 — UNDP Youth Climate Action Grants',
      url:         'https://www.youth4climate.org/',
      description: 'UNDP and Italian government partnership supporting youth-led climate solutions globally. Grants up to $30,000 for local-level projects. Targets youth leaders aged 18-29. Provides access to 30,000-member platform, mentorship, and training. Honduras eligible.',
      funder:      'UNDP / Youth4Climate',
      source:      'Youth4Climate',
      country:     'Global',
      themes:      ['Climate Action', 'Youth-Led', 'Innovation', 'UNDP'],
      deadline:    '2027-02-15', // Annual cycle Jan-Feb; prepare for 2027
      amount_max:  30000,
      amount_min:  5000,
    },
    {
      title:       'Canada Fund for Local Initiatives (CFLI) Honduras 2027',
      url:         'https://www.canada.ca/en/embassies-consulates.html',
      description: 'Annual bilateral fund from Canada for local NGOs legally registered in Honduras. Grants of CAD $35,000–$45,000 (approx. USD $26k–$33k). 2025 priorities include climate action and biodiversity conservation. Applications accepted in Spanish. Requires gender-based analysis.',
      funder:      'Government of Canada / CFLI',
      source:      'Canada CFLI',
      country:     'Honduras',
      themes:      ['Climate Action', 'Biodiversity', 'Gender', 'Local NGO'],
      deadline:    '2027-03-31', // Annual calls typically Q1; prepare materials in winter
      amount_max:  33000,
      amount_min:  26000,
    },
    {
      title:       'Echoing Green Fellowship 2027 — Emerging Social Entrepreneurs',
      url:         'https://echoinggreen.org/fellowship/',
      description: 'Prestigious 18-month fellowship providing $90,000 to emerging social entrepreneurs (ages 18+) working full-time on early-stage organizations. Explicitly welcomes climate justice and environmental sustainability. Global eligibility. Applications open September, close early October annually.',
      funder:      'Echoing Green',
      source:      'Echoing Green',
      country:     'Global',
      themes:      ['Fellowship', 'Social Entrepreneurship', 'Climate Justice', 'Youth'],
      deadline:    '2026-10-07', // Opens September, closes early October
      amount_max:  100000,
      amount_min:  90000,
    },
    {
      title:       'MIT Solve Global Challenge 2026 — Climate + Environmental Innovation',
      url:         'https://solve.mit.edu/challenges',
      description: 'Annual MIT-backed innovation competition with $10,000 base funding for each selected Solver team, plus themed prizes of $50,000–$200,000. Strong Latin American representation in past winners. Applications typically open March-April. Honduras and LAC organizations eligible.',
      funder:      'MIT Solve',
      source:      'MIT Solve',
      country:     'Global',
      themes:      ['Innovation', 'Climate', 'Technology', 'Social Enterprise'],
      deadline:    '2026-07-01', // Applications typically March-April to July; annual cycle
      amount_max:  200000,
      amount_min:  10000,
    },
  ];
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
async function fetchNewSources() {
  const grants = [];

  // Static entries — always included
  grants.push(...getStaticEntries());
  console.log(`    Static entries: ${getStaticEntries().length} annual programs`);

  // MAR Fund live scraper
  try {
    const marGrants = await fetchMARFund();
    if (marGrants.length > 0) {
      console.log(`    MAR Fund: ${marGrants.length} calls`);
      grants.push(...marGrants);
    }
  } catch (err) {
    console.warn(`    MAR Fund failed: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // Mercociudades
  try {
    const mercoGrants = await fetchMercociudades();
    if (mercoGrants.length > 0) {
      console.log(`    Mercociudades: ${mercoGrants.length} opportunities`);
      grants.push(...mercoGrants);
    }
  } catch (err) {
    console.warn(`    Mercociudades failed: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // HeroX
  try {
    const heroGrants = await fetchHeroX();
    if (heroGrants.length > 0) {
      console.log(`    HeroX: ${heroGrants.length} environmental challenges`);
      grants.push(...heroGrants);
    }
  } catch (err) {
    console.warn(`    HeroX failed: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // IDB
  try {
    const idbGrants = await fetchIDB();
    if (idbGrants.length > 0) {
      console.log(`    IDB: ${idbGrants.length} calls`);
      grants.push(...idbGrants);
    }
  } catch (err) {
    console.warn(`    IDB failed: ${err.message}`);
  }

  return grants;
}

module.exports = { fetchNewSources };
