#!/bin/bash

# ============================================
# Generate Workers Script
# Creates one worker per account for maximum parallelization
# ============================================
# Usage:
#   ./generate-workers.sh 30
#   This will create 30 workers (worker-1 to worker-30)
# ============================================

NUM_WORKERS=${1:-30}
COMPOSE_FILE="docker-compose.yml"
TEMP_FILE="docker-compose.tmp.yml"

echo "🔧 Generating $NUM_WORKERS workers..."

# Read the original docker-compose.yml
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ Error: $COMPOSE_FILE not found!"
    exit 1
fi

# Create a backup
cp "$COMPOSE_FILE" "${COMPOSE_FILE}.backup"
echo "✅ Backup created: ${COMPOSE_FILE}.backup"

# Extract the worker template (worker-1)
WORKER_TEMPLATE=$(sed -n '/worker-1:/,/worker-2:/p' "$COMPOSE_FILE" | head -n -1)

# Start building new compose file
cat > "$TEMP_FILE" << 'EOF'
version: '3.8'

# ============================================
# WhatsApp Multi-Docker Automation System
# AUTO-GENERATED: One worker per account
# ============================================

services:
EOF

# Copy master, postgres, redis, dashboard
sed -n '/postgres:/,/networks:/p' "$COMPOSE_FILE" | head -n -1 >> "$TEMP_FILE"

# Generate workers
for i in $(seq 1 $NUM_WORKERS); do
    PORT=$((3000 + $i))
    WORKER_ID="worker-${i}"
    CONTAINER_NAME="wa_worker_${i}"
    
    # Generate unique seed for each worker
    SEED="unique-seed-${WORKER_ID}-$(openssl rand -hex 8)"
    
    cat >> "$TEMP_FILE" << EOF

  # ============================================
  # WORKER ${i} - Account ${i}
  # ============================================
  ${WORKER_ID}:
    build:
      context: ../worker
      dockerfile: Dockerfile
    container_name: ${CONTAINER_NAME}
    env_file:
      - .env
    environment:
      WORKER_ID: \${WORKER_${i}_ID:-${WORKER_ID}}
      WORKER_PORT: 3001
      DEVICE_SEED: \${WORKER_${i}_SEED:-${SEED}}
      PROXY_COUNTRY: \${WORKER_${i}_COUNTRY:-US}
      MASTER_URL: http://master:5000
      LOG_LEVEL: \${LOG_LEVEL:-info}
      # Proxy configuration
      PROXY_HOST: \${PROXY_HOST:-}
      PROXY_PORT: \${PROXY_PORT:-}
      PROXY_USER: \${PROXY_USER:-}
      PROXY_PASS: \${WORKER_${i}_PROXY_PASS:-}
      PROXY_TYPE: \${PROXY_TYPE:-socks5}
      PROXY_LIST: \${WORKER_${i}_PROXY_LIST:-}
    volumes:
      - worker${i}_sessions:/data/sessions
      - worker${i}_qrcodes:/data/qrcodes
      - worker${i}_logs:/data/logs
    ports:
      - "${PORT}:3001"
    depends_on:
      master:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    networks:
      - wa_network
EOF
done

# Add volumes
cat >> "$TEMP_FILE" << 'EOF'

# ============================================
# VOLUMES
# ============================================
volumes:
EOF

# Copy existing volumes
sed -n '/volumes:/,/networks:/p' "$COMPOSE_FILE" | grep -E "^\s+[a-z]" | head -n -1 >> "$TEMP_FILE"

# Add new worker volumes
for i in $(seq 1 $NUM_WORKERS); do
    echo "  worker${i}_sessions:" >> "$TEMP_FILE"
    echo "    driver: local" >> "$TEMP_FILE"
    echo "  worker${i}_qrcodes:" >> "$TEMP_FILE"
    echo "    driver: local" >> "$TEMP_FILE"
    echo "  worker${i}_logs:" >> "$TEMP_FILE"
    echo "    driver: local" >> "$TEMP_FILE"
done

# Add networks
cat >> "$TEMP_FILE" << 'EOF'

# ============================================
# NETWORKS
# ============================================
networks:
  wa_network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
EOF

# Replace original file
mv "$TEMP_FILE" "$COMPOSE_FILE"

echo "✅ Generated $NUM_WORKERS workers in $COMPOSE_FILE"
echo ""
echo "📋 Next steps:"
echo "1. Update master-server/src/api/routes/accounts.js with worker URLs"
echo "2. Update master-server/src/services/QueueProcessor.js with worker list"
echo "3. Run: docker compose up -d --build"
echo ""
echo "💡 Each worker will handle ONE account for maximum parallelization!"

