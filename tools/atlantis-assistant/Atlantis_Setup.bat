@echo off
setlocal EnableExtensions
title Atlantis Setup
color 0B

rem ── Where this downloads the app files from ──────────────────────────
rem This currently points at a feature branch (PR #2, not yet merged).
rem Once that PR merges into main, change REPO_BRANCH below to "main".
set "REPO_OWNER=oisa333-blip"
set "REPO_NAME=AlpacaBot"
set "REPO_BRANCH=claude/traders-alpaca-connections-audit-i6rkpy"
set "REPO_PATH=tools/atlantis-assistant"
set "BASE_URL=https://raw.githubusercontent.com/%REPO_OWNER%/%REPO_NAME%/%REPO_BRANCH%/%REPO_PATH%"

echo ============================================================
echo                     ATLANTIS SETUP
echo ============================================================
echo.
echo This is the only file you need. Double-clicking it will:
echo   1. Download the Atlantis app files from GitHub (URL printed below)
echo   2. Install Python if needed (via winget)
echo   3. Create a virtual environment and install requirements
echo   4. Install the Playwright browser used for browser automation
echo   5. Install Ollama if needed (via winget) and pull the local AI model
echo   6. Download a small, fully offline voice-recognition model (~40 MB)
echo   7. Create a one-click "Atlantis" shortcut on your Desktop
echo   8. Ask you if you want to run it right now
echo.
echo Nothing here is hidden. Every URL and step is printed on screen, and
echo you're welcome to open this file in Notepad first to read it end to end.
echo.
echo Files will be downloaded from:
echo   %BASE_URL%
echo.
pause

set /p INSTALLTO="Install Atlantis into which folder? [Enter for default: %USERPROFILE%\Atlantis]: "
if "%INSTALLTO%"=="" set "INSTALLTO=%USERPROFILE%\Atlantis"
if not exist "%INSTALLTO%" mkdir "%INSTALLTO%"
set "ATLANTISDATA=%USERPROFILE%\.atlantis"
if not exist "%ATLANTISDATA%" mkdir "%ATLANTISDATA%"

echo.
echo [1/8] Downloading Atlantis application files to %INSTALLTO% ...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE_URL%/run_atlantis.py' -OutFile '%INSTALLTO%\run_atlantis.py'"
if errorlevel 1 goto :failpause
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE_URL%/atlantis_tools.py' -OutFile '%INSTALLTO%\atlantis_tools.py'"
if errorlevel 1 goto :failpause
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE_URL%/requirements.txt' -OutFile '%INSTALLTO%\requirements.txt'"
if errorlevel 1 goto :failpause
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE_URL%/Launch_Atlantis.vbs' -OutFile '%INSTALLTO%\Launch_Atlantis.vbs'"
if errorlevel 1 goto :failpause
echo Downloaded.

echo.
echo [2/8] Checking Python...
set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE (
    where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
    echo Python not found. Installing via winget...
    where winget >nul 2>nul
    if errorlevel 1 (
        echo winget is missing. Install "App Installer" from the Microsoft Store, then re-run this.
        goto :failpause
    )
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 goto :failpause
    where py >nul 2>nul && set "PYEXE=py -3"
)
if not defined PYEXE goto :failpause

echo.
echo [3/8] Creating virtual environment and installing requirements...
%PYEXE% -m venv "%INSTALLTO%\.venv"
if errorlevel 1 goto :failpause
call "%INSTALLTO%\.venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r "%INSTALLTO%\requirements.txt"
if errorlevel 1 goto :failpause

echo.
echo [4/8] Installing the Playwright browser (used for browser automation)...
python -m playwright install chromium
if errorlevel 1 (
    echo Playwright browser install did not finish. Browser features will not
    echo work until this succeeds; everything else will still run. Retry later
    echo with: python -m playwright install chromium
)

echo.
echo [5/8] Checking Ollama...
set "OLLAMAEXE="
where ollama >nul 2>nul && set "OLLAMAEXE=ollama"
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMAEXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLLAMAEXE (
    echo Ollama not found. Installing via winget...
    where winget >nul 2>nul
    if errorlevel 1 goto :failpause
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 goto :failpause
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMAEXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
)
if not defined OLLAMAEXE goto :failpause

echo Downloading the local AI model (this is the largest download)...
start "" /min "%OLLAMAEXE%" serve
timeout /t 3 /nobreak >nul
"%OLLAMAEXE%" pull qwen2.5-coder:3b
if errorlevel 1 (
    echo The AI model download did not finish. Atlantis will still be
    echo installed -- you can re-run "ollama pull qwen2.5-coder:3b" later.
)

echo.
echo [6/8] Downloading offline voice-recognition model (about 40 MB)...
if exist "%ATLANTISDATA%\vosk-model" (
    echo Voice model already installed, skipping.
) else (
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip' -OutFile '%TEMP%\vosk-model.zip'"
    if errorlevel 1 (
        echo Voice model download failed -- check your internet connection.
        echo Voice mode will not work until this succeeds; everything else will.
    ) else (
        powershell -NoProfile -Command "Expand-Archive -LiteralPath '%TEMP%\vosk-model.zip' -DestinationPath '%TEMP%\vosk-extract' -Force"
        powershell -NoProfile -Command "Move-Item -Path '%TEMP%\vosk-extract\vosk-model-small-en-us-0.15' -Destination '%ATLANTISDATA%\vosk-model'"
        del /q "%TEMP%\vosk-model.zip" >nul 2>nul
        rmdir /s /q "%TEMP%\vosk-extract" >nul 2>nul
    )
)

echo.
echo [7/8] Creating one-click Desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$desk=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut((Join-Path $desk 'Atlantis.lnk')); $s.TargetPath='wscript.exe'; $s.Arguments='\"%INSTALLTO%\Launch_Atlantis.vbs\"'; $s.WorkingDirectory='%INSTALLTO%'; $s.Description='Atlantis Personal AI'; $s.Save()"
if errorlevel 1 goto :failpause

echo.
echo ============================================================
echo               SETUP COMPLETE -- READY TO RUN
echo ============================================================
echo.
echo Installed to: %INSTALLTO%
echo A shortcut named "Atlantis" is now on your Desktop -- use that from
echo now on and skip this file entirely.
echo.
echo Before Atlantis can read/write files or launch apps for you, open the
echo app and add at least one folder under Settings -^> File Access, and any
echo apps you want it able to launch under Settings -^> Apps. Nothing is
echo accessible until you add it there on purpose.
echo.
choice /c YN /m "[8/8] Run Atlantis now"
if errorlevel 2 goto :skiprun
start "" wscript.exe "%INSTALLTO%\Launch_Atlantis.vbs"
:skiprun
echo.
pause
exit /b 0

:failpause
echo.
echo Setup stopped before finishing. Nothing was left half-broken --
echo you can safely re-run this file to pick up where it left off.
echo.
pause
exit /b 1
