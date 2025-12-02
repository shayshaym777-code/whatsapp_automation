#!/bin/bash
# בדוק את 3 ההודעות האחרונות

echo "📊 בודק את 3 ההודעות האחרונות..."
echo ""

# בדוק את הלוגים האחרונים של Worker
docker compose logs --tail=100 worker-1 | grep -E "(📤|📥|✅|❌|SEND|Message sent|Worker response)" | tail -20

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# בדוק את הלוגים האחרונים של Master
docker compose logs --tail=100 master | grep -E "(📤|📥|✅|❌|Campaign|Sending|Worker response)" | tail -20

