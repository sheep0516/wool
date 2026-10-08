@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ==========================================
echo    Content check - scanning markdown files
echo   ==========================================
echo.

node --version >nul 2>nul
if errorlevel 1 goto no_node

node tools\check-content.js
set "CODE=%errorlevel%"

echo.
if "%CODE%"=="0" echo   All good - no problem found.
if not "%CODE%"=="0" echo   Problems found - see the list above.
echo.
echo   Press any key to close this window.
pause >nul
exit /b %CODE%

:no_node
echo.
echo   [ERROR] Node.js not found.
echo   Please install it from https://nodejs.org and then double-click this file again.
echo.
pause
exit /b 1
