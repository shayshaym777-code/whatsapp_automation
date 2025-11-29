@echo off
REM ============================================
REM WhatsApp Multi-Docker Automation System
REM Logs Script for Windows
REM ============================================

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

cd /d "%PROJECT_DIR%\docker"

REM Parse arguments
set SERVICE=
set LINES=100

:parse_args
if "%~1"=="" goto show_logs
if /i "%~1"=="--service" (
    set SERVICE=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="-s" (
    set SERVICE=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--lines" (
    set LINES=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="-n" (
    set LINES=%~2
    shift
    shift
    goto parse_args
)
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
REM Assume it's a service name
set SERVICE=%~1
shift
goto parse_args

:show_help
echo Usage: logs.bat [options] [service]
echo.
echo Options:
echo   --service, -s SERVICE  View logs for specific service
echo   --lines, -n NUMBER     Number of lines to show (default: 100)
echo   --help, -h             Show this help
echo.
echo Services: master, worker-1, worker-2, worker-3, postgres, redis
exit /b 0

:show_logs
echo Following logs (Ctrl+C to stop)...
echo.

if defined SERVICE (
    docker-compose logs -f --tail=%LINES% %SERVICE%
) else (
    docker-compose logs -f --tail=%LINES%
)

