# ============================================
# שליחת הודעת בדיקה - PowerShell
# העתק והדבק את כל הקובץ הזה ב-PowerShell
# ============================================

# הגדרות - שנה לפי הצורך
$API_URL = "http://130.94.113.203:5000/api/send"
$API_KEY = "8a229939..."

Write-Host "🧪 שולח הודעת בדיקה..." -ForegroundColor Cyan
Write-Host ""

# המספרים לבדיקה
$contacts = @(
    @{phone = "+972502920643"; name = ""},
    @{phone = "+972559786598"; name = ""},
    @{phone = "+972509456568"; name = ""}
)

# ההודעה
$message = "Hello test message"

Write-Host "📤 שולח ל-$($contacts.Count) מספרים..." -ForegroundColor Yellow
Write-Host "הודעה: $message" -ForegroundColor Gray
Write-Host "API: $API_URL" -ForegroundColor Gray
Write-Host ""

# הכנת הבקשה
$body = @{
    contacts = $contacts
    message = $message
} | ConvertTo-Json -Depth 10

$headers = @{
    "Content-Type" = "application/json"
    "X-API-Key" = $API_KEY
}

try {
    Write-Host "⏳ שולח בקשה..." -ForegroundColor Yellow
    
    # שליחת הבקשה
    $response = Invoke-WebRequest -Uri $API_URL -Method POST -Headers $headers -Body $body -UseBasicParsing
    
    Write-Host ""
    Write-Host "✅ הבקשה הצליחה!" -ForegroundColor Green
    Write-Host "HTTP Status: $($response.StatusCode)" -ForegroundColor Gray
    Write-Host ""
    
    $result = $response.Content | ConvertFrom-Json
    Write-Host "📊 תוצאות:" -ForegroundColor Cyan
    $result | ConvertTo-Json
    
    if ($result.campaign_id) {
        Write-Host ""
        Write-Host "📋 Campaign ID: $($result.campaign_id)" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "💡 לבדוק סטטוס (לאחר 10 שניות):" -ForegroundColor Yellow
        Write-Host "   Invoke-WebRequest -Uri 'http://130.94.113.203:5000/api/campaigns/$($result.campaign_id)/status' -Headers @{'X-API-Key'='$API_KEY'}" -ForegroundColor Gray
    }
    
} catch {
    Write-Host ""
    Write-Host "❌ הבקשה נכשלה!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errorBody = $reader.ReadToEnd()
        Write-Host "Response: $errorBody" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "✅ סיום" -ForegroundColor Green

