@echo off
REM Double-click to install Phaedo into your AI apps (Claude Desktop, Cursor,
REM Claude Code) and pair with your phone. Safe to run again any time.
setlocal

REM Resolve the mcp\ folder relative to this script (installers\windows\ -> mcp\).
set "HERE=%~dp0"
pushd "%HERE%..\.." || (echo Could not find the mcp folder & pause & exit /b 1)

echo Phaedo MCP installer
echo Folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed.
  echo Install it from https://nodejs.org ^(the LTS button^), then double-click this again.
  echo.
  pause
  popd
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo Using node %%v
echo.

if not exist node_modules (
  echo Installing dependencies ^(one time^)...
  call npm install --omit=dev
  echo.
)

REM Configure every detected client, then run the one-time phone pairing.
node install.mjs --pair

echo.
echo Done. If a client was already open, restart it so it picks up Phaedo.
pause
popd
endlocal
