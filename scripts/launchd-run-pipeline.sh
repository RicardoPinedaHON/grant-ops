#!/bin/bash
# Wrapper for the "GrantOps Full Pipeline" LaunchAgent.
# launchd's StartCalendarInterval only supports fixed times of day, not
# "every N days" — so this fires every day at 5:17am and no-ops on the
# off day, giving an effective every-2-days cadence anchored to a fixed
# local time (5:17am was chosen deliberately, see run-full-pipeline.bat's
# original comment about round-cron-time LinkedIn/Jina rate limiting).
set -uo pipefail

PROJECT_DIR="/Users/ricardopineda/grant-ops"
cd "$PROJECT_DIR"
source "$PROJECT_DIR/scripts/launchd-common.sh"

DAY_EPOCH=$(( $(date +%s) / 86400 ))
if (( DAY_EPOCH % 2 != 0 )); then
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "[$(date '+%d/%m/%Y %H:%M:%S')] Starting full pipeline run (launchd)..." >> logs/pipeline_run.log

# Scratch files from the previous run (the headless run can't `rm` them) —
# removed here, in plain shell, before the new run creates its own.
node scripts/cleanup-temp.js --apply >> logs/pipeline_run.log 2>&1 || true

run_claude pipeline "Follow .claude/skills/grant-full-pipeline/SKILL.md exactly, step by step. Do not ask for approval or pause for confirmation at any step -- proceed straight through autonomously per Ricardo's standing instruction in that skill file." || true

# Per-run source report (output/run_report.md + run_report_whatsapp.txt); never fails the run.
node scripts/run-report.js >> logs/pipeline_run.log 2>&1 || true

echo "[$(date '+%d/%m/%Y %H:%M:%S')] Done." >> logs/pipeline_run.log
