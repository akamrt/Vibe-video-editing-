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
