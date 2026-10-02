@echo off
cd /d "%~dp0"
if not exist "node_modules\wrangler\bin\wrangler.js" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run cloudflare:deploy
if errorlevel 1 pause
