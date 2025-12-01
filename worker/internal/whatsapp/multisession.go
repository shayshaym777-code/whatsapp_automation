package whatsapp

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/whatsapp-automation/worker/internal/telegram"
)

// MaxSessionsPerPhone is the maximum number of backup sessions per phone
const MaxSessionsPerPhone = 4

// SessionInfo represents a single session for a phone number
type SessionInfo struct {
	SessionNumber int       // 1, 2, 3, or 4
	WorkerID      string    // Which worker manages this session
	Status        string    // CONNECTED, DISCONNECTED, CONNECTING
	LastActive    time.Time // Last activity timestamp
	Client        *AccountClient
}

// PhoneMultiSession manages multiple sessions for a single phone number
type PhoneMultiSession struct {
	Phone          string
	Sessions       []*SessionInfo
	ActiveSession  int // Currently active session number (1-4)
	mu             sync.RWMutex
}

// MultiSessionManager manages all phone numbers and their sessions
type MultiSessionManager struct {
	phones map[string]*PhoneMultiSession // phone -> multi-session
	mu     sync.RWMutex
}

// NewMultiSessionManager creates a new multi-session manager
func NewMultiSessionManager() *MultiSessionManager {
	return &MultiSessionManager{
		phones: make(map[string]*PhoneMultiSession),
	}
}

// GetOrCreatePhoneSession gets or creates a phone's multi-session entry
func (m *MultiSessionManager) GetOrCreatePhoneSession(phone string) *PhoneMultiSession {
	m.mu.Lock()
	defer m.mu.Unlock()

	if ps, exists := m.phones[phone]; exists {
		return ps
	}

	ps := &PhoneMultiSession{
		Phone:         phone,
		Sessions:      make([]*SessionInfo, 0, MaxSessionsPerPhone),
		ActiveSession: 0, // No active session yet
	}
	m.phones[phone] = ps
	return ps
}

// AddSession adds a new session for a phone number
func (ps *PhoneMultiSession) AddSession(sessionNum int, workerID string, client *AccountClient) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	if sessionNum < 1 || sessionNum > MaxSessionsPerPhone {
		return fmt.Errorf("session number must be between 1 and %d", MaxSessionsPerPhone)
	}

	// Check if session already exists
	for i, s := range ps.Sessions {
		if s.SessionNumber == sessionNum {
			// Update existing session
			ps.Sessions[i].WorkerID = workerID
			ps.Sessions[i].Client = client
			ps.Sessions[i].Status = "CONNECTED"
			ps.Sessions[i].LastActive = time.Now()
			log.Printf("[MultiSession] Updated session %d for %s", sessionNum, ps.Phone)
			return nil
		}
	}

	// Add new session
	session := &SessionInfo{
		SessionNumber: sessionNum,
		WorkerID:      workerID,
		Status:        "CONNECTED",
		LastActive:    time.Now(),
		Client:        client,
	}
	ps.Sessions = append(ps.Sessions, session)

	// If this is the first session or no active session, make it active
	if ps.ActiveSession == 0 {
		ps.ActiveSession = sessionNum
		log.Printf("[MultiSession] Session %d is now ACTIVE for %s", sessionNum, ps.Phone)
	}

	log.Printf("[MultiSession] Added session %d for %s (total: %d sessions)", sessionNum, ps.Phone, len(ps.Sessions))
	return nil
}

// GetActiveSession returns the currently active session's client
func (ps *PhoneMultiSession) GetActiveSession() *AccountClient {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	for _, s := range ps.Sessions {
		if s.SessionNumber == ps.ActiveSession && s.Status == "CONNECTED" && s.Client != nil {
			return s.Client
		}
	}

	// Active session not available, find first connected one
	for _, s := range ps.Sessions {
		if s.Status == "CONNECTED" && s.Client != nil {
			return s.Client
		}
	}

	return nil
}

// MarkSessionDisconnected marks a session as disconnected and tries to failover
func (ps *PhoneMultiSession) MarkSessionDisconnected(sessionNum int, workerID string) (failedOver bool, newSession int) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Find and mark the session
	for _, s := range ps.Sessions {
		if s.SessionNumber == sessionNum {
			s.Status = "DISCONNECTED"
			log.Printf("[MultiSession] Session %d for %s marked DISCONNECTED", sessionNum, ps.Phone)
			break
		}
	}

	// If this was the active session, try to failover
	if ps.ActiveSession == sessionNum {
		// Find next available session
		for _, s := range ps.Sessions {
			if s.Status == "CONNECTED" && s.Client != nil && s.Client.LoggedIn {
				ps.ActiveSession = s.SessionNumber
				log.Printf("[MultiSession] ✅ Failover: %s switched from session %d to session %d",
					ps.Phone, sessionNum, s.SessionNumber)
				return true, s.SessionNumber
			}
		}

		// No available session found
		ps.ActiveSession = 0
		log.Printf("[MultiSession] ⚠️ No backup sessions available for %s!", ps.Phone)
	}

	return false, 0
}

// GetSessionCount returns the number of connected sessions
func (ps *PhoneMultiSession) GetSessionCount() (connected int, total int) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	total = len(ps.Sessions)
	for _, s := range ps.Sessions {
		if s.Status == "CONNECTED" {
			connected++
		}
	}
	return connected, total
}

// AllSessionsDown checks if all sessions are disconnected
func (ps *PhoneMultiSession) AllSessionsDown() bool {
	connected, total := ps.GetSessionCount()
	return total > 0 && connected == 0
}

// GetStatus returns the phone's overall status
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

	return map[string]interface{}{
		"phone":          ps.Phone,
		"active_session": ps.ActiveSession,
		"sessions":       sessions,
		"connected":      connected,
		"total":          total,
	}
}

// HandleSessionEvent handles session connect/disconnect events
func (m *MultiSessionManager) HandleSessionEvent(phone string, sessionNum int, workerID string, connected bool, client *AccountClient) {
	ps := m.GetOrCreatePhoneSession(phone)

	if connected {
		ps.AddSession(sessionNum, workerID, client)
	} else {
		failedOver, newSession := ps.MarkSessionDisconnected(sessionNum, workerID)

		if ps.AllSessionsDown() {
			// All sessions down - send Telegram alert
			log.Printf("[MultiSession] 🔴 ALL SESSIONS DOWN for %s!", phone)
			go telegram.AlertAllSessionsDown(phone)
		} else if failedOver {
			log.Printf("[MultiSession] Failover successful: %s now using session %d", phone, newSession)
		}
	}
}

// GetActiveSessionForPhone returns the active session for a phone
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

// SendFromPhone sends a message using the active session for a phone
func (m *MultiSessionManager) SendFromPhone(ctx context.Context, phone, toPhone, message string) (*SendResult, error) {
	client := m.GetActiveSessionForPhone(phone)
	if client == nil {
		return nil, fmt.Errorf("no active session for phone %s", phone)
	}

	// The actual send is delegated to the client
	// This will be called from the ClientManager
	return nil, fmt.Errorf("use ClientManager.SendMessage instead")
}

// AlertAllSessionsDown sends alert when all sessions for a phone are down
func AlertAllSessionsDown(phone string) {
	telegram.AlertAllSessionsDown(phone)
}

