@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-mpesa-postgres.ps1"
exit /b %ERRORLEVEL%
