package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"

	"github.com/whatsapp-automation/worker/internal/config"
	"github.com/whatsapp-automation/worker/internal/fingerprint"
	"github.com/whatsapp-automation/worker/internal/whatsapp"
)

// Server represents the HTTP API server for the worker
type Server struct {
	WorkerID     string
	DeviceSeed   string
	ProxyCountry string
	Fingerprint  fingerprint.DeviceFingerprint
	ProxyConfig  *config.ProxyConfig
	ProxyPool    *config.ProxyPool
	client       *whatsapp.ClientManager
	monitor      *whatsapp.ConnectionMonitor
}

// NewServer creates a new API server instance
func NewServer(workerID, deviceSeed, proxyCountry string, fp fingerprint.DeviceFingerprint, proxyConfig *config.ProxyConfig) (*Server, error) {
	// Load proxy pool for rotation
	proxyPool := config.LoadProxyPool()

	client := whatsapp.NewClientManager(fp, proxyCountry, workerID, proxyConfig)
	monitor := whatsapp.NewConnectionMonitor(client)

	return &Server{
		WorkerID:     workerID,
		DeviceSeed:   deviceSeed,
		ProxyCountry: proxyCountry,
		Fingerprint:  fp,
		ProxyConfig:  proxyConfig,
		ProxyPool:    proxyPool,
		client:       client,
		monitor:      monitor,
	}, nil
}

// StartBackgroundServices starts the connection monitor, auto warmup, and loads existing sessions
func (s *Server) StartBackgroundServices(ctx context.Context) {
	// Load existing sessions from disk
	log.Printf("[STARTUP] Loading existing sessions...")
	loaded, skipped, err := s.client.LoadExistingSessions(ctx)
	if err != nil {
		log.Printf("[STARTUP] Error loading sessions: %v", err)
	} else {
		log.Printf("[STARTUP] Loaded %d sessions, skipped %d invalid sessions", loaded, skipped)
	}

	// Clean up any accounts that failed to load properly
	removed := s.client.CleanupInactiveAccounts()
	if len(removed) > 0 {
		log.Printf("[STARTUP] Cleaned up %d inactive accounts", len(removed))
	}

	// Start the connection monitor
	s.monitor.Start()
	log.Printf("[STARTUP] Connection monitor started")

	// Start auto warmup for new accounts
	s.client.StartAutoWarmup()
	log.Printf("[STARTUP] Auto warmup system started")

	// Start keep alive scheduler (sends messages every hour, checks health every 5 min)
	s.client.StartKeepAlive()
	log.Printf("[STARTUP] Keep alive system started")

	// Start human activity simulator for all connected accounts
	s.client.StartAllActivitySimulators()
	log.Printf("[STARTUP] Human activity simulator started")

	// Start heartbeat system (keeps connections alive)
	s.client.StartHeartbeat()
	log.Printf("[STARTUP] Heartbeat system started")

	// Setup message handlers for receiving messages
	s.client.SetupAllMessageHandlers()
	log.Printf("[STARTUP] Message receivers setup complete")
}

// GetClientManager returns the client manager (for external access if needed)
func (s *Server) GetClientManager() *whatsapp.ClientManager {
	return s.client
}

// GetMonitor returns the connection monitor (for external access if needed)
func (s *Server) GetMonitor() *whatsapp.ConnectionMonitor {
	return s.monitor
}

