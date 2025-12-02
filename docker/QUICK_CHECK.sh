#!/bin/bash
# Quick check if system is running

echo "=== Master Server Status ==="
docker compose ps master

echo ""
echo "=== Last 20 Master Logs ==="
docker compose logs --tail=20 master | grep -E "(QueueProcessor|Starting|Started|Error|error|📥|✅|❌)"

echo ""
echo "=== Queue Status ==="
docker compose exec -T postgres psql -U whatsapp -d whatsapp_automation -c "SELECT COUNT(*) as pending FROM message_queue WHERE status = 'pending';" 2>/dev/null || echo "Database not ready"

