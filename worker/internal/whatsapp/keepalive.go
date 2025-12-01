package whatsapp

import (
	"context"
	"log"
	"math/rand"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

const (
	// KeepAliveInterval - how often to send keep alive messages
	KeepAliveInterval = 60 * time.Minute // Every hour

	// HealthCheckInterval - how often to check account health
	HealthCheckInterval = 5 * time.Minute
)

// Keep alive messages - short and natural
var keepAliveMessages = []string{
	"Hi 👋",
	"Hey",
	"מה קורה?",
	"👍",
	"✌️",
	"🙂",
	"yo",
	"hey",
	"sup",
	"hi",
}

// External phone numbers for keep alive - NOT our accounts!
// These are real numbers to send keep alive to (looks more natural)
var keepAliveTargetPhones = []string{
	"972557042301",
	"972502492495",
	"972535251110",
	"972508572614",
	"972506595779",
	"972547449724",
	"972587959957",
	"972506461221",
	"972524493395",
	"972525204958",
	"972536200412",
	"972523963939",
	"972503801200",
	"972504885005",
	"972504441987",
	"972509212327",
	"972525904818",
	"972545688632",
	"972544878211",
	"972548352757",
	"972534325821",
	"972526635197",
	"972525000963",
	"972585538805",
	"972526161676",
	"972546882912",
	"972526341867",
	"972538222661",
	"972544437792",
	"972505438438",
	"972542548337",
	"972546109493",
	"972586272776",
	"972528206358",
	"972548836499",
	"972529382987",
	"972537262058",
	"972523951114",
	"972584449967",
	"972533443306",
	"972544465781",
	"972508923226",
	"972522000065",
	"972585200032",
	"972542677772",
	"972549198510",
	"972502281601",
	"972547995532",
	"972556886913",
	"972502170020",
	"972558817372",
	"972559695072",
	"972522420357",
	"972547174377",
	"972528876633",
	"972527338887",
	"972556668936",
	"972509748484",
	"972523663774",
	"972533365999",
	"972509344850",
	"972538248114",
	"972525116467",
	"972507330647",
	"972509456568",
}

// AccountHealthStatus represents the health state of an account
type AccountHealthStatus string

const (
	StatusHealthy      AccountHealthStatus = "HEALTHY"
	StatusDisconnected AccountHealthStatus = "DISCONNECTED"
	StatusBlocked      AccountHealthStatus = "BLOCKED"
	StatusSuspicious   AccountHealthStatus = "SUSPICIOUS"
)

// AccountHealth tracks health info for an account
type AccountHealth struct {
	Phone              string
	Status             AccountHealthStatus
	LastAlive          time.Time
	LastMessageSent    time.Time
	LastMessageReceived time.Time
	LastError          string
	ConsecutiveFailures int
	MessagesToday      int
}

// keepAliveStop channel to stop keep alive
var keepAliveStop chan struct{}

// accountHealthMap tracks health for all accounts
var accountHealthMap = make(map[string]*AccountHealth)

// StartKeepAlive starts the keep alive scheduler
func (m *ClientManager) StartKeepAlive() {
	if keepAliveStop != nil {
		close(keepAliveStop)
	}

	keepAliveStop = make(chan struct{})
	stopCh := keepAliveStop

	// Keep alive ticker - every hour
	keepAliveTicker := time.NewTicker(KeepAliveInterval)

	// Health check ticker - every 5 minutes
	healthTicker := time.NewTicker(HealthCheckInterval)

	go func(stop <-chan struct{}) {
		log.Println("[KeepAlive] Started - sending keep alive every hour, health check every 5 min")
		defer keepAliveTicker.Stop()
		defer healthTicker.Stop()

		// Run health check immediately
		m.checkAllAccountsHealth()

		for {
			select {
			case <-keepAliveTicker.C:
				m.sendKeepAliveMessages()
			case <-healthTicker.C:
				m.checkAllAccountsHealth()
			case <-stop:
				log.Println("[KeepAlive] Stopped")
				return
			}
		}
	}(stopCh)
}

// StopKeepAlive stops the keep alive scheduler
func (m *ClientManager) StopKeepAlive() {
	if keepAliveStop != nil {
		close(keepAliveStop)
		keepAliveStop = nil
		log.Println("[KeepAlive] Stopped")
	}
}

// sendKeepAliveMessages sends a keep alive message from each account to external numbers
// We send to external numbers (not our accounts) to look more natural
func (m *ClientManager) sendKeepAliveMessages() {
	activeAccounts := m.GetActiveAccounts()

	if len(activeAccounts) == 0 {
		log.Println("[KeepAlive] No active accounts for keep alive")
		return
	}

	if len(keepAliveTargetPhones) == 0 {
		log.Println("[KeepAlive] No target phones configured for keep alive")
		return
	}

	log.Printf("[KeepAlive] Sending keep alive for %d accounts to external numbers", len(activeAccounts))

	for _, sender := range activeAccounts {
		// Pick a random external target phone (not our accounts!)
		targetPhone := keepAliveTargetPhones[rand.Intn(len(keepAliveTargetPhones))]

		// Pick random message
		message := keepAliveMessages[rand.Intn(len(keepAliveMessages))]

		// Send keep alive to external number
		err := m.sendKeepAliveMessage(sender, targetPhone, message)

		// Update health status
		health := m.getOrCreateHealth(sender.Phone)
		
		if err != nil {
			health.ConsecutiveFailures++
			health.LastError = err.Error()
			
			// Check if blocked
			if isBlockedError(err) {
				health.Status = StatusBlocked
				log.Printf("[KeepAlive] 🔴 ACCOUNT BLOCKED: %s - %v", sender.Phone, err)
			} else {
				health.Status = StatusSuspicious
				log.Printf("[KeepAlive] ⚠️ Keep alive failed for %s: %v", sender.Phone, err)
			}
		} else {
			health.Status = StatusHealthy
			health.LastAlive = time.Now()
			health.LastMessageSent = time.Now()
			health.ConsecutiveFailures = 0
			health.LastError = ""
			log.Printf("[KeepAlive] ✅ Keep alive sent: %s -> %s (external)", sender.Phone, targetPhone)
		}

		// Delay between accounts (30-90 seconds)
		delay := 30 + rand.Intn(60)
		time.Sleep(time.Duration(delay) * time.Second)
	}
}

// sendKeepAliveMessage sends a single keep alive message
func (m *ClientManager) sendKeepAliveMessage(from *AccountClient, toPhone string, message string) error {
	toPhoneSanitized := sanitizePhone(toPhone)
	toJID := types.NewJID(toPhoneSanitized, types.DefaultUserServer)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	msg := &waE2E.Message{
		Conversation: proto.String(message),
	}

	_, err := from.Client.SendMessage(ctx, toJID, msg)
	return err
}

// checkAllAccountsHealth checks health status of all accounts
func (m *ClientManager) checkAllAccountsHealth() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for phone, acc := range m.accounts {
		health := m.getOrCreateHealth(phone)

		// Check connection status
		if !acc.Connected {
			health.Status = StatusDisconnected
			log.Printf("[HealthCheck] 🟡 %s: DISCONNECTED", phone)
			
			// Attempt reconnect
			go m.attemptReconnect(phone)
			continue
		}

		if !acc.LoggedIn {
			health.Status = StatusDisconnected
			log.Printf("[HealthCheck] 🟡 %s: NOT LOGGED IN", phone)
			continue
		}

		// Check for suspicious activity (no messages for too long)
		if health.ConsecutiveFailures > 3 {
			health.Status = StatusSuspicious
			log.Printf("[HealthCheck] 🟠 %s: SUSPICIOUS (failures: %d)", phone, health.ConsecutiveFailures)
			continue
		}

		// If we got here and status was bad, it might be recovered
		if health.Status != StatusBlocked {
			health.Status = StatusHealthy
		}
	}
}

