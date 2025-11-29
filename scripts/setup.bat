@echo off
REM ============================================
REM WhatsApp Multi-Docker Automation System
REM Setup Script for Windows
REM ============================================

echo ============================================
echo WhatsApp Multi-Docker Automation System
echo Setup Script
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

REM Check Docker
echo Checking prerequisites...
echo.

docker --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Docker is not installed or not in PATH
    echo Please install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/
    exit /b 1
)
echo   Docker: OK

docker-compose --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    docker compose version >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Docker Compose is not installed
        exit /b 1
    )
)
echo   Docker Compose: OK

docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Docker daemon is not running
    echo Please start Docker Desktop
    exit /b 1
)
echo   Docker Daemon: Running
echo.

REM Create directories
echo Creating directories...
if not exist "%PROJECT_DIR%\data\postgres" mkdir "%PROJECT_DIR%\data\postgres"
if not exist "%PROJECT_DIR%\data\redis" mkdir "%PROJECT_DIR%\data\redis"
if not exist "%PROJECT_DIR%\data\sessions\worker-1" mkdir "%PROJECT_DIR%\data\sessions\worker-1"
if not exist "%PROJECT_DIR%\data\sessions\worker-2" mkdir "%PROJECT_DIR%\data\sessions\worker-2"
if not exist "%PROJECT_DIR%\data\sessions\worker-3" mkdir "%PROJECT_DIR%\data\sessions\worker-3"
if not exist "%PROJECT_DIR%\data\qrcodes" mkdir "%PROJECT_DIR%\data\qrcodes"
if not exist "%PROJECT_DIR%\data\logs" mkdir "%PROJECT_DIR%\data\logs"
echo   Directories created
echo.

REM Copy environment files
echo Setting up environment files...

if not exist "%PROJECT_DIR%\docker\.env" (
    if exist "%PROJECT_DIR%\docker\env.template" (
        copy "%PROJECT_DIR%\docker\env.template" "%PROJECT_DIR%\docker\.env" >nul
        echo   Created docker/.env
    )
) else (
    echo   docker/.env already exists
)

if not exist "%PROJECT_DIR%\master-server\.env" (
    if exist "%PROJECT_DIR%\master-server\env.template" (
        copy "%PROJECT_DIR%\master-server\env.template" "%PROJECT_DIR%\master-server\.env" >nul
        echo   Created master-server/.env
    )
) else (
    echo   master-server/.env already exists
)

if not exist "%PROJECT_DIR%\worker\.env" (
    if exist "%PROJECT_DIR%\worker\env.template" (
        copy "%PROJECT_DIR%\worker\env.template" "%PROJECT_DIR%\worker\.env" >nul
        echo   Created worker/.env
    )
) else (
    echo   worker/.env already exists
)

echo.
echo ============================================
echo Setup completed successfully!
echo ============================================
echo.
echo Next steps:
echo   1. Review and update docker/.env
echo   2. Run: scripts\start.bat
echo.
pause

