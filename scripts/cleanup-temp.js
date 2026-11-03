#!/usr/bin/env node
'use strict';
/**
 * Removes leftover scratch files from pipeline runs. The skills write driver
 * scripts (save-*-temp.js) and prompt dumps into the repo root and could not
 * delete them in the headless run (`rm` is not in the permission allow-list),
 * so they piled up — 40+ by 2026-10-30.
 *
 *   node scripts/cleanup-temp.js            dry run: list what would go
 *   node scripts/cleanup-temp.js --apply    delete
 *
 * Safety: only files at the repo root matching the scratch patterns below, and
 * only if git does NOT track them (a tracked file is never touched); plus the
 * temp dirs under output/ that the pipeline itself creates.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = [
  /^save-.*\.js$/,
  /^.*-temp\d*\.(js|txt|json)$/,
  /^.*_temp\.(js|txt|json)$/,
  /^nearmiss_prompt_\d+\.txt$/,
  /^research_prompt_\d+\.txt$/,
  /^nearmiss_targets_.*\.json$/,
  /^research_targets_.*\.json$/,
];
const TEMP_DIRS = ['output/tmp_prompts', 'output/tmp_linkedin_images', 'output/tmp_nearmiss'];
const TEMP_FILES = ['output/nm_temp.txt'];

function untrackedRootFiles() {
  const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.'], { cwd: ROOT, encoding: 'utf8' });
  const ignored = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', '.'], { cwd: ROOT, encoding: 'utf8' });
  return new Set([...out.split('\n'), ...ignored.split('\n')].filter(f => f && !f.includes('/')));
}

function main() {
  const apply = process.argv.includes('--apply');
  const candidates = [...untrackedRootFiles()].filter(f => SCRATCH.some(re => re.test(f))).sort();
  const files = [...candidates, ...TEMP_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))];
  const dirs = TEMP_DIRS.filter(d => fs.existsSync(path.join(ROOT, d)));

  for (const f of files) {
    console.log(`${apply ? 'delete' : 'would delete'}  ${f}`);
    if (apply) fs.rmSync(path.join(ROOT, f), { force: true });
  }
  for (const d of dirs) {
    console.log(`${apply ? 'delete' : 'would delete'}  ${d}/`);
    if (apply) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  }
  console.log(`${apply ? 'Removed' : 'Would remove'} ${files.length} file(s) and ${dirs.length} temp dir(s).${apply ? '' : ' Re-run with --apply.'}`);
}

if (require.main === module) main();

module.exports = { SCRATCH, TEMP_DIRS };
