package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
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

	"github.com/whatsapp-automation/worker/internal/config"
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

	// Auto warmup control
	warmupStop chan struct{}

	// Proxy configuration
	proxyConfig *config.ProxyConfig
	proxyPool   *config.ProxyPool // Pool for sticky proxy assignment
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

	// State tracking to reduce log spam
	lastConnectedState bool
	lastLoggedInState  bool
	lastStateChange    time.Time

	// Warmup tracking for new accounts
	CreatedAt      time.Time // When account was first connected
	LastWarmupSent time.Time // Last warmup message time
	WarmupComplete bool      // True after 3 days of warmup

	// Proxy assignment - each account gets a dedicated proxy
	AssignedProxy    string // Full proxy URL assigned to this account
	ProxyFailCount   int    // Number of consecutive proxy failures
	LastProxyFailure time.Time
}

// NewClientManager creates a new client manager for this worker
func NewClientManager(fp fingerprint.DeviceFingerprint, proxyCountry, workerID string, proxyConfig *config.ProxyConfig) *ClientManager {
	// Ensure directories exist
	os.MkdirAll(QRCodeDir, 0755)
	os.MkdirAll(getSessionsDir(), 0755)

	// Load proxy pool for sticky assignment
	proxyPool := config.LoadProxyPool()
	log.Printf("[ClientManager] Initialized with %d proxies for sticky assignment", proxyPool.Count())

	return &ClientManager{
		Fingerprint:  fp,
		ProxyCountry: proxyCountry,
		WorkerID:     workerID,
		accounts:     make(map[string]*AccountClient),
		proxyConfig:  proxyConfig,
		proxyPool:    proxyPool,
	}
}

// GetProxyPool returns the proxy pool (for handlers to access stats)
func (m *ClientManager) GetProxyPool() *config.ProxyPool {
	return m.proxyPool
}

// createClientWithProxy creates a WhatsApp client with optional proxy support
func (m *ClientManager) createClientWithProxy(device *store.Device, clientLog waLog.Logger, assignedProxyURL string) (*whatsmeow.Client, error) {
	client := whatsmeow.NewClient(device, clientLog)
	client.EnableAutoReconnect = true
	client.AutoTrustIdentity = true

	// Use assigned proxy if provided (sticky assignment)
	if assignedProxyURL != "" {
		err := client.SetProxyAddress(assignedProxyURL)
		if err != nil {
			return nil, fmt.Errorf("failed to set assigned proxy address: %w", err)
		}
		log.Printf("[Proxy] Using ASSIGNED proxy: %s", truncateProxy(assignedProxyURL))
		return client, nil
	}

	// Fallback to single proxy config if no assignment
	if m.proxyConfig != nil && m.proxyConfig.Enabled {
		proxyURL := m.proxyConfig.GetURL()
		if proxyURL != "" {
			err := client.SetProxyAddress(proxyURL)
			if err != nil {
				return nil, fmt.Errorf("failed to set proxy address: %w", err)
			}
			log.Printf("[Proxy] Using fallback proxy: %s", m.proxyConfig.String())
		}
	}

	return client, nil
}

