'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePromptFiles, agentInstruction } = require('../src/utils/prompt-files');
const { SCRATCH } = require('../scripts/cleanup-temp');

test('writePromptFiles writes each prompt verbatim to a file and returns a one-line agent instruction', () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  process.chdir(tmp);
  try {
    const long = 'x'.repeat(13000) + '\nBe exact: "quotes" and `ticks`';
    const out = writePromptFiles('research', [{ research_prompt: long, grant: { id: 1 } }, { research_prompt: 'two' }], 'research_prompt');
    assert.equal(out.length, 2);
    assert.equal(fs.readFileSync(out[0].prompt_file, 'utf8'), long);
    assert.equal(fs.readFileSync(out[1].prompt_file, 'utf8'), 'two');
    assert.equal(out[0].agent_prompt, agentInstruction(out[0].prompt_file));
    assert.ok(out[0].agent_prompt.length < 300);
    assert.ok(out[0].prompt_file.startsWith(fs.realpathSync(tmp)) || out[0].prompt_file.startsWith(tmp));
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cleanup-temp patterns match pipeline scratch but never real source/config files', () => {
  const scratch = ['save-scores-temp.js', 'save-nearmiss-temp2.js', 'dump-prompts-temp.txt', 'nearmiss_prompt_3.txt',
    'research_prompt_0.txt', 'research_targets_full.json', 'nearmiss_targets_temp.json', 'research_out_temp.txt', 'pipeline-summary-temp.js'];
  const real = ['package.json', 'package-lock.json', 'CLAUDE.md', 'README.md', 'org-profile.yaml', 'org-profile.example.yaml',
    'run-full-pipeline.bat', 'MIGRATION_PROMPT.md', '.env', 'capture-nearmiss.js'];
  for (const f of scratch) assert.ok(SCRATCH.some(re => re.test(f)), `should match ${f}`);
  for (const f of real) assert.ok(!SCRATCH.some(re => re.test(f)), `must NOT match ${f}`);
});
