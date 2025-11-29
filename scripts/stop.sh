#!/bin/bash

# ============================================
# WhatsApp Multi-Docker Automation System
# Stop Script
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
echo -e "${BLUE}Stopping Services${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Change to docker directory
cd "$PROJECT_DIR/docker"

# Parse arguments
REMOVE_VOLUMES=false
REMOVE_IMAGES=false
SERVICE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --volumes|-v)
            REMOVE_VOLUMES=true
            shift
            ;;
        --images|-i)
            REMOVE_IMAGES=true
            shift
            ;;
        --service|-s)
            SERVICE="$2"
            shift 2
            ;;
        --all|-a)
            REMOVE_VOLUMES=true
            REMOVE_IMAGES=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --volumes, -v    Remove volumes (WARNING: deletes all data)"
            echo "  --images, -i     Remove images"
            echo "  --service, -s    Stop specific service only"
            echo "  --all, -a        Remove volumes and images"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Stop services
if [ -n "$SERVICE" ]; then
    echo -e "${YELLOW}Stopping service: $SERVICE${NC}"
    docker-compose stop $SERVICE
    docker-compose rm -f $SERVICE
else
    echo -e "${YELLOW}Stopping all services...${NC}"
    docker-compose down
fi

# Remove volumes if requested
if [ "$REMOVE_VOLUMES" = true ]; then
    echo ""
    echo -e "${RED}WARNING: This will delete all data including:${NC}"
    echo -e "${RED}  - PostgreSQL database${NC}"
    echo -e "${RED}  - Redis cache${NC}"
    echo -e "${RED}  - WhatsApp sessions${NC}"
    echo ""
    read -p "Are you sure? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Removing volumes...${NC}"
        docker-compose down -v
        echo -e "${GREEN}Volumes removed.${NC}"
    else
        echo -e "${BLUE}Volumes preserved.${NC}"
    fi
fi

# Remove images if requested
if [ "$REMOVE_IMAGES" = true ]; then
    echo ""
    echo -e "${YELLOW}Removing images...${NC}"
    docker-compose down --rmi local
    echo -e "${GREEN}Images removed.${NC}"
fi

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Services stopped successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "To start again: ${BLUE}./scripts/start.sh${NC}"
echo -e "To rebuild:     ${BLUE}./scripts/start.sh --build${NC}"

