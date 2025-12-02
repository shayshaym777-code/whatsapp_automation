# 🌐 איך האתר צריך לשלוח בקשות API

## הבעיה:
האתר שולח בקשה אבל ההודעה לא נשלחת.

## ✅ מה צריך לשלוח:

### 1. כתובת ה-API:
```
http://130.94.113.203:5000/api/send
```

### 2. Method:
```
POST
```

### 3. Headers:
```javascript
{
  "Content-Type": "application/json",
  "X-API-Key": "8a229939..."  // ← חשוב מאוד!
}
```

### 4. Body:
```json
{
  "contacts": [
    {"phone": "+972502920643", "name": ""},
    {"phone": "+972559786598", "name": ""},
    {"phone": "+972509456568", "name": ""}
  ],
  "message": "ההודעה שלך"
}
```

---

## 🔍 איך לבדוק מה האתר שולח:

### בדוק בלוגים של Master:
```bash
docker compose logs -f master | grep -E "(POST|/api/send|AUTH|401|403)"
```

**מה לחפש:**
- `[API] POST /api/send` = הבקשה הגיעה
- `[AUTH] ✅ ACCEPTED` = API key תקין
- `[AUTH] ❌ REJECTED` = API key שגוי או חסר
- `401` = אין API key
- `403` = API key שגוי

---

## 🐛 בעיות נפוצות:

### 1. אין API key:
```
[AUTH] ❌ REJECTED: No API key provided
[API] ❌ POST /api/send | 401
```

**פתרון:**
- וודא שהאתר שולח `X-API-Key` header
- בדוק שהמפתח נכון: `8a229939...`

---

### 2. API key שגוי:
```
[AUTH] ❌ REJECTED: Invalid API key | Provided: ***1234
[API] ❌ POST /api/send | 403
```

**פתרון:**
- בדוק שהמפתח בשרת תואם למפתח באתר
- עדכן את `.env` בשרת: `API_KEY=המפתח_הנכון`

---

### 3. CORS Error:
```
Access to fetch at 'http://130.94.113.203:5000/api/send' from origin 'https://your-website.com' has been blocked by CORS policy
```

**פתרון:**
- צריך להוסיף CORS headers ב-Master Server
- או להשתמש ב-proxy

---

### 4. הבקשה לא מגיעה בכלל:
- בדוק שהכתובת נכונה
- בדוק שיש חיבור לאינטרנט
- בדוק שהשרת פועל: `curl http://130.94.113.203:5000/health`

---

## ✅ דוגמה קוד JavaScript (לאתר):

```javascript
async function sendMessage(contacts, message) {
  const API_URL = 'http://130.94.113.203:5000/api/send';
  const API_KEY = '8a229939...';  // ← המפתח שלך
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY  // ← חשוב מאוד!
      },
      body: JSON.stringify({
        contacts: contacts,
        message: message
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('Error:', error);
      return { success: false, error: error.error || 'Unknown error' };
    }
    
    const result = await response.json();
    console.log('Success:', result);
    return { success: true, data: result };
    
  } catch (error) {
    console.error('Network error:', error);
    return { success: false, error: error.message };
  }
}

// שימוש:
sendMessage(
  [
    {phone: '+972502920643', name: ''},
    {phone: '+972559786598', name: ''}
  ],
  'Hello test'
);
```

---

## 🔍 בדיקה מהירה:

### 1. בדוק שהשרת עובד:
```bash
curl http://130.94.113.203:5000/health
```

### 2. בדוק עם API key:
```bash
curl -X POST http://130.94.113.203:5000/api/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 8a229939..." \
  -d '{"contacts":[{"phone":"+972502920643","name":""}],"message":"test"}'
```

### 3. בדוק לוגים:
```bash
docker compose logs -f master | grep -E "(POST|AUTH|401|403)"
```

---

## 📊 מה תראה בלוגים אם הכל תקין:

```
[API] POST /api/send | IP: 192.168.1.100 | Key: ***939
[AUTH] ✅ ACCEPTED: Valid API key | IP: 192.168.1.100 | Path: /api/send
[Campaign camp_123] Distributing 3 contacts to 27 accounts:
[Campaign camp_123] 📤 Sending from 14453187618 to +972502920643
[Campaign camp_123] ✅ Sent from 14453187618 to +972502920643
[API] ✅ POST /api/send | 200 | 150ms
```

---

## ❌ מה תראה אם יש בעיה:

### אין API key:
```
[API] POST /api/send | IP: 192.168.1.100 | Key: none
[AUTH] ❌ REJECTED: No API key provided
[API] ❌ POST /api/send | 401 | 5ms | Error: API key required
```

### API key שגוי:
```
[API] POST /api/send | IP: 192.168.1.100 | Key: ***1234
[AUTH] ❌ REJECTED: Invalid API key | Provided: ***1234
[API] ❌ POST /api/send | 403 | 3ms | Error: Invalid API key
```

