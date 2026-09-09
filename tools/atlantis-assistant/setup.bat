@echo off
setlocal EnableExtensions
title Atlantis Setup
color 0B

echo ============================================================
echo                     ATLANTIS SETUP
echo ============================================================
echo.
echo Run this ONCE. It will, in order:
echo   1. Install Python if needed (via winget)
echo   2. Create a virtual environment here and install requirements
echo   3. Install the Playwright browser used for browser automation
echo   4. Install Ollama if needed (via winget) and pull the local AI model
echo   5. Download a small, fully offline voice-recognition model (~40 MB)
echo   6. Create a one-click "Atlantis" shortcut on your Desktop
echo.
echo Everything downloaded here comes from the official sources below --
echo nothing is hidden or embedded in this file, so you can read every
echo step above and below before running it.
echo   Python:      https://www.python.org        (via winget)
echo   Ollama:      https://ollama.com             (via winget)
echo   Playwright:  https://playwright.dev
echo   Voice model: https://alphacephei.com/vosk/models
echo.
pause

set "HERE=%~dp0"
set "ATLANTISDATA=%USERPROFILE%\.atlantis"
if not exist "%ATLANTISDATA%" mkdir "%ATLANTISDATA%"

echo.
echo [1/6] Checking Python...
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
echo [2/6] Creating virtual environment and installing requirements...
%PYEXE% -m venv "%HERE%.venv"
if errorlevel 1 goto :failpause
call "%HERE%.venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r "%HERE%requirements.txt"
if errorlevel 1 goto :failpause

echo.
echo [3/6] Installing the Playwright browser (used for browser automation)...
python -m playwright install chromium
if errorlevel 1 (
    echo Playwright browser install did not finish. Browser features will not
    echo work until this succeeds; everything else will still run. You can
    echo retry later by running: python -m playwright install chromium
)

echo.
echo [4/6] Checking Ollama...
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
echo [5/6] Downloading offline voice-recognition model (about 40 MB)...
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
echo [6/6] Creating one-click Desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$desk=[Environment]::GetFolderPath('Desktop'); $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut((Join-Path $desk 'Atlantis.lnk')); $s.TargetPath='wscript.exe'; $s.Arguments='\"%HERE%Launch_Atlantis.vbs\"'; $s.WorkingDirectory='%HERE%'; $s.Description='Atlantis Personal AI'; $s.Save()"
if errorlevel 1 goto :failpause

echo.
echo ============================================================
echo                      SETUP COMPLETE
echo ============================================================
echo.
echo Double-click the "Atlantis" icon on your Desktop any time from now on --
echo it starts Ollama and Atlantis together and opens the app window, with
echo no other steps needed.
echo.
echo Before Atlantis can read/write files or launch apps for you, open the
echo app and add at least one folder under Settings -^> File Access, and any
echo apps you want it able to launch under Settings -^> Apps. Nothing is
echo accessible until you do that on purpose.
echo.
echo Launching Atlantis now...
start "" wscript.exe "%HERE%Launch_Atlantis.vbs"
timeout /t 2 /nobreak >nul
exit /b 0

:failpause
echo.
echo Setup stopped before finishing. Nothing was left half-broken --
echo you can safely re-run this file to pick up where it left off.
echo.
pause
exit /b 1
