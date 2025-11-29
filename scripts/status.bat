@echo off
REM ============================================
REM WhatsApp Multi-Docker Automation System
REM Status Script for Windows
REM ============================================

echo ============================================
echo WhatsApp Multi-Docker Automation System
echo Service Status
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..

cd /d "%PROJECT_DIR%\docker"

echo Container Status:
echo.
docker-compose ps
echo.

echo Service Health:
echo.

REM Check PostgreSQL
echo   PostgreSQL:
docker exec wa_postgres pg_isready -U whatsapp -d whatsapp_automation >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
) else (
    echo     Status: Unhealthy
)

REM Check Redis
echo   Redis:
docker exec wa_redis redis-cli ping >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
) else (
    echo     Status: Unhealthy
)

REM Check Master
echo   Master:
curl -s http://localhost:5000/health >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
    echo     URL: http://localhost:5000
) else (
    echo     Status: Unhealthy
)

REM Check Workers
echo   Worker-1 (US):
curl -s http://localhost:3001/health >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
    echo     URL: http://localhost:3001
) else (
    echo     Status: Unhealthy
)

echo   Worker-2 (IL):
curl -s http://localhost:3002/health >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
    echo     URL: http://localhost:3002
) else (
    echo     Status: Unhealthy
)

echo   Worker-3 (GB):
curl -s http://localhost:3003/health >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo     Status: Healthy
    echo     URL: http://localhost:3003
) else (
    echo     Status: Unhealthy
)

echo.
echo ============================================
pause

