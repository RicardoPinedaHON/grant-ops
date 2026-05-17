const axios = require('axios');

/**
 * ReliefWeb v2 API
 * Free registration at: https://apidoc.reliefweb.int/parameters#appname
 * Returns actual funding opportunities filtered by Honduras/LAC.
 */

const SEARCHES = [
  { query: 'Honduras environment climate grant', country: 'Honduras' },
  { query: 'Central America air quality youth fund', region: 'Central America and Caribbean' },
  { query: 'Honduras indigenous forest conservation', country: 'Honduras' },
  { query: 'Latin America circular economy climate youth', region: 'Central America and Caribbean' },
];

async function fetchReliefWeb(config) {
  const appname = config.appname;
  if (!appname) {
    console.warn('  [ReliefWeb] No appname configured. Register at https://apidoc.reliefweb.int/parameters#appname');
    return [];
  }

  const grants = [];
  const seen = new Set();

  for (const search of SEARCHES) {
    try {
      const body = {
        query: { value: search.query, fields: ['title', 'body'] },
        filter: buildFilter(search),
        fields: {
          include: ['id', 'title', 'body', 'url', 'date', 'source', 'country', 'theme', 'deadline_closing'],
        },
        limit: config.limit || 30,
        sort: ['date.created:desc'],
      };

      const res = await axios.post(
        `${config.base_url}/jobs`,
        body,
        {
          params: { appname },
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );

      const items = res.data?.data || [];
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        grants.push(normalize(item));
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`  [ReliefWeb] Failed "${search.query}": ${msg}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return grants;
}

function buildFilter(search) {
  if (search.country) {
    return { field: 'country.name', value: search.country };
  }
  if (search.region) {
    return { field: 'country.region.name', value: search.region };
  }
  return {};
}

function normalize(item) {
  const f = item.fields || {};
  const deadline = f.deadline_closing ? f.deadline_closing.split('T')[0] : null;
  return {
    source: 'ReliefWeb',
    id: `rw_${item.id}`,
    title: f.title || '',
    description: (f.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
    url: f.url || `https://reliefweb.int/node/${item.id}`,
    funder: (f.source || []).map(s => s.name).join(', ') || 'ReliefWeb',
    deadline,
    amount_min: null,
    amount_max: null,
    country: (f.country || []).map(c => c.name).join(', ') || 'Global',
    themes: (f.theme || []).map(t => t.name),
    type: 'funding_opportunity',
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { fetchReliefWeb };
