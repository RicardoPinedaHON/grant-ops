@echo off
REM Runs 2 hours after run-full-pipeline.bat to check whether that run
REM actually completed (it might have hung -- see CLAUDE.md Troubleshooting
REM and .claude/skills/grant-pipeline-validate/SKILL.md) and finish it if not.
REM Scheduled via the "GrantOps Pipeline Validate" task.
REM Uses the same .claude/settings.json permission allow-list as
REM run-full-pipeline.bat so it never stops to ask for approval.

cd /d "C:\Users\Ricar\OneDrive\Escritorio\Proyectos\grant-ops"

echo [%date% %time%] Starting pipeline validation check... >> logs\pipeline_run.log

"C:\Users\Ricar\AppData\Roaming\npm\claude.cmd" -p "Follow .claude/skills/grant-pipeline-validate/SKILL.md exactly, step by step. Do not ask for approval or pause for confirmation at any step -- proceed straight through autonomously, same as grant-full-pipeline." --output-format text >> logs\pipeline_run.log 2>&1

echo [%date% %time%] Validation check done. >> logs\pipeline_run.log
