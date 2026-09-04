@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "APP_DIR=%%~fI"
set "SDK_DIR=%APP_DIR%\app\sdk\master\js"
set "UI_DIR=%APP_DIR%\app\ui"
set "ARTIFACT_PATH=%~dp0caemble-ui.tar.gz"

if exist "%ARTIFACT_PATH%" del /f /q "%ARTIFACT_PATH%"

pushd "%APP_DIR%"
if errorlevel 1 exit /b 1

echo [1/5] Installing JavaScript SDK dependencies
cd /d "%SDK_DIR%"
call npm ci --no-fund || goto :fail

echo [2/5] Building JavaScript SDK
call npm run build || goto :fail

echo [3/5] Installing UI dependencies
cd /d "%UI_DIR%"
call npm ci --no-fund || goto :fail

echo [4/5] Building production UI
set "VITE_API_BASE_URL=/api"
set "VITE_CAEMBLE_HOST_ORIGIN=https://www.caemble.com"
set "VITE_CAEMBLE_RUNNER_ORIGIN=https://code-to-cad.caemble.com"
call npm run build || goto :fail

echo [5/5] Creating deployment artifact
tar -C "%UI_DIR%\dist" -czf "%ARTIFACT_PATH%" . || goto :fail

echo.
echo Build complete.
echo Artifact: %ARTIFACT_PATH%

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
