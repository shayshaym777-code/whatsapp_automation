package whatsapp

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	"github.com/whatsapp-automation/worker/internal/fingerprint"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// QRCodeDir is where QR code images are stored
	QRCodeDir = "/data/qrcodes"
	// DefaultSessionsDir for local development
	DefaultSessionsDir = "./sessions"
)

// ClientManager manages WhatsApp client connections for multiple accounts
type ClientManager struct {
	Fingerprint  fingerprint.DeviceFingerprint
	ProxyCountry string
	WorkerID     string

	// Account management
	accounts map[string]*AccountClient // phone -> client
	mu       sync.RWMutex
}

// AccountClient represents a connected WhatsApp account
type AccountClient struct {
	Phone     string
	Client    *whatsmeow.Client
	Container *sqlstore.Container
	Connected bool
	LoggedIn  bool
	QRCode    string // Base64 QR code if pending login
	QRPath    string // Path to QR code image
}

// NewClientManager creates a new client manager for this worker
func NewClientManager(fp fingerprint.DeviceFingerprint, proxyCountry, workerID string) *ClientManager {
	// Ensure directories exist
	os.MkdirAll(QRCodeDir, 0755)
	os.MkdirAll(getSessionsDir(), 0755)

	return &ClientManager{
		Fingerprint:  fp,
		ProxyCountry: proxyCountry,
		WorkerID:     workerID,
		accounts:     make(map[string]*AccountClient),
	}
}

func getSessionsDir() string {
	if _, err := os.Stat("/data/sessions"); err == nil {
		return "/data/sessions"
	}
	return DefaultSessionsDir
}

