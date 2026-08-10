@echo off
REM Runs the entire Grant Ops cycle unattended (scan incl. LinkedIn -> score
REM -> Notion sync -> deep research top-scored eligible grants -> re-sync).
REM Scheduled every 2 days via the "GrantOps Full Pipeline" task.
REM Uses .claude/settings.json's permission allow-list (Bash node/npm, Read,
REM Write, Edit, WebSearch, WebFetch, Agent, Task) so it never stops to ask
REM for approval -- per Ricardo's instruction (2026-08-07).

cd /d "C:\Users\Ricar\OneDrive\Escritorio\Proyectos\grant-ops"

echo [%date% %time%] Starting full pipeline run... >> logs\pipeline_run.log

"C:\Users\Ricar\AppData\Roaming\npm\claude.cmd" -p "Follow .claude/skills/grant-full-pipeline/SKILL.md exactly, step by step. Do not ask for approval or pause for confirmation at any step -- proceed straight through autonomously per Ricardo's standing instruction in that skill file." --output-format text >> logs\pipeline_run.log 2>&1

echo [%date% %time%] Done. >> logs\pipeline_run.log
