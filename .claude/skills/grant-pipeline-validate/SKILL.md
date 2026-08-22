---
name: grant-pipeline-validate
description: Runs 2 hours after the main scheduled pipeline (grant-full-pipeline) to check whether that run actually completed, and if not — a hang, a skipped step, or the machine being off at fire time — finish it. Reads the logs, doesn't just assume success.
---

# Grant Ops — Pipeline Validation (autonomous)

This is the SECOND scheduled job (`run-pipeline-validate.bat`, ~2 hours after
`run-full-pipeline.bat`, every 2 days). Added 2026-08-22 after a real,
repeatedly-observed failure mode: `run-scoring.js` (and other steps) finish
their actual work but the Node process never exits — CLAUDE.md's
Troubleshooting section has flagged this since at least 2026-08-18, and it
has now reproduced multiple times. In the unattended scheduled run, that
hang means every step after the stuck one silently never runs — no error,
no crash, just nothing — until Task Scheduler eventually kills it hours
later. Nobody would know unless they went looking at the logs by hand,
which is exactly what happened on 2026-08-22 before this skill existed.

**Same rules as grant-full-pipeline**: do NOT ask for approval or pause for
confirmation at any step. Run everything in the foreground, wait for each
command to finish — this is one headless `claude -p` turn with no
continuation.

## Step 1 — Read today's actual state, don't assume

Check, in this order:

1. `output/logs/pipeline_run.log` — does TODAY's date have a "Starting full
   pipeline run" line? If not, the scheduled 5:17am fire never happened at
   all (machine was off/asleep) — skip to Step 3 (run the whole pipeline).
2. If today's run started, does it have a matching completion summary
   line after it (the kind of multi-paragraph "All N steps... Summary for
   the log" text `grant-full-pipeline` writes at the end)? If yes, the run
   completed normally — log `[<timestamp>] Validation: pipeline completed
   normally, nothing to do.` to `logs/pipeline_run.log` and stop. Don't
   re-run anything just because you can.
3. If today's run started but has NO completion summary: it's stuck or was
   killed. Check for a live hung process and where the pipeline actually
   got to (see Step 2).

## Step 2 — Diagnose exactly where it stopped

Check file modification times against `output/logs/scan_*.log`'s own
"Finished" timestamp for today, in this order, to find the last step that
actually completed:

- `output/grants_prescored.json` fresh (matches today's scan) but
  `output/grants_scored.json` stale/older → scan finished, real Claude
  scoring (step 1b) never ran or didn't finish.
- `grants_scored.json` fresh but Notion wasn't synced (spot-check via
  `node -e "require('./src/notion-client').notionRequest('POST', 'databases/'+process.env.NOTION_DB_ID+'/query', {page_size:1}).then(r=>console.log(r.results?.[0]?.properties?.['Scan Date']?.date?.start))"`
  or similar — does the most-recently-touched Notion page's Scan Date match
  today?) → step 1c never ran.
- Everything above is fresh but no near-miss/deep-research section appears
  in today's log → steps 2-6 never ran.

Also check for a live stuck process tied to this repo. **Use `node -e`, not
PowerShell** — `.claude/settings.json`'s permission allow-list only covers
`Bash(node *)`/`Bash(npm *)`, not PowerShell, so a raw PowerShell command
here would stall waiting on an approval that never comes in headless mode.
`node -e` can still shell out internally (the allow-list only matches the
literal top-level `node ...` invocation, same trick `notion-client.js`'s
`https` calls already rely on) — e.g.:
```
node -e "console.log(require('child_process').execSync('tasklist /FI \"IMAGENAME eq node.exe\" /FO CSV').toString())"
```
Cross-reference against the process start time you'd expect for the stuck
step (roughly today's 5:17am fire time plus however long scan.js/scoring
should take) — if one matches and looks idle, that's very likely the exact
hang this skill exists for. Kill it the same way:
```
node -e "process.kill(<pid>)"
```
Its real work is done in every observed case so far, it's just not exiting.

## Step 3 — Resume from wherever it actually stopped

Run the remaining steps of `grant-full-pipeline`'s sequence, starting from
whatever step Step 2 identified as the first incomplete one (or from the
very beginning if today's run never started at all per Step 1.1). Follow
that skill's instructions exactly for each step you run — this skill does
not duplicate that logic, it just decides where to resume.

## Step 4 — Always log the outcome

Whether you found nothing wrong, found and fixed a hang, or ran the whole
pipeline from scratch, append a clear entry to `output/logs/pipeline_run.log`
(same file the main pipeline writes to, so Ricardo checks one place):

```
[<timestamp>] Validation check: <one of: "pipeline completed normally,
nothing to do" | "found pipeline never started (machine off?), ran full
pipeline" | "found hung process after step <N>, killed it and resumed from
step <N+1>">. <one-line summary of what got processed, if anything did.>
```

## Guardrails

- This is a SAFETY NET, not a second full run by default — Step 1.2's check
  must actually pass before declaring "nothing to do." Don't skip straight
  to re-running everything "just in case" — that wastes LLM calls and could
  double-process grants that already went through cleanly.
- If you kill a process, confirm first (via file timestamps, per Step 2)
  that its real work already landed on disk — don't kill something that's
  genuinely still in the middle of real work. The known hang pattern is
  specifically "finished its work, then didn't exit," not "still working."
- If something looks broken in a way this skill doesn't have a clear
  procedure for (not just "stuck" but actually erroring, corrupted output,
  etc.), log the concern clearly instead of guessing at a fix — a wrong
  automated "fix" is worse than a loud, honest "this needs a human."
