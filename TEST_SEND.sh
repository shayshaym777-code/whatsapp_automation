#!/bin/bash
# ============================================
# בדיקת שליחה - הודעה למספרים מהקובץ
# ============================================

# כתובת השרת (שנה לפי הצורך)
API_URL="${API_URL:-http://localhost:5000/api/send}"
API_KEY="${API_KEY:-your-api-key-change-in-production}"

echo "🧪 בודק שליחת הודעה..."
echo "API URL: $API_URL"
echo ""

# המספרים מהקובץ
CONTACTS='[
  {"phone": "+972502920643", "name": ""},
  {"phone": "+972559786598", "name": ""},
  {"phone": "+972509456568", "name": ""}
]'

# ההודעה
MESSAGE="היי מה נשמע"

echo "📤 שולח הודעה ל-3 מספרים..."
echo "הודעה: $MESSAGE"
echo ""

# שליחת הבקשה
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{
    \"contacts\": $CONTACTS,
    \"message\": \"$MESSAGE\"
  }")

# הפרדת תשובה וסטטוס
HTTP_BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')
HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)

echo "📥 תשובה מהשרת:"
echo "HTTP Status: $HTTP_STATUS"
echo ""
echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ הבקשה הצליחה!"
    CAMPAIGN_ID=$(echo "$HTTP_BODY" | jq -r '.campaign_id' 2>/dev/null)
    if [ -n "$CAMPAIGN_ID" ]; then
        echo "📋 Campaign ID: $CAMPAIGN_ID"
        echo ""
        echo "💡 לבדוק סטטוס:"
        echo "   curl $API_URL/../campaigns/$CAMPAIGN_ID/status"
    fi
else
    echo "❌ הבקשה נכשלה!"
    echo "בדוק את הלוגים: docker compose logs -f master"
fi

