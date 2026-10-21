@echo off
title KALRO Guesthouse
cd /d "%~dp0"
echo Starting KALRO Guesthouse... open http://localhost:3000 in your browser.
node --no-warnings src\server.js
pause
