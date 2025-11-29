#!/bin/bash

# ============================================
# WhatsApp Multi-Docker Automation System
# Logs Script
# ============================================

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to docker directory
cd "$PROJECT_DIR/docker"

# Parse arguments
SERVICE=""
LINES=100
FOLLOW=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --service|-s)
            SERVICE="$2"
            shift 2
            ;;
        --lines|-n)
            LINES="$2"
            shift 2
            ;;
        --no-follow)
            FOLLOW=false
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --service, -s    View logs for specific service (master, worker-1, worker-2, worker-3, postgres, redis)"
            echo "  --lines, -n      Number of lines to show (default: 100)"
            echo "  --no-follow      Don't follow logs"
            echo "  --help, -h       Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                        # All logs, follow"
            echo "  $0 -s master              # Master logs only"
            echo "  $0 -s worker-1 -n 50      # Worker 1, last 50 lines"
            exit 0
            ;;
        *)
            # Assume it's a service name
            SERVICE="$1"
            shift
            ;;
    esac
done

# Build command
CMD="docker-compose logs"

if [ "$FOLLOW" = true ]; then
    CMD="$CMD -f"
fi

CMD="$CMD --tail=$LINES"

if [ -n "$SERVICE" ]; then
    CMD="$CMD $SERVICE"
fi

# Execute
exec $CMD

