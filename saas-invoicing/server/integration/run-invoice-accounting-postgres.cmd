@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-invoice-accounting-postgres.ps1"
exit /b %ERRORLEVEL%