// RegisterRoutes registers all HTTP routes
func (s *Server) RegisterRoutes(r *mux.Router) {
	// Health and status endpoints
	r.HandleFunc("/health", s.handleHealth).Methods(http.MethodGet)
	r.HandleFunc("/status", s.handleStatus).Methods(http.MethodGet)

	// Message sending endpoints
	r.HandleFunc("/send", s.handleSend).Methods(http.MethodPost)
	r.HandleFunc("/send/bulk", s.handleSendBulk).Methods(http.MethodPost)

	// Account management endpoints
	r.HandleFunc("/accounts/connect", s.handleAccountsConnect).Methods(http.MethodPost)
	r.HandleFunc("/accounts/pair", s.handleAccountsPair).Methods(http.MethodPost) // Pairing code method (faster)
	r.HandleFunc("/accounts/disconnect", s.handleAccountsDisconnect).Methods(http.MethodPost)
	r.HandleFunc("/accounts/status", s.handleAccountsStatus).Methods(http.MethodGet)
	r.HandleFunc("/accounts", s.handleAccountsList).Methods(http.MethodGet)
	r.HandleFunc("/accounts/cleanup", s.handleAccountsCleanup).Methods(http.MethodPost) // Remove inactive accounts

	// Monitor endpoints
	r.HandleFunc("/monitor/stats", s.handleMonitorStats).Methods(http.MethodGet)
	r.HandleFunc("/monitor/revival", s.handleRevivalAccounts).Methods(http.MethodGet)

	// Warmup endpoints
	r.HandleFunc("/warmup/status", s.handleWarmupStatus).Methods(http.MethodGet)
	r.HandleFunc("/accounts/{phone}/skip-warmup", s.handleSkipWarmup).Methods(http.MethodPost)

	// Reconnect endpoint
	r.HandleFunc("/accounts/{phone}/reconnect", s.handleAccountReconnect).Methods(http.MethodPost)

	// Health endpoints
	r.HandleFunc("/accounts/health", s.handleAccountsHealth).Methods(http.MethodGet)

	// Activity endpoints
	r.HandleFunc("/activity/logs", s.handleActivityLogs).Methods(http.MethodGet)
	r.HandleFunc("/activity/logs/{phone}", s.handleActivityLogsForPhone).Methods(http.MethodGet)

	// Received messages endpoints
	r.HandleFunc("/messages/received", s.handleReceivedMessages).Methods(http.MethodGet)
	r.HandleFunc("/messages/received/{phone}", s.handleReceivedMessagesForPhone).Methods(http.MethodGet)

	// Proxy endpoints
	r.HandleFunc("/proxy/stats", s.handleProxyStats).Methods(http.MethodGet)
}

// writeJSON writes a JSON response
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// writeError writes an error response
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]interface{}{
		"error":   true,
		"message": message,
	})
}

// GET /health - Health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := s.client.HealthSummary()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"healthy":       true,
		"worker_id":     s.WorkerID,
		"proxy_country": s.ProxyCountry,
		"timestamp":     time.Now().Unix(),
		"whatsapp":      health,
	})
}

// GET /status - Detailed status with fingerprint
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"worker_id":     s.WorkerID,
		"proxy_country": s.ProxyCountry,
		"device_seed":   s.DeviceSeed,
		"fingerprint":   s.Fingerprint.ToMap(),
		"accounts":      s.client.GetAllAccountsStatus(),
		"timestamp":     time.Now().Unix(),
	})
}

// SendRequest represents a single message send request
type SendRequest struct {
	FromPhone string `json:"from_phone"`
	ToPhone   string `json:"to_phone"`
	Message   string `json:"message"`
}

// POST /send - Send a single message
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var req SendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return
	}

	// Validate request
	if req.FromPhone == "" {
		writeError(w, http.StatusBadRequest, "from_phone is required")
		return
	}
	if req.ToPhone == "" {
		writeError(w, http.StatusBadRequest, "to_phone is required")
		return
	}
	if req.Message == "" {
		writeError(w, http.StatusBadRequest, "message is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	result, err := s.client.SendMessage(ctx, req.FromPhone, req.ToPhone, req.Message)
	if err != nil {
		log.Printf("[SEND] Error sending message from %s to %s: %v", req.FromPhone, req.ToPhone, err)
		writeError(w, http.StatusInternalServerError, "Failed to send message: "+err.Error())
		return
	}

	log.Printf("[SEND] Message sent from %s to %s, ID: %s", req.FromPhone, req.ToPhone, result.MessageID)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":    true,
		"message_id": result.MessageID,
		"timestamp":  result.Timestamp,
		"from_phone": result.FromPhone,
		"to_phone":   result.ToPhone,
	})
}

// BulkSendRequest represents a bulk message send request
type BulkSendRequest struct {
	Messages []SendRequest `json:"messages"`
}

