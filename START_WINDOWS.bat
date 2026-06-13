@echo off
title The Wired 2.0 - Setup
color 0C
echo.
echo  ========================================
echo   The Wired 2.0 -- Setting up...
echo  ========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed!
    echo.
    echo  Please install Node.js from: https://nodejs.org
    echo  Download the LTS version, install it, then run this again.
    echo.
    pause
    exit /b 1
)

echo  [OK] Node.js found
echo.

:: Install dependencies
echo  Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)

echo.
echo  ========================================
echo   Starting The Wired 2.0...
echo  ========================================
echo.

:: Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set IP=%%a
    goto :found
)
:found
set IP=%IP: =%

echo  Local address:  http://localhost:3000
echo  Network (LAN):  http://%IP%:3000
echo.
echo  Share the Network address with friends on the same WiFi.
echo  For internet access, see README.md
echo.
echo  Press Ctrl+C to stop the server.
echo.

node server.js
pause
