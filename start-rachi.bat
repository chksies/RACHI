@echo off
rem Starts RACHI and opens the dashboard. Close this window to stop it.
cd /d "%~dp0"
start "" cmd /c "timeout /t 6 >nul & start http://localhost:8000"
npm run dev
pause
