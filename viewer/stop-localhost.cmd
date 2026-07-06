@echo off
set PORT=%1
if "%PORT%"=="" set PORT=3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)
