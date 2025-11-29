#!/bin/bash

# ============================================
# WhatsApp Multi-Docker Automation System
# Setup Script
# ============================================
# This script:
#   1. Checks prerequisites (Docker, Docker Compose)
#   2. Copies env.template files to .env
#   3. Creates necessary directories
#   4. Sets proper permissions
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
echo -e "${BLUE}Setup Script${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# ============================================
# CHECK PREREQUISITES
# ============================================

echo -e "${CYAN}Checking prerequisites...${NC}"
echo ""

# Check Docker
echo -n "  Docker: "
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version | cut -d ' ' -f 3 | cut -d ',' -f 1)
    echo -e "${GREEN}✓ Installed (v$DOCKER_VERSION)${NC}"
else
    echo -e "${RED}✗ Not installed${NC}"
    echo ""
    echo -e "${RED}Docker is required. Please install Docker:${NC}"
    echo -e "  ${YELLOW}https://docs.docker.com/get-docker/${NC}"
    exit 1
fi

# Check Docker Compose
echo -n "  Docker Compose: "
if command -v docker-compose &> /dev/null; then
    COMPOSE_VERSION=$(docker-compose --version | cut -d ' ' -f 4 | cut -d ',' -f 1 2>/dev/null || docker-compose --version)
    echo -e "${GREEN}✓ Installed ($COMPOSE_VERSION)${NC}"
elif docker compose version &> /dev/null; then
    COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || echo "v2+")
    echo -e "${GREEN}✓ Installed (Docker Compose $COMPOSE_VERSION)${NC}"
else
    echo -e "${RED}✗ Not installed${NC}"
    echo ""
    echo -e "${RED}Docker Compose is required. Please install Docker Compose:${NC}"
    echo -e "  ${YELLOW}https://docs.docker.com/compose/install/${NC}"
    exit 1
fi

# Check if Docker daemon is running
echo -n "  Docker Daemon: "
if docker info &> /dev/null; then
    echo -e "${GREEN}✓ Running${NC}"
else
    echo -e "${RED}✗ Not running${NC}"
    echo ""
    echo -e "${RED}Docker daemon is not running. Please start Docker.${NC}"
    exit 1
fi

echo ""

# ============================================
# CREATE DIRECTORIES
# ============================================

echo -e "${CYAN}Creating directories...${NC}"
echo ""

# List of directories to create
DIRECTORIES=(
    "$PROJECT_DIR/data/postgres"
    "$PROJECT_DIR/data/redis"
    "$PROJECT_DIR/data/sessions/worker-1"
    "$PROJECT_DIR/data/sessions/worker-2"
    "$PROJECT_DIR/data/sessions/worker-3"
    "$PROJECT_DIR/data/qrcodes"
    "$PROJECT_DIR/data/logs"
    "$PROJECT_DIR/data/media"
)

for dir in "${DIRECTORIES[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo -e "  ${GREEN}✓${NC} Created: ${dir#$PROJECT_DIR/}"
    else
        echo -e "  ${YELLOW}○${NC} Exists:  ${dir#$PROJECT_DIR/}"
    fi
done

echo ""

# ============================================
# COPY ENVIRONMENT FILES
# ============================================

echo -e "${CYAN}Setting up environment files...${NC}"
echo ""

# Function to copy env template
copy_env_template() {
    local template="$1"
    local target="$2"
    local name="$3"
    
    if [ -f "$template" ]; then
        if [ ! -f "$target" ]; then
            cp "$template" "$target"
            echo -e "  ${GREEN}✓${NC} Created: $name"
        else
            echo -e "  ${YELLOW}○${NC} Exists:  $name (not overwritten)"
        fi
    else
        echo -e "  ${RED}✗${NC} Missing template: $template"
    fi
}

# Copy environment files
copy_env_template "$PROJECT_DIR/docker/env.template" "$PROJECT_DIR/docker/.env" "docker/.env"
copy_env_template "$PROJECT_DIR/master-server/env.template" "$PROJECT_DIR/master-server/.env" "master-server/.env"
copy_env_template "$PROJECT_DIR/worker/env.template" "$PROJECT_DIR/worker/.env" "worker/.env"

echo ""

# ============================================
# SET PERMISSIONS
# ============================================

echo -e "${CYAN}Setting permissions...${NC}"
echo ""

# Make scripts executable
chmod +x "$PROJECT_DIR/scripts/"*.sh 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Scripts made executable"

# Set data directory permissions (for Docker volumes)
chmod -R 755 "$PROJECT_DIR/data" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Data directories permissions set"

echo ""

# ============================================
# GENERATE SECURE SECRETS (Optional)
# ============================================

echo -e "${CYAN}Security recommendations...${NC}"
echo ""

# Generate random secrets suggestion
if command -v openssl &> /dev/null; then
    JWT_SECRET=$(openssl rand -hex 32)
    API_KEY=$(openssl rand -hex 24)
    
    echo -e "  ${YELLOW}!${NC} Consider updating these values in docker/.env:"
    echo ""
    echo -e "     JWT_SECRET=${JWT_SECRET}"
    echo -e "     API_KEY=${API_KEY}"
    echo ""
else
    echo -e "  ${YELLOW}!${NC} Install openssl to generate secure secrets"
fi

# ============================================
# SUMMARY
# ============================================

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}Setup completed successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Next steps:"
echo ""
echo -e "  1. ${YELLOW}Review and update environment files:${NC}"
echo -e "     - docker/.env"
echo -e "     - master-server/.env"
echo -e "     - worker/.env"
echo ""
echo -e "  2. ${YELLOW}Update security settings:${NC}"
echo -e "     - Change DB_PASSWORD from default"
echo -e "     - Set unique JWT_SECRET"
echo -e "     - Set unique API_KEY"
echo -e "     - Update DEVICE_SEED values for each worker"
echo ""
echo -e "  3. ${YELLOW}Start the system:${NC}"
echo -e "     ${BLUE}./scripts/start.sh${NC}"
echo ""
echo -e "  4. ${YELLOW}View logs:${NC}"
echo -e "     ${BLUE}./scripts/logs.sh${NC}"
echo ""
echo -e "  5. ${YELLOW}Check status:${NC}"
echo -e "     ${BLUE}./scripts/status.sh${NC}"
echo ""

