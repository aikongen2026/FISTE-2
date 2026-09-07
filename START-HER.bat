@echo off
cd /d %~dp0
where node >nul 2>nul || (echo Node.js 20+ mangler. Installer Node.js fra nodejs.org & pause & exit /b 1)
start "" http://localhost:3000
npm start
