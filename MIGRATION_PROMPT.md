# Prompt para pegar en Claude Code en la otra computadora (siempre encendida)

Pegá este bloque completo como primer mensaje, con el directorio de trabajo
ya puesto en esta misma carpeta de grant-ops (sincronizada vía OneDrive):

---

Este proyecto (grant-ops) ya está sincronizado acá vía OneDrive desde otra
computadora donde se armó todo el pipeline. Necesito que lo migres para que
corra permanentemente EN ESTA máquina, porque nunca se apaga. Contexto
completo en `CLAUDE.md` y en `.claude/skills/grant-full-pipeline/SKILL.md`
— leelos primero.

Hacé esto, en orden, y preguntame antes de cualquier paso irreversible o
que toque configuración fuera de esta carpeta del proyecto:

1. Confirmá que estás parado en la carpeta correcta (`package.json`,
   `CLAUDE.md`, `.claude/skills/grant-full-pipeline/` deben existir acá).
2. Corré `node -v`, `npm -v` — si falta Node.js, decímelo antes de instalar
   nada.
3. Corré `npm test` — deben pasar 34/34. Si falla algo, para y avisame en
   vez de intentar arreglarlo silenciosamente (el código ya funciona en la
   otra máquina; si falla acá, probablemente sea un problema de entorno
   local, no del código).
4. Corré `npx playwright install chromium` (necesario para el paso de
   digest-expander del pipeline).
5. Este proyecto necesita quedar "confiado" para que `.claude/settings.json`
   (ya sincronizado) tenga efecto en modo headless (`claude -p`) — sin esto,
   los permisos se ignoran. Esto es un ajuste de seguridad en TU
   `~/.claude.json` local (no en el proyecto) — PREGUNTAME antes de
   aplicarlo, igual que se hizo en la otra máquina.
6. Corré una vez, en foreground, el script completo para verificar que
   funciona acá antes de programarlo:
   `& "$PWD\run-full-pipeline.bat"` (PowerShell) — revisá
   `logs\pipeline_run.log` al terminar y confirmá que dice algo coherente
   (sources fetched, sync a Notion confirmado). Si intenta backgroundear
   algún paso y termina sin completar todo, ESO es un bug — el skill dice
   explícitamente que no debe backgroundear nada en modo headless.
7. Si el paso 6 funciona limpio, creá una tarea programada de Windows
   llamada "GrantOps Full Pipeline" que corra `run-full-pipeline.bat`
   (usando la ruta absoluta REAL de esta máquina, no la de la otra) cada 2
   días. Podés usar `Register-ScheduledTask` con `New-ScheduledTaskAction` +
   `New-ScheduledTaskTrigger -Once -At <próxima_hora_razonable> 
   -RepetitionInterval (New-TimeSpan -Days 2) -RepetitionDuration
   (New-TimeSpan -Days 3650)`.
8. Verificá con `Get-ScheduledTask -TaskName "GrantOps Full Pipeline"` y
   `Get-ScheduledTaskInfo` que quedó bien creada, con la próxima corrida en
   una fecha/hora sensata.
9. Dame un resumen final: qué se instaló, qué se confió, cuándo corre la
   próxima ejecución programada, y el resultado del test manual del paso 6.

NO toques nada del `config/sources.yaml` ni de `.env` — deben quedar
exactamente como están, ya sincronizados.

---

Cuando esa sesión te confirme que quedó funcionando ahí (paso 9), avisame
acá — voy a borrar la tarea programada "GrantOps Full Pipeline" en ESTA
computadora para que no corran las dos en paralelo y no se pisen escribiendo
`history.json` / sincronizando a Notion al mismo tiempo.
