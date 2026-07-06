@echo off
set PORT=%1
if "%PORT%"=="" set PORT=3000
node "%~dp0server.js"
