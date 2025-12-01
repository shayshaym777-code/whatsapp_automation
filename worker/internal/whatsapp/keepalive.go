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

// sendKeepAliveMessages sends a keep alive message from each account to another
func (m *ClientManager) sendKeepAliveMessages() {
	activeAccounts := m.GetActiveAccounts()

	if len(activeAccounts) < 2 {
		log.Println("[KeepAlive] Need at least 2 accounts for keep alive")
		return
	}

	log.Printf("[KeepAlive] Sending keep alive for %d accounts", len(activeAccounts))

	for i, sender := range activeAccounts {
		// Pick a random receiver (not self)
		receiverIdx := (i + 1 + rand.Intn(len(activeAccounts)-1)) % len(activeAccounts)
		receiver := activeAccounts[receiverIdx]

		if receiver.Phone == sender.Phone {
			receiverIdx = (receiverIdx + 1) % len(activeAccounts)
			receiver = activeAccounts[receiverIdx]
		}

		// Pick random message
		message := keepAliveMessages[rand.Intn(len(keepAliveMessages))]

		// Send keep alive
		err := m.sendKeepAliveMessage(sender, receiver.Phone, message)

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
			log.Printf("[KeepAlive] ✅ Keep alive sent: %s -> %s", sender.Phone, receiver.Phone)
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

