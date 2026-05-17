@echo off
cd /d "C:\Users\Ricar\OneDrive\Escritorio\Proyectos\grant-ops"

echo [%date% %time%] Starting weekly grant scan... >> logs\weekly.log

"C:\Program Files\nodejs\node.exe" src/scan.js >> logs\weekly.log 2>&1
"C:\Program Files\nodejs\node.exe" src/run-scoring.js >> logs\weekly.log 2>&1
"C:\Program Files\nodejs\node.exe" src/expand-now.js >> logs\weekly.log 2>&1

echo [%date% %time%] Done. >> logs\weekly.log
