'use strict';
/**
 * Per-run record of what each source group and LinkedIn page did, written to
 * output/source_status.json by scan.js and read by scripts/run-report.js.
 * Scrapers call record*(); nothing here ever throws.
 */
const state = { groups: {}, linkedin: {} };

function recordGroup(key, { ok = true, count = 0, error = null } = {}) {
  state.groups[key] = { ok, count, error: error ? String(error).slice(0, 200) : null };
}

function recordLinkedIn(name, info = {}) {
  state.linkedin[name] = { ...info, error: info.error ? String(info.error).slice(0, 200) : null };
}

function snapshot() { return JSON.parse(JSON.stringify(state)); }
function reset() { state.groups = {}; state.linkedin = {}; }

module.exports = { recordGroup, recordLinkedIn, snapshot, reset };
