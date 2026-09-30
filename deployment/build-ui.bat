@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
set "SDK_DIR=%APP_DIR%\app\sdk\master\js"
set "UI_DIR=%APP_DIR%\app\ui"
set "ARTIFACT_PATH=%~dp0caemble.tar.gz"

pushd "%APP_DIR%"
if errorlevel 1 exit /b 1

echo [1/3] Installing JavaScript SDK dependencies
cd /d "%SDK_DIR%"
call npm ci --no-fund || goto :fail

echo [2/3] Installing UI dependencies
cd /d "%UI_DIR%"
call npm ci --no-fund || goto :fail

echo [3/3] Building production UI, CLI, and evaluation runtime
set "VITE_API_BASE_URL=/api"
set "VITE_CAEMBLE_HOST_ORIGIN=https://www.caemble.com"
set "VITE_CAEMBLE_RUNNER_ORIGIN=https://code-to-cad.caemble.com"
call npm run build || goto :fail

echo.
echo Build complete.
echo Unified release: %ARTIFACT_PATH%
echo Local CLI: %UI_DIR%\dist-cli\caemble.cjs

popd
exit /b 0

:fail
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Build failed.
popd
exit /b %BUILD_EXIT_CODE%