// ConnectAccount connects a WhatsApp account and returns QR code if needed
func (m *ClientManager) ConnectAccount(ctx context.Context, phone string) (*ConnectResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if already connected
	if acc, exists := m.accounts[phone]; exists && acc.Client != nil {
		if acc.Client.IsLoggedIn() {
			return &ConnectResult{
				Status:   "already_connected",
				Phone:    phone,
				LoggedIn: true,
				DeviceID: acc.Client.Store.ID.String(),
			}, nil
		}
		// If there's a pending QR code, return it
		if acc.QRCode != "" {
			return &ConnectResult{
				Status:     "qr_code",
				Phone:      phone,
				QRCode:     acc.QRCode,
				QRCodePath: acc.QRPath,
				LoggedIn:   false,
			}, nil
		}
	}

	// Initialize session storage
	dbPath := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.db", sanitizePhone(phone)))
	dbURI := fmt.Sprintf("file:%s?_foreign_keys=on", dbPath)

	log.Printf("[%s] Initializing session storage at %s", phone, dbPath)

	dbLog := waLog.Stdout("DB-"+phone, "INFO", true)
	container, err := sqlstore.New(ctx, "sqlite3", dbURI, dbLog)
	if err != nil {
		return nil, fmt.Errorf("failed to create session store: %w", err)
	}

	// Get or create device
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to get device: %w", err)
	}

	if device == nil {
		log.Printf("[%s] Creating new device", phone)
		device = container.NewDevice()
		if err := container.PutDevice(ctx, device); err != nil {
			container.Close()
			return nil, fmt.Errorf("failed to store device: %w", err)
		}
	} else {
		log.Printf("[%s] Using existing device", phone)
	}

	// Configure device properties based on fingerprint
	osName := fmt.Sprintf("Windows %s", m.Fingerprint.ComputerName)
	platform := waCompanionReg.DeviceProps_PlatformType(1) // Chrome
	store.DeviceProps.PlatformType = &platform
	store.DeviceProps.Os = &osName

	// Create WhatsApp client
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client := whatsmeow.NewClient(device, clientLog)
	client.EnableAutoReconnect = true
	client.AutoTrustIdentity = true

	// Create account entry
	acc := &AccountClient{
		Phone:     phone,
		Client:    client,
		Container: container,
		Connected: false,
		LoggedIn:  false,
	}
	m.accounts[phone] = acc

	// Set up event handler
	client.AddEventHandler(func(evt interface{}) {
		m.handleEvent(phone, evt)
	})

	// Check if already logged in (has existing session)
	if client.Store.ID != nil {
		log.Printf("[%s] Existing session found, attempting to connect...", phone)
		err = client.Connect()
		if err != nil {
			log.Printf("[%s] Failed to connect with existing session: %v", phone, err)
		} else {
			acc.Connected = true
			// Wait a moment for login state to update
			time.Sleep(2 * time.Second)
			acc.LoggedIn = client.IsLoggedIn()

			if acc.LoggedIn {
				log.Printf("[%s] Connected with existing session", phone)
				return &ConnectResult{
					Status:   "connected",
					Phone:    phone,
					LoggedIn: true,
					DeviceID: client.Store.ID.String(),
				}, nil
			}
		}
	}

	// Need QR code login - disconnect first if connected
	client.Disconnect()

	// Channel to receive QR code
	qrCodeChan := make(chan string, 1)
	qrErrorChan := make(chan error, 1)

	log.Printf("[%s] Getting QR channel...", phone)
	qrChan, err := client.GetQRChannel(context.Background())
	if err != nil {
		if err == whatsmeow.ErrQRStoreContainsID {
			log.Printf("[%s] Already has session, connecting...", phone)
			err = client.Connect()
			if err != nil {
				return nil, fmt.Errorf("failed to connect: %w", err)
			}
			acc.Connected = true
			acc.LoggedIn = client.IsLoggedIn()
			return &ConnectResult{
				Status:   "connected",
				Phone:    phone,
				LoggedIn: acc.LoggedIn,
			}, nil
		}
		return nil, fmt.Errorf("failed to get QR channel: %w", err)
	}

	// Start goroutine to handle QR events - this runs in background
	go func() {
		for evt := range qrChan {
			log.Printf("[%s] QR Event: %s", phone, evt.Event)
			if evt.Event == "code" {
				// Generate and save QR code
				qrPath, err := m.generateQRImage(phone, evt.Code)
				if err != nil {
					log.Printf("[%s] Failed to generate QR image: %v", phone, err)
				} else {
					log.Printf("[%s] QR code image saved to: %s", phone, qrPath)
				}

				// Update account with QR code
				m.mu.Lock()
				if acc, exists := m.accounts[phone]; exists {
					acc.QRCode = evt.Code
					acc.QRPath = qrPath
				}
				m.mu.Unlock()

				// Send to channel (non-blocking)
				select {
				case qrCodeChan <- evt.Code:
				default:
					log.Printf("[%s] QR code channel full or closed, but QR is saved in account", phone)
				}
				return
			} else if evt.Event == "success" {
				log.Printf("[%s] Login successful via QR!", phone)
				m.mu.Lock()
				if acc, exists := m.accounts[phone]; exists {
					acc.LoggedIn = true
					acc.QRCode = ""
				}
				m.mu.Unlock()
				select {
				case qrErrorChan <- nil:
				default:
				}
				return
			} else if evt.Event == "timeout" {
				select {
				case qrErrorChan <- fmt.Errorf("QR code timeout"):
				default:
				}
				return
			}
		}
	}()

	// Connect to WhatsApp
	log.Printf("[%s] Connecting to WhatsApp...", phone)
	err = client.Connect()
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to connect: %w", err)
	}
	acc.Connected = true

	// Wait for QR code or success
	log.Printf("[%s] Waiting for QR code...", phone)
	select {
	case qrCode := <-qrCodeChan:
		log.Printf("[%s] Received QR code!", phone)
		// Generate QR code image
		qrPath, err := m.generateQRImage(phone, qrCode)
		if err != nil {
			log.Printf("[%s] Failed to generate QR image: %v", phone, err)
		} else {
			log.Printf("[%s] QR code image saved to: %s", phone, qrPath)
		}

		acc.QRCode = qrCode
		acc.QRPath = qrPath

		return &ConnectResult{
			Status:     "qr_code",
			Phone:      phone,
			QRCode:     qrCode,
			QRCodePath: qrPath,
			LoggedIn:   false,
		}, nil

	case err := <-qrErrorChan:
		if err != nil {
			return &ConnectResult{
				Status: "error",
				Phone:  phone,
			}, err
		}
		// Success
		return &ConnectResult{
			Status:   "connected",
			Phone:    phone,
			LoggedIn: true,
		}, nil

	case <-time.After(180 * time.Second):
		log.Printf("[%s] Timeout waiting for QR code (180s) - checking if QR was saved...", phone)
		// Check if QR code was saved by the background goroutine
		m.mu.RLock()
		if savedAcc, exists := m.accounts[phone]; exists && savedAcc.QRCode != "" {
			qrCode := savedAcc.QRCode
			qrPath := savedAcc.QRPath
			m.mu.RUnlock()
			log.Printf("[%s] QR code was saved by background process!", phone)
			return &ConnectResult{
				Status:     "qr_code",
				Phone:      phone,
				QRCode:     qrCode,
				QRCodePath: qrPath,
				LoggedIn:   false,
			}, nil
		}
		m.mu.RUnlock()

		// Return pending status - QR code may still arrive
		return &ConnectResult{
			Status: "pending",
			Phone:  phone,
		}, nil

	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// ConnectResult represents the result of a connection attempt
type ConnectResult struct {
	Status      string `json:"status"` // "connected", "qr_code", "already_connected", "timeout", "pending", "error", "pairing_code"
	Phone       string `json:"phone"`
	QRCode      string `json:"qr_code,omitempty"`
	QRCodePath  string `json:"qr_code_path,omitempty"`
	PairingCode string `json:"pairing_code,omitempty"` // 8-digit pairing code (XXXX-XXXX format)
	LoggedIn    bool   `json:"logged_in"`
	DeviceID    string `json:"device_id,omitempty"`
}

// ConnectWithPairingCode connects a WhatsApp account using pairing code method
// This is faster and more reliable than QR code, especially in Docker environments
func (m *ClientManager) ConnectWithPairingCode(ctx context.Context, phone string) (*ConnectResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if already connected
	if acc, exists := m.accounts[phone]; exists && acc.Client != nil {
		if acc.Client.IsLoggedIn() {
			return &ConnectResult{
				Status:   "already_connected",
				Phone:    phone,
				LoggedIn: true,
				DeviceID: acc.Client.Store.ID.String(),
			}, nil
		}
	}

	// Initialize session storage
	dbPath := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.db", sanitizePhone(phone)))
	dbURI := fmt.Sprintf("file:%s?_foreign_keys=on", dbPath)

	log.Printf("[%s] Initializing session storage for pairing code at %s", phone, dbPath)

	dbLog := waLog.Stdout("DB-"+phone, "INFO", true)
	container, err := sqlstore.New(ctx, "sqlite3", dbURI, dbLog)
	if err != nil {
		return nil, fmt.Errorf("failed to create session store: %w", err)
	}

	// Get or create device
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to get device: %w", err)
	}

	if device == nil {
		log.Printf("[%s] Creating new device for pairing code", phone)
		device = container.NewDevice()
		if err := container.PutDevice(ctx, device); err != nil {
			container.Close()
			return nil, fmt.Errorf("failed to store device: %w", err)
		}
	}

	// Configure device properties based on fingerprint
	osName := fmt.Sprintf("Windows %s", m.Fingerprint.ComputerName)
	platform := waCompanionReg.DeviceProps_PlatformType(1) // Chrome
	store.DeviceProps.PlatformType = &platform
	store.DeviceProps.Os = &osName

	// Create WhatsApp client
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client := whatsmeow.NewClient(device, clientLog)
	client.EnableAutoReconnect = true
	client.AutoTrustIdentity = true

	// Create account entry
	acc := &AccountClient{
		Phone:     phone,
		Client:    client,
		Container: container,
		Connected: false,
		LoggedIn:  false,
	}
	m.accounts[phone] = acc

	// Set up event handler
	client.AddEventHandler(func(evt interface{}) {
		m.handleEvent(phone, evt)
	})

	// Check if already logged in (has existing session)
	if client.Store.ID != nil {
		log.Printf("[%s] Existing session found, attempting to connect...", phone)
		err = client.Connect()
		if err != nil {
			log.Printf("[%s] Failed to connect with existing session: %v", phone, err)
		} else {
			acc.Connected = true
			time.Sleep(2 * time.Second)
			acc.LoggedIn = client.IsLoggedIn()

			if acc.LoggedIn {
				log.Printf("[%s] Connected with existing session", phone)
				return &ConnectResult{
					Status:   "connected",
					Phone:    phone,
					LoggedIn: true,
					DeviceID: client.Store.ID.String(),
				}, nil
			}
		}
	}

	// Connect first (required for pairing code)
	log.Printf("[%s] Connecting to WhatsApp for pairing code...", phone)
	err = client.Connect()
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to connect: %w", err)
	}
	acc.Connected = true

	// Request pairing code
	// The phone number must be in format: country code + number (e.g., 1234567890 for +1234567890)
	phoneNumber := sanitizePhone(phone)
	log.Printf("[%s] Requesting pairing code for phone: %s", phone, phoneNumber)

	pairingCode, err := client.PairPhone(ctx, phoneNumber, true, whatsmeow.PairClientChrome, "Chrome (Windows)")
	if err != nil {
		log.Printf("[%s] Failed to get pairing code: %v", phone, err)
		return nil, fmt.Errorf("failed to get pairing code: %w", err)
	}

	log.Printf("[%s] Pairing code received: %s", phone, pairingCode)

	// Format pairing code as XXXX-XXXX
	formattedCode := pairingCode
	if len(pairingCode) == 8 {
		formattedCode = pairingCode[:4] + "-" + pairingCode[4:]
	}

	return &ConnectResult{
		Status:      "pairing_code",
		Phone:       phone,
		PairingCode: formattedCode,
		LoggedIn:    false,
	}, nil
}