// GetProxyConfig returns the current proxy configuration
func (m *ClientManager) GetProxyConfig() *config.ProxyConfig {
	return m.proxyConfig
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

	// Load existing metadata FIRST to get assigned proxy
	meta := m.loadAccountMeta(phone)
	isNewAccount := meta == nil

	// Determine which proxy to use
	var assignedProxy string
	if meta != nil && meta.AssignedProxy != "" {
		// Use existing assigned proxy
		assignedProxy = meta.AssignedProxy
		log.Printf("[%s] Using existing assigned proxy: %s", phone, truncateProxy(assignedProxy))
	} else if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		// Assign a new proxy from the pool
		proxy := m.proxyPool.AssignProxyToPhone(phone)
		if proxy.Enabled {
			assignedProxy = proxy.GetURL()
			log.Printf("[%s] Assigned NEW proxy: %s", phone, truncateProxy(assignedProxy))
		}
	}

	// Create WhatsApp client with the assigned proxy
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client, err := m.createClientWithProxy(device, clientLog, assignedProxy)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to create client with proxy: %w", err)
	}

	// Create account entry
	acc := &AccountClient{
		Phone:         phone,
		Client:        client,
		Container:     container,
		Connected:     false,
		LoggedIn:      false,
		AssignedProxy: assignedProxy,
	}

	// Apply rest of metadata
	m.applyAccountMeta(acc, meta)

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
				// Save meta if new account
				if isNewAccount {
					m.saveAccountMeta(phone, acc)
					log.Printf("[%s] New account - warmup period started (3 days)", phone)
				}
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

	// Load existing metadata FIRST to get assigned proxy
	metaPair := m.loadAccountMeta(phone)
	isNewAccountPair := metaPair == nil

	// Determine which proxy to use
	var assignedProxyPair string
	if metaPair != nil && metaPair.AssignedProxy != "" {
		// Use existing assigned proxy
		assignedProxyPair = metaPair.AssignedProxy
		log.Printf("[%s] Using existing assigned proxy: %s", phone, truncateProxy(assignedProxyPair))
	} else if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		// Assign a new proxy from the pool
		proxy := m.proxyPool.AssignProxyToPhone(phone)
		if proxy.Enabled {
			assignedProxyPair = proxy.GetURL()
			log.Printf("[%s] Assigned NEW proxy for pairing: %s", phone, truncateProxy(assignedProxyPair))
		}
	}

	// Create WhatsApp client with the assigned proxy
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client, err := m.createClientWithProxy(device, clientLog, assignedProxyPair)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to create client with proxy: %w", err)
	}

	// Create account entry
	acc := &AccountClient{
		Phone:         phone,
		Client:        client,
		Container:     container,
		Connected:     false,
		LoggedIn:      false,
		AssignedProxy: assignedProxyPair,
	}

	// Apply rest of metadata
	m.applyAccountMeta(acc, metaPair)

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
				// Save meta if new account (includes proxy assignment)
				if isNewAccountPair {
					m.saveAccountMeta(phone, acc)
					log.Printf("[%s] New account - warmup period started (3 days)", phone)
				}
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
// Only logs state CHANGES to reduce log spam
func (m *ClientManager) handleEvent(phone string, evt interface{}) {
	m.mu.Lock()
	acc, exists := m.accounts[phone]
	if !exists {
		m.mu.Unlock()
		return
	}

	switch v := evt.(type) {
	case *events.Connected:
		// Only log if state actually changed
		if !acc.lastConnectedState || !acc.lastLoggedInState {
			log.Printf("[%s] Connected to WhatsApp", phone)
		}
		acc.Connected = true
		acc.LoggedIn = true
		acc.QRCode = ""
		acc.lastConnectedState = true
		acc.lastLoggedInState = true
		acc.lastStateChange = time.Now()
		m.mu.Unlock()

	case *events.LoggedOut:
		// Always log logout - it's important
		log.Printf("[%s] Logged out from WhatsApp: %v", phone, v.Reason)
		acc.LoggedIn = false
		acc.lastLoggedInState = false
		acc.lastStateChange = time.Now()
		m.mu.Unlock()

	case *events.Disconnected:
		// Only log if state actually changed
		if acc.lastConnectedState {
			log.Printf("[%s] Disconnected from WhatsApp", phone)
		}
		acc.Connected = false
		acc.lastConnectedState = false
		acc.lastStateChange = time.Now()
		m.mu.Unlock()

	case *events.PairSuccess:
		log.Printf("[%s] Successfully paired with device: %s", phone, v.ID.String())
		acc.LoggedIn = true
		acc.QRCode = ""
		acc.lastLoggedInState = true
		acc.lastStateChange = time.Now()
		// For new accounts, CreatedAt is already set. Save meta now.
		isNewAccount := acc.CreatedAt.IsZero()
		if isNewAccount {
			acc.CreatedAt = time.Now()
		}
		m.mu.Unlock()
		// Save metadata for new account
		if err := m.saveAccountMeta(phone, acc); err != nil {
			log.Printf("[%s] Failed to save account meta after pairing: %v", phone, err)
		} else {
			log.Printf("[%s] New account - warmup period started (3 days)", phone)
		}
		// Register with Master server for warmup tracking
		if isNewAccount {
			go m.registerWithMaster(phone)
		}

	case *events.Message:
		m.mu.Unlock()
		// Don't log every message - too spammy
		// log.Printf("[%s] Received message from %s", phone, v.Info.Sender.String())

	default:
		m.mu.Unlock()
	}
}

