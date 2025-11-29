#!/bin/bash

# ============================================
# WhatsApp Multi-Docker Automation System
# Start Script
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}WhatsApp Multi-Docker Automation System${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Change to docker directory
cd "$PROJECT_DIR/docker"

# Check if .env exists, if not copy from template
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}No .env file found in docker/ directory.${NC}"
    if [ -f "env.template" ]; then
        echo -e "${YELLOW}Copying env.template to .env...${NC}"
        cp "env.template" ".env"
        echo -e "${GREEN}Created .env file from template.${NC}"
        echo -e "${YELLOW}Please review docker/.env and update settings as needed.${NC}"
        echo ""
    else
        echo -e "${RED}Error: No env.template file found.${NC}"
        echo -e "${RED}Please run ./scripts/setup.sh first.${NC}"
        exit 1
    fi
fi

# Parse arguments
BUILD=false
DETACH=true
LOGS=false
SERVICE=""
SETUP=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --build|-b)
            BUILD=true
            shift
            ;;
        --foreground|-f)
            DETACH=false
            shift
            ;;
        --logs|-l)
            LOGS=true
            shift
            ;;
        --service|-s)
            SERVICE="$2"
            shift 2
            ;;
        --setup)
            SETUP=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --build, -b       Rebuild images before starting"
            echo "  --foreground, -f  Run in foreground (don't detach)"
            echo "  --logs, -l        Follow logs after starting"
            echo "  --service, -s     Start specific service only"
            echo "  --setup           Run setup script first"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Run setup if requested
if [ "$SETUP" = true ]; then
    echo -e "${YELLOW}Running setup script...${NC}"
    "$SCRIPT_DIR/setup.sh"
    echo ""
fi

# Build command
CMD="docker-compose"
ARGS=""

if [ "$BUILD" = true ]; then
    echo -e "${YELLOW}Building images...${NC}"
    ARGS="$ARGS --build"
fi

if [ "$DETACH" = true ]; then
    ARGS="$ARGS -d"
fi

# Start services
echo -e "${GREEN}Starting services...${NC}"
echo ""

if [ -n "$SERVICE" ]; then
    echo -e "${BLUE}Starting service: $SERVICE${NC}"
    $CMD up $ARGS $SERVICE
else
    echo -e "${BLUE}Starting all services...${NC}"
    $CMD up $ARGS
fi

# Wait for services to be healthy
if [ "$DETACH" = true ]; then
    echo ""
    echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
    
    # Wait for postgres
    echo -n "  PostgreSQL: "
    for i in {1..30}; do
        if docker exec wa_postgres pg_isready -U whatsapp -d whatsapp_automation > /dev/null 2>&1; then
            echo -e "${GREEN}Ready${NC}"
            break
        fi
        if [ $i -eq 30 ]; then
            echo -e "${RED}Timeout${NC}"
        fi
        sleep 1
        echo -n "."
    done
    
    # Wait for redis
    echo -n "  Redis: "
    for i in {1..30}; do
        if docker exec wa_redis redis-cli ping > /dev/null 2>&1; then
            echo -e "${GREEN}Ready${NC}"
            break
        fi
        if [ $i -eq 30 ]; then
            echo -e "${RED}Timeout${NC}"
        fi
        sleep 1
        echo -n "."
    done
    
    # Wait for master
    echo -n "  Master: "
    for i in {1..60}; do
        if curl -s http://localhost:5000/health > /dev/null 2>&1; then
            echo -e "${GREEN}Ready${NC}"
            break
        fi
        if [ $i -eq 60 ]; then
            echo -e "${RED}Timeout${NC}"
        fi
        sleep 1
        echo -n "."
    done
    
    # Wait for workers
    for port in 3001 3002 3003; do
        worker_num=$((port - 3000))
        echo -n "  Worker-$worker_num: "
        for i in {1..60}; do
            if curl -s http://localhost:$port/health > /dev/null 2>&1; then
                echo -e "${GREEN}Ready${NC}"
                break
            fi
            if [ $i -eq 60 ]; then
                echo -e "${RED}Timeout${NC}"
            fi
            sleep 1
            echo -n "."
        done
    done
    
    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}All services started successfully!${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo -e "Services available at:"
    echo -e "  ${BLUE}Master API:${NC}    http://localhost:5000"
    echo -e "  ${BLUE}Worker 1 (US):${NC} http://localhost:3001"
    echo -e "  ${BLUE}Worker 2 (IL):${NC} http://localhost:3002"
    echo -e "  ${BLUE}Worker 3 (GB):${NC} http://localhost:3003"
    echo -e "  ${BLUE}PostgreSQL:${NC}    localhost:5432"
    echo -e "  ${BLUE}Redis:${NC}         localhost:6379"
    echo ""
    echo -e "Useful commands:"
    echo -e "  ${YELLOW}./scripts/status.sh${NC}  # Check service status"
    echo -e "  ${YELLOW}./scripts/logs.sh${NC}    # View logs"
    echo -e "  ${YELLOW}./scripts/stop.sh${NC}    # Stop all services"
    echo ""
    
    # Follow logs if requested
    if [ "$LOGS" = true ]; then
        echo -e "${BLUE}Following logs...${NC}"
        $CMD logs -f
    fi
fi