// generateQRImage creates a QR code image file
func (m *ClientManager) generateQRImage(phone, code string) (string, error) {
	filename := fmt.Sprintf("qr-%s-%s.png", sanitizePhone(phone), uuid.New().String()[:8])
	qrPath := filepath.Join(QRCodeDir, filename)

	err := qrcode.WriteFile(code, qrcode.Medium, 512, qrPath)
	if err != nil {
		return "", err
	}

	return qrPath, nil
}

// handleEvent processes WhatsApp events for an account
func (m *ClientManager) handleEvent(phone string, evt interface{}) {
	m.mu.Lock()
	acc, exists := m.accounts[phone]
	m.mu.Unlock()

	if !exists {
		return
	}

	switch v := evt.(type) {
	case *events.Connected:
		log.Printf("[%s] Connected to WhatsApp", phone)
		m.mu.Lock()
		acc.Connected = true
		acc.LoggedIn = true
		acc.QRCode = ""
		m.mu.Unlock()

	case *events.LoggedOut:
		log.Printf("[%s] Logged out from WhatsApp: %v", phone, v.Reason)
		m.mu.Lock()
		acc.LoggedIn = false
		m.mu.Unlock()

	case *events.Disconnected:
		log.Printf("[%s] Disconnected from WhatsApp", phone)
		m.mu.Lock()
		acc.Connected = false
		m.mu.Unlock()

	case *events.PairSuccess:
		log.Printf("[%s] Successfully paired with device: %s", phone, v.ID.String())
		m.mu.Lock()
		acc.LoggedIn = true
		acc.QRCode = ""
		m.mu.Unlock()

	case *events.Message:
		log.Printf("[%s] Received message from %s", phone, v.Info.Sender.String())
	}
}