// SendMessage sends a text message from one account to a recipient
// Includes anti-ban measures: typing simulation, message variation, health reporting
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

	// === ANTI-BAN: Apply message variation ===
	variedMessage := applyMessageVariation(message)

	// === ANTI-BAN: Simulate typing (human-like delay) ===
	typingDelay := calculateTypingDelay(variedMessage)

	// Send "composing" presence to show typing indicator
	if err := acc.Client.SendPresence(types.PresenceAvailable); err != nil {
		log.Printf("[%s] Failed to send presence: %v", fromPhone, err)
	}

	// Wait for typing simulation
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(typingDelay):
	}

	// Create message
	msg := &waE2E.Message{
		Conversation: proto.String(variedMessage),
	}

	// Send message
	resp, err := acc.Client.SendMessage(ctx, recipientJID, msg)

	// === Report to Master for health tracking ===
	go m.reportMessageToMaster(fromPhone, err == nil, err)

	if err != nil {
		// Check if this might be a proxy failure
		if isProxyError(err) {
			m.handleProxyFailure(fromPhone, acc)
		}
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	// Reset proxy failure count on success
	if acc.ProxyFailCount > 0 {
		acc.ProxyFailCount = 0
		log.Printf("[%s] Proxy failure count reset after successful send", fromPhone)
	}

	log.Printf("[%s] Message sent to %s (typing delay: %v, proxy: %s)", fromPhone, toPhone, typingDelay, truncateProxy(acc.AssignedProxy))

	return &SendResult{
		MessageID: resp.ID,
		Timestamp: resp.Timestamp.Unix(),
		FromPhone: fromPhone,
		ToPhone:   toPhone,
	}, nil
}

// isProxyError checks if an error is likely proxy-related
func isProxyError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	proxyErrors := []string{
		"proxy",
		"socks",
		"connection refused",
		"connection reset",
		"timeout",
		"network unreachable",
		"host unreachable",
		"no route to host",
		"i/o timeout",
	}
	for _, pe := range proxyErrors {
		if strings.Contains(errStr, pe) {
			return true
		}
	}
	return false
}

// handleProxyFailure handles proxy failures and potentially reassigns proxy
func (m *ClientManager) handleProxyFailure(phone string, acc *AccountClient) {
	acc.ProxyFailCount++
	acc.LastProxyFailure = time.Now()
	
	log.Printf("[%s] Proxy failure #%d for proxy: %s", phone, acc.ProxyFailCount, truncateProxy(acc.AssignedProxy))
	
	// After 3 consecutive failures, try to reassign proxy
	if acc.ProxyFailCount >= 3 && m.proxyPool != nil && m.proxyPool.Count() > 1 {
		log.Printf("[%s] Too many proxy failures, attempting to reassign proxy...", phone)
		
		newProxy := m.proxyPool.ReassignProxy(phone)
		if newProxy.Enabled && newProxy.GetURL() != acc.AssignedProxy {
			oldProxy := acc.AssignedProxy
			acc.AssignedProxy = newProxy.GetURL()
			acc.ProxyFailCount = 0
			
			// Save the new assignment
			if err := m.saveAccountMeta(phone, acc); err != nil {
				log.Printf("[%s] Failed to save new proxy assignment: %v", phone, err)
			}
			
			log.Printf("[%s] PROXY REASSIGNED: %s -> %s", phone, truncateProxy(oldProxy), truncateProxy(acc.AssignedProxy))
			
			// Note: The client will use the new proxy on next reconnect
			// For immediate effect, we could disconnect and reconnect, but that's disruptive
		}
	}

// applyMessageVariation adds invisible characters for uniqueness
func applyMessageVariation(message string) string {
	// Zero-width characters for invisible variation
	zeroWidth := []string{
		"\u200B", // Zero-width space
		"\u200C", // Zero-width non-joiner
		"\u200D", // Zero-width joiner
	}

	// Add 1-2 invisible characters at random positions
	result := message
	numChars := 1 + rand.Intn(2)

	for i := 0; i < numChars; i++ {
		char := zeroWidth[rand.Intn(len(zeroWidth))]
		pos := rand.Intn(len(result) + 1)
		result = result[:pos] + char + result[pos:]
	}

	return result
}

// calculateTypingDelay simulates human typing speed
func calculateTypingDelay(message string) time.Duration {
	// Base: 50-150ms per character
	charCount := len(message)
	perCharMs := 50 + rand.Intn(100)
	typingTime := charCount * perCharMs

	// Add word pauses (100-200ms between words)
	wordCount := len(strings.Fields(message))
	wordPauseMs := wordCount * (100 + rand.Intn(100))

	// Add "thinking" pause (1-3 seconds)
	thinkingMs := 1000 + rand.Intn(2000)

	totalMs := typingTime + wordPauseMs + thinkingMs

	// Cap at 15 seconds for long messages
	if totalMs > 15000 {
		totalMs = 15000
	}

	// Minimum 2 seconds
	if totalMs < 2000 {
		totalMs = 2000
	}

	return time.Duration(totalMs) * time.Millisecond
}

// reportMessageToMaster reports message success/failure to Master for health tracking
func (m *ClientManager) reportMessageToMaster(phone string, success bool, sendErr error) {
	masterURL := os.Getenv("MASTER_URL")
	if masterURL == "" {
		masterURL = "http://master:5000"
	}

	url := fmt.Sprintf("%s/api/accounts/%s/health/message", masterURL, phone)

	payload := map[string]interface{}{
		"success": success,
	}
	if sendErr != nil {
		payload["error"] = sendErr.Error()
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
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

// CleanupInactiveAccounts removes accounts that are not logged in
// These accounts need manual re-pairing and should not stay in memory
func (m *ClientManager) CleanupInactiveAccounts() []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var removed []string
	for phone, account := range m.accounts {
		if !account.LoggedIn {
			// Disconnect client if exists
			if account.Client != nil {
				account.Client.Disconnect()
			}
			// Close container/database
			if account.Container != nil {
				account.Container.Close()
			}
			delete(m.accounts, phone)
			removed = append(removed, phone)
			log.Printf("[%s] Removed from memory - not logged in (needs re-pairing)", phone)
		}
	}

	if len(removed) > 0 {
		log.Printf("[CLEANUP] Removed %d inactive accounts: %v", len(removed), removed)
	}

	return removed
}

// LoadExistingSessions loads and connects sessions from the sessions directory
// Only loads sessions that have valid logged-in state
func (m *ClientManager) LoadExistingSessions(ctx context.Context) (int, int, error) {
	sessionsDir := getSessionsDir()

	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[STARTUP] Sessions directory does not exist: %s", sessionsDir)
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("failed to read sessions directory: %w", err)
	}

	loaded := 0
	skipped := 0

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".db") {
			continue
		}

		// Extract phone from filename (e.g., "1234567890.db" -> "1234567890")
		phone := strings.TrimSuffix(entry.Name(), ".db")
		if phone == "" {
			continue
		}

		// Try to load and validate the session
		valid, err := m.loadAndValidateSession(ctx, phone)
		if err != nil {
			log.Printf("[STARTUP] Error loading session for %s: %v", phone, err)
			skipped++
			continue
		}

		if valid {
			loaded++
			log.Printf("[STARTUP] Loaded valid session: %s", phone)
		} else {
			skipped++
			log.Printf("[STARTUP] Skipped invalid/not-logged-in session: %s", phone)
		}
	}

	log.Printf("[STARTUP] Session loading complete: %d loaded, %d skipped", loaded, skipped)
	return loaded, skipped, nil
}

