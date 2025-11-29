@echo off
REM ============================================
REM WhatsApp Multi-Docker Automation System
REM Start Script for Windows
REM ============================================

echo ============================================
echo WhatsApp Multi-Docker Automation System
echo Starting Services...
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

cd /d "%PROJECT_DIR%\docker"

REM Check if .env exists
if not exist ".env" (
    echo No .env file found. Copying from template...
    if exist "env.template" (
        copy "env.template" ".env" >nul
        echo Created .env from template
    ) else (
        echo ERROR: No env.template found. Run setup.bat first.
        pause
        exit /b 1
    )
)

REM Parse arguments
set BUILD=
set LOGS=

:parse_args
if "%~1"=="" goto start_services
if /i "%~1"=="--build" set BUILD=--build
if /i "%~1"=="-b" set BUILD=--build
if /i "%~1"=="--logs" set LOGS=1
if /i "%~1"=="-l" set LOGS=1
shift
goto parse_args

:start_services
echo Starting Docker Compose services...
echo.

docker-compose up -d %BUILD%

if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Failed to start services
    pause
    exit /b 1
)

echo.
echo Waiting for services to be healthy...
echo.

REM Wait a bit for services to start
timeout /t 10 /nobreak >nul

echo Checking service status...
docker-compose ps

echo.
echo ============================================
echo Services started!
echo ============================================
echo.
echo Available at:
echo   Master API:    http://localhost:5000
echo   Worker 1 (US): http://localhost:3001
echo   Worker 2 (IL): http://localhost:3002
echo   Worker 3 (GB): http://localhost:3003
echo   PostgreSQL:    localhost:5432
echo   Redis:         localhost:6379
echo.

if defined LOGS (
    echo Following logs... Press Ctrl+C to stop
    docker-compose logs -f
) else (
    echo To view logs: scripts\logs.bat
    echo To stop:      scripts\stop.bat
    echo.
    pause
)

