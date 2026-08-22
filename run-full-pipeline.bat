@echo off
REM Runs the entire Grant Ops cycle unattended (scan incl. LinkedIn -> REAL
REM Claude scoring -> Notion sync -> near-miss gate -> deep research -> re-sync).
REM Scheduled every 2 days at 5:17am via the "GrantOps Full Pipeline" task
REM (moved off 5:00am on 2026-08-22 -- LinkedIn's Jina Reader calls fail
REM specifically at round cron times, shared-IP congestion). A companion
REM task, "GrantOps Pipeline Validate" (run-pipeline-validate.bat), fires
REM 2 hours later to catch/finish a hung run -- see CLAUDE.md Troubleshooting.
REM Uses .claude/settings.json's permission allow-list (Bash node/npm, Read,
REM Write, Edit, WebSearch, WebFetch, Agent, Task) so it never stops to ask
REM for approval -- per Ricardo's instruction (2026-08-07).

cd /d "C:\Users\Ricar\OneDrive\Escritorio\Proyectos\grant-ops"

echo [%date% %time%] Starting full pipeline run... >> logs\pipeline_run.log

"C:\Users\Ricar\AppData\Roaming\npm\claude.cmd" -p "Follow .claude/skills/grant-full-pipeline/SKILL.md exactly, step by step. Do not ask for approval or pause for confirmation at any step -- proceed straight through autonomously per Ricardo's standing instruction in that skill file." --output-format text >> logs\pipeline_run.log 2>&1

echo [%date% %time%] Done. >> logs\pipeline_run.log