// SendMessage sends a text message from one account to a recipient
func (m *ClientManager) SendMessage(ctx context.Context, fromPhone, toPhone, message string) (*SendResult, error) {
	m.mu.RLock()
	acc, exists := m.accounts[fromPhone]
	m.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("account %s not connected", fromPhone)
	}

	if !acc.LoggedIn {
		return nil, fmt.Errorf("account %s not logged in", fromPhone)
	}

	// Parse recipient JID
	recipientJID, err := parseJID(toPhone)
	if err != nil {
		return nil, fmt.Errorf("invalid recipient phone: %w", err)
	}

	// Create message
	msg := &waE2E.Message{
		Conversation: proto.String(message),
	}

	// Send message
	resp, err := acc.Client.SendMessage(ctx, recipientJID, msg)
	if err != nil {
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	return &SendResult{
		MessageID: resp.ID,
		Timestamp: resp.Timestamp.Unix(),
		FromPhone: fromPhone,
		ToPhone:   toPhone,
	}, nil
}

// SendResult represents the result of sending a message
type SendResult struct {
	MessageID string `json:"message_id"`
	Timestamp int64  `json:"timestamp"`
	FromPhone string `json:"from_phone"`
	ToPhone   string `json:"to_phone"`
}

// GetAccountStatus returns the status of a connected account
func (m *ClientManager) GetAccountStatus(phone string) *AccountStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	acc, exists := m.accounts[phone]
	if !exists {
		return &AccountStatus{
			Phone:     phone,
			Connected: false,
			LoggedIn:  false,
		}
	}

	status := &AccountStatus{
		Phone:     phone,
		Connected: acc.Connected,
		LoggedIn:  acc.LoggedIn,
	}

	if acc.Client != nil && acc.Client.Store.ID != nil {
		status.DeviceID = acc.Client.Store.ID.String()
	}

	if acc.QRCode != "" {
		status.PendingQR = true
		status.QRCode = acc.QRCode
		status.QRPath = acc.QRPath
	}

	return status
}