// loadAndValidateSession attempts to load a session and verify it's logged in
func (m *ClientManager) loadAndValidateSession(ctx context.Context, phone string) (bool, error) {
	dbPath := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.db", phone))
	dbURI := fmt.Sprintf("file:%s?_foreign_keys=on", dbPath)

	// Use quieter logging for startup
	dbLog := waLog.Stdout("DB-"+phone, "WARN", true)
	container, err := sqlstore.New(ctx, "sqlite3", dbURI, dbLog)
	if err != nil {
		return false, fmt.Errorf("failed to open session store: %w", err)
	}

	// Get device
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		container.Close()
		return false, fmt.Errorf("failed to get device: %w", err)
	}

	if device == nil {
		container.Close()
		return false, nil // No device stored
	}

	// Check if device has a valid ID (was logged in before)
	if device.ID == nil {
		container.Close()
		return false, nil // Never completed login
	}

	// Configure device properties
	osName := fmt.Sprintf("Windows %s", m.Fingerprint.ComputerName)
	platform := waCompanionReg.DeviceProps_PlatformType(1) // Chrome
	store.DeviceProps.PlatformType = &platform
	store.DeviceProps.Os = &osName

	// Load existing metadata FIRST to get assigned proxy
	loadedMeta := m.loadAccountMeta(phone)

	// Determine which proxy to use
	var assignedProxyLoad string
	if loadedMeta != nil && loadedMeta.AssignedProxy != "" {
		// Use existing assigned proxy
		assignedProxyLoad = loadedMeta.AssignedProxy
		log.Printf("[%s] Restoring assigned proxy: %s", phone, truncateProxy(assignedProxyLoad))
	} else if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		// Assign a new proxy from the pool (shouldn't happen for existing sessions)
		proxy := m.proxyPool.AssignProxyToPhone(phone)
		if proxy.Enabled {
			assignedProxyLoad = proxy.GetURL()
			log.Printf("[%s] Assigned proxy for existing session: %s", phone, truncateProxy(assignedProxyLoad))
		}
	}

	// Create client with quieter logging and the assigned proxy
	clientLog := waLog.Stdout("Client-"+phone, "WARN", true)
	client, err := m.createClientWithProxy(device, clientLog, assignedProxyLoad)
	if err != nil {
		container.Close()
		return false, fmt.Errorf("failed to create client with proxy: %w", err)
	}

	// Create account entry
	acc := &AccountClient{
		Phone:              phone,
		Client:             client,
		Container:          container,
		Connected:          false,
		LoggedIn:           false,
		lastConnectedState: false,
		lastLoggedInState:  false,
		AssignedProxy:      assignedProxyLoad,
	}

	// Apply rest of metadata
	m.applyAccountMeta(acc, loadedMeta)

	// Set up event handler
	client.AddEventHandler(func(evt interface{}) {
		m.handleEvent(phone, evt)
	})

	// Try to connect
	err = client.Connect()
	if err != nil {
		container.Close()
		return false, fmt.Errorf("failed to connect: %w", err)
	}

	// Wait for connection to establish
	time.Sleep(3 * time.Second)

	// Check if actually logged in
	if !client.IsLoggedIn() {
		client.Disconnect()
		container.Close()
		return false, nil // Session exists but not valid anymore
	}

	// Session is valid - add to accounts
	m.mu.Lock()
	acc.Connected = true
	acc.LoggedIn = true
	acc.lastConnectedState = true
	acc.lastLoggedInState = true
	acc.lastStateChange = time.Now()
	m.accounts[phone] = acc
	m.mu.Unlock()

	// Log warmup status
	if !acc.WarmupComplete {
		accountAge := time.Since(acc.CreatedAt)
		remainingWarmup := (3 * 24 * time.Hour) - accountAge
		if remainingWarmup > 0 {
			log.Printf("[%s] Account in warmup period - %v remaining", phone, remainingWarmup.Round(time.Hour))
		}
	}

	return true, nil
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

