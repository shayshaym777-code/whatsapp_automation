package whatsapp

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/whatsapp-automation/worker/internal/telegram"
)

// v8.0: Simple multi-session - 4 backups per phone, auto-failover
// No fingerprints, no rotation between sessions
// Send from ONE session only, failover if it falls

const MaxSessionsPerPhone = 4

// SessionInfo represents a single session for a phone number
type SessionInfo struct {
	SessionNumber int
	WorkerID      string
	Status        string // CONNECTED, DISCONNECTED
	LastActive    time.Time
	Client        *AccountClient
}

// PhoneMultiSession manages multiple sessions for a single phone
type PhoneMultiSession struct {
	Phone         string
	Sessions      []*SessionInfo
	ActiveSession int // Currently active session number (1-4), 0 = none
	mu            sync.RWMutex
}

// MultiSessionManager manages all phones
type MultiSessionManager struct {
	phones map[string]*PhoneMultiSession
	mu     sync.RWMutex
}

// NewMultiSessionManager creates a new manager
func NewMultiSessionManager() *MultiSessionManager {
	return &MultiSessionManager{
		phones: make(map[string]*PhoneMultiSession),
	}
}

// GetOrCreatePhoneSession gets or creates phone entry
func (m *MultiSessionManager) GetOrCreatePhoneSession(phone string) *PhoneMultiSession {
	m.mu.Lock()
	defer m.mu.Unlock()

	if ps, exists := m.phones[phone]; exists {
		return ps
	}

	ps := &PhoneMultiSession{
		Phone:         phone,
		Sessions:      make([]*SessionInfo, 0, MaxSessionsPerPhone),
		ActiveSession: 0,
	}
	m.phones[phone] = ps
	return ps
}

// AddSession adds a new session
func (ps *PhoneMultiSession) AddSession(sessionNum int, workerID string, client *AccountClient) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	if sessionNum < 1 || sessionNum > MaxSessionsPerPhone {
		return fmt.Errorf("session number must be 1-4")
	}

	// Update existing or add new
	for i, s := range ps.Sessions {
		if s.SessionNumber == sessionNum {
			ps.Sessions[i].WorkerID = workerID
			ps.Sessions[i].Client = client
			ps.Sessions[i].Status = "CONNECTED"
			ps.Sessions[i].LastActive = time.Now()
			log.Printf("[Session] Updated session %d for %s", sessionNum, ps.Phone)
			return nil
		}
	}

	// Add new
	ps.Sessions = append(ps.Sessions, &SessionInfo{
		SessionNumber: sessionNum,
		WorkerID:      workerID,
		Status:        "CONNECTED",
		LastActive:    time.Now(),
		Client:        client,
	})

	// Set as active if first session
	if ps.ActiveSession == 0 {
		ps.ActiveSession = sessionNum
		log.Printf("[Session] Session %d is now ACTIVE for %s", sessionNum, ps.Phone)
	}

	log.Printf("[Session] Added session %d for %s (total: %d)", sessionNum, ps.Phone, len(ps.Sessions))
	return nil
}

// GetActiveSession returns the currently active session's client
func (ps *PhoneMultiSession) GetActiveSession() *AccountClient {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	// Try active session first
	for _, s := range ps.Sessions {
		if s.SessionNumber == ps.ActiveSession && s.Status == "CONNECTED" && s.Client != nil {
			return s.Client
		}
	}

	// Fallback to any connected session
	for _, s := range ps.Sessions {
		if s.Status == "CONNECTED" && s.Client != nil {
			return s.Client
		}
	}

	return nil
}

// MarkSessionDisconnected marks session as down and tries failover
func (ps *PhoneMultiSession) MarkSessionDisconnected(sessionNum int) (failedOver bool, newSession int) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Mark as disconnected
	for _, s := range ps.Sessions {
		if s.SessionNumber == sessionNum {
			s.Status = "DISCONNECTED"
			log.Printf("[Session] Session %d for %s DISCONNECTED", sessionNum, ps.Phone)
			break
		}
	}

	// Failover if this was active session
	if ps.ActiveSession == sessionNum {
		for _, s := range ps.Sessions {
			if s.Status == "CONNECTED" && s.Client != nil && s.Client.LoggedIn {
				oldSession := ps.ActiveSession
				ps.ActiveSession = s.SessionNumber
				log.Printf("[Session] ✅ Failover: %s from session %d to %d", ps.Phone, oldSession, s.SessionNumber)
				return true, s.SessionNumber
			}
		}

		// No backup available
		ps.ActiveSession = 0
		log.Printf("[Session] ⚠️ No backup sessions for %s!", ps.Phone)
	}

	return false, 0
}

// GetSessionCount returns connected/total counts
func (ps *PhoneMultiSession) GetSessionCount() (connected int, total int) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	total = len(ps.Sessions)
	for _, s := range ps.Sessions {
		if s.Status == "CONNECTED" {
			connected++
		}
	}
	return
}

// AllSessionsDown checks if all sessions are down
func (ps *PhoneMultiSession) AllSessionsDown() bool {
	connected, total := ps.GetSessionCount()
	return total > 0 && connected == 0
}

// GetStatus returns phone status
// v8.0: Only 2 statuses - CONNECTED (🟢) or DISCONNECTED (🔴)
// At least 1 session connected = CONNECTED
func (ps *PhoneMultiSession) GetStatus() map[string]interface{} {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	sessions := make([]map[string]interface{}, len(ps.Sessions))
	for i, s := range ps.Sessions {
		sessions[i] = map[string]interface{}{
			"session_number": s.SessionNumber,
			"worker_id":      s.WorkerID,
			"status":         s.Status,
			"last_active":    s.LastActive,
		}
	}

	connected, total := ps.GetSessionCount()

	// v8.0: Simple status logic
	// 🟢 CONNECTED = at least 1 session connected
	// 🔴 DISCONNECTED = all sessions down
	status := "DISCONNECTED"
	if connected > 0 {
		status = "CONNECTED"
	}

	return map[string]interface{}{
		"phone":            ps.Phone,
		"status":           status,
		"active_session":   ps.ActiveSession,
		"sessions":         sessions,
		"connected_count":  connected,
		"total_sessions":   total,
		"sessions_display": fmt.Sprintf("%d/%d", connected, total),
	}
}

// HandleSessionEvent handles connect/disconnect events
func (m *MultiSessionManager) HandleSessionEvent(phone string, sessionNum int, workerID string, connected bool, client *AccountClient) {
	ps := m.GetOrCreatePhoneSession(phone)

	if connected {
		ps.AddSession(sessionNum, workerID, client)
	} else {
		failedOver, newSession := ps.MarkSessionDisconnected(sessionNum)

		if ps.AllSessionsDown() {
			log.Printf("[Session] 🔴 ALL SESSIONS DOWN for %s!", phone)
			go telegram.AlertAllSessionsDown(phone)
		} else if failedOver {
			log.Printf("[Session] Failover: %s now using session %d", phone, newSession)
		}
	}
}

// GetActiveSessionForPhone returns active session client
func (m *MultiSessionManager) GetActiveSessionForPhone(phone string) *AccountClient {
	m.mu.RLock()
	ps, exists := m.phones[phone]
	m.mu.RUnlock()

	if !exists {
		return nil
	}

	return ps.GetActiveSession()
}

// GetAllPhonesStatus returns status for all phones
func (m *MultiSessionManager) GetAllPhonesStatus() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(m.phones))
	for _, ps := range m.phones {
		result = append(result, ps.GetStatus())
	}
	return result
}
