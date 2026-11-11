@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-accounting-postgres.ps1"
exit /b %ERRORLEVEL%
