const { getPage, safeGoto } = require('./playwright-base');

const SOURCES = [
  {
    name: 'RECID',
    url: 'https://re-cid.org/convocatoria-y-oportunidades/',
    selectors: {
      articles: '.entry-content li, article, .post',
      title: 'a, h2, h3',
      link: 'a',
    },
  },
  {
    name: 'Gestionándote',
    url: 'https://gestionandote.org/?cat=convocatorias',
    selectors: {
      articles: 'article, .post, .entry',
      title: 'h2 a, h3 a, .entry-title a',
      link: 'h2 a, h3 a, .entry-title a',
    },
  },
  {
    name: 'IKI Small Grants',
    url: 'https://www.international-climate-initiative.com/en/find-funding/small-grants/',
    selectors: {
      articles: '.funding-item, .call-item, article, .content-block',
      title: 'h2, h3, .title',
      link: 'a',
    },
  },
];

async function fetchSpanishAggregators() {
  const grants = [];

  for (const source of SOURCES) {
    const page = await getPage();
    try {
      const ok = await safeGoto(page, source.url, 25000);
      if (!ok) { await page.close(); continue; }

      // Wait for article content to render (handles WordPress lazy JS)
      try {
        await page.waitForSelector('article, .post, h2 a', { timeout: 8000 });
      } catch (_) { /* proceed anyway */ }
      await page.waitForTimeout(1000);

      const items = await page.evaluate((src) => {
        const results = [];
        const articles = document.querySelectorAll(src.selectors.articles);
        // Ricardo, 2026-09-11 — confirmed live: IKI Small Grants' `.title`
        // selector sometimes matches a status badge ("Call closed") instead
        // of the actual program name, because that site reuses the same
        // heading-ish markup for both. A title that's ONLY a status word is
        // never the real grant name on any of these sites — fall back to
        // the link text, then the raw block text, rejecting this pattern at
        // each step so a bad selector match doesn't silently become "the
        // title" for downstream scoring/search/Notion.
        const STATUS_ONLY_RE = /^(call\s+)?(open|closed|apply\s*now|now\s*open|now\s*closed)\.?$/i;

        for (const el of Array.from(articles).slice(0, 25)) {
          const titleEl = el.querySelector(src.selectors.title);
          const linkEl = el.querySelector(src.selectors.link);
          const text = el.textContent?.trim() || '';

          if (!titleEl && !text) continue;

          let title = titleEl?.textContent?.trim() || '';
          if (!title || STATUS_ONLY_RE.test(title)) title = linkEl?.textContent?.trim() || '';
          if (!title || STATUS_ONLY_RE.test(title)) title = text.slice(0, 100);

          results.push({
            title,
            url: linkEl?.href || '',
            description: text.slice(0, 300),
          });
        }

        // Fallback: get all links on the page if no articles found
        if (results.length === 0) {
          const links = document.querySelectorAll('a[href*="convocatoria"], a[href*="oportunidad"], a[href*="grant"], a[href*="fondo"], a[href*="beca"]');
          for (const link of Array.from(links).slice(0, 20)) {
            results.push({
              title: link.textContent?.trim() || '',
              url: link.href || '',
              description: '',
            });
          }
        }

        return results.filter(r => r.title.length > 5);
      }, source);

      for (const item of items) {
        grants.push({
          source: source.name,
          id: `sp_${Buffer.from(item.url || item.title).toString('base64').slice(0, 20)}`,
          title: item.title,
          description: item.description,
          url: item.url,
          funder: source.name,
          deadline: null,
          amount_min: null,
          amount_max: null,
          country: 'LAC',
          themes: [],
          type: 'aggregator',
          fetched_at: new Date().toISOString(),
        });
      }

      console.log(`  [Spanish] ${source.name}: ${items.length} items`);
    } catch (err) {
      console.warn(`  [Spanish] Error on ${source.name}: ${err.message}`);
    } finally {
      await page.close();
    }

    await new Promise(r => setTimeout(r, 2500));
  }

  return grants;
}

module.exports = { fetchSpanishAggregators };
