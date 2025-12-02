#!/bin/bash
# ============================================
# WhatsApp Automation - Server Update Script
# העתק והדבק את כל הקובץ הזה בשרת
# ============================================

echo "🚀 מתחיל עדכון השרת..."

# עבור לתיקיית הפרויקט
cd ~/whatsapp_automation/docker || exit

echo "📥 מושך שינויים חדשים..."
git pull origin main

echo "📋 בודק קובץ .env..."
if [ ! -f .env ]; then
    echo "⚠️  קובץ .env לא קיים - יוצר מהטמפלייט..."
    cp env.template .env
    echo "✅ קובץ .env נוצר - עדכן את ההגדרות!"
else
    echo "✅ קובץ .env קיים"
fi

echo "🛑 עוצר את כל השירותים..."
docker compose down

echo "🔨 בונה ומריץ מחדש..."
docker compose up -d --build

echo "⏳ מחכה 10 שניות לשירותים להתחיל..."
sleep 10

echo "📊 בודק סטטוס שירותים..."
docker compose ps

echo ""
echo "✅ עדכון הושלם!"
echo ""
echo "📝 פקודות שימושיות:"
echo "   docker compose logs -f master      # לוגים של Master"
echo "   docker compose logs -f worker-1   # לוגים של Worker 1 (ישראל)"
echo "   docker compose logs -f worker-2   # לוגים של Worker 2 (ארה\"ב)"
echo "   docker compose logs -f worker-3   # לוגים של Worker 3 (ארה\"ב)"
echo ""
echo "🌐 כתובות:"
echo "   Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
echo "   API: http://$(hostname -I | awk '{print $1}'):5000"
echo ""

