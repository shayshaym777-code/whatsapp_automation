#!/bin/bash
# Full update: Stop server, update code, rebuild, restart with logs

cd ~/whatsapp_automation/docker

echo "🛑 Stopping master server..."
docker compose stop master

echo "📥 Pulling latest code..."
git pull origin main

echo "🔨 Building and starting master server..."
docker compose up -d --build master

echo "⏳ Waiting for server to start (10 seconds)..."
sleep 10

echo "📋 Showing logs (press Ctrl+C to stop)..."
docker compose logs -f master worker-1 worker-2 worker-3 | grep -E "(📥 Received|✅ Added|📊 Contacts|⏳.*waiting|📤 Processing|✅ Sent|❌ Failed|🚨 BLOCKED|📊 Batch|✅ Campaign.*COMPLETED)" --line-buffered

