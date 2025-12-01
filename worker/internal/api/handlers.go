package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/mux"

	"github.com/whatsapp-automation/worker/internal/config"
	"github.com/whatsapp-automation/worker/internal/fingerprint"
	"github.com/whatsapp-automation/worker/internal/whatsapp"
)

// v8.0: Simplified worker API - no warmup, no stages

// Server represents the HTTP API server
type Server struct {
	WorkerID     string
	DeviceSeed   string
	ProxyCountry string
	Fingerprint  fingerprint.DeviceFingerprint
	ProxyConfig  *config.ProxyConfig
	client       *whatsapp.ClientManager
	monitor      *whatsapp.ConnectionMonitor
}

// NewServer creates a new API server
func NewServer(workerID, deviceSeed, proxyCountry string, fp fingerprint.DeviceFingerprint, proxyConfig *config.ProxyConfig) (*Server, error) {
	client := whatsapp.NewClientManager(fp, proxyCountry, workerID, proxyConfig)
	monitor := whatsapp.NewConnectionMonitor(client)

	return &Server{
		WorkerID:     workerID,
		DeviceSeed:   deviceSeed,
		ProxyCountry: proxyCountry,
		Fingerprint:  fp,
		ProxyConfig:  proxyConfig,
		client:       client,
		monitor:      monitor,
	}, nil
}

// StartBackgroundServices starts monitor and loads sessions
func (s *Server) StartBackgroundServices(ctx context.Context) {
	// Load existing sessions
	log.Printf("[STARTUP] Loading sessions...")
	loaded, skipped, err := s.client.LoadExistingSessions(ctx)
	if err != nil {
		log.Printf("[STARTUP] Error: %v", err)
	} else {
		log.Printf("[STARTUP] Loaded %d sessions, skipped %d", loaded, skipped)
	}

	// Cleanup
	removed := s.client.CleanupInactiveAccounts()
	if len(removed) > 0 {
		log.Printf("[STARTUP] Cleaned up %d inactive accounts", len(removed))
	}

	// Start monitor
	s.monitor.Start()
	log.Printf("[STARTUP] Connection monitor started")

	// Start heartbeat
	s.client.StartHeartbeat()
	log.Printf("[STARTUP] Heartbeat started")

	// Setup message handlers
	s.client.SetupAllMessageHandlers()
	log.Printf("[STARTUP] Ready")
}

// GetClientManager returns client manager
func (s *Server) GetClientManager() *whatsapp.ClientManager {
	return s.client
}

// GetMonitor returns monitor
func (s *Server) GetMonitor() *whatsapp.ConnectionMonitor {
	return s.monitor
}

// RegisterRoutes registers HTTP routes
func (s *Server) RegisterRoutes(r *mux.Router) {
	// Health
	r.HandleFunc("/health", s.handleHealth).Methods(http.MethodGet)
	r.HandleFunc("/status", s.handleStatus).Methods(http.MethodGet)

	// Send
	r.HandleFunc("/send", s.handleSend).Methods(http.MethodPost)

	// Accounts
	r.HandleFunc("/accounts", s.handleAccountsList).Methods(http.MethodGet)
	r.HandleFunc("/accounts/pair", s.handlePair).Methods(http.MethodPost)
	r.HandleFunc("/accounts/connect", s.handleConnect).Methods(http.MethodPost)
	r.HandleFunc("/accounts/{phone}/reconnect", s.handleReconnect).Methods(http.MethodPost)

	// Sessions
	r.HandleFunc("/sessions", s.handleSessions).Methods(http.MethodGet)
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]interface{}{"error": true, "message": message})
}

// GET /health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := s.client.HealthSummary()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"healthy":   true,
		"worker_id": s.WorkerID,
		"version":   "8.0",
		"whatsapp":  health,
	})
}

// GET /status
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"worker_id": s.WorkerID,
		"country":   s.ProxyCountry,
		"accounts":  s.client.GetAllAccountsStatus(),
	})
}

// SendRequest for POST /send
type SendRequest struct {
	FromPhone string `json:"from_phone"`
	ToPhone   string `json:"to_phone"`
	Message   string `json:"message"`
	Name      string `json:"name"` // For {name} replacement
}

// POST /send - Send a message with anti-ban
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var req SendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if req.FromPhone == "" || req.ToPhone == "" || req.Message == "" {
		writeError(w, http.StatusBadRequest, "from_phone, to_phone, message required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	result, err := s.client.SendMessage(ctx, req.FromPhone, req.ToPhone, req.Message, req.Name)
	if err != nil {
		log.Printf("[SEND] Error from %s to %s: %v", req.FromPhone, req.ToPhone, err)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	log.Printf("[SEND] ✅ %s → %s", req.FromPhone, req.ToPhone)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":    true,
		"message_id": result.MessageID,
		"timestamp":  result.Timestamp,
	})
}

// GET /accounts
func (s *Server) handleAccountsList(w http.ResponseWriter, r *http.Request) {
	accounts := s.client.GetAllAccountsStatus()
	healthy := 0
	for _, acc := range accounts {
		if acc.LoggedIn {
			healthy++
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"accounts":      accounts,
		"total_healthy": healthy,
	})
}

// PairRequest for POST /accounts/pair
type PairRequest struct {
	Phone         string `json:"phone"`
	SessionNumber int    `json:"session_number"` // 1-4
}

// POST /accounts/pair - Get pairing code
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	var req PairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if req.Phone == "" {
		writeError(w, http.StatusBadRequest, "phone required")
		return
	}

	if req.SessionNumber < 1 || req.SessionNumber > 4 {
		req.SessionNumber = 1
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	result, err := s.client.ConnectWithPairingCode(ctx, req.Phone)
	if err != nil {
		log.Printf("[PAIR] Error for %s: %v", req.Phone, err)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	log.Printf("[PAIR] %s session %d: %s", req.Phone, req.SessionNumber, result.Status)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":        true,
		"status":         result.Status,
		"phone":          result.Phone,
		"pairing_code":   result.PairingCode,
		"session_number": req.SessionNumber,
		"instructions":   "WhatsApp > Settings > Linked Devices > Link with phone number",
	})
}

// ConnectRequest for POST /accounts/connect
type ConnectRequest struct {
	Phone string `json:"phone"`
}

// POST /accounts/connect - Connect with QR
func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	var req ConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if req.Phone == "" {
		writeError(w, http.StatusBadRequest, "phone required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()

	result, err := s.client.ConnectAccount(ctx, req.Phone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"status":    result.Status,
		"phone":     result.Phone,
		"qr_code":   result.QRCode,
		"logged_in": result.LoggedIn,
	})
}

// POST /accounts/{phone}/reconnect
func (s *Server) handleReconnect(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	phone := vars["phone"]

	if phone == "" {
		writeError(w, http.StatusBadRequest, "phone required")
		return
	}

	err := s.client.TriggerReconnect(phone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Reconnect triggered",
	})
}

// GET /sessions - Get all sessions status
func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	// This would need MultiSessionManager integration
	// For now return accounts as sessions
	accounts := s.client.GetAllAccountsStatus()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sessions": accounts,
	})
}
