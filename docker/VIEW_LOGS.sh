#!/bin/bash
# ============================================
# WhatsApp Automation - View Logs Script
# צפייה בלוגים של כל השירותים
# ============================================

echo "📋 לוגים של WhatsApp Automation"
echo "=================================="
echo ""
echo "בחר איזה לוגים לראות:"
echo ""
echo "1) Master Server (API) - לראות בקשות API"
echo "2) Worker 1 (ישראל) - לראות שליחות"
echo "3) Worker 2 (ארה\"ב) - לראות שליחות"
echo "4) Worker 3 (ארה\"ב) - לראות שליחות"
echo "5) כל הלוגים ביחד"
echo "6) רק בקשות API (Master) - פילטר"
echo ""
read -p "בחר אפשרות (1-6): " choice

cd ~/whatsapp_automation/docker || exit

case $choice in
    1)
        echo ""
        echo "📊 לוגים של Master Server (API)..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f master
        ;;
    2)
        echo ""
        echo "📊 לוגים של Worker 1 (ישראל)..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f worker-1
        ;;
    3)
        echo ""
        echo "📊 לוגים של Worker 2 (ארה\"ב)..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f worker-2
        ;;
    4)
        echo ""
        echo "📊 לוגים של Worker 3 (ארה\"ב)..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f worker-3
        ;;
    5)
        echo ""
        echo "📊 כל הלוגים ביחד..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f
        ;;
    6)
        echo ""
        echo "📊 בקשות API בלבד (Master)..."
        echo "לחץ Ctrl+C כדי לצאת"
        echo ""
        docker compose logs -f master | grep -E "(POST|GET|PUT|DELETE|api|API|error|Error|401|403|500)"
        ;;
    *)
        echo "❌ אפשרות לא תקינה"
        exit 1
        ;;
esac

