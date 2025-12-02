#!/bin/bash

# ============================================
# Setup 30 Workers - One Worker Per Account
# ============================================
# This script sets up 30 workers, each handling ONE account
# Maximum parallelization: 30 accounts × 15 msg/min = 450 msg/min
# ============================================

set -e

NUM_WORKERS=30
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Setting up $NUM_WORKERS workers (one per account)..."
echo ""

# Step 1: Generate docker-compose.yml with 30 workers
echo "📝 Step 1: Generating docker-compose.yml..."
if [ -f "generate-workers.sh" ]; then
    chmod +x generate-workers.sh
    ./generate-workers.sh $NUM_WORKERS
else
    echo "⚠️  generate-workers.sh not found, creating workers manually..."
    # You can manually edit docker-compose.yml or use the script
fi

# Step 2: Update .env file with worker URLs
echo "📝 Step 2: Updating .env file..."
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found, creating from template..."
    cp env.template .env 2>/dev/null || echo "# Worker Configuration" > .env
fi

# Add WORKER_COUNT to .env
if ! grep -q "WORKER_COUNT" .env; then
    echo "" >> .env
    echo "# ============================================" >> .env
    echo "# WORKER COUNT" >> .env
    echo "# ============================================" >> .env
    echo "WORKER_COUNT=$NUM_WORKERS" >> .env
fi

# Add worker URLs to .env
for i in $(seq 1 $NUM_WORKERS); do
    WORKER_URL_VAR="WORKER_${i}_URL"
    WORKER_URL="http://worker-${i}:3001"
    
    if ! grep -q "$WORKER_URL_VAR" .env; then
        echo "${WORKER_URL_VAR}=${WORKER_URL}" >> .env
    else
        # Update existing
        sed -i "s|^${WORKER_URL_VAR}=.*|${WORKER_URL_VAR}=${WORKER_URL}|" .env
    fi
done

echo "✅ Updated .env with $NUM_WORKERS worker URLs"

# Step 3: Update master server environment
echo "📝 Step 3: Updating master server configuration..."
# The master server will auto-detect workers from WORKER_N_URL env vars

# Step 4: Build and start
echo ""
echo "🔨 Step 4: Building and starting services..."
echo "   This may take a few minutes..."
echo ""

# Build master first (it needs to know about workers)
echo "Building master server..."
docker compose build master

# Build all workers
echo "Building $NUM_WORKERS workers..."
docker compose build --parallel

# Start services
echo "Starting services..."
docker compose up -d

# Wait for services to be healthy
echo ""
echo "⏳ Waiting for services to be healthy..."
sleep 10

# Check status
echo ""
echo "📊 Service Status:"
docker compose ps

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Summary:"
echo "   - $NUM_WORKERS workers created (one per account)"
echo "   - Each worker can send 15 messages/minute"
echo "   - Total capacity: $((NUM_WORKERS * 15)) messages/minute"
echo ""
echo "🔍 Check logs:"
echo "   docker compose logs -f master"
echo "   docker compose logs -f worker-1"
echo ""
echo "💡 To add more workers later:"
echo "   1. Update WORKER_COUNT in .env"
echo "   2. Add WORKER_N_URL entries"
echo "   3. Run: docker compose up -d --build"

