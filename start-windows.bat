@echo off
title Mr.Clean Car Detailing
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Opening the download page - install the LTS version, then run this file again. & start https://nodejs.org & pause & exit /b)
if not exist node_modules (echo Installing... & call npm install)
if not exist data\carwash.db (call npm run seed:demo)
start "" http://localhost:3000/staff
echo.
echo Mr.Clean is running at http://localhost:3000   (staff PIN pad: http://localhost:3000/staff)
echo Admin PIN 2222 - Employee PIN 1111 - Close this window to stop.
call npm start
pause