// AccountMeta stores persistent metadata about an account
type AccountMeta struct {
	CreatedAt      string `json:"created_at"`
	LastWarmupSent string `json:"last_warmup_sent,omitempty"`
	WarmupComplete bool   `json:"warmup_complete"`
	AssignedProxy  string `json:"assigned_proxy,omitempty"` // Dedicated proxy URL for this account
}

// saveAccountMeta saves account metadata to a JSON file
func (m *ClientManager) saveAccountMeta(phone string, acc *AccountClient) error {
	metaFile := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.meta.json", sanitizePhone(phone)))

	meta := AccountMeta{
		CreatedAt:      acc.CreatedAt.Format(time.RFC3339),
		WarmupComplete: acc.WarmupComplete,
		AssignedProxy:  acc.AssignedProxy, // Save dedicated proxy assignment
	}
	if !acc.LastWarmupSent.IsZero() {
		meta.LastWarmupSent = acc.LastWarmupSent.Format(time.RFC3339)
	}

	jsonData, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal meta: %w", err)
	}

	if err := os.WriteFile(metaFile, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write meta file: %w", err)
	}

	log.Printf("[%s] Saved account meta (proxy: %s)", phone, truncateProxy(acc.AssignedProxy))
	return nil
}

// truncateProxy returns a shortened proxy URL for logging
func truncateProxy(proxyURL string) string {
	if proxyURL == "" {
		return "none"
	}
	if len(proxyURL) > 50 {
		return proxyURL[:50] + "..."
	}
	return proxyURL
}

// loadAccountMeta loads account metadata from a JSON file
func (m *ClientManager) loadAccountMeta(phone string) *AccountMeta {
	metaFile := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.meta.json", sanitizePhone(phone)))

	data, err := os.ReadFile(metaFile)
	if err != nil {
		// No meta file exists - this is a new account
		return nil
	}

	var meta AccountMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		log.Printf("[%s] Failed to parse meta file: %v", phone, err)
		return nil
	}

	return &meta
}

