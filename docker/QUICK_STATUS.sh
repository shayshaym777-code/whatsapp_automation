#!/bin/bash
# Quick status check

echo "=== Master Server Status ==="
docker compose logs --tail=10 master | grep -E "(QueueProcessor|Starting|Started|📥|✅|❌|Error)" | tail -5

echo ""
echo "=== Queue Status ==="
docker compose exec -T postgres psql -U whatsapp -d whatsapp_automation -c "SELECT COUNT(*) as pending_messages FROM message_queue WHERE status = 'pending';" 2>/dev/null || echo "Database not ready"

echo ""
echo "=== Workers Status ==="
docker compose ps | grep worker

