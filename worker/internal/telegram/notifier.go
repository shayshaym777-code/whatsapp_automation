package telegram

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

const (
	// Telegram Bot Configuration
	TelegramToken  = "8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w"
	TelegramChatID = "8014432452"
	TelegramAPIURL = "https://api.telegram.org/bot%s/sendMessage"
)

// Notifier handles Telegram notifications
type Notifier struct {
	token  string
	chatID string
	client *http.Client
}

// NewNotifier creates a new Telegram notifier
func NewNotifier() *Notifier {
	return &Notifier{
		token:  TelegramToken,
		chatID: TelegramChatID,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// SendAlert sends a message to Telegram
func (n *Notifier) SendAlert(message string) error {
	url := fmt.Sprintf(TelegramAPIURL, n.token)

	payload := map[string]string{
		"chat_id":    n.chatID,
		"text":       message,
		"parse_mode": "HTML",
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := n.client.Post(url, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to send telegram message: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("telegram API returned status %d", resp.StatusCode)
	}

	log.Printf("[Telegram] Alert sent: %s", message[:min(50, len(message))]+"...")
	return nil
}

// AlertDisconnected sends disconnection alert
func (n *Notifier) AlertDisconnected(phone, worker, reason string) {
	msg := fmt.Sprintf(`⚠️ <b>DISCONNECTED</b>

📱 Phone: %s
🖥️ Worker: %s
📝 Reason: %s
⏰ Time: %s`, phone, worker, reason, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send disconnect alert: %v", err)
	}
}

// AlertBlocked sends blocked account alert
func (n *Notifier) AlertBlocked(phone, worker, errorMsg string) {
	msg := fmt.Sprintf(`🚨 <b>BLOCKED</b>

📱 Phone: %s
🖥️ Worker: %s
❌ Error: %s
⏰ Time: %s
⚠️ Action: Do not use for 48 hours`, phone, worker, errorMsg, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send blocked alert: %v", err)
	}
}

// AlertLowDevices sends low devices warning
func (n *Notifier) AlertLowDevices(healthyCount, totalCount int) {
	msg := fmt.Sprintf(`⚠️ <b>LOW DEVICES</b>

📊 Healthy: %d / %d
⚠️ Need more devices to handle load!
⏰ Time: %s`, healthyCount, totalCount, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send low devices alert: %v", err)
	}
}

// AlertCampaignDone sends campaign completion notification
func (n *Notifier) AlertCampaignDone(sent, failed int, duration time.Duration) {
	msg := fmt.Sprintf(`✅ <b>CAMPAIGN DONE</b>

📤 Sent: %d
❌ Failed: %d
⏱️ Duration: %s
⏰ Time: %s`, sent, failed, duration.Round(time.Second), time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send campaign done alert: %v", err)
	}
}

// AlertReconnected sends successful reconnection notification
func (n *Notifier) AlertReconnected(phone, worker string) {
	msg := fmt.Sprintf(`✅ <b>RECONNECTED</b>

📱 Phone: %s
🖥️ Worker: %s
⏰ Time: %s`, phone, worker, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send reconnected alert: %v", err)
	}
}

// AlertReconnectFailed sends reconnection failure notification
func (n *Notifier) AlertReconnectFailed(phone, worker string) {
	msg := fmt.Sprintf(`❌ <b>RECONNECT FAILED</b>

📱 Phone: %s
🖥️ Worker: %s
⚠️ Needs manual pairing!
⏰ Time: %s`, phone, worker, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send reconnect failed alert: %v", err)
	}
}

// AlertAllSessionsDown sends alert when all 4 sessions for a phone are down (v7.0)
func (n *Notifier) AlertAllSessionsDown(phone string) {
	msg := fmt.Sprintf(`🔴 <b>כל ה-SESSIONS נפלו!</b>

📱 Phone: %s
⚠️ צריך לסרוק QR מחדש!
⏰ Time: %s

<i>כל 4 ה-sessions לא זמינים. נא לסרוק QR חדש.</i>`, phone, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send all sessions down alert: %v", err)
	}
}

// AlertSessionFailover sends notification when session switches to backup (v7.0)
func (n *Notifier) AlertSessionFailover(phone string, fromSession, toSession int) {
	msg := fmt.Sprintf(`🔄 <b>SESSION FAILOVER</b>

📱 Phone: %s
📤 From Session: %d
📥 To Session: %d
⏰ Time: %s

<i>עבר אוטומטית ל-session גיבוי.</i>`, phone, fromSession, toSession, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send session failover alert: %v", err)
	}
}

// AlertNewAccountConnected sends new account connection notification
func (n *Notifier) AlertNewAccountConnected(phone, worker string, isNew bool) {
	status := "Ready to send"
	if isNew {
		status = "Warmup mode (3 days)"
	}

	msg := fmt.Sprintf(`🆕 <b>NEW ACCOUNT</b>

📱 Phone: %s
🖥️ Worker: %s
📊 Status: %s
⏰ Time: %s`, phone, worker, status, time.Now().Format("2006-01-02 15:04:05"))

	if err := n.SendAlert(msg); err != nil {
		log.Printf("[Telegram] Failed to send new account alert: %v", err)
	}
}

// min helper
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Global notifier instance
var globalNotifier *Notifier

// GetNotifier returns the global notifier instance
func GetNotifier() *Notifier {
	if globalNotifier == nil {
		globalNotifier = NewNotifier()
	}
	return globalNotifier
}

// Quick helper functions for easy access
func AlertDisconnected(phone, worker, reason string) {
	GetNotifier().AlertDisconnected(phone, worker, reason)
}

func AlertBlocked(phone, worker, errorMsg string) {
	GetNotifier().AlertBlocked(phone, worker, errorMsg)
}

func AlertLowDevices(healthy, total int) {
	GetNotifier().AlertLowDevices(healthy, total)
}

func AlertCampaignDone(sent, failed int, duration time.Duration) {
	GetNotifier().AlertCampaignDone(sent, failed, duration)
}

func AlertReconnected(phone, worker string) {
	GetNotifier().AlertReconnected(phone, worker)
}

func AlertReconnectFailed(phone, worker string) {
	GetNotifier().AlertReconnectFailed(phone, worker)
}

func AlertAllSessionsDown(phone string) {
	GetNotifier().AlertAllSessionsDown(phone)
}

func AlertSessionFailover(phone string, fromSession, toSession int) {
	GetNotifier().AlertSessionFailover(phone, fromSession, toSession)
}
