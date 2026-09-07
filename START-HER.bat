@echo off
chcp 65001 >nul
title Vestfjella Fiske STABLE 1.3
cd /d "%~dp0"

where node >nul 2>nul
if not %errorlevel%==0 goto no_node

if not exist "node_modules\pngjs\package.json" (
  echo Forste oppstart: installerer nodvendige pakker...
  call npm install --no-audit --no-fund
  if not %errorlevel%==0 (
    echo Installasjonen feilet. Kontroller internettforbindelsen og prov igjen.
    pause
    exit /b 1
  )
)

echo Starter Vestfjella Fiske STABLE 1.3...
start "Vestfjella Fiske-server" /min cmd /c "npm start"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
exit /b 0

:no_node
echo Node.js 20 eller nyere mangler.
start "" https://nodejs.org/
pause
