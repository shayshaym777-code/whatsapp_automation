@echo off
REM ============================================
REM WhatsApp Multi-Docker Automation System
REM Stop Script for Windows
REM ============================================

echo ============================================
echo WhatsApp Multi-Docker Automation System
echo Stopping Services...
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

cd /d "%PROJECT_DIR%\docker"

REM Parse arguments
set VOLUMES=
set IMAGES=

:parse_args
if "%~1"=="" goto stop_services
if /i "%~1"=="--volumes" set VOLUMES=-v
if /i "%~1"=="-v" set VOLUMES=-v
if /i "%~1"=="--images" set IMAGES=--rmi local
if /i "%~1"=="-i" set IMAGES=--rmi local
if /i "%~1"=="--all" (
    set VOLUMES=-v
    set IMAGES=--rmi local
)
shift
goto parse_args

:stop_services
if defined VOLUMES (
    echo WARNING: This will delete all data including:
    echo   - PostgreSQL database
    echo   - Redis cache
    echo   - WhatsApp sessions
    echo.
    set /p CONFIRM="Are you sure? (y/N): "
    if /i not "%CONFIRM%"=="y" (
        echo Cancelled.
        pause
        exit /b 0
    )
)

echo Stopping services...
docker-compose down %VOLUMES% %IMAGES%

echo.
echo ============================================
echo Services stopped!
echo ============================================
echo.
echo To start again: scripts\start.bat
pause

