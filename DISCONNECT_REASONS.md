# למה חשבונות מתנתקים ואיך לחבר אותם אוטומטית

## 🔍 איך לדעת למה חשבון מתנתק?

### 1. דרך API:

```bash
# בדוק למה חשבון מתנתק:
curl http://localhost:5000/api/accounts/+972501234567/disconnect-reason

# תשובה:
{
  "phone": "+972501234567",
  "connected": false,
  "logged_in": true,
  "status": "disconnected",
  "reconnecting": true,
  "last_error": "Disconnected: connection timeout",
  "disconnect_reason": "Connection lost - will auto-reconnect (has valid session)",
  "can_auto_reconnect": true,
  "auto_reconnect_enabled": true,
  "consecutive_failures": 2,
  "worker_id": "worker-1"
}
```

### 2. דרך לוגים:

```bash
# צפה בלוגים של worker:
docker compose logs -f worker-1 | grep "Disconnected\|disconnect"

# דוגמה לוג:
[+972501234567] ❌ Disconnected from WhatsApp - Reason: Disconnected: connection timeout
[+972501234567] 🔄 Account has valid session - attempting auto-reconnect (no QR needed)
[+972501234567] Will attempt auto-reconnect in 3s (using existing session)
```

### 3. דרך Dashboard:

- לך ל-Accounts page
- לחץ על חשבון מנותק
- תראה את ה-`last_error` ו-`disconnect_reason`

## 🔄 Auto-Reconnect אוטומטי (בלי QR/Pairing Code)

### איך זה עובד?

**אם יש session קיים:**
- ✅ המערכת מנסה reconnect אוטומטית
- ✅ **לא צריך QR Code או Pairing Code**
- ✅ מנסה כל 30 שניות (ConnectionMonitor)
- ✅ מנסה עד 48 שעות

**אם אין session:**
- ❌ צריך QR Code או Pairing Code ידנית
- ❌ לא יכול לעשות auto-reconnect

### מתי זה עובד?

```
✅ יש session קיים → Auto-reconnect עובד!
❌ אין session → צריך QR/Pairing Code ידנית
```

### איך לבדוק אם יש session?

```bash
# בדוק אם יש session:
curl http://localhost:5000/api/accounts/+972501234567/disconnect-reason

# אם "logged_in": true → יש session → Auto-reconnect יעבוד!
# אם "logged_in": false → אין session → צריך QR/Pairing Code
```

## 📋 סיבות נפוצות לניתוק:

### 1. **Connection Timeout** (הכי נפוץ)
```
Reason: "Disconnected: connection timeout"
Solution: Auto-reconnect יעבוד (יש session)
```

### 2. **Stream Replaced** (מכשיר אחר התחבר)
```
Reason: "Stream replaced - another device connected"
Solution: צריך לנתק את המכשיר האחר, אחרת לא יכול להתחבר
```

### 3. **KeepAlive Timeout** (חיבור איטי)
```
Reason: "KeepAlive timeout"
Solution: Auto-reconnect יעבוד (יש session)
```

### 4. **Network Error** (בעיית רשת)
```
Reason: "Network error" / "ECONNREFUSED"
Solution: Auto-reconnect יעבוד (יש session)
```

### 5. **Logged Out** (התנתק מהטלפון)
```
Reason: "Logged out"
Solution: צריך QR/Pairing Code חדש (אין session)
```

## 🛠️ איך לשפר Auto-Reconnect?

### כבר מוגדר:

1. **ConnectionMonitor** - בודק כל 30 שניות
2. **attemptSmartReconnect** - מנסה reconnect עם exponential backoff
3. **Heartbeat** - בודק חיבורים כל דקה

### אם Auto-Reconnect לא עובד:

1. **בדוק שיש session:**
   ```bash
   curl http://localhost:5000/api/accounts/+972501234567/disconnect-reason
   # אם "logged_in": false → צריך QR/Pairing Code
   ```

2. **בדוק את הלוגים:**
   ```bash
   docker compose logs -f worker-1 | grep "reconnect\|Reconnect"
   ```

3. **נסה reconnect ידני:**
   ```bash
   curl -X POST http://localhost:5000/api/accounts/+972501234567/reconnect
   ```

## 📊 דוגמה: חשבון מנותק

```json
{
  "phone": "+972501234567",
  "connected": false,
  "logged_in": true,  ← יש session!
  "status": "disconnected",
  "reconnecting": true,
  "last_error": "Disconnected: connection timeout",
  "disconnect_reason": "Connection lost - will auto-reconnect (has valid session)",
  "can_auto_reconnect": true,  ← Auto-reconnect יעבוד!
  "auto_reconnect_enabled": true,
  "consecutive_failures": 2,
  "worker_id": "worker-1"
}
```

**מה קורה:**
1. החשבון מתנתק (connection timeout)
2. המערכת מזהה שיש session (`logged_in: true`)
3. ConnectionMonitor מנסה reconnect כל 30 שניות
4. attemptSmartReconnect מנסה עם exponential backoff
5. אחרי כמה ניסיונות → מתחבר בהצלחה!

## ⚠️ מתי Auto-Reconnect לא יעבוד?

### 1. אין session (`logged_in: false`)
```
Reason: צריך QR/Pairing Code חדש
Solution: חיבור ידני דרך Dashboard
```

### 2. Stream Replaced (מכשיר אחר מחובר)
```
Reason: "Stream replaced - another device connected"
Solution: נתק את המכשיר האחר, אחרת לא יכול להתחבר
```

### 3. חסימה (Blocked)
```
Reason: "Account blocked" / "banned"
Solution: צריך לחכות 48 שעות או לפתוח חשבון חדש
```

## 🔧 API Endpoints:

### 1. בדוק למה מתנתק:
```bash
GET /api/accounts/:phone/disconnect-reason
```

### 2. Reconnect ידני:
```bash
POST /api/accounts/:phone/reconnect
```

### 3. רשימת כל החשבונות:
```bash
GET /api/accounts
# כולל last_error לכל חשבון
```

## 📝 סיכום:

✅ **Auto-Reconnect עובד** אם יש session (`logged_in: true`)
✅ **לא צריך QR/Pairing Code** אם יש session
✅ **מנסה עד 48 שעות** לפני שהוא מוותר
✅ **API endpoint** לראות למה מתנתק

❌ **לא יעבוד** אם אין session (`logged_in: false`)
❌ **לא יעבוד** אם Stream Replaced (מכשיר אחר מחובר)