// AccountStatus represents the status of an account
type AccountStatus struct {
	Phone     string `json:"phone"`
	Connected bool   `json:"connected"`
	LoggedIn  bool   `json:"logged_in"`
	DeviceID  string `json:"device_id,omitempty"`
	PendingQR bool   `json:"pending_qr,omitempty"`
	QRCode    string `json:"qr_code,omitempty"`
	QRPath    string `json:"qr_path,omitempty"`
}

// GetAllAccountsStatus returns status of all connected accounts
func (m *ClientManager) GetAllAccountsStatus() []*AccountStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	statuses := make([]*AccountStatus, 0, len(m.accounts))
	for phone, acc := range m.accounts {
		status := &AccountStatus{
			Phone:     phone,
			Connected: acc.Connected,
			LoggedIn:  acc.LoggedIn,
		}
		if acc.Client != nil && acc.Client.Store.ID != nil {
			status.DeviceID = acc.Client.Store.ID.String()
		}
		if acc.QRCode != "" {
			status.PendingQR = true
			status.QRCode = acc.QRCode
			status.QRPath = acc.QRPath
		}
		statuses = append(statuses, status)
	}

	return statuses
}

// DisconnectAccount disconnects a WhatsApp account
func (m *ClientManager) DisconnectAccount(phone string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	acc, exists := m.accounts[phone]
	if !exists {
		return fmt.Errorf("account %s not found", phone)
	}

	if acc.Client != nil {
		acc.Client.Disconnect()
	}

	if acc.Container != nil {
		acc.Container.Close()
	}

	delete(m.accounts, phone)
	return nil
}

// HealthSummary returns a summary for health checks
func (m *ClientManager) HealthSummary() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	connectedCount := 0
	loggedInCount := 0

	for _, acc := range m.accounts {
		if acc.Connected {
			connectedCount++
		}
		if acc.LoggedIn {
			loggedInCount++
		}
	}

	return map[string]interface{}{
		"total_accounts":  len(m.accounts),
		"connected_count": connectedCount,
		"logged_in_count": loggedInCount,
		"proxy_country":   m.ProxyCountry,
		"worker_id":       m.WorkerID,
		"fingerprint":     m.Fingerprint.ToMap(),
	}
}

// Helper functions

func sanitizePhone(phone string) string {
	// Remove all non-numeric characters except leading +
	result := strings.Builder{}
	for i, r := range phone {
		if r == '+' && i == 0 {
			continue // Skip leading +
		}
		if r >= '0' && r <= '9' {
			result.WriteRune(r)
		}
	}
	return result.String()
}

func parseJID(phone string) (types.JID, error) {
	phone = sanitizePhone(phone)
	if phone == "" {
		return types.JID{}, fmt.Errorf("empty phone number")
	}

	return types.NewJID(phone, types.DefaultUserServer), nil
}
