#!/bin/bash
# Update server and view live logs of sent numbers (minimal downtime)
cd ~/whatsapp_automation/docker
echo "📥 Pulling latest code..."
git pull origin main
echo "🔨 Rebuilding master (will restart automatically)..."
docker compose up -d --build master
echo "⏳ Waiting 8 seconds for server to start..."
sleep 8
echo "🟢 Now showing live logs of sent numbers..."
docker compose logs -f master | grep --line-buffered "🟢 Sent to:" | sed 's/.*🟢 Sent to: /🟢 /'

