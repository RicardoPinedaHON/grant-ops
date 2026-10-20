#!/bin/bash
# Wrapper for the "GrantOps Pipeline Validate" LaunchAgent — fires 2 hours
# after the full pipeline (7:17am), same run-days, to catch/finish a hung run.
set -uo pipefail

PROJECT_DIR="/Users/ricardopineda/grant-ops"
cd "$PROJECT_DIR"
source "$PROJECT_DIR/scripts/launchd-common.sh"

DAY_EPOCH=$(( $(date +%s) / 86400 ))
if (( DAY_EPOCH % 2 != 0 )); then
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "[$(date '+%d/%m/%Y %H:%M:%S')] Starting pipeline validation check (launchd)..." >> logs/pipeline_run.log

run_claude validate "Follow .claude/skills/grant-pipeline-validate/SKILL.md exactly, step by step. Do not ask for approval or pause for confirmation at any step -- proceed straight through autonomously, same as grant-full-pipeline." || true

echo "[$(date '+%d/%m/%Y %H:%M:%S')] Validation check done." >> logs/pipeline_run.log
