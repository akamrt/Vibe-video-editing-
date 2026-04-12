@echo off
setlocal enabledelayedexpansion
title VibeCut AI
color 0B

echo.
echo  ===================================================
echo       VibeCut AI - Starting Application...
echo  ===================================================
echo.

:: Check if setup has been run
if not exist "node_modules" (
    echo  First time running? Let me set things up for you...
    echo.
    call INSTALL.bat
    if %ERRORLEVEL% neq 0 (
        echo  Setup failed. Please try running INSTALL.bat first.
        pause
        exit /b 1
    )
    echo.
    echo  ===================================================
    echo       Setup complete! Now starting the app...
    echo  ===================================================
    echo.
)

:: Auto-update: pull latest from GitHub and reinstall if needed
where git >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo  Checking for updates...

    :: Save current package.json hash
    set "OLD_HASH="
    for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do (
        if not defined OLD_HASH set "OLD_HASH=%%h"
    )

    git pull --ff-only >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        set "NEW_HASH="
        for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do (
            if not defined NEW_HASH set "NEW_HASH=%%h"
        )
        if not "!OLD_HASH!"=="!NEW_HASH!" (
            echo  Dependencies changed - running npm install...
            call npm install
        )
        echo  Up to date!
    ) else (
        echo  Could not auto-update. Continuing with current version.
    )
    echo.
)

:: Check for .env.local
if not exist ".env.local" (
    echo  [WARNING] No API keys found!
    echo  The app will start but AI features won't work.
    echo  Edit ".env.local" to add your API keys.
    echo.
)

:: Kill any existing processes on our ports
echo  Checking for other instances...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /F /PID %%a >nul 2>nul
)
:: Kill any orphaned Python tracker processes
taskkill /F /IM vibecut-tracker.exe >nul 2>nul

:: Start the backend server in a new minimized window
echo  Starting backend server...
start "VibeCut Backend" /min cmd /c "node server/server.cjs"

:: Wait for backend to start
timeout /t 3 /nobreak >nul

:: Start the frontend and open browser
echo  Starting app...
echo.
echo  ===================================================
echo.
echo   Your app is starting! A browser window will open.
echo.
echo   If it doesn't open automatically, go to:
echo   http://localhost:3000
echo.    
echo   TO STOP: Close this window and the minimized 
echo   "VibeCut Backend" window in your taskbar.
echo.
echo  ===================================================
echo.

:: Open browser first
start http://localhost:3000

:: Run Vite (this blocks until user closes)
npx vite