// attemptReconnect tries to reconnect a disconnected account
func (m *ClientManager) attemptReconnect(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || acc == nil {
		return
	}

	// Don't reconnect if already connected
	if acc.Connected && acc.LoggedIn {
		return
	}

	// Don't reconnect if blocked
	health := m.getOrCreateHealth(phone)
	if health.Status == StatusBlocked {
		log.Printf("[Reconnect] Skipping blocked account: %s", phone)
		return
	}

	log.Printf("[Reconnect] 🔄 Attempting reconnect for %s", phone)

	// Try to reconnect
	if acc.Client != nil {
		err := acc.Client.Connect()
		if err != nil {
			log.Printf("[Reconnect] Failed to reconnect %s: %v", phone, err)
			health.ConsecutiveFailures++
			health.LastError = err.Error()
		} else {
			// Wait for connection
			time.Sleep(3 * time.Second)
			
			if acc.Client.IsLoggedIn() {
				log.Printf("[Reconnect] ✅ Successfully reconnected %s", phone)
				acc.Connected = true
				acc.LoggedIn = true
				health.Status = StatusHealthy
				health.ConsecutiveFailures = 0
			}
		}
	}
}

// getOrCreateHealth gets or creates health tracking for an account
func (m *ClientManager) getOrCreateHealth(phone string) *AccountHealth {
	if health, exists := accountHealthMap[phone]; exists {
		return health
	}

	health := &AccountHealth{
		Phone:  phone,
		Status: StatusHealthy,
	}
	accountHealthMap[phone] = health
	return health
}

// GetAccountHealth returns health status for an account
func (m *ClientManager) GetAccountHealth(phone string) *AccountHealth {
	if health, exists := accountHealthMap[phone]; exists {
		return health
	}
	return nil
}

// GetAllAccountsHealth returns health status for all accounts
func (m *ClientManager) GetAllAccountsHealth() map[string]*AccountHealth {
	return accountHealthMap
}

// isBlockedError checks if an error indicates the account is blocked
func isBlockedError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	blockIndicators := []string{
		"banned",
		"blocked",
		"restricted",
		"unusual activity",
		"account suspended",
		"temporarily unavailable",
		"not authorized",
	}
	for _, indicator := range blockIndicators {
		if strings.Contains(errStr, indicator) {
			return true
		}
	}
	return false
}

// TriggerReconnect manually triggers reconnect for an account
func (m *ClientManager) TriggerReconnect(phone string) error {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists {
		return nil
	}

	log.Printf("[Reconnect] Manual reconnect triggered for %s", phone)
	
	if acc.Client != nil {
		// Disconnect first
		acc.Client.Disconnect()
		time.Sleep(2 * time.Second)
		
		// Reconnect
		err := acc.Client.Connect()
		if err != nil {
			return err
		}
		
		// Wait and check
		time.Sleep(3 * time.Second)
		
		if acc.Client.IsLoggedIn() {
			acc.Connected = true
			acc.LoggedIn = true
			health := m.getOrCreateHealth(phone)
			health.Status = StatusHealthy
			health.ConsecutiveFailures = 0
			log.Printf("[Reconnect] ✅ Manual reconnect successful for %s", phone)
		}
	}
	
	return nil
}

