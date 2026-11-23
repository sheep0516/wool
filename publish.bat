@echo off
setlocal
cd /d "%~dp0"

set "PS="
where pwsh >nul 2>nul && set "PS=pwsh"
if not defined PS (
  where powershell >nul 2>nul && set "PS=powershell"
)
if not defined PS (
  echo [ERROR] PowerShell not found on this machine.
  echo Please run tools\publish.ps1 manually after installing PowerShell.
  echo.
  pause
  exit /b 1
)

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\publish.ps1" %*

echo.
echo   Finished. Press any key to close this window.
pause >nul
