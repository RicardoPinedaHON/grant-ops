#!/usr/bin/env node
/**
 * init-wizard.js
 * Interactive setup that creates org-profile.yaml for a new organization.
 */

'use strict';

const readline = require('readline');
const fs   = require('fs');
const path = require('path');
const yaml = require('yaml');

const ROOT        = path.join(__dirname, '..');
const PROFILE_OUT = path.join(ROOT, 'org-profile.yaml');

const FOCUS_OPTIONS = [
  { key: 'A', value: 'air_quality',                    label: 'Air quality / pollution monitoring' },
  { key: 'B', value: 'climate_action_mitigation',      label: 'Climate action / mitigation' },
  { key: 'C', value: 'circular_economy',               label: 'Circular economy / waste management' },
  { key: 'D', value: 'water_governance',               label: 'Water governance / WASH' },
  { key: 'E', value: 'youth_empowerment',              label: 'Youth leadership / empowerment' },
  { key: 'F', value: 'biodiversity',                   label: 'Biodiversity / ecosystem conservation' },
  { key: 'G', value: 'indigenous_rights',              label: 'Indigenous rights / community land' },
  { key: 'H', value: 'environmental_policy_advocacy',  label: 'Environmental policy / advocacy' },
  { key: 'I', value: 'energy_transition',              label: 'Energy transition / renewables' },
  { key: 'J', value: 'food_security',                  label: 'Food security / agroecology' },
  { key: 'K', value: 'gender_equality',                label: 'Gender equality / women\'s rights' },
  { key: 'L', value: 'disaster_risk_reduction',        label: 'Disaster risk reduction / early warning' },
];

const LAC_COUNTRIES = [
  'Honduras', 'Guatemala', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama',
  'Mexico', 'Colombia', 'Ecuador', 'Peru', 'Bolivia', 'Brazil', 'Argentina',
  'Chile', 'Paraguay', 'Uruguay', 'Venezuela', 'Dominican Republic', 'Haiti', 'Cuba',
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise(resolve => {
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    rl.question(`  ${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   grant-ops — Organization Setup Wizard  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (fs.existsSync(PROFILE_OUT)) {
    const overwrite = await ask('org-profile.yaml already exists. Overwrite? (y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nSetup cancelled.\n');
      rl.close(); return;
    }
  }

  console.log('\n── Organization ─────────────────────────────\n');
  const orgName       = await ask('Organization name');
  const website       = await ask('Website (https://...)');
  const contactEmail  = await ask('Contact email');
  const foundedYear   = await ask('Founded year', String(new Date().getFullYear() - 3));
  const staffTotal    = await ask('Total staff / team size', '10');
  const annualBudget  = await ask('Annual budget USD (approximate)', '100000');

  console.log('\n── Geography ────────────────────────────────\n');
  console.log('  Common countries: ' + LAC_COUNTRIES.slice(0, 8).join(', ') + ', ...');
  const country       = await ask('Primary country of operation');
  const willingRaw    = await ask('Also willing to work in (comma-separated, or leave blank)', 'Latin America, Central America');
  const willing       = willingRaw ? willingRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  console.log('\n── Mission ──────────────────────────────────\n');
  console.log('  Select your primary focus areas (enter letters, e.g. A,B,E):');
  FOCUS_OPTIONS.forEach(o => console.log(`    ${o.key}. ${o.label}`));
  const focusRaw  = await ask('\n  Your selections');
  const focusKeys = focusRaw.toUpperCase().split(/[,\s]+/).filter(Boolean);
  const primaryFocus = FOCUS_OPTIONS
    .filter(o => focusKeys.includes(o.key))
    .map(o => o.value);

  if (primaryFocus.length === 0) {
    console.log('  No focus areas selected — using climate_action_mitigation as default.');
    primaryFocus.push('climate_action_mitigation');
  }

  console.log('\n── Grant preferences ────────────────────────\n');
  const sweetMin = await ask('Minimum grant size USD (sweet spot)', '20000');
  const sweetMax = await ask('Maximum grant size USD (sweet spot)', '200000');
  const hardMin  = await ask('Absolute minimum USD (too small to apply)', '5000');
  const hardMax  = await ask('Absolute maximum USD (too large to manage alone)', '1000000');

  console.log('\n── Capacity ─────────────────────────────────\n');
  const langsRaw    = await ask('Languages your team can write proposals in (comma-separated)', 'es, en');
  const languages   = langsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const canMatch    = await ask('Can you provide matching funds? (y/N)', 'N');
  const prevFunders = await ask('Previous funders (comma-separated, or leave blank)', '');

  console.log('\n── Active projects ──────────────────────────\n');
  console.log('  You can add up to 5 projects. Press Enter to skip a project slot.\n');

  const projects = [];
  for (let i = 1; i <= 5; i++) {
    const name = await ask(`Project ${i} name (or Enter to skip)`);
    if (!name) break;
    const desc     = await ask(`  One-line description`);
    const urgency  = await ask(`  Funding urgency (high/medium/low)`, 'medium');
    const tagsRaw  = await ask(`  Keywords/tags (comma-separated)`, 'climate, environment');
    const tags     = tagsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    projects.push({ name, description: desc, funding_urgency: urgency, tags });
  }

  if (projects.length === 0) {
    projects.push({
      name: 'Core Program',
      description: 'Main programmatic work of the organization',
      funding_urgency: 'high',
      tags: primaryFocus.slice(0, 3),
    });
  }

  // Build profile
  const profile = {
    organization: {
      name: orgName,
      founded_year: parseInt(foundedYear) || 2020,
      legal_status: 'Non-profit organization',
      staff_size: { total: parseInt(staffTotal) || 10, operational_team: Math.round(parseInt(staffTotal) * 0.7) || 7 },
      annual_budget_usd: parseInt(annualBudget) || 100000,
      website,
      contact_email: contactEmail,
    },
    geography: {
      country,
      region: 'Latin America',
      willing_to_work_in: willing,
    },
    mission: {
      primary_focus: primaryFocus,
      projects,
    },
    capacity: {
      languages,
      grant_size_min_usd:           parseInt(hardMin)  || 5000,
      grant_size_max_usd:           parseInt(hardMax)  || 1000000,
      grant_size_sweet_spot_min_usd: parseInt(sweetMin) || 20000,
      grant_size_sweet_spot_max_usd: parseInt(sweetMax) || 200000,
      can_provide_matching_funds: canMatch.toLowerCase() === 'y',
      max_matching_percent: 15,
    },
    experience: {
      previous_funders: prevFunders ? prevFunders.split(',').map(s => s.trim()).filter(Boolean) : [],
      years_operating: new Date().getFullYear() - (parseInt(foundedYear) || 2020),
    },
  };

  const yamlStr = `# ================================================
# grant-ops — Organization Profile
# Generated by: grant-ops init
# Edit this file to refine your scoring preferences
# ================================================\n\n` + yaml.stringify(profile);

  fs.writeFileSync(PROFILE_OUT, yamlStr, 'utf8');

  console.log('\n✅  org-profile.yaml created successfully!\n');
  console.log('  Next steps:');
  console.log('  1. Review and edit org-profile.yaml to fine-tune details');
  console.log('  2. Run: grant-ops run   (full scan + score + report)');
  console.log('  3. Open output/report_YYYY-MM-DD.html in your browser\n');

  rl.close();
}

main().catch(err => {
  console.error('\nSetup error:', err.message);
  rl.close();
  process.exit(1);
});
