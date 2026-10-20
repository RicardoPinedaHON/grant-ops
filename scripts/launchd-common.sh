#!/bin/bash
# Shared helpers for the launchd wrappers (launchd-run-pipeline.sh,
# launchd-run-validate.sh). Sourced, not executed.
#
# Added 2026-10-20 after two failure modes silently cost three cycles:
#   - 2026-10-14 and 10-16: `claude -p` failed with "OAuth session expired"
#   - 2026-10-20: launchd fired at 5:17 but DNS was not up yet (ENOTFOUND)
# Each failure was a one-line log entry nobody read. Now: wait for the
# network, use a long-lived token if one is installed, and raise a macOS
# notification (plus logs/ALERTS.log) whenever a run fails.

GRANTOPS_ALERT_LOG="$PROJECT_DIR/logs/ALERTS.log"
GRANTOPS_TOKEN_FILE="$HOME/.config/grantops/oauth-token"
GRANTOPS_FAIL_PATTERN='Failed to authenticate|OAuth session expired|API Error|Invalid API key|usage limit|ENOTFOUND'

# Long-lived token from `claude setup-token`, if installed (chmod 600). It
# does not expire like the interactive login session does.
load_token() {
  if [ -r "$GRANTOPS_TOKEN_FILE" ]; then
    CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$GRANTOPS_TOKEN_FILE")"
    export CLAUDE_CODE_OAUTH_TOKEN
  fi
}

notify() {
  local title="$1" msg="$2"
  echo "[$(date '+%d/%m/%Y %H:%M:%S')] $title: $msg" >> "$GRANTOPS_ALERT_LOG"
  /usr/bin/osascript -e "display notification \"$msg\" with title \"$title\" sound name \"Basso\"" >/dev/null 2>&1 || true
}

# launchd can fire right after wake, before Wi-Fi/DNS are back. Poll up to
# ~15 min (any HTTP response means DNS + TCP + TLS work).
wait_for_network() {
  local i
  for i in $(seq 1 30); do
    if /usr/bin/curl -sS -I -m 8 -o /dev/null https://api.anthropic.com 2>/dev/null; then
      return 0
    fi
    sleep 30
  done
  return 1
}

# run_claude <label> <prompt>: appends output to pipeline_run.log and alerts
# on failure (non-zero exit OR a known failure signature in the output,
# since `claude -p` can exit 0 after printing an auth/API error).
run_claude() {
  local label="$1" prompt="$2" out rc=0
  out="$(mktemp)"

  load_token
  if ! wait_for_network; then
    echo "Network unreachable after 15 min; skipped." >> logs/pipeline_run.log
    notify "GrantOps $label FAILED" "No network after 15 min — run skipped. Check logs/pipeline_run.log"
    rm -f "$out"
    return 1
  fi

  claude -p "$prompt" --output-format text > "$out" 2>&1 || rc=$?
  cat "$out" >> logs/pipeline_run.log

  if [ "$rc" -ne 0 ] || head -c 2000 "$out" | grep -q -E "$GRANTOPS_FAIL_PATTERN"; then
    notify "GrantOps $label FAILED" "$(head -c 160 "$out" | tr '\n"' "  ") (exit $rc). If auth: run 'claude' once in a terminal, or 'claude setup-token'."
    rm -f "$out"
    return 1
  fi
  rm -f "$out"
}
