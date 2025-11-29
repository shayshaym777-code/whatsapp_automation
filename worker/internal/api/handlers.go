package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/mux"

	"github.com/whatsapp-automation/worker/internal/fingerprint"
	"github.com/whatsapp-automation/worker/internal/whatsapp"
)

// Server represents the HTTP API server for the worker
type Server struct {
	WorkerID     string
	DeviceSeed   string
	ProxyCountry string
	Fingerprint  fingerprint.DeviceFingerprint
	client       *whatsapp.ClientManager
}

// NewServer creates a new API server instance
func NewServer(workerID, deviceSeed, proxyCountry string, fp fingerprint.DeviceFingerprint) (*Server, error) {
	client := whatsapp.NewClientManager(fp, proxyCountry, workerID)

	return &Server{
		WorkerID:     workerID,
		DeviceSeed:   deviceSeed,
		ProxyCountry: proxyCountry,
		Fingerprint:  fp,
		client:       client,
	}, nil
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
