#!/bin/bash
# Check if tables exist in database

echo "📊 Checking database tables..."

docker compose exec -T postgres psql -U whatsapp -d whatsapp_automation -c "\dt"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📋 Checking message_queue table..."
docker compose exec -T postgres psql -U whatsapp -d whatsapp_automation -c "SELECT COUNT(*) FROM message_queue;"

echo ""
echo "📋 Checking chat_history table..."
docker compose exec -T postgres psql -U whatsapp -d whatsapp_automation -c "SELECT COUNT(*) FROM chat_history;"

