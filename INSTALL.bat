@echo off
setlocal enabledelayedexpansion
title VibeCut AI - Installer
color 0A

echo.
echo  ===================================================
echo  __      __ _  _           ___         _      _    ___ 
echo  \ \    / /(_)^| ^|__  ___  / __\ _  _ _^| ^|_   / \  ^|_ _^|
echo   \ \/\/ / ^| ^|^| '_ \/ -_^)^| (__ ^| ^|^| ^|  _^| ^| _ \ ^| ^| 
echo    \_/\_/  ^|_^|^|_.__/\___^| \___^|\_,_^|\__^| ^|_/ \_\^|___^|
echo.
echo  ===================================================
echo             One-Click Installer for Windows
echo  ===================================================
echo.

:: ====================================================
:: STEP 1: Check for Node.js
:: ====================================================
echo  [Step 1/4] Checking for Node.js...
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo  Node.js is NOT installed on this computer.
    echo  Node.js is required to run VibeCut AI.
    echo.
    echo  ===================================================
    echo   INSTALLING NODE.JS AUTOMATICALLY...
    echo  ===================================================
    echo.

    :: Try winget first (available on Win10 1809+ and Win11)
    where winget >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        echo  Installing via Windows Package Manager...
        echo  (You may see a User Account Control prompt - click Yes)
        echo.
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        if !ERRORLEVEL! equ 0 (
            echo.
            echo  [OK] Node.js installed successfully!
            echo.
            echo  ===================================================
            echo   IMPORTANT: Please close this window and
            echo   double-click INSTALL.bat again to continue.
            echo  ===================================================
            echo.
            echo  (Node.js needs a fresh terminal to be recognized)
            pause
            exit /b 0
        )
    )

    :: If winget failed or isn't available, download the MSI directly
    echo  Downloading Node.js installer...
    set "NODE_MSI=%TEMP%\nodejs_installer.msi"
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.15.1/node-v22.15.1-x64.msi' -OutFile '%NODE_MSI%' -UseBasicParsing }" 2>nul

    if exist "%NODE_MSI%" (
        echo.
        echo  ===================================================
        echo   The Node.js installer will open now.
        echo   Click "Next" through all the steps to install it.
        echo  ===================================================
        echo.
        pause
        start /wait msiexec /i "%NODE_MSI%"
        del "%NODE_MSI%" >nul 2>nul
        echo.
        echo  ===================================================
        echo   Node.js installation complete!
        echo   Please close this window and double-click 
        echo   INSTALL.bat again to continue the setup.
        echo  ===================================================
        pause
        exit /b 0
    ) else (
        echo.
        echo  ===================================================
        echo   Could not download Node.js automatically.
        echo.
        echo   Please install Node.js manually:
        echo   1. Go to https://nodejs.org
        echo   2. Click the big green "Download" button
        echo   3. Run the downloaded file and click Next
        echo   4. Come back and double-click INSTALL.bat again
        echo  ===================================================
        pause
        exit /b 1
    )
) else (
    for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
    echo  [OK] Node.js is installed: !NODE_VER!
)

echo.

:: ====================================================
:: STEP 2: Install npm packages
:: ====================================================
echo  [Step 2/4] Installing app dependencies...
echo  (This may take a minute the first time)
echo.

call npm install --loglevel=error
if %ERRORLEVEL% neq 0 (
    echo.
    echo  [ERROR] Failed to install dependencies.
    echo  Please check your internet connection and try again.
    pause
    exit /b 1
)
echo.
echo  [OK] Dependencies installed!
echo.

:: ====================================================
:: STEP 3: Download yt-dlp and ffmpeg
:: ====================================================
echo  [Step 3/4] Downloading video tools...
echo.

if not exist "bin" mkdir bin

:: Download yt-dlp
if exist "bin\yt-dlp.exe" (
    echo  [OK] yt-dlp already downloaded.
) else (
    echo  Downloading yt-dlp (video downloader)...
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe' -UseBasicParsing }" 2>nul
    if exist "bin\yt-dlp.exe" (
        echo  [OK] yt-dlp downloaded!
    ) else (
        echo  [WARNING] Could not download yt-dlp. Video downloads may not work.
    )
)

