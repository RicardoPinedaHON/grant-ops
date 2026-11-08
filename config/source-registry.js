'use strict';
/**
 * Every place the scan consults, with the links to open by hand. rss and
 * linkedin come from config/sources.yaml; the rest is hard-coded in the scraper
 * modules, so their pages are listed here. `sources` are the `grant.source`
 * names that module produces (used to match counts), `group` is the key
 * scrapers/index.js records in source-status.js. Keep this in step when a
 * scraper gains or loses a page (test/run-report.test.js checks yaml sources).
 */
const STATIC = [
  { name: 'fundsforNGOs', group: 'fundsforngos', sources: ['fundsforNGOs', 'fundsforNGOs - Honduras'], urls: [
    'https://www.fundsforngos.org/tag/honduras/', 'https://www.fundsforngos.org/tag/latin-america/',
    'https://www.fundsforngos.org/tag/youth/', 'https://www.fundsforngos.org/category/environment/'] },
  { name: 'Gestionándote', group: 'spanish', sources: ['Gestionándote'], urls: ['https://gestionandote.org/?cat=convocatorias'] },
  { name: 'RECID', group: 'spanish', sources: ['RECID'], urls: ['https://re-cid.org/convocatoria-y-oportunidades/'] },
  { name: 'IKI Small Grants', group: 'spanish', sources: ['IKI Small Grants'], urls: ['https://www.international-climate-initiative.com/en/find-funding/small-grants/'] },
  { name: 'USAID Honduras + Grants.gov', group: 'usaid', sources: ['USAID', 'Grants.gov'], urls: [
    'https://www.usaid.gov/honduras/work-with-us/opportunities-local-organizations',
    'https://www.grants.gov/search-results.html?keyword=Honduras+environment&oppStatuses=posted',
    'https://www.grants.gov/search-results.html?keyword=Central+America+climate&oppStatuses=posted'] },
  { name: 'IAF', group: 'foundations', sources: ['IAF'], urls: ['https://iaf.gov/apply-for-grant/'] },
  { name: 'UNDP SGP', group: 'foundations', sources: ['UNDP SGP'], urls: ['https://sgp.undp.org/our-work/calls-for-proposals.html'] },
  { name: 'CEPF', group: 'foundations', sources: ['CEPF'], urls: ['https://www.cepf.net/grants/apply-for-grant'] },
  { name: 'Rainforest Trust', group: 'foundations', sources: ['Rainforest Trust'], urls: ['https://www.rainforesttrust.org/get-involved/apply-for-funding/'] },
  { name: 'Climate Calling', group: 'foundations', sources: ['Climate Calling'], urls: ['https://www.climatecalling.org/opportunities'] },
  { name: 'Fast Forward', group: 'foundations', sources: ['Fast Forward'], urls: ['https://www.ffwd.org/accelerator'] },
  { name: 'MAR Fund', group: 'new-sources', sources: ['MAR Fund'], urls: ['https://marfund.org/convocatorias/'] },
  { name: 'HeroX', group: 'new-sources', sources: ['HeroX'], urls: ['https://www.herox.com/crowdsourcing-projects?q=environment+climate&sort=mostRecent'] },
  { name: 'IDB', group: 'new-sources', sources: ['IDB'], urls: ['https://www.iadb.org/en/calls-for-proposals'] },
  { name: 'Mercociudades', group: 'new-sources', sources: ['Mercociudades'], urls: ['https://mercociudades.org/convocatoria/', 'https://mercociudades.org/oportunidades/'] },
  { name: 'Youth Climate Justice Fund', group: 'new-sources', sources: ['Youth Climate Justice Fund'], urls: ['https://youthclimatejusticefund.org/apply/'] },
  { name: 'Youth4Climate', group: 'new-sources', sources: ['Youth4Climate'], urls: ['https://www.youth4climate.org/'] },
  { name: 'Canada CFLI', group: 'new-sources', sources: ['Canada CFLI'], urls: ['https://www.canada.ca/en/embassies-consulates.html'] },
  { name: 'Echoing Green', group: 'new-sources', sources: ['Echoing Green'], urls: ['https://echoinggreen.org/fellowship/'] },
  { name: 'MIT Solve', group: 'new-sources', sources: ['MIT Solve'], urls: ['https://solve.mit.edu/challenges'] },
  { name: 'WePropel', group: 'portals', sources: ['WePropel'], urls: ['https://www.wepropel.org/oportunidades'] },
  { name: 'EasyGrant (portal)', group: 'portals', sources: ['EasyGrant'], urls: ['https://app.easygrant.io/lists/discover'] },
  { name: 'Leaders of Today', group: 'portals', sources: ['Leaders of Today'], urls: ['https://www.leadersoftoday.com/opportunities'] },
  { name: 'Outlook: Grant Newsletters folder', group: 'email', sources: [], urls: ['(Microsoft Graph, carpeta "Grant Newsletters")'] },
];

function buildRegistry(cfg = {}) {
  const rss = (cfg.rss || []).filter(s => s.enabled).map(s => ({ name: s.name, group: 'rss', sources: [s.name], urls: [s.url] }));
  const linkedin = ((cfg.linkedin || {}).sources || []).filter(s => s.enabled !== false)
    .map(s => ({ name: `LinkedIn: ${s.name}`, group: 'linkedin', sources: [`LinkedIn: ${s.name}`], urls: [s.url], linkedinKey: s.name }));
  return [...rss, ...STATIC, ...linkedin];
}

module.exports = { buildRegistry, STATIC };