// BulkSendResult represents the result of a single message in bulk send
type BulkSendResult struct {
	FromPhone string `json:"from_phone"`
	ToPhone   string `json:"to_phone"`
	MessageID string `json:"message_id,omitempty"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
}

// POST /send/bulk - Send multiple messages
func (s *Server) handleSendBulk(w http.ResponseWriter, r *http.Request) {
	var req BulkSendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return
	}

	if len(req.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "messages array is required and cannot be empty")
		return
	}

	results := make([]BulkSendResult, 0, len(req.Messages))
	successCount := 0
	failCount := 0

	for _, msg := range req.Messages {
		result := BulkSendResult{
			FromPhone: msg.FromPhone,
			ToPhone:   msg.ToPhone,
		}

		// Validate
		if msg.FromPhone == "" || msg.ToPhone == "" || msg.Message == "" {
			result.Success = false
			result.Error = "missing required fields"
			failCount++
			results = append(results, result)
			continue
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		sendResult, err := s.client.SendMessage(ctx, msg.FromPhone, msg.ToPhone, msg.Message)
		cancel()

		if err != nil {
			result.Success = false
			result.Error = err.Error()
			failCount++
			log.Printf("[BULK] Failed to send from %s to %s: %v", msg.FromPhone, msg.ToPhone, err)
		} else {
			result.Success = true
			result.MessageID = sendResult.MessageID
			successCount++
			log.Printf("[BULK] Sent from %s to %s, ID: %s", msg.FromPhone, msg.ToPhone, sendResult.MessageID)
		}

		results = append(results, result)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"total":   len(req.Messages),
		"success": successCount,
		"failed":  failCount,
		"results": results,
	})
}

// ConnectRequest represents an account connection request
type ConnectRequest struct {
	Phone string `json:"phone"`
}

// POST /accounts/connect - Connect a WhatsApp account
func (s *Server) handleAccountsConnect(w http.ResponseWriter, r *http.Request) {
	var req ConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return
	}

	if req.Phone == "" {
		writeError(w, http.StatusBadRequest, "phone is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()

	result, err := s.client.ConnectAccount(ctx, req.Phone)
	if err != nil {
		log.Printf("[CONNECT] Error connecting account %s: %v", req.Phone, err)
		writeError(w, http.StatusInternalServerError, "Failed to connect: "+err.Error())
		return
	}

	log.Printf("[CONNECT] Account %s status: %s", req.Phone, result.Status)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":      true,
		"status":       result.Status,
		"phone":        result.Phone,
		"qr_code":      result.QRCode,
		"qr_code_path": result.QRCodePath,
		"logged_in":    result.LoggedIn,
		"device_id":    result.DeviceID,
	})
}

// PairRequest represents a pairing code connection request
type PairRequest struct {
	Phone string `json:"phone"`
}

// POST /accounts/pair - Connect a WhatsApp account using pairing code (faster than QR)
// This method is recommended for Docker environments
func (s *Server) handleAccountsPair(w http.ResponseWriter, r *http.Request) {
	var req PairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return
	}

	if req.Phone == "" {
		writeError(w, http.StatusBadRequest, "phone is required (format: +1234567890)")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	result, err := s.client.ConnectWithPairingCode(ctx, req.Phone)
	if err != nil {
		log.Printf("[PAIR] Error getting pairing code for %s: %v", req.Phone, err)
		writeError(w, http.StatusInternalServerError, "Failed to get pairing code: "+err.Error())
		return
	}

	log.Printf("[PAIR] Account %s status: %s", req.Phone, result.Status)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":      true,
		"status":       result.Status,
		"phone":        result.Phone,
		"pairing_code": result.PairingCode,
		"logged_in":    result.LoggedIn,
		"device_id":    result.DeviceID,
		"instructions": "Open WhatsApp on your phone > Settings > Linked Devices > Link a Device > Link with phone number instead > Enter the pairing code",
	})
}

// DisconnectRequest represents an account disconnection request
type DisconnectRequest struct {
	Phone string `json:"phone"`
}

// POST /accounts/disconnect - Disconnect a WhatsApp account
func (s *Server) handleAccountsDisconnect(w http.ResponseWriter, r *http.Request) {
	var req DisconnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return
	}

	if req.Phone == "" {
		writeError(w, http.StatusBadRequest, "phone is required")
		return
	}

	err := s.client.DisconnectAccount(req.Phone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to disconnect: "+err.Error())
		return
	}

	log.Printf("[DISCONNECT] Account %s disconnected", req.Phone)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"phone":   req.Phone,
		"message": "Account disconnected",
	})
}

// GET /accounts/status?phone=xxx - Get status of a specific account
func (s *Server) handleAccountsStatus(w http.ResponseWriter, r *http.Request) {
	phone := r.URL.Query().Get("phone")
	if phone == "" {
		writeError(w, http.StatusBadRequest, "phone query parameter is required")
		return
	}

	status := s.client.GetAccountStatus(phone)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"account": status,
	})
}

// GET /accounts - List all connected accounts
func (s *Server) handleAccountsList(w http.ResponseWriter, r *http.Request) {
	accounts := s.client.GetAllAccountsStatus()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"count":    len(accounts),
		"accounts": accounts,
	})
}

// POST /accounts/cleanup - Remove all accounts that are not logged in
func (s *Server) handleAccountsCleanup(w http.ResponseWriter, r *http.Request) {
	removed := s.client.CleanupInactiveAccounts()

	// Reset monitor failures for removed accounts
	for _, phone := range removed {
		s.monitor.ResetFailures(phone)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":        true,
		"removed_count":  len(removed),
		"removed_phones": removed,
		"message":        "Inactive accounts removed. They need manual re-pairing.",
	})
}

// GET /monitor/stats - Get connection monitor statistics
func (s *Server) handleMonitorStats(w http.ResponseWriter, r *http.Request) {
	stats := s.monitor.GetReconnectStats()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"monitor": stats,
	})
}

// GET /monitor/revival - Get accounts currently in 48h revival period
func (s *Server) handleRevivalAccounts(w http.ResponseWriter, r *http.Request) {
	accounts := s.monitor.GetRevivalAccounts()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":        true,
		"revival_period": "48 hours",
		"description":    "Accounts that disconnected are given 48 hours of automatic reconnection attempts",
		"count":          len(accounts),
		"accounts":       accounts,
	})
}

// GET /warmup/status - Get warmup status for all accounts
func (s *Server) handleWarmupStatus(w http.ResponseWriter, r *http.Request) {
	statuses := s.client.GetWarmupStatus()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"count":    len(statuses),
		"accounts": statuses,
	})
}

// POST /accounts/{phone}/skip-warmup - Skip warmup for an account
func (s *Server) handleSkipWarmup(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	phone := vars["phone"]

	if phone == "" {
		writeError(w, http.StatusBadRequest, "phone is required")
		return
	}

	err := s.client.SkipWarmup(phone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to skip warmup: "+err.Error())
		return
	}

	log.Printf("[WARMUP] Skipped warmup for account %s", phone)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"phone":   phone,
		"message": "Warmup skipped - account can now send at full capacity",
	})
}

// GET /proxy/stats - Get proxy pool statistics with sticky assignments
func (s *Server) handleProxyStats(w http.ResponseWriter, r *http.Request) {
	var stats map[string]interface{}

	// Get proxy pool from client manager
	proxyPool := s.client.GetProxyPool()

	if proxyPool != nil && proxyPool.IsEnabled() {
		// Get rotation stats
		stats = proxyPool.GetStats()
	} else if s.ProxyConfig != nil && s.ProxyConfig.Enabled {
		stats = map[string]interface{}{
			"mode": "single_proxy",
			"single_proxy": map[string]interface{}{
				"host":    s.ProxyConfig.Host,
				"port":    s.ProxyConfig.Port,
				"type":    s.ProxyConfig.Type,
				"enabled": s.ProxyConfig.Enabled,
			},
		}
	} else {
		stats = map[string]interface{}{
			"mode":          "no_proxy",
			"proxy_enabled": false,
		}
	}

	stats["worker_id"] = s.WorkerID
	stats["proxy_country"] = s.ProxyCountry

	// Add account stats from client manager
	accountStats := s.client.GetAccountStats()
	stats["accounts"] = accountStats

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"proxy":   stats,
	})
}

// POST /accounts/{phone}/reconnect - Manually trigger reconnect for an account
func (s *Server) handleAccountReconnect(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	phone := vars["phone"]

	if phone == "" {
		writeError(w, http.StatusBadRequest, "phone is required")
		return
	}

	err := s.client.TriggerReconnect(phone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to reconnect: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Reconnect triggered for " + phone,
	})
}

// GET /accounts/health - Get health status of all accounts
func (s *Server) handleAccountsHealth(w http.ResponseWriter, r *http.Request) {
	healthMap := s.client.GetAllAccountsHealth()

	accounts := make([]map[string]interface{}, 0)
	for phone, health := range healthMap {
		if health == nil {
			continue
		}
		accounts = append(accounts, map[string]interface{}{
			"phone":                phone,
			"status":               health.Status,
			"last_alive":           health.LastAlive,
			"last_message_sent":    health.LastMessageSent,
			"last_error":           health.LastError,
			"consecutive_failures": health.ConsecutiveFailures,
			"messages_today":       health.MessagesToday,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"accounts": accounts,
	})
}

// GET /activity/logs - Get activity logs for all accounts
func (s *Server) handleActivityLogs(w http.ResponseWriter, r *http.Request) {
	allLogs := s.client.GetAllActivityLogs()

	// Format for response
	result := make(map[string][]map[string]interface{})
	for phone, logs := range allLogs {
		formatted := make([]map[string]interface{}, len(logs))
		for i, log := range logs {
			formatted[i] = map[string]interface{}{
				"time":        log.Time.Format("15:04:05"),
				"timestamp":   log.Time.Unix(),
				"activity":    log.Activity,
				"description": log.Description,
				"details":     log.Details,
			}
		}
		result[phone] = formatted
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"logs":    result,
	})
}

// GET /activity/logs/{phone} - Get activity logs for a specific account
func (s *Server) handleActivityLogsForPhone(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	phone := vars["phone"]

	logs := s.client.GetActivityLogs(phone)

	formatted := make([]map[string]interface{}, len(logs))
	for i, log := range logs {
		formatted[i] = map[string]interface{}{
			"time":        log.Time.Format("15:04:05"),
			"timestamp":   log.Time.Unix(),
			"activity":    log.Activity,
			"description": log.Description,
			"details":     log.Details,
		}
	}

	lastActivity := s.client.GetLastActivity(phone)
	var lastActivityStr string
	if lastActivity != nil {
		lastActivityStr = lastActivity.Format("15:04:05")
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":       true,
		"phone":         phone,
		"logs":          formatted,
		"last_activity": lastActivityStr,
	})
}

// GET /messages/received - Get recent received messages
func (s *Server) handleReceivedMessages(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
			limit = l
		}
	}

	messages := s.client.GetReceivedMessages(limit)

	formatted := make([]map[string]interface{}, len(messages))
	for i, msg := range messages {
		formatted[i] = map[string]interface{}{
			"id":         msg.ID,
			"from":       msg.From,
			"to":         msg.To,
			"message":    msg.Message,
			"timestamp":  msg.Timestamp.Unix(),
			"time":       msg.Timestamp.Format("15:04:05"),
			"is_group":   msg.IsGroup,
			"group_name": msg.GroupName,
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"count":    len(messages),
		"messages": formatted,
	})
}

// GET /messages/received/{phone} - Get received messages for specific account
func (s *Server) handleReceivedMessagesForPhone(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	phone := vars["phone"]

	messages := s.client.GetReceivedMessagesForAccount(phone)

	formatted := make([]map[string]interface{}, len(messages))
	for i, msg := range messages {
		formatted[i] = map[string]interface{}{
			"id":         msg.ID,
			"from":       msg.From,
			"to":         msg.To,
			"message":    msg.Message,
			"timestamp":  msg.Timestamp.Unix(),
			"time":       msg.Timestamp.Format("15:04:05"),
			"is_group":   msg.IsGroup,
			"group_name": msg.GroupName,
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"phone":    phone,
		"count":    len(messages),
		"messages": formatted,
	})
}
