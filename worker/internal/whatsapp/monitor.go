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
	disconnectedSince    map[string]time.Time // NEW: Track when account first disconnected
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
	// MaxReconnectFailures before temporarily pausing (will resume after cooldown)
	MaxReconnectFailures = 10
	// FailureCooldownMultiplier increases cooldown after each failure
	FailureCooldownMultiplier = 2
	// RevivalPeriod - how long to keep trying to revive a disconnected account
	RevivalPeriod = 48 * time.Hour
	// ReconnectInterval - try to reconnect every X minutes during revival period
	ReconnectIntervalMinutes = 15
)

// NewConnectionMonitor creates a new connection monitor
func NewConnectionMonitor(manager *ClientManager) *ConnectionMonitor {
	return &ConnectionMonitor{
		manager:              manager,
		checkInterval:        DefaultCheckInterval,
		reconnectCooldown:    DefaultReconnectCooldown,
		lastReconnectAttempt: make(map[string]time.Time),
		reconnectFailures:    make(map[string]int),
		disconnectedSince:    make(map[string]time.Time), // NEW
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
// Accounts get 48 hours of revival attempts before being marked as dead
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
	expiredCount := 0
	revivingCount := 0

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

		// If client says it's connected, clear disconnected tracking and skip
		if acc.Client.IsConnected() {
			m.mu.Lock()
			delete(m.disconnectedSince, phone)
			m.mu.Unlock()
			continue
		}

		// Account was logged in but is now disconnected
		disconnectedCount++

		// Track when this account first disconnected
		m.mu.Lock()
		if _, exists := m.disconnectedSince[phone]; !exists {
			m.disconnectedSince[phone] = time.Now()
			log.Printf("[MONITOR] 🔴 Account %s disconnected - starting 48h revival period", phone)
		}
		disconnectedTime := m.disconnectedSince[phone]
		m.mu.Unlock()

		// Check if revival period expired (48 hours)
		timeSinceDisconnect := time.Since(disconnectedTime)
		if timeSinceDisconnect > RevivalPeriod {
			expiredCount++
			// Don't delete the account! Just mark it as needing attention
			// Log only once per hour to avoid spam
			if int(timeSinceDisconnect.Hours())%1 == 0 && int(timeSinceDisconnect.Minutes())%60 < 1 {
				log.Printf("[MONITOR] ⚠️ Account %s revival period expired (%.1f hours) - needs manual attention",
					phone, timeSinceDisconnect.Hours())
			}
			continue
		}

		revivingCount++

		// Try to reconnect during the revival period
		if m.shouldAttemptReconnect(phone) {
			remainingHours := (RevivalPeriod - timeSinceDisconnect).Hours()
			log.Printf("[MONITOR] 🔄 Attempting revival for %s (%.1f hours remaining)", phone, remainingHours)

			if m.attemptReconnect(phone, acc) {
				reconnected++
				// Clear disconnected tracking on success
				m.mu.Lock()
				delete(m.disconnectedSince, phone)
				m.mu.Unlock()
				log.Printf("[MONITOR] ✅ Account %s revived successfully!", phone)
			}
		}
	}

	// Log summary periodically
	if reconnected > 0 || revivingCount > 0 || expiredCount > 0 {
		log.Printf("[MONITOR] Status: %d reconnected, %d reviving, %d expired (48h+), %d never logged in",
			reconnected, revivingCount, expiredCount, skippedNotLoggedIn)
	}
}

// shouldAttemptReconnect checks if enough time has passed since last attempt
// During the 48h revival period, we try every 15 minutes with exponential backoff
func (m *ConnectionMonitor) shouldAttemptReconnect(phone string) bool {
	m.mu.RLock()
	lastAttempt, exists := m.lastReconnectAttempt[phone]
	failures := m.reconnectFailures[phone]
	disconnectedSince, isDisconnected := m.disconnectedSince[phone]
	m.mu.RUnlock()

	if !exists {
		return true
	}

	// During revival period (first 48 hours), use different logic
	if isDisconnected {
		timeSinceDisconnect := time.Since(disconnectedSince)

		// First 2 hours: try every 5 minutes
		if timeSinceDisconnect < 2*time.Hour {
			return time.Since(lastAttempt) >= 5*time.Minute
		}

		// Hours 2-12: try every 15 minutes
		if timeSinceDisconnect < 12*time.Hour {
			return time.Since(lastAttempt) >= 15*time.Minute
		}

		// Hours 12-48: try every 30 minutes
		return time.Since(lastAttempt) >= 30*time.Minute
	}

	// Normal cooldown logic (for non-revival cases)
	cooldown := m.reconnectCooldown
	for i := 0; i < failures; i++ {
		cooldown *= FailureCooldownMultiplier
		if cooldown > 30*time.Minute {
			cooldown = 30 * time.Minute // Cap at 30 minutes
			break
		}
	}

	// After max failures, wait longer but don't give up completely
	if failures >= MaxReconnectFailures {
		// Try once per hour even after max failures
		return time.Since(lastAttempt) >= 1*time.Hour
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
	stats["revival_period_hours"] = RevivalPeriod.Hours()

	failureDetails := make(map[string]int)
	for phone, failures := range m.reconnectFailures {
		failureDetails[phone] = failures
	}
	stats["failure_counts"] = failureDetails

	// Revival status for disconnected accounts
	revivalStatus := make(map[string]map[string]interface{})
	for phone, disconnectedTime := range m.disconnectedSince {
		timeSince := time.Since(disconnectedTime)
		remaining := RevivalPeriod - timeSince
		if remaining < 0 {
			remaining = 0
		}

		revivalStatus[phone] = map[string]interface{}{
			"disconnected_since": disconnectedTime.Format(time.RFC3339),
			"hours_disconnected": timeSince.Hours(),
			"hours_remaining":    remaining.Hours(),
			"revival_expired":    timeSince > RevivalPeriod,
			"status":             m.getRevivalPhase(timeSince),
		}
	}
	stats["revival_accounts"] = revivalStatus
	stats["accounts_in_revival"] = len(revivalStatus)

	return stats
}

// getRevivalPhase returns the current phase of revival for logging
func (m *ConnectionMonitor) getRevivalPhase(timeSince time.Duration) string {
	if timeSince > RevivalPeriod {
		return "EXPIRED - needs manual attention"
	}
	if timeSince < 2*time.Hour {
		return "CRITICAL - trying every 5 min"
	}
	if timeSince < 12*time.Hour {
		return "ACTIVE - trying every 15 min"
	}
	return "EXTENDED - trying every 30 min"
}

// GetRevivalAccounts returns list of accounts currently in revival period
func (m *ConnectionMonitor) GetRevivalAccounts() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	accounts := make([]map[string]interface{}, 0)
	for phone, disconnectedTime := range m.disconnectedSince {
		timeSince := time.Since(disconnectedTime)
		remaining := RevivalPeriod - timeSince
		if remaining < 0 {
			remaining = 0
		}

		accounts = append(accounts, map[string]interface{}{
			"phone":              phone,
			"disconnected_since": disconnectedTime.Format(time.RFC3339),
			"hours_disconnected": timeSince.Hours(),
			"hours_remaining":    remaining.Hours(),
			"revival_expired":    timeSince > RevivalPeriod,
			"phase":              m.getRevivalPhase(timeSince),
			"failures":           m.reconnectFailures[phone],
		})
	}

	return accounts
}
