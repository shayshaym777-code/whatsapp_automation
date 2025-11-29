#!/bin/bash

# ============================================
# WhatsApp Multi-Docker Automation System
# Status Script
# ============================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}WhatsApp Multi-Docker Automation System${NC}"
echo -e "${BLUE}Service Status${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Change to docker directory
cd "$PROJECT_DIR/docker"

# Show container status
echo -e "${CYAN}Container Status:${NC}"
echo ""
docker-compose ps
echo ""

# Check individual services
echo -e "${CYAN}Service Health:${NC}"
echo ""

# PostgreSQL
echo -n "  PostgreSQL:  "
if docker exec wa_postgres pg_isready -U whatsapp -d whatsapp_automation > /dev/null 2>&1; then
    echo -e "${GREEN}● Healthy${NC}"
else
    echo -e "${RED}● Unhealthy${NC}"
fi

# Redis
echo -n "  Redis:       "
if docker exec wa_redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}● Healthy${NC}"
else
    echo -e "${RED}● Unhealthy${NC}"
fi

# Master
echo -n "  Master:      "
if curl -s http://localhost:5000/health > /dev/null 2>&1; then
    echo -e "${GREEN}● Healthy${NC}"
    MASTER_HEALTH=$(curl -s http://localhost:5000/health 2>/dev/null || echo "{}")
    echo -e "               ${YELLOW}$MASTER_HEALTH${NC}"
else
    echo -e "${RED}● Unhealthy${NC}"
fi

# Workers
for port in 3001 3002 3003; do
    worker_num=$((port - 3000))
    echo -n "  Worker-$worker_num:    "
    if curl -s http://localhost:$port/health > /dev/null 2>&1; then
        echo -e "${GREEN}● Healthy${NC}"
        WORKER_HEALTH=$(curl -s http://localhost:$port/health 2>/dev/null | head -c 200 || echo "{}")
        echo -e "               ${YELLOW}$WORKER_HEALTH${NC}"
    else
        echo -e "${RED}● Unhealthy${NC}"
    fi
done

echo ""
echo -e "${CYAN}Resource Usage:${NC}"
echo ""
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>/dev/null | grep -E "(NAME|wa_)" || echo "  Unable to get stats"

echo ""
echo -e "${BLUE}============================================${NC}"

