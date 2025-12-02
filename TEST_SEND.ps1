# ============================================
# בדיקת שליחה - הודעה למספרים מהקובץ
# PowerShell Script
# ============================================

# הגדרות
$API_URL = "http://localhost:5000/api/send"
$API_KEY = "your-api-key-change-in-production"

Write-Host "🧪 בודק שליחת הודעה..." -ForegroundColor Cyan
Write-Host "API URL: $API_URL" -ForegroundColor Gray
Write-Host ""

# המספרים מהקובץ
$contacts = @(
    @{phone = "+972502920643"; name = ""},
    @{phone = "+972559786598"; name = ""},
    @{phone = "+972509456568"; name = ""}
)

# ההודעה
$message = "היי מה נשמע"

Write-Host "📤 שולח הודעה ל-$($contacts.Count) מספרים..." -ForegroundColor Yellow
Write-Host "הודעה: $message" -ForegroundColor Gray
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
    # שליחת הבקשה
    $response = Invoke-WebRequest -Uri $API_URL -Method POST -Headers $headers -Body $body -UseBasicParsing
    
    Write-Host "✅ הבקשה הצליחה!" -ForegroundColor Green
    Write-Host "HTTP Status: $($response.StatusCode)" -ForegroundColor Gray
    Write-Host ""
    
    $result = $response.Content | ConvertFrom-Json
    $result | ConvertTo-Json
    
    if ($result.campaign_id) {
        Write-Host ""
        Write-Host "📋 Campaign ID: $($result.campaign_id)" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "💡 לבדוק סטטוס (לאחר כמה שניות):" -ForegroundColor Yellow
        Write-Host "   Invoke-WebRequest -Uri 'http://localhost:5000/api/campaigns/$($result.campaign_id)/status' -Headers @{'X-API-Key'='$API_KEY'}" -ForegroundColor Gray
    }
    
} catch {
    Write-Host "❌ הבקשה נכשלה!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errorBody = $reader.ReadToEnd()
        Write-Host "Response: $errorBody" -ForegroundColor Red
    }
}

