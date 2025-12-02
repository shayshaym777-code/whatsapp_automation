# 🔐 הגדרות API - הסבר

## מה הם שני הערכים האלה?

### 1. **EXTERNAL_API_URL**
```
http://130.94.113.203:5000
```

**מה זה?**
- זה הכתובת הציבורית של ה-Master Server API שלך
- זה ה-URL שהאתר החיצוני צריך להשתמש בו כדי לשלוח בקשות

**איפה זה מוגדר?**
- בקובץ `.env` בשרת: `EXTERNAL_API_URL=http://130.94.113.203:5000`
- או ישירות בקוד של האתר החיצוני

**דוגמה לשימוש:**
```bash
curl http://130.94.113.203:5000/api/send \
  -H "X-API-Key: 8a229939..." \
  -H "Content-Type: application/json" \
  -d '{"contacts": [...], "message": "Hello"}'
```

---

### 2. **EXTERNAL_API_KEY**
```
8a229939...
```

**מה זה?**
- זה מפתח API לאימות בקשות
- כל בקשה חייבת לכלול את המפתח הזה ב-header

**איפה זה מוגדר?**
- בקובץ `.env` בשרת: `API_KEY=8a229939...`
- האתר החיצוני צריך להשתמש באותו מפתח

**איך להשתמש?**
יש שתי אפשרויות:

**אפשרות 1: X-API-Key header**
```bash
curl -H "X-API-Key: 8a229939..." http://130.94.113.203:5000/api/send
```

**אפשרות 2: Authorization Bearer**
```bash
curl -H "Authorization: Bearer 8a229939..." http://130.94.113.203:5000/api/send
```

---

## 🔧 הגדרה בשרת

### שלב 1: עדכן את `.env`
```bash
cd ~/whatsapp_automation/docker
nano .env
```

עדכן את השורות הבאות:
```bash
# כתובת ה-API הציבורית שלך
EXTERNAL_API_URL=http://130.94.113.203:5000

# מפתח API (השתמש במפתח חזק!)
API_KEY=8a229939...
```

### שלב 2: אתחל את השירותים
```bash
docker compose restart master
```

---

## 📋 דוגמה לבקשה מהאתר החיצוני

```javascript
// JavaScript/Node.js
const axios = require('axios');

const response = await axios.post(
  'http://130.94.113.203:5000/api/send',
  {
    contacts: [
      { phone: '+1234567890', name: 'John' },
      { phone: '+1987654321', name: 'Jane' }
    ],
    message: 'Hello {name}!'
  },
  {
    headers: {
      'X-API-Key': '8a229939...',
      'Content-Type': 'application/json'
    }
  }
);
```

---

## ⚠️ אבטחה

1. **אל תחלוק את ה-API_KEY** - זה כמו סיסמה!
2. **השתמש ב-HTTPS** - אם אפשר, השתמש ב-HTTPS במקום HTTP
3. **שנה את המפתח** - אם המפתח נחשף, שנה אותו מיד

---

## ✅ בדיקה

```bash
# בדוק שהאימות עובד
curl http://130.94.113.203:5000/api/send \
  -H "X-API-Key: 8a229939..." \
  -H "Content-Type: application/json" \
  -d '{"contacts": [], "message": "test"}'

# אם המפתח שגוי, תקבל:
# {"error":"Invalid API key","message":"The provided API key is incorrect"}

# אם המפתח נכון, תקבל תשובה תקינה
```

---

## 📝 סיכום

| ערך | תיאור | דוגמה |
|-----|-------|-------|
| **EXTERNAL_API_URL** | כתובת ה-API הציבורית | `http://130.94.113.203:5000` |
| **EXTERNAL_API_KEY** | מפתח לאימות בקשות | `8a229939...` |

**האתר החיצוני צריך:**
- לשלוח בקשות ל-`EXTERNAL_API_URL`
- לכלול את `EXTERNAL_API_KEY` ב-header `X-API-Key`

