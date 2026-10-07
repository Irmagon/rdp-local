@echo off
chcp 6501 >nul
cd /d "%~dp0"

echo === Install dependencies ===
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed
  pause
  exit /b 1
)

echo.
echo === Build exe ===
call npm run build
if errorlevel 1 (
  echo ERROR: build failed
  pause
  exit /b 1
)

echo.
echo OK: dist\remote-desktop.exe
pause
