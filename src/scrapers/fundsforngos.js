const { getPage, safeGoto } = require('./playwright-base');

const PAGES = [
  { url: 'https://www.fundsforngos.org/tag/honduras/', label: 'Honduras tag' },
  { url: 'https://www.fundsforngos.org/category/environment/', label: 'Environment category' },
  { url: 'https://www.fundsforngos.org/tag/latin-america/', label: 'Latin America tag' },
  { url: 'https://www.fundsforngos.org/tag/youth/', label: 'Youth tag' },
];

async function fetchFundsForNGOs() {
  const grants = [];
  const seen = new Set();

  for (const target of PAGES) {
    const page = await getPage();
    try {
      const ok = await safeGoto(page, target.url);
      if (!ok) { await page.close(); continue; }

      // Wait for article list
      await page.waitForSelector('article, .post, .entry', { timeout: 10000 }).catch(() => {});

      const items = await page.evaluate(() => {
        const articles = document.querySelectorAll('article, .post');
        return Array.from(articles).slice(0, 20).map(el => {
          const titleEl = el.querySelector('h2 a, h3 a, .entry-title a');
          const excerptEl = el.querySelector('.entry-summary, .entry-content p, .excerpt');
          const dateEl = el.querySelector('time, .entry-date, .post-date');
          return {
            title: titleEl?.textContent?.trim() || '',
            url: titleEl?.href || '',
            description: excerptEl?.textContent?.trim() || '',
            date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '',
          };
        }).filter(i => i.title && i.url);
      });

      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        grants.push({
          source: 'fundsforNGOs',
          id: `ffn_${Buffer.from(item.url).toString('base64').slice(0, 20)}`,
          title: item.title,
          description: item.description,
          url: item.url,
          funder: extractFunder(item.title),
          deadline: extractDeadlineFromTitle(item.title),
          amount_min: null,
          amount_max: extractAmount(item.title + ' ' + item.description),
          country: 'Honduras/LAC',
          themes: [],
          type: 'aggregator',
          fetched_at: new Date().toISOString(),
        });
      }

      console.log(`  [fundsforNGOs] ${target.label}: ${items.length} items`);
    } catch (err) {
      console.warn(`  [fundsforNGOs] Error on ${target.label}: ${err.message}`);
    } finally {
      await page.close();
    }

    // Polite delay between requests
    await new Promise(r => setTimeout(r, 2000));
  }

  return grants;
}

function extractFunder(title) {
  // Common patterns: "X Foundation Grants for...", "Y Fund: Call for..."
  const match = title.match(/^([^:–-]+?)\s+(?:Grant|Fund|Call|Award|Fellowship)/i);
  return match ? match[1].trim() : '';
}

function extractDeadlineFromTitle(title) {
  const match = title.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/);
  if (match) {
    const parsed = new Date(match[1]);
    if (!isNaN(parsed)) return parsed.toISOString().split('T')[0];
  }
  return null;
}

function extractAmount(text) {
  const match = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:million|M\b)?/i);
  if (!match) return null;
  let amount = parseFloat(match[1].replace(/,/g, ''));
  if (/million|M\b/i.test(match[0])) amount *= 1000000;
  return amount;
}

module.exports = { fetchFundsForNGOs };
