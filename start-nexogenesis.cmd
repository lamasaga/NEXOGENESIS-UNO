@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem The upstream dsh.cmd is resolved by PowerShell; never inherit its shared home.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-nexogenesis.ps1" %*
set "NEXO_EXIT_CODE=%ERRORLEVEL%"
if not "%NEXO_EXIT_CODE%"=="0" pause
endlocal & exit /b %NEXO_EXIT_CODE%
