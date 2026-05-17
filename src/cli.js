#!/usr/bin/env node
/**
 * grant-ops CLI entry point
 * Usage: grant-ops <command>
 */

'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');

const COMMANDS = {
  init:   'Interactive setup — creates your org-profile.yaml',
  scan:   'Fetch new grant opportunities from all sources',
  score:  'Score fetched grants against your org profile',
  expand: 'Expand newsletter digests into individual grants',
  report: 'Open the latest HTML report in your browser',
  run:    'Full pipeline: scan → score → expand → report',
};

const cmd = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case 'init':
    require('./init-wizard');
    break;

  case 'scan':
    run('node', ['src/scan.js', ...process.argv.slice(3)]);
    break;

  case 'score':
    run('node', ['src/run-scoring.js']);
    break;

  case 'expand':
    run('node', ['src/expand-now.js']);
    break;

  case 'report': {
    const output = path.join(ROOT, 'output');
    if (!fs.existsSync(output)) {
      console.error('No output directory found. Run: grant-ops scan && grant-ops score first.');
      process.exit(1);
    }
    const reports = fs.readdirSync(output)
      .filter(f => f.startsWith('report_') && f.endsWith('.html'))
      .sort().reverse();
    if (!reports.length) {
      console.error('No HTML report found. Run: grant-ops run');
      process.exit(1);
    }
    const reportPath = path.join(output, reports[0]);
    console.log('Opening:', reportPath);
    const opener = process.platform === 'win32' ? 'start' :
                   process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').execSync(`${opener} "${reportPath}"`, { shell: true });
    break;
  }

  case 'run':
    runSequential([
      ['node', ['src/scan.js']],
      ['node', ['src/run-scoring.js']],
      ['node', ['src/expand-now.js']],
    ]);
    break;

  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
}

function printHelp() {
  console.log('\ngrant-ops — AI-powered grant scanner for NGOs\n');
  console.log('Usage: grant-ops <command>\n');
  console.log('Commands:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${desc}`);
  }
  console.log('\nFirst time? Run: grant-ops init\n');
}

function run(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
  child.on('exit', code => process.exit(code || 0));
}

function runSequential(steps) {
  const [first, ...rest] = steps;
  const child = spawn(first[0], first[1], { cwd: ROOT, stdio: 'inherit', shell: true });
  child.on('exit', code => {
    if (code !== 0) { process.exit(code); }
    if (rest.length) runSequential(rest);
    else {
      // open report after full run
      process.argv[2] = 'report';
      require('./cli');
    }
  });
}
