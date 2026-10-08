@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ==========================================
echo    Personal Knowledge Base - Local Website
echo   ==========================================
echo.

rem ---------- check node ----------
node --version >nul 2>nul
if errorlevel 1 goto no_node

if exist "node_modules" goto has_deps
echo   First run: installing dependencies, please wait...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto npm_fail
echo.
echo   Dependencies installed.
echo.
:has_deps

echo   Starting... your browser will open automatically.
echo.

rem tell server.js that start.bat is supervising it, so it may exit to be rerun
set "PKB_SUPERVISED=1"

:run
node server.js
set "CODE=%errorlevel%"

rem exit code 7 means server.js itself changed and asked for a restart
if "%CODE%"=="7" goto restart
if not "%CODE%"=="0" goto node_fail

echo.
echo   Press any key to close this window.
pause >nul
exit /b 0

:restart
echo.
echo   server.js changed - restarting...
echo.
rem do not auto-open the browser again on every restart
set "NO_OPEN=1"
goto run

:no_node
echo.
echo   [ERROR] Node.js not found.
echo   Please install it from https://nodejs.org and then double-click this file again.
echo.
pause
exit /b 1

:npm_fail
echo.
echo   [ERROR] Failed to install dependencies. Check your network and try again.
echo.
pause
exit /b 1

:node_fail
echo.
echo   [ERROR] The server exited unexpectedly (exit code %CODE%).
echo   Please copy the messages above so it can be diagnosed.
echo.
pause
exit /b 1
