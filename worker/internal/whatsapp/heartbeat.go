package whatsapp

import (
	"context"
	"log"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
)

const (
	// HeartbeatInterval - how often to send heartbeat (keep connection alive)
	HeartbeatInterval = 5 * time.Minute

	// ConnectionCheckInterval - how often to verify connection is alive
	ConnectionCheckInterval = 30 * time.Second

	// MaxConnectionRetries - max retries before marking account as problematic
	MaxConnectionRetries = 10
)

// HeartbeatManager keeps connections alive
type HeartbeatManager struct {
	manager  *ClientManager
	stopChan chan struct{}
	running  bool
	mu       sync.Mutex
}

// NewHeartbeatManager creates a new heartbeat manager
func NewHeartbeatManager(manager *ClientManager) *HeartbeatManager {
	return &HeartbeatManager{
		manager: manager,
	}
}

// Start begins the heartbeat system
func (h *HeartbeatManager) Start() {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.running {
		return
	}

	h.stopChan = make(chan struct{})
	h.running = true

	// Start heartbeat goroutine
	go h.heartbeatLoop()

	// Start connection check goroutine
	go h.connectionCheckLoop()

	log.Println("[Heartbeat] 💓 Started - keeping connections alive")
}

// Stop stops the heartbeat system
func (h *HeartbeatManager) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()

	if !h.running {
		return
	}

	close(h.stopChan)
	h.running = false
	log.Println("[Heartbeat] 💔 Stopped")
}

// heartbeatLoop sends periodic heartbeats to keep connections alive
func (h *HeartbeatManager) heartbeatLoop() {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-h.stopChan:
			return
		case <-ticker.C:
			h.sendHeartbeats()
		}
	}
}

// connectionCheckLoop checks connections more frequently
func (h *HeartbeatManager) connectionCheckLoop() {
	ticker := time.NewTicker(ConnectionCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-h.stopChan:
			return
		case <-ticker.C:
			h.checkConnections()
		}
	}
}

// sendHeartbeats sends presence to all connected accounts
func (h *HeartbeatManager) sendHeartbeats() {
	h.manager.mu.RLock()
	accounts := make([]*AccountClient, 0)
	phones := make([]string, 0)
	for phone, acc := range h.manager.accounts {
		if acc.Connected && acc.LoggedIn && acc.Client != nil {
			accounts = append(accounts, acc)
			phones = append(phones, phone)
		}
	}
	h.manager.mu.RUnlock()

	if len(accounts) == 0 {
		return
	}

	successCount := 0
	for i, acc := range accounts {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)

		// Send presence to keep connection alive
		err := acc.Client.SendPresence(ctx, types.PresenceAvailable)
		cancel()

		if err != nil {
			log.Printf("[Heartbeat] ❌ Failed for %s: %v", phones[i], err)
			// Mark as potentially disconnected
			h.manager.mu.Lock()
			acc.Connected = false
			h.manager.mu.Unlock()
		} else {
			successCount++
		}
	}

	if successCount > 0 {
		log.Printf("[Heartbeat] 💓 Sent to %d/%d accounts", successCount, len(accounts))
	}
}

// checkConnections verifies all connections are still alive
func (h *HeartbeatManager) checkConnections() {
	h.manager.mu.RLock()
	accounts := make([]*AccountClient, 0)
	phones := make([]string, 0)
	for phone, acc := range h.manager.accounts {
		if acc.LoggedIn && acc.Client != nil {
			accounts = append(accounts, acc)
			phones = append(phones, phone)
		}
	}
	h.manager.mu.RUnlock()

	reconnectNeeded := make([]string, 0)

	for i, acc := range accounts {
		phone := phones[i]

		// Check if client thinks it's connected
		isConnected := acc.Client.IsConnected()
		isLoggedIn := acc.Client.IsLoggedIn()

		h.manager.mu.Lock()
		wasConnected := acc.Connected
		acc.Connected = isConnected
		acc.LoggedIn = isLoggedIn
		h.manager.mu.Unlock()

		// If was connected but now isn't, add to reconnect list
		if wasConnected && !isConnected {
			reconnectNeeded = append(reconnectNeeded, phone)
			log.Printf("[Heartbeat] ⚠️ %s disconnected, will attempt reconnect", phone)
		}
	}

	// Attempt immediate reconnect for recently disconnected accounts
	for _, phone := range reconnectNeeded {
		go h.attemptImmediateReconnect(phone)
	}
}

// attemptImmediateReconnect tries to reconnect immediately when disconnection is detected
func (h *HeartbeatManager) attemptImmediateReconnect(phone string) {
	h.manager.mu.RLock()
	acc, exists := h.manager.accounts[phone]
	h.manager.mu.RUnlock()

	if !exists || acc.Client == nil {
		return
	}

	// Wait a moment before reconnecting
	time.Sleep(5 * time.Second)

	// Check if already reconnected
	if acc.Client.IsConnected() {
		return
	}

	log.Printf("[Heartbeat] 🔄 Attempting immediate reconnect for %s", phone)

	err := acc.Client.Connect()
	if err != nil {
		log.Printf("[Heartbeat] ❌ Immediate reconnect failed for %s: %v", phone, err)
		return
	}

	// Wait for connection to stabilize
	time.Sleep(3 * time.Second)

	if acc.Client.IsConnected() && acc.Client.IsLoggedIn() {
		h.manager.mu.Lock()
		acc.Connected = true
		acc.LoggedIn = true
		h.manager.mu.Unlock()
		log.Printf("[Heartbeat] ✅ Immediate reconnect successful for %s", phone)
	}
}

// StartHeartbeat starts the heartbeat manager (convenience method on ClientManager)
func (m *ClientManager) StartHeartbeat() {
	if m.heartbeat == nil {
		m.heartbeat = NewHeartbeatManager(m)
	}
	m.heartbeat.Start()
}

// StopHeartbeat stops the heartbeat manager
func (m *ClientManager) StopHeartbeat() {
	if m.heartbeat != nil {
		m.heartbeat.Stop()
	}
}

