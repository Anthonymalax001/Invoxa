@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-accounting-postgres-fresh.ps1"
exit /b %ERRORLEVEL%
