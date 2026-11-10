@echo off
chcp 65001 >nul
title Mineflayer Bot
set /p "BOT_USERNAME=Username: "
set /p "MC_HOST=IP server: "

if "%BOT_USERNAME%"=="" (
    echo.
    echo [ERROR] Username is required.
    pause
    exit /b 1
)

if "%MC_HOST%"=="" (
    echo.
    echo [ERROR] IP server is required.
    pause
    exit /b 1
)

set "MC_PORT=25565"

echo.
echo Port: 25565 (automatic)
if not exist "node_modules" (
    echo.
    echo Installing packages...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)
echo.
echo Building optimized production runtime...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] build failed.
    pause
    exit /b 1
)
echo.
echo Starting bot...
echo Account: %BOT_USERNAME%
echo Server : %MC_HOST%:%MC_PORT%
echo.
call npm run start:prod -- "%BOT_USERNAME%" "%MC_HOST%"
pause
