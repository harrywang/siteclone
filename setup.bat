@echo off
setlocal

REM SiteClone Installer (Windows)
REM Run from the repo root: setup.bat

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. It ships with Node.js.
  exit /b 1
)

echo ==^> Installing dependencies...
call npm install
if errorlevel 1 exit /b 1

echo ==^> Building production bundle...
call npm run build
if errorlevel 1 exit /b 1

echo.
echo SiteClone is ready!
echo.
echo   Run as web app:        npm start
echo   Run as desktop app:    npm run electron:dev
echo   Build Windows .exe:    npm run electron:build:win
echo.
echo For dynamic mode, install Chromium once:
echo   npx playwright install chromium
echo.

endlocal
