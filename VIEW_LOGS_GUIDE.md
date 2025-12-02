# 📋 מדריך צפייה בלוגים

## איך לראות אם השרת מקבל בקשות API?

### 🚀 דרך מהירה (העתק והדבק)

```bash
cd ~/whatsapp_automation/docker && docker compose logs -f master
```

---

## 📊 מה תראה בלוגים?

### ✅ בקשה שהצליחה:
```
[API] 2025-01-15T10:30:45.123Z | POST /api/send | IP: 192.168.1.100 | Key: ***939
[AUTH] ✅ ACCEPTED: Valid API key | IP: 192.168.1.100 | Path: /api/send | Key: ***939
[API] ✅ POST /api/send | 200 | 150ms
```

### ❌ בקשה שנדחתה - אין API key:
```
[API] 2025-01-15T10:30:45.123Z | POST /api/send | IP: 192.168.1.100 | Key: none
[AUTH] ❌ REJECTED: No API key provided | IP: 192.168.1.100 | Path: /api/send
[API] ❌ POST /api/send | 401 | 5ms | Error: API key required
```

### ❌ בקשה שנדחתה - API key שגוי:
```
[API] 2025-01-15T10:30:45.123Z | POST /api/send | IP: 192.168.1.100 | Key: ***1234
[AUTH] ❌ REJECTED: Invalid API key | IP: 192.168.1.100 | Path: /api/send | Provided: ***1234
[API] ❌ POST /api/send | 403 | 3ms | Error: Invalid API key
```

---

## 🔍 פקודות שימושיות

### 1. לוגים בזמן אמת (הכי חשוב!)
```bash
docker compose logs -f master
```
**מה זה עושה:** מציג כל בקשה API בזמן אמת

---

### 2. רק בקשות API (פילטר)
```bash
docker compose logs -f master | grep -E "(POST|GET|PUT|DELETE|/api/)"
```
**מה זה עושה:** מציג רק בקשות API, לא לוגים אחרים

---

### 3. רק שגיאות ודחיות
```bash
docker compose logs -f master | grep -E "(❌|REJECTED|error|Error|401|403|500)"
```
**מה זה עושה:** מציג רק בקשות שנדחו או שגיאות

---

### 4. רק בקשות שהצליחו
```bash
docker compose logs -f master | grep -E "(✅|ACCEPTED|200|success)"
```
**מה זה עושה:** מציג רק בקשות שהצליחו

---

### 5. לוגים אחרונים (100 שורות)
```bash
docker compose logs --tail=100 master
```
**מה זה עושה:** מציג את 100 השורות האחרונות

---

### 6. לוגים של שעה אחרונה
```bash
docker compose logs --since 1h master
```
**מה זה עושה:** מציג לוגים משעה אחרונה

---

### 7. לוגים של כל השירותים
```bash
docker compose logs -f
```
**מה זה עושה:** מציג לוגים של כל השירותים (Master + Workers)

---

## 🎯 דוגמאות שימוש

### בדיקה מהירה - האם יש בקשות?
```bash
docker compose logs --tail=50 master | grep -E "(POST|GET|/api/)"
```

### בדיקה - כמה בקשות נדחו?
```bash
docker compose logs master | grep "REJECTED" | wc -l
```

### בדיקה - מה ה-IP של הבקשות?
```bash
docker compose logs master | grep "IP:" | tail -20
```

---

## 📝 סקריפט אוטומטי

השתמש בסקריפט המוכן:
```bash
cd ~/whatsapp_automation/docker
chmod +x VIEW_LOGS.sh
./VIEW_LOGS.sh
```

---

## 🔧 פתרון בעיות

### לא רואה לוגים?
```bash
# בדוק שהשירותים רצים
docker compose ps

# אתחל את Master
docker compose restart master

# בדוק שוב
docker compose logs -f master
```

### לוגים לא מעודכנים?
```bash
# נקה לוגים ישנים
docker compose logs --tail=0 -f master
```

---

## 📊 מה כל סימן אומר?

| סימן | משמעות |
|------|---------|
| ✅ | בקשה התקבלה/הצליחה |
| ❌ | בקשה נדחתה/נכשלה |
| ⚠️ | אזהרה (API key לא מוגדר) |
| [API] | בקשה API |
| [AUTH] | אימות API key |
| IP: | כתובת IP של השולח |
| Key: | תצוגה מקוצרת של API key |

---

## 💡 טיפים

1. **השתמש ב-`-f`** - זה מציג לוגים בזמן אמת
2. **לחץ Ctrl+C** - כדי לצאת מלוגים
3. **שמור לוגים** - אם צריך, שמור לוגים לקובץ:
   ```bash
   docker compose logs master > api_logs.txt
   ```

---

## ✅ בדיקה מהירה

```bash
# בדוק אם יש בקשות ב-5 דקות האחרונות
docker compose logs --since 5m master | grep -E "(POST|GET|/api/)"
```

