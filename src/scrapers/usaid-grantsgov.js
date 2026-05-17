const { getPage, safeGoto } = require('./playwright-base');

const SOURCES = [
  {
    name: 'USAID Honduras',
    url: 'https://www.usaid.gov/honduras/work-with-us/opportunities-local-organizations',
    type: 'usaid',
  },
  {
    name: 'Grants.gov Search',
    // Search for international/LAC environment grants
    url: 'https://www.grants.gov/search-results.html?keyword=Honduras+environment&oppStatuses=posted',
    type: 'grantsgov',
  },
  {
    name: 'Grants.gov Central America',
    url: 'https://www.grants.gov/search-results.html?keyword=Central+America+climate&oppStatuses=posted',
    type: 'grantsgov',
  },
];

async function fetchUSAIDAndGrantsGov() {
  const grants = [];

  for (const source of SOURCES) {
    const page = await getPage();
    try {
      const ok = await safeGoto(page, source.url, 25000);
      if (!ok) { await page.close(); continue; }

      await page.waitForTimeout(3000);

      let items = [];
      if (source.type === 'usaid') {
        items = await scrapeUSAID(page);
      } else if (source.type === 'grantsgov') {
        items = await scrapeGrantsGov(page);
      }

      for (const item of items) {
        grants.push({
          source: source.name,
          id: `usg_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
          title: item.title,
          description: item.description || '',
          url: item.url,
          funder: item.funder || source.name,
          deadline: item.deadline || null,
          amount_min: null,
          amount_max: item.amount || null,
          country: 'Honduras/International',
          themes: [],
          type: 'government_grant',
          fetched_at: new Date().toISOString(),
        });
      }

      console.log(`  [Gov] ${source.name}: ${items.length} items`);
    } catch (err) {
      console.warn(`  [Gov] Error on ${source.name}: ${err.message}`);
    } finally {
      await page.close();
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  return grants;
}

async function scrapeUSAID(page) {
  return page.evaluate(() => {
    const items = [];
    // USAID uses various content structures
    const links = document.querySelectorAll('.views-row, .field-item, article, .node');
    for (const el of Array.from(links).slice(0, 20)) {
      const titleEl = el.querySelector('h2, h3, .field-title, a');
      const descEl = el.querySelector('p, .field-body');
      const linkEl = el.querySelector('a');
      if (!titleEl) continue;
      items.push({
        title: titleEl.textContent?.trim() || '',
        url: linkEl?.href || window.location.href,
        description: descEl?.textContent?.trim()?.slice(0, 300) || '',
        funder: 'USAID Honduras',
      });
    }
    // Fallback: any RFA/RFP links
    if (items.length === 0) {
      const rfaLinks = document.querySelectorAll('a[href*="rfp"], a[href*="rfa"], a[href*="solicitation"], a[href*="opportunity"]');
      for (const link of Array.from(rfaLinks).slice(0, 10)) {
        items.push({
          title: link.textContent?.trim() || '',
          url: link.href || '',
          description: '',
          funder: 'USAID Honduras',
        });
      }
    }
    return items.filter(i => i.title.length > 5);
  });
}

async function scrapeGrantsGov(page) {
  return page.evaluate(() => {
    const items = [];
    // Grants.gov search results
    const rows = document.querySelectorAll('.grant-result, .search-result, tr[data-opportunity], .opp-row');
    for (const row of Array.from(rows).slice(0, 20)) {
      const titleEl = row.querySelector('.opportunity-title, .grant-title, td a, h4 a');
      const agencyEl = row.querySelector('.agency-name, .grant-agency');
      const deadlineEl = row.querySelector('.close-date, .deadline');
      const amountEl = row.querySelector('.award-ceiling, .amount');
      if (!titleEl) continue;
      items.push({
        title: titleEl.textContent?.trim() || '',
        url: titleEl.href || document.location.href,
        description: '',
        funder: agencyEl?.textContent?.trim() || 'US Federal',
        deadline: deadlineEl?.textContent?.trim() || null,
        amount: parseFloat((amountEl?.textContent?.replace(/[$,]/g, '') || '0')) || null,
      });
    }
    return items.filter(i => i.title.length > 5);
  });
}

module.exports = { fetchUSAIDAndGrantsGov };
