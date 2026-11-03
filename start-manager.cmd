@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Arena Manager
node arena-manager.mjs --open
if errorlevel 1 (
  echo.
  echo Failed to start. Make sure Node.js 22+ is installed and on PATH.
  pause
)