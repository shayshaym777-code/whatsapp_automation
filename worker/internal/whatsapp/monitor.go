package whatsapp

import (
	"context"
	"log"
	"sync"
	"time"
)

// ConnectionMonitor handles automatic reconnection of disconnected accounts
type ConnectionMonitor struct {
	manager           *ClientManager
	checkInterval     time.Duration
	reconnectCooldown time.Duration

	// Track reconnection attempts to prevent spam
	lastReconnectAttempt map[string]time.Time
	reconnectFailures    map[string]int
	mu                   sync.RWMutex

	// Control
	stopChan chan struct{}
	running  bool
}

const (
	// DefaultCheckInterval is how often to check for disconnected accounts
	DefaultCheckInterval = 30 * time.Second
	// DefaultReconnectCooldown is minimum time between reconnection attempts for same account
	DefaultReconnectCooldown = 60 * time.Second
	// MaxReconnectFailures before giving up on an account
	MaxReconnectFailures = 5
	// FailureCooldownMultiplier increases cooldown after each failure
	FailureCooldownMultiplier = 2
)

// NewConnectionMonitor creates a new connection monitor
func NewConnectionMonitor(manager *ClientManager) *ConnectionMonitor {
	return &ConnectionMonitor{
		manager:              manager,
		checkInterval:        DefaultCheckInterval,
		reconnectCooldown:    DefaultReconnectCooldown,
		lastReconnectAttempt: make(map[string]time.Time),
		reconnectFailures:    make(map[string]int),
		stopChan:             make(chan struct{}),
	}
}

// Start begins the connection monitoring loop
func (m *ConnectionMonitor) Start() {
	if m.running {
		return
	}
	m.running = true
	log.Printf("[MONITOR] Starting connection monitor (check every %v)", m.checkInterval)
	go m.monitorLoop()
}

// Stop stops the connection monitoring loop
func (m *ConnectionMonitor) Stop() {
	if !m.running {
		return
	}
	m.running = false
	close(m.stopChan)
	log.Printf("[MONITOR] Connection monitor stopped")
}

// monitorLoop is the main monitoring loop
func (m *ConnectionMonitor) monitorLoop() {
	ticker := time.NewTicker(m.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopChan:
			return
		case <-ticker.C:
			m.checkAndReconnect()
		}
	}
}

// checkAndReconnect checks all accounts and reconnects disconnected ones
func (m *ConnectionMonitor) checkAndReconnect() {
	m.manager.mu.RLock()
	accounts := make([]*AccountClient, 0, len(m.manager.accounts))
	phones := make([]string, 0, len(m.manager.accounts))
	for phone, acc := range m.manager.accounts {
		accounts = append(accounts, acc)
		phones = append(phones, phone)
	}
	m.manager.mu.RUnlock()

	reconnected := 0
	skippedNotLoggedIn := 0
	disconnectedCount := 0

	for i, acc := range accounts {
		phone := phones[i]

		// === CRITICAL: Only reconnect accounts that WERE logged in ===
		// If account was never logged in (LoggedIn == false), skip it entirely
		// These accounts need manual re-pairing, not automatic reconnection
		if !acc.LoggedIn {
			skippedNotLoggedIn++
			continue
		}

		// Check if actually disconnected
		if acc.Client == nil {
			continue
		}

		// If client says it's connected, skip
		if acc.Client.IsConnected() {
			continue
		}

		// Account was logged in but is now disconnected - try to reconnect
		disconnectedCount++
		if m.shouldAttemptReconnect(phone) {
			if m.attemptReconnect(phone, acc) {
				reconnected++
			}
		}
	}

	// Only log if something actually happened (reduces log spam significantly)
	if reconnected > 0 {
		log.Printf("[MONITOR] Reconnected %d accounts", reconnected)
	}
	if disconnectedCount > 0 && reconnected == 0 {
		// Only log disconnected count occasionally, not every check
		// This is handled by shouldAttemptReconnect cooldown
	}
}

// shouldAttemptReconnect checks if enough time has passed since last attempt
func (m *ConnectionMonitor) shouldAttemptReconnect(phone string) bool {
	m.mu.RLock()
	lastAttempt, exists := m.lastReconnectAttempt[phone]
	failures := m.reconnectFailures[phone]
	m.mu.RUnlock()

	if !exists {
		return true
	}

	// Calculate cooldown based on number of failures
	cooldown := m.reconnectCooldown
	for i := 0; i < failures; i++ {
		cooldown *= FailureCooldownMultiplier
		if cooldown > 30*time.Minute {
			cooldown = 30 * time.Minute // Cap at 30 minutes
			break
		}
	}

	// Check if we've exceeded max failures
	if failures >= MaxReconnectFailures {
		// Only log once when hitting the limit
		return false
	}

	return time.Since(lastAttempt) >= cooldown
}

// attemptReconnect tries to reconnect a specific account
func (m *ConnectionMonitor) attemptReconnect(phone string, acc *AccountClient) bool {
	m.mu.Lock()
	m.lastReconnectAttempt[phone] = time.Now()
	m.mu.Unlock()

	log.Printf("[MONITOR] Attempting to reconnect: %s", phone)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	err := acc.Client.Connect()
	if err != nil {
		m.mu.Lock()
		m.reconnectFailures[phone]++
		failures := m.reconnectFailures[phone]
		m.mu.Unlock()

		// Only log failures occasionally to reduce spam
		if failures == 1 || failures == MaxReconnectFailures {
			log.Printf("[MONITOR] Reconnect failed for %s (attempt %d/%d): %v",
				phone, failures, MaxReconnectFailures, err)
		}
		return false
	}

	// Wait a moment for connection to stabilize
	select {
	case <-ctx.Done():
		return false
	case <-time.After(2 * time.Second):
	}

	// Verify connection
	if acc.Client.IsConnected() && acc.Client.IsLoggedIn() {
		m.mu.Lock()
		m.reconnectFailures[phone] = 0 // Reset failures on success
		m.mu.Unlock()

		log.Printf("[MONITOR] Successfully reconnected: %s", phone)

		// Update account state
		m.manager.mu.Lock()
		acc.Connected = true
		m.manager.mu.Unlock()

		return true
	}

	return false
}

// ResetFailures resets the failure count for an account (call after successful manual login)
func (m *ConnectionMonitor) ResetFailures(phone string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.reconnectFailures, phone)
	delete(m.lastReconnectAttempt, phone)
}

// GetReconnectStats returns statistics about reconnection attempts
func (m *ConnectionMonitor) GetReconnectStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	stats := make(map[string]interface{})
	stats["running"] = m.running
	stats["check_interval"] = m.checkInterval.String()
	stats["accounts_with_failures"] = len(m.reconnectFailures)

	failureDetails := make(map[string]int)
	for phone, failures := range m.reconnectFailures {
		failureDetails[phone] = failures
	}
	stats["failure_counts"] = failureDetails

	return stats
}
