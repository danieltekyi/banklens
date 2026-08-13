@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PIPELINE_DIR=%~dp0"
set "PROJECT_ROOT=%~dp0.."

if not exist "%PROJECT_ROOT%\wrangler.jsonc" (
    echo ERROR: Could not find wrangler.jsonc relative to this pipeline folder.
    echo Expected: "%PROJECT_ROOT%\wrangler.jsonc"
    exit /b 1
)

if not exist "%PIPELINE_DIR%requirements.txt" (
    echo ERROR: requirements.txt is missing from "%PIPELINE_DIR%"
    exit /b 1
)

if not exist "%PIPELINE_DIR%.venv\Scripts\python.exe" (
    echo Creating BankLens Python virtual environment...
    python -m venv "%PIPELINE_DIR%.venv"
    if errorlevel 1 exit /b %errorlevel%
)

call "%PIPELINE_DIR%.venv\Scripts\activate.bat"
if errorlevel 1 exit /b %errorlevel%

python -m pip install --disable-pip-version-check -r "%PIPELINE_DIR%requirements.txt"
if errorlevel 1 exit /b %errorlevel%

python "%PIPELINE_DIR%banklens_wrangle.py" --project-root "%PROJECT_ROOT%" %*
if errorlevel 1 exit /b %errorlevel%

endlocal
