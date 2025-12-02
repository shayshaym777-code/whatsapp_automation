#!/bin/bash
# ============================================
# בדיקת בקשות API ושליחות
# מציג לוגים של Master + Workers יחד
# ============================================

echo "🔍 בודק בקשות API ושליחות..."
echo "לחץ Ctrl+C כדי לצאת"
echo ""
echo "=========================================="
echo ""

# הצג לוגים של כל השירותים יחד
docker compose logs -f master worker-1 worker-2 | grep -E "(API|POST|GET|/api/send|Campaign|📤|📥|✅|❌|SEND|Error|not logged|not connected|AUTH)"

