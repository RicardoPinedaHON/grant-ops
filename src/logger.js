'use strict';
/**
 * logger.js
 * Pipeline audit log — writes a dated text file under output/logs/
 * so every run is traceable: what was fetched, what was filtered, why.
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'output', 'logs');

let logPath   = null;
let logStream = null;

function initLog(label = 'pipeline') {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  logPath   = path.join(LOG_DIR, `${label}_${date}_${time}.log`);
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(Buffer.from([0xEF, 0xBB, 0xBF])); // UTF-8 BOM for Windows readability
  writeLine(`=== GRANT-OPS ${label.toUpperCase()} LOG ===`);
  writeLine(`Started : ${new Date().toISOString()}`);
  writeLine('');
  return logPath;
}

function writeLine(msg) {
  if (logStream) logStream.write(msg + '\n');
}

function logSection(title) {
  writeLine('');
  writeLine('─'.repeat(60));
  writeLine(`  ${title}`);
  writeLine('─'.repeat(60));
}

function logSourceResult(source, count, detail) {
  const tag = count > 0 ? `[+${count}]` : '[ 0]';
  writeLine(`  ${tag.padEnd(6)} ${source}${detail ? '  — ' + detail : ''}`);
}

function logGrantParsed(grant) {
  writeLine(`  PARSED   "${grant.title.slice(0, 80)}" | ${grant.source}`);
}

function logGrantFiltered(grant, reason, extra) {
  const src   = grant.source || '';
  const title = (grant.title || '').slice(0, 70);
  writeLine(`  FILTERED [${reason}] "${title}" | ${src}${extra ? '  (' + extra + ')' : ''}`);
}

function logGrantScored(grant, scoring) {
  const rec   = (scoring.recommendation || '?').padEnd(11);
  const score = scoring.final_score?.toFixed(2) || '?';
  const title = (grant.title || '').slice(0, 65);
  const angle = scoring.application_angle ? `  → ${scoring.application_angle.slice(0, 100)}` : '';
  writeLine(`  ${rec} [${score}] "${title}"${angle}`);
}

function logSummary(data) {
  logSection('SUMMARY');
  for (const [key, val] of Object.entries(data)) {
    writeLine(`  ${String(key).padEnd(25)} ${val}`);
  }
  writeLine('');
}

function closeLog() {
  if (logStream) {
    writeLine('');
    writeLine(`Finished: ${new Date().toISOString()}`);
    logStream.end();
    logStream = null;
  }
  return logPath;
}

module.exports = {
  initLog,
  writeLine,
  logSection,
  logSourceResult,
  logGrantParsed,
  logGrantFiltered,
  logGrantScored,
  logSummary,
  closeLog,
};
