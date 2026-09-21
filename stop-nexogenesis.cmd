@echo off
setlocal EnableExtensions DisableDelayedExpansion
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-nexogenesis.ps1"
set "NEXO_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%NEXO_EXIT_CODE%"=="0" (
  echo NEXOGENESIS-UNO stop command finished.
) else (
  echo NEXOGENESIS-UNO was not stopped. Review the message above.
)
pause
endlocal & exit /b %NEXO_EXIT_CODE%
