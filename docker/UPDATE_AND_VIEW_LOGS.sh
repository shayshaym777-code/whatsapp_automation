#!/bin/bash
# ============================================
# WhatsApp Automation - Update Server & View Logs
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
echo "📋 מתחיל להציג לוגים של Master Server (API)..."
echo "   לחץ Ctrl+C כדי לצאת"
echo ""
echo "=========================================="
echo ""

# הצג לוגים של Master Server
docker compose logs -f master