:: Download ffmpeg
if exist "bin\ffmpeg.exe" (
    echo  [OK] ffmpeg already downloaded.
) else (
    echo  Downloading ffmpeg (video processor)...
    echo  This file is larger - please wait...
    powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $tmp = 'bin\ffmpeg-release.zip'; Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $tmp -UseBasicParsing; if (Test-Path $tmp) { Write-Host '  Extracting...'; $shell = New-Object -ComObject Shell.Application; $zip = $shell.NameSpace((Resolve-Path $tmp).Path); $dest = $shell.NameSpace((Resolve-Path 'bin').Path); foreach ($item in $zip.Items()) { if ($item.Name -match 'ffmpeg') { $inner = $shell.NameSpace($item.Path + '\bin'); if ($inner) { foreach ($f in $inner.Items()) { $dest.CopyHere($f, 0x14) } } } }; Remove-Item $tmp -Force } }" 2>nul
    if exist "bin\ffmpeg.exe" (
        echo  [OK] ffmpeg downloaded!
    ) else (
        echo  [WARNING] Could not download ffmpeg. Some video features may not work.
    )
)

echo.

:: ====================================================
:: STEP 4: Build Python tracker (optional)
:: ====================================================
echo  [Step 4/5] Building Python tracker (optional)...
echo.

if exist "bin\vibecut-tracker.exe" (
    echo  [OK] Python tracker already built.
) else (
    where python >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        python -c "import mediapipe; import cv2" >nul 2>nul
        if !ERRORLEVEL! equ 0 (
            python -c "import PyInstaller" >nul 2>nul
            if !ERRORLEVEL! neq 0 (
                echo  Installing PyInstaller...
                python -m pip install pyinstaller --quiet
            )
            echo  Building Python tracker binary (this may take a few minutes^)...
            python python\build.py
            if exist "bin\vibecut-tracker.exe" (
                echo  [OK] Python tracker built successfully!
            ) else (
                echo  [WARNING] Build failed. Browser tracking will be used instead.
            )
        ) else (
            echo  [INFO] Python tracker dependencies not installed.
            echo  To enable AI-powered person tracking, run:
            echo    pip install mediapipe opencv-python-headless numpy pyinstaller
            echo    python python\build.py
            echo.
            echo  The app will use browser-based tracking in the meantime.
        )
    ) else (
        echo  [INFO] Python not found. Skipping tracker build.
        echo  The app will use browser-based tracking.
    )
)

echo.

:: ====================================================
:: STEP 5: Set up API keys
:: ====================================================
echo  [Step 5/5] Checking API keys...
echo.

if not exist ".env.local" (
    if exist ".env.example" (
        copy ".env.example" ".env.local" >nul
    ) else (
        (
            echo GEMINI_API_KEY=your_gemini_api_key_here
            echo KIMI_API_KEY=your_kimi_api_key_here
            echo OPENAI_API_KEY=your_openai_api_key_here
            echo MINIMAX_API_KEY=your_minimax_api_key_here
        ) > ".env.local"
    )
    echo  [INFO] Created .env.local file.
    echo.
    echo  ===================================================
    echo   You need API keys to use the AI features.
    echo   Open the file ".env.local" in Notepad and 
    echo   replace the placeholder text with your real keys.
    echo.
    echo   Need a free API key? Get one at:
    echo   https://aistudio.google.com/apikey
    echo  ===================================================
) else (
    echo  [OK] API keys file already exists.
)

echo.
echo.
echo  ===================================================
echo   INSTALLATION COMPLETE!
echo  ===================================================
echo.
echo   To run VibeCut AI:
echo     - Double-click "START.bat" in this folder
echo     - Or type: .\START.bat
echo.
echo   The app will open in your web browser automatically.
echo  ===================================================
echo.
pause