// applyAccountMeta applies loaded metadata to an account
func (m *ClientManager) applyAccountMeta(acc *AccountClient, meta *AccountMeta) {
	if meta == nil {
		// New account - set CreatedAt to now
		acc.CreatedAt = time.Now()
		acc.WarmupComplete = false
		return
	}

	// Parse CreatedAt
	if createdAt, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
		acc.CreatedAt = createdAt
	} else {
		acc.CreatedAt = time.Now()
	}

	// Parse LastWarmupSent
	if meta.LastWarmupSent != "" {
		if lastWarmup, err := time.Parse(time.RFC3339, meta.LastWarmupSent); err == nil {
			acc.LastWarmupSent = lastWarmup
		}
	}

	acc.WarmupComplete = meta.WarmupComplete

	// Restore assigned proxy
	if meta.AssignedProxy != "" {
		acc.AssignedProxy = meta.AssignedProxy
		log.Printf("[%s] Restored assigned proxy from meta: %s", acc.Phone, truncateProxy(acc.AssignedProxy))
	}
}

// UpdateWarmupSent updates the last warmup sent time and saves metadata
func (m *ClientManager) UpdateWarmupSent(phone string) {
	m.mu.Lock()
	acc, exists := m.accounts[phone]
	if !exists {
		m.mu.Unlock()
		return
	}
	acc.LastWarmupSent = time.Now()
	m.mu.Unlock()

	// Save to file
	if err := m.saveAccountMeta(phone, acc); err != nil {
		log.Printf("[%s] Failed to save warmup meta: %v", phone, err)
	}
}

// MarkWarmupComplete marks an account's warmup as complete
func (m *ClientManager) MarkWarmupComplete(phone string) {
	m.mu.Lock()
	acc, exists := m.accounts[phone]
	if !exists {
		m.mu.Unlock()
		return
	}
	acc.WarmupComplete = true
	m.mu.Unlock()

	// Save to file
	if err := m.saveAccountMeta(phone, acc); err != nil {
		log.Printf("[%s] Failed to save warmup complete meta: %v", phone, err)
	}
	log.Printf("[%s] Warmup complete! Account is now fully warmed up.", phone)
}

// GetActiveAccounts returns all logged-in and connected accounts
func (m *ClientManager) GetActiveAccounts() []*AccountClient {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var active []*AccountClient
	for _, acc := range m.accounts {
		if acc.LoggedIn && acc.Connected && acc.Client != nil {
			active = append(active, acc)
		}
	}
	return active
}

// GetAccountProxyAssignments returns proxy assignments for all accounts
func (m *ClientManager) GetAccountProxyAssignments() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(m.accounts))
	for _, acc := range m.accounts {
		proxyDisplay := acc.AssignedProxy
		if len(proxyDisplay) > 70 {
			proxyDisplay = proxyDisplay[:70] + "..."
		}
		if proxyDisplay == "" {
			proxyDisplay = "none"
		}

		result = append(result, map[string]interface{}{
			"phone":            acc.Phone,
			"assigned_proxy":   proxyDisplay,
			"logged_in":        acc.LoggedIn,
			"connected":        acc.Connected,
			"proxy_fail_count": acc.ProxyFailCount,
		})
	}
	return result
}

// registerWithMaster registers a new account with the Master server for warmup tracking
func (m *ClientManager) registerWithMaster(phone string) {
	masterURL := os.Getenv("MASTER_URL")
	if masterURL == "" {
		masterURL = "http://master:5000"
	}

	url := fmt.Sprintf("%s/api/accounts/%s/register", masterURL, phone)

	payload := map[string]string{
		"worker_id": m.WorkerID,
		"country":   m.ProxyCountry,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[%s] Failed to marshal register payload: %v", phone, err)
		return
	}

	// Retry up to 3 times
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
		if err != nil {
			log.Printf("[%s] Failed to create register request: %v", phone, err)
			return
		}

		req.Header.Set("Content-Type", "application/json")

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("[%s] Failed to register with Master (attempt %d/3): %v", phone, attempt, err)
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			log.Printf("[%s] Successfully registered with Master for warmup tracking", phone)
			return
		}

		log.Printf("[%s] Master returned status %d (attempt %d/3)", phone, resp.StatusCode, attempt)
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}

	log.Printf("[%s] Failed to register with Master after 3 attempts", phone)
}

// NotifyMasterWarmupMessage notifies Master that a warmup message was sent
func (m *ClientManager) NotifyMasterWarmupMessage(fromPhone, toPhone string) {
	masterURL := os.Getenv("MASTER_URL")
	if masterURL == "" {
		masterURL = "http://master:5000"
	}

	url := fmt.Sprintf("%s/api/accounts/%s/warmup/message-sent", masterURL, fromPhone)

	payload := map[string]string{
		"target_phone": toPhone,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
}
