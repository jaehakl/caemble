@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
set "SDK_DIR=%APP_DIR%\app\sdk\master\js"
set "UI_DIR=%APP_DIR%\app\ui"
set "ARTIFACT_PATH=%~dp0caemble-ui.tar.gz"

if exist "%ARTIFACT_PATH%" del /f /q "%ARTIFACT_PATH%"

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found in PATH.
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node was not found in PATH.
    exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1)"
if errorlevel 1 (
    echo WARNING: Node.js 22.13 LTS or Node.js 24 or newer is recommended.
    node --version
)

where tar >nul 2>nul
if errorlevel 1 (
    echo ERROR: tar was not found in PATH.
    exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo ERROR: powershell.exe was not found in PATH.
    exit /b 1
)

set "CAEMBLE_UI_DIR=%UI_DIR%"
powershell.exe -NoProfile -Command "$path = [regex]::Escape($env:CAEMBLE_UI_DIR); $items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $path }; if ($items) { $items | Select-Object ProcessId, CommandLine | Format-Table -AutoSize; exit 1 }"
if errorlevel 1 (
    echo ERROR: Stop the Caemble UI development server before running this build.
    exit /b 1
)

pushd "%APP_DIR%"
if errorlevel 1 (
    echo ERROR: Repository directory was not found: %APP_DIR%
    exit /b 1
)

echo [1/4] Installing JavaScript SDK dependencies
cd /d "%SDK_DIR%"
call npm ci || goto :fail

echo [2/4] Installing UI dependencies
cd /d "%UI_DIR%"
call npm ci || goto :fail

echo [3/4] Building production UI
set "VITE_API_BASE_URL=/api"
set "VITE_CAEMBLE_HOST_ORIGIN=https://www.caemble.com"
set "VITE_CAEMBLE_RUNNER_ORIGIN=https://code-to-cad.caemble.com"
set "NODE_OPTIONS=--max-old-space-size=4096"
call npm run build || goto :fail

if not exist "%UI_DIR%\dist\index.html" (
    echo ERROR: Build output is missing dist\index.html.
    goto :fail
)
if not exist "%UI_DIR%\dist\runner.html" (
    echo ERROR: Build output is missing dist\runner.html.
    goto :fail
)

echo [4/4] Creating deployment artifact
tar -C "%UI_DIR%\dist" -czf "%ARTIFACT_PATH%" . || goto :fail

set "CAEMBLE_ARTIFACT_PATH=%ARTIFACT_PATH%"
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath $env:CAEMBLE_ARTIFACT_PATH).Hash.ToLowerInvariant()"`) do set "ARTIFACT_SHA256=%%I"
if not defined ARTIFACT_SHA256 (
    echo ERROR: Could not calculate the artifact SHA256.
    goto :fail
)

echo.
echo Build complete.
echo Artifact: %ARTIFACT_PATH%
echo SHA256:  %ARTIFACT_SHA256%

popd
exit /b 0

:fail
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
if exist "%ARTIFACT_PATH%" del /f /q "%ARTIFACT_PATH%"
echo.
echo Build failed.
popd
exit /b %BUILD_EXIT_CODE%
