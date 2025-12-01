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
	"github.com/whatsapp-automation/worker/internal/telegram"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// QRCodeDir is where QR code images are stored
	QRCodeDir = "/data/qrcodes"
	// DefaultSessionsDir for local development
	DefaultSessionsDir = "./sessions"
)

// v8.0: Simplified ClientManager - no warmup, no stages

// ClientManager manages WhatsApp client connections
type ClientManager struct {
	Fingerprint  fingerprint.DeviceFingerprint
	ProxyCountry string
	WorkerID     string

	accounts map[string]*AccountClient
	mu       sync.RWMutex

	proxyConfig *config.ProxyConfig
	proxyPool   *config.ProxyPool

	heartbeat *HeartbeatManager
}

// AccountClient represents a connected WhatsApp account
type AccountClient struct {
	Phone     string
	Client    *whatsmeow.Client
	Container *sqlstore.Container
	Connected bool
	LoggedIn  bool
	QRCode    string
	QRPath    string

	// State tracking
	lastConnectedState bool
	lastLoggedInState  bool
	lastStateChange    time.Time
	CreatedAt          time.Time

	// Message counting for anti-ban pauses
	SessionMsgCount int
	TotalMsgToday   int
	LastDayReset    time.Time

	// Health tracking
	LastError           string
	ConsecutiveFailures int
	BannedUntil         time.Time

	// Delivery tracking
	MessagesSent      int
	MessagesDelivered int
	MessagesFailed    int

	mu sync.RWMutex
}

// NewClientManager creates a new client manager for this worker
func NewClientManager(fp fingerprint.DeviceFingerprint, proxyCountry, workerID string, proxyConfig *config.ProxyConfig) *ClientManager {
	// Ensure directories exist
	os.MkdirAll(QRCodeDir, 0755)
	os.MkdirAll(getSessionsDir(), 0755)

	// Load proxy pool for rotation (every 10-20 messages)
	proxyPool := config.LoadProxyPool()
	log.Printf("[ClientManager] Initialized with %d proxies for rotation", proxyPool.Count())

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

	// Load existing metadata
	meta := m.loadAccountMeta(phone)
	isNewAccount := meta == nil

	// Get proxy from rotating pool for this connection
	var proxyURL string
	if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		proxy := m.proxyPool.GetProxyForMessage()
		if proxy.Enabled {
			proxyURL = proxy.GetURL()
			log.Printf("[%s] Using rotating proxy: %s", phone, proxy.String())
		}
	}

	// Create WhatsApp client with proxy
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client, err := m.createClientWithProxy(device, clientLog, proxyURL)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to create client with proxy: %w", err)
	}

	// Create account entry
	acc := &AccountClient{
		Phone:     phone,
		Client:    client,
		Container: container,
		Connected: false,
		LoggedIn:  false,
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

	// Load existing metadata
	metaPair := m.loadAccountMeta(phone)
	isNewAccountPair := metaPair == nil

	// Get proxy from rotating pool for this connection
	var proxyURLPair string
	if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		proxy := m.proxyPool.GetProxyForMessage()
		if proxy.Enabled {
			proxyURLPair = proxy.GetURL()
			log.Printf("[%s] Using rotating proxy for pairing: %s", phone, proxy.String())
		}
	}

	// Create WhatsApp client with proxy
	clientLog := waLog.Stdout("Client-"+phone, "INFO", true)
	client, err := m.createClientWithProxy(device, clientLog, proxyURLPair)
	if err != nil {
		container.Close()
		return nil, fmt.Errorf("failed to create client with proxy: %w", err)
	}

	// Create account entry
	acc := &AccountClient{
		Phone:     phone,
		Client:    client,
		Container: container,
		Connected: false,
		LoggedIn:  false,
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
			log.Printf("[%s] ✅ Connected to WhatsApp", phone)
		}
		acc.Connected = true
		acc.LoggedIn = true
		acc.QRCode = ""
		acc.lastConnectedState = true
		acc.lastLoggedInState = true
		acc.lastStateChange = time.Now()
		acc.LastError = ""
		acc.ConsecutiveFailures = 0
		m.mu.Unlock()

		// Update health status
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusHealthy
			health.LastAlive = time.Now()
			health.ConsecutiveFailures = 0
			health.LastError = ""
		}

		// Start activity simulator for this account
		go m.StartHumanActivitySimulator(phone)

	case *events.LoggedOut:
		// Always log logout - it's important
		log.Printf("[%s] ⚠️ Logged out from WhatsApp: %v", phone, v.Reason)
		acc.LoggedIn = false
		acc.lastLoggedInState = false
		acc.lastStateChange = time.Now()
		acc.LastError = fmt.Sprintf("Logged out: %v", v.Reason)
		m.mu.Unlock()

		// Update health
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusDisconnected
			health.LastError = acc.LastError
		}

	case *events.Disconnected:
		// Only log if state actually changed
		wasConnected := acc.lastConnectedState
		if wasConnected {
			log.Printf("[%s] ❌ Disconnected from WhatsApp", phone)
			// Send Telegram alert
			go telegram.AlertDisconnected(phone, m.WorkerID, "Connection lost")
		}
		acc.Connected = false
		acc.lastConnectedState = false
		acc.lastStateChange = time.Now()
		m.mu.Unlock()

		// Update health
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusDisconnected
		}

		// v8.0: Simple reconnect - 5-25 seconds delay
		if acc.LoggedIn {
			go func(p string) {
				delay := time.Duration(rand.Intn(20)+5) * time.Second
				log.Printf("[%s] Will attempt reconnect in %v", p, delay)
				time.Sleep(delay)
				m.attemptSmartReconnect(p)
			}(phone)
		}

	case *events.KeepAliveTimeout:
		log.Printf("[%s] ⚠️ KeepAlive timeout (errors: %d, last success: %v)",
			phone, v.ErrorCount, v.LastSuccess)
		acc.ConsecutiveFailures = int(v.ErrorCount)
		m.mu.Unlock()

		// Update health
		if health := m.GetAccountHealth(phone); health != nil {
			health.ConsecutiveFailures = int(v.ErrorCount)
			if v.ErrorCount > 3 {
				health.Status = StatusSuspicious
			}
		}

		// Force reconnect if too many failures (reduced from 5 to 3)
		if v.ErrorCount > 3 {
			log.Printf("[%s] 🔄 KeepAlive failed %d times, forcing reconnect", phone, v.ErrorCount)
			go func(p string) {
				// Random delay to avoid all accounts reconnecting at once
				delay := time.Duration(rand.Intn(10)+5) * time.Second
				time.Sleep(delay)

				m.mu.RLock()
				a, ok := m.accounts[p]
				m.mu.RUnlock()
				if ok && a.Client != nil {
					a.Client.Disconnect()
					time.Sleep(3 * time.Second)
					m.attemptSmartReconnect(p)
				}
			}(phone)
		}

	case *events.KeepAliveRestored:
		log.Printf("[%s] ✅ KeepAlive restored", phone)
		acc.ConsecutiveFailures = 0
		acc.LastError = ""
		m.mu.Unlock()

		// Update health
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusHealthy
			health.ConsecutiveFailures = 0
			health.LastAlive = time.Now()
		}

	case *events.Receipt:
		// Track message delivery for Delivery Rate calculation
		if v.Type == events.ReceiptTypeDelivered || v.Type == events.ReceiptTypeRead {
			acc.mu.Lock()
			acc.MessagesDelivered++
			acc.mu.Unlock()

			// Update health - message was delivered
			if health := m.GetAccountHealth(phone); health != nil {
				health.LastAlive = time.Now()
				if health.Status == StatusSuspicious {
					health.Status = StatusHealthy
				}
			}
		}
		m.mu.Unlock()

	case *events.StreamReplaced:
		log.Printf("[%s] 🚨 Stream replaced! Another client connected with same session", phone)
		acc.Connected = false
		acc.LastError = "Stream replaced - another device connected"
		m.mu.Unlock()

		// Update health - don't auto-reconnect to avoid loop
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusSuspicious
			health.LastError = "Stream replaced by another device"
		}

	case *events.TemporaryBan:
		log.Printf("[%s] ⛔ TEMPORARY BAN! Code: %s, Expires: %v",
			phone, v.Code.String(), v.Expire)
		acc.LastError = fmt.Sprintf("Temp ban: %s, expires: %v", v.Code.String(), v.Expire)
		acc.BannedUntil = time.Now().Add(v.Expire)
		m.mu.Unlock()

		// Update health
		if health := m.GetAccountHealth(phone); health != nil {
			health.Status = StatusBlocked
			health.LastError = acc.LastError
		}

	case *events.PairSuccess:
		log.Printf("[%s] ✅ Successfully paired with device: %s", phone, v.ID.String())
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
		// Start activity simulator
		go m.StartHumanActivitySimulator(phone)

	case *events.Message:
		m.mu.Unlock()
		// Handle incoming message
		m.handleIncomingMessage(phone, v)

	default:
		m.mu.Unlock()
	}
}

// attemptSmartReconnect tries to reconnect with exponential backoff
func (m *ClientManager) attemptSmartReconnect(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || acc.Client == nil {
		return
	}

	// Check if banned
	if !acc.BannedUntil.IsZero() && time.Now().Before(acc.BannedUntil) {
		log.Printf("[%s] Account banned until %v, skipping reconnect", phone, acc.BannedUntil)
		return
	}

	maxRetries := 5
	for i := 0; i < maxRetries; i++ {
		// Check if already connected
		if acc.Client.IsConnected() && acc.Client.IsLoggedIn() {
			log.Printf("[%s] ✅ Already connected, skipping reconnect", phone)
			return
		}

		log.Printf("[%s] 🔄 Reconnect attempt %d/%d", phone, i+1, maxRetries)

		err := acc.Client.Connect()
		if err == nil {
			// Wait for connection to stabilize
			time.Sleep(3 * time.Second)

			if acc.Client.IsConnected() && acc.Client.IsLoggedIn() {
				log.Printf("[%s] ✅ Reconnected successfully", phone)
				m.mu.Lock()
				acc.Connected = true
				acc.LoggedIn = true
				acc.ConsecutiveFailures = 0
				m.mu.Unlock()
				return
			}
		}

		log.Printf("[%s] ❌ Reconnect attempt %d failed: %v", phone, i+1, err)

		// Exponential backoff: 5s, 10s, 20s, 40s, 80s
		backoff := time.Duration(5*(1<<i)) * time.Second
		if backoff > 2*time.Minute {
			backoff = 2 * time.Minute
		}
		time.Sleep(backoff)
	}

	log.Printf("[%s] 🚨 All reconnect attempts failed", phone)

	// Update health
	if health := m.GetAccountHealth(phone); health != nil {
		health.Status = StatusDisconnected
		health.LastError = "All reconnect attempts failed"
	}
}

// SendMessage sends a text message from one account to a recipient
// Includes anti-ban measures: typing simulation, message variation, pauses, proxy rotation
// SendMessage sends a message with anti-ban measures
// v8.0: Simplified - no warmup checks, just anti-ban
func (m *ClientManager) SendMessage(ctx context.Context, fromPhone, toPhone, message string, name ...string) (*SendResult, error) {
	m.mu.RLock()
	acc, exists := m.accounts[fromPhone]
	m.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("account %s not connected", fromPhone)
	}

	if !acc.LoggedIn {
		return nil, fmt.Errorf("account %s not logged in", fromPhone)
	}

	// Check if blocked
	if health := m.GetAccountHealth(fromPhone); health != nil {
		if health.Status == StatusBlocked {
			return nil, fmt.Errorf("account %s is BLOCKED - do not use for 48h", fromPhone)
		}
	}

	// Parse recipient JID
	recipientJID, err := parseJID(toPhone)
	if err != nil {
		return nil, fmt.Errorf("invalid recipient phone: %w", err)
	}

	// Get name for {name} replacement
	contactName := ""
	if len(name) > 0 {
		contactName = name[0]
	}

	// === ANTI-BAN: Apply message variation ===
	variedMessage := applyMessageVariationWithName(message, contactName)

	// === ANTI-BAN: Get message count for pauses ===
	acc.mu.RLock()
	sessionCount := acc.SessionMsgCount
	acc.mu.RUnlock()

	// === ANTI-BAN: Random delay 2-4 seconds + jitter ===
	baseDelay := getRandomDelay()

	// === ANTI-BAN: Typing simulation (1-3 seconds) ===
	typingDelay := getTypingDuration()

	// === ANTI-BAN: Pauses every 10/50/100 messages ===
	pauseDelay := getPauseDuration(sessionCount + 1)
	if pauseDelay > 0 {
		log.Printf("[%s] Taking a break: %v (after %d messages)", fromPhone, pauseDelay, sessionCount+1)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pauseDelay):
		}
	}

	// === ANTI-BAN: Send typing indicator ===
	if err := acc.Client.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Printf("[%s] Failed to send presence: %v", fromPhone, err)
	}

	// Wait for typing simulation
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(typingDelay):
	}

	log.Printf("[%s] Sending to %s (delay: %v)", fromPhone, toPhone, baseDelay)

	// Wait for base delay
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(baseDelay):
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
		// Track failed message for delivery rate
		acc.mu.Lock()
		acc.MessagesFailed++
		acc.MessagesSent++
		acc.mu.Unlock()

		// Check if this might be a proxy failure
		if isProxyError(err) {
			log.Printf("[%s] Proxy error detected, will rotate on next message", fromPhone)
		}
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	// Increment message counters
	acc.mu.Lock()
	acc.SessionMsgCount++
	acc.TotalMsgToday++
	acc.MessagesSent++
	acc.mu.Unlock()

	log.Printf("[%s] ✅ Message sent to %s (session: %d, today: %d)",
		fromPhone, toPhone, acc.SessionMsgCount, acc.TotalMsgToday)

	return &SendResult{
		MessageID: resp.ID,
		Timestamp: resp.Timestamp.Unix(),
		FromPhone: fromPhone,
		ToPhone:   toPhone,
	}, nil
}

// applyPauses returns the pause duration based on message count
// v5.0 spec:
// Every 10 messages:  10-30 seconds
// Every 50 messages:  2-5 minutes
// Every 100 messages: 5-10 minutes
func (m *ClientManager) applyPauses(msgCount int) time.Duration {
	if msgCount%100 == 0 {
		// Long break: 5-10 minutes
		pause := rand.Intn(300) + 300 // 300-600 seconds
		return time.Duration(pause) * time.Second
	}

	if msgCount%50 == 0 {
		// Session break: 2-5 minutes
		pause := rand.Intn(180) + 120 // 120-300 seconds
		return time.Duration(pause) * time.Second
	}

	if msgCount%10 == 0 {
		// Short break: 10-30 seconds
		pause := rand.Intn(20) + 10 // 10-30 seconds
		return time.Duration(pause) * time.Second
	}

	return 0
}

// StageLimits defines daily and hourly limits per stage
type StageLimits struct {
	MaxDay  int
	MaxHour int
}

// resetCountersIfNeeded resets daily counters
func (m *ClientManager) resetCountersIfNeeded(acc *AccountClient) {
	now := time.Now()

	acc.mu.Lock()
	defer acc.mu.Unlock()

	// Reset daily counter if new day
	today := now.Format("2006-01-02")
	lastDay := acc.LastDayReset.Format("2006-01-02")
	if today != lastDay {
		if acc.TotalMsgToday > 0 {
			log.Printf("[%s] Daily counter reset (was %d)", acc.Phone, acc.TotalMsgToday)
		}
		acc.TotalMsgToday = 0
		acc.SessionMsgCount = 0
		acc.LastDayReset = now
	}
}

// getStageLimits returns the sending limits based on warmup stage
// v6.0 simplified stages:
// new_born (1-3 days): 5/day - WARMUP ONLY
// baby (4-7 days): 20/day - can send campaigns
// teen (8-14 days): 50/day - can send campaigns
// adult (15+ days): 100/day - can send campaigns
func getStageLimits(stage string) StageLimits {
	limits := map[string]StageLimits{
		"new_born": {MaxDay: 5, MaxHour: 5},     // Warmup only!
		"baby":     {MaxDay: 20, MaxHour: 20},   // Can send campaigns
		"teen":     {MaxDay: 50, MaxHour: 50},   // Can send campaigns
		"adult":    {MaxDay: 100, MaxHour: 100}, // Full capacity
	}

	if l, ok := limits[stage]; ok {
		return l
	}
	return limits["adult"] // Default
}

// getDelayByStage returns the delay based on warmup stage
// v5.0: Base delay is 2-4 seconds for all stages (20-25 msgs/min max)
// Stage differences are minimal - focus is on daily limits instead
func getDelayByStage(stage string) time.Duration {
	// v5.0 spec: Base delay 2-4 seconds with jitter
	// All stages use similar delay - differentiation is in daily limits
	delays := map[string][2]int{
		"new_born": {3, 5}, // Slightly slower for new accounts
		"baby":     {3, 4}, // 3-4 seconds
		"toddler":  {2, 4}, // 2-4 seconds
		"teen":     {2, 4}, // 2-4 seconds
		"adult":    {2, 4}, // 2-4 seconds
		"veteran":  {2, 3}, // 2-3 seconds (fastest)
	}

	d, ok := delays[stage]
	if !ok || len(d) != 2 {
		d = delays["adult"] // Default to adult
	}

	// Add jitter ±0.5 seconds
	base := rand.Intn(d[1]-d[0]+1) + d[0]
	jitter := (rand.Float64() - 0.5) // -0.5 to +0.5 second

	totalSeconds := float64(base) + jitter
	if totalSeconds < 1.5 {
		totalSeconds = 1.5 // Minimum 1.5 seconds
	}

	return time.Duration(totalSeconds * float64(time.Second))
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

// applyMessageVariation adds invisible characters for uniqueness
// v8.0 Anti-Ban Functions

// Random emojis for 30% of messages
var randomEmojis = []string{
	"😊", "👍", "🙏", "✨", "💪", "🎉", "👋", "😄",
	"🔥", "💯", "⭐", "🌟", "💫", "🙌", "👏", "❤️",
}

// applyMessageVariationWithName applies all anti-ban variations
// 1. Process spin tags: {Hello|Hi|Hey} → random choice
// 2. Replace {name} with contact name
// 3. Add zero-width characters
// 4. Add random emoji (30%)
func applyMessageVariationWithName(message string, name string) string {
	result := message

	// 1. Process spin tags {option1|option2|option3}
	result = processSpinTags(result)

	// 2. Replace {name}
	result = strings.ReplaceAll(result, "{name}", name)

	// 3. Add zero-width characters (invisible)
	result = addZeroWidthChars(result)

	// 4. Add random emoji (30% chance)
	if rand.Float64() < 0.3 {
		result = result + " " + randomEmojis[rand.Intn(len(randomEmojis))]
	}

	return result
}

// processSpinTags handles {option1|option2|option3} syntax
func processSpinTags(text string) string {
	// Simple implementation - find {word|word|word} patterns
	result := text
	for {
		start := strings.Index(result, "{")
		if start == -1 {
			break
		}
		end := strings.Index(result[start:], "}")
		if end == -1 {
			break
		}
		end += start

		inner := result[start+1 : end]
		if !strings.Contains(inner, "|") {
			// Not a spin tag (might be {name}), skip
			break
		}

		options := strings.Split(inner, "|")
		choice := options[rand.Intn(len(options))]
		result = result[:start] + choice + result[end+1:]
	}
	return result
}

// addZeroWidthChars adds invisible characters for uniqueness
func addZeroWidthChars(text string) string {
	zeroWidth := []string{
		"\u200B", // Zero-width space
		"\u200C", // Zero-width non-joiner
		"\u200D", // Zero-width joiner
		"\uFEFF", // Zero-width no-break space
	}

	// Add 2-4 random zero-width chars at the end
	count := 2 + rand.Intn(3)
	for i := 0; i < count; i++ {
		text += zeroWidth[rand.Intn(len(zeroWidth))]
	}
	return text
}

// getRandomDelay returns 2-4 seconds + jitter
func getRandomDelay() time.Duration {
	base := 2.0 + rand.Float64()*2.0 // 2-4 seconds
	jitter := (rand.Float64() - 0.5) // -0.5 to +0.5
	total := base + jitter
	if total < 1.5 {
		total = 1.5
	}
	return time.Duration(total * float64(time.Second))
}

// getTypingDuration returns 1-3 seconds for typing simulation
func getTypingDuration() time.Duration {
	seconds := 1 + rand.Intn(3) // 1, 2, or 3 seconds
	return time.Duration(seconds) * time.Second
}

// getPauseDuration returns pause based on message count
// Every 10: 10-30 seconds
// Every 50: 2-5 minutes
// Every 100: 5-10 minutes
func getPauseDuration(msgCount int) time.Duration {
	if msgCount > 0 && msgCount%100 == 0 {
		pause := 300 + rand.Intn(300) // 5-10 min
		return time.Duration(pause) * time.Second
	}
	if msgCount > 0 && msgCount%50 == 0 {
		pause := 120 + rand.Intn(180) // 2-5 min
		return time.Duration(pause) * time.Second
	}
	if msgCount > 0 && msgCount%10 == 0 {
		pause := 10 + rand.Intn(20) // 10-30 sec
		return time.Duration(pause) * time.Second
	}
	return 0
}

// Legacy function for backward compatibility
func applyMessageVariation(message string) string {
	return applyMessageVariationWithName(message, "")
}

// v8.0: Removed getWarmupStage - no more stages

// calculateTypingDelay simulates human typing speed (additional to stage delay)
func calculateTypingDelay(message string) time.Duration {
	// Base: 30-80ms per character (faster than before)
	charCount := len(message)
	perCharMs := 30 + rand.Intn(50)
	typingTime := charCount * perCharMs

	// Add word pauses (50-100ms between words)
	wordCount := len(strings.Fields(message))
	wordPauseMs := wordCount * (50 + rand.Intn(50))

	totalMs := typingTime + wordPauseMs

	// Cap at 5 seconds for long messages (typing simulation only)
	if totalMs > 5000 {
		totalMs = 5000
	}

	// Minimum 500ms
	if totalMs < 500 {
		totalMs = 500
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

	// Load existing metadata
	loadedMeta := m.loadAccountMeta(phone)

	// Get proxy from rotating pool for this connection
	var proxyURLLoad string
	if m.proxyPool != nil && m.proxyPool.Count() > 0 {
		proxy := m.proxyPool.GetProxyForMessage()
		if proxy.Enabled {
			proxyURLLoad = proxy.GetURL()
			log.Printf("[%s] Using rotating proxy for session: %s", phone, proxy.String())
		}
	}

	// Create client with quieter logging and proxy
	clientLog := waLog.Stdout("Client-"+phone, "WARN", true)
	client, err := m.createClientWithProxy(device, clientLog, proxyURLLoad)
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

	// v8.0: No warmup logging
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

// AccountMeta stores persistent metadata about an account (v8.0 simplified)
type AccountMeta struct {
	CreatedAt string `json:"created_at"`
}

// saveAccountMeta saves account metadata to a JSON file
func (m *ClientManager) saveAccountMeta(phone string, acc *AccountClient) error {
	metaFile := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.meta.json", sanitizePhone(phone)))

	acc.mu.RLock()
	meta := AccountMeta{
		CreatedAt: acc.CreatedAt.Format(time.RFC3339),
	}
	acc.mu.RUnlock()

	jsonData, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal meta: %w", err)
	}

	if err := os.WriteFile(metaFile, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write meta file: %w", err)
	}

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

// applyAccountMeta applies loaded metadata to an account (v8.0 simplified)
func (m *ClientManager) applyAccountMeta(acc *AccountClient, meta *AccountMeta) {
	if meta == nil {
		acc.CreatedAt = time.Now()
		return
	}

	if createdAt, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
		acc.CreatedAt = createdAt
	} else {
		acc.CreatedAt = time.Now()
	}
}

// v8.0: Removed warmup functions - UpdateWarmupSent, MarkWarmupComplete, SkipWarmup

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

// GetAccountStats returns statistics for all accounts (v8.0 simplified)
func (m *ClientManager) GetAccountStats() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(m.accounts))
	for _, acc := range m.accounts {
		acc.mu.RLock()

		deliveryRate := 100.0
		if acc.MessagesSent > 0 {
			deliveryRate = float64(acc.MessagesDelivered) / float64(acc.MessagesSent) * 100
		}

		result = append(result, map[string]interface{}{
			"phone":              acc.Phone,
			"logged_in":          acc.LoggedIn,
			"connected":          acc.Connected,
			"session_msgs":       acc.SessionMsgCount,
			"today_msgs":         acc.TotalMsgToday,
			"messages_sent":      acc.MessagesSent,
			"messages_delivered": acc.MessagesDelivered,
			"messages_failed":    acc.MessagesFailed,
			"delivery_rate":      deliveryRate,
		})
		acc.mu.RUnlock()
	}
	return result
}

// GetConnectionStatus returns detailed connection status for all accounts
func (m *ClientManager) GetConnectionStatus() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(m.accounts))
	for phone, acc := range m.accounts {
		acc.mu.RLock()

		// Check actual connection status from whatsmeow client
		wsConnected := false
		wsLoggedIn := false
		if acc.Client != nil {
			wsConnected = acc.Client.IsConnected()
			wsLoggedIn = acc.Client.IsLoggedIn()
		}

		status := "unknown"
		reconnecting := false

		if wsConnected && wsLoggedIn {
			status = "connected"
		} else if acc.LoggedIn && !wsConnected {
			status = "disconnected"
			reconnecting = true // Monitor will try to reconnect
		} else if !acc.LoggedIn {
			status = "not_logged_in"
		} else {
			status = "connecting"
			reconnecting = true
		}

		result = append(result, map[string]interface{}{
			"phone":             phone,
			"status":            status,
			"connected":         wsConnected,
			"logged_in":         wsLoggedIn,
			"reconnecting":      reconnecting,
			"last_error":        acc.LastError,
			"consecutive_fails": acc.ConsecutiveFailures,
			"banned_until":      acc.BannedUntil.Format(time.RFC3339),
			"is_banned":         time.Now().Before(acc.BannedUntil),
		})
		acc.mu.RUnlock()
	}
	return result
}

// getDailyLimitForStage returns daily message limit based on warmup stage
// v7.0 updated stages
func getDailyLimitForStage(stage string) int {
	switch stage {
	case "WARMING":
		return 5
	case "Baby":
		return 15
	case "Toddler":
		return 30
	case "Teen":
		return 50
	case "Adult":
		return 100
	case "Veteran":
		return 200
	default:
		return 100 // Default to Adult
	}
}

// v8.0: Removed SetAccountWarmup - no warmup system

// isInternalAccount checks if a phone number belongs to our system
func (m *ClientManager) isInternalAccount(phone string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Normalize phone number
	normalizedPhone := sanitizePhone(phone)

	for accPhone := range m.accounts {
		if sanitizePhone(accPhone) == normalizedPhone {
			return true
		}
	}
	return false
}

// GetHealthyAccountsCount returns the number of healthy accounts ready to send
func (m *ClientManager) GetHealthyAccountsCount() (healthy int, total int, alerts []string) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	total = len(m.accounts)

	for phone, acc := range m.accounts {
		if !acc.Connected || !acc.LoggedIn {
			continue
		}

		// Check health status
		if health := m.GetAccountHealth(phone); health != nil {
			if health.Status == StatusBlocked || health.Status == StatusTempBlocked {
				continue
			}
		}

		healthy++
	}

	// Generate alerts
	if healthy == 0 {
		alerts = append(alerts, "🚨 אין חשבונות זמינים לשליחה!")
	} else if healthy < 3 {
		alerts = append(alerts, fmt.Sprintf("⚠️ רק %d חשבונות זמינים - מומלץ להוסיף עוד", healthy))
	}

	if total > 0 && float64(healthy)/float64(total) < 0.5 {
		alerts = append(alerts, fmt.Sprintf("⚠️ רק %.0f%% מהחשבונות פעילים", float64(healthy)/float64(total)*100))
	}

	return healthy, total, alerts
}

// CanSendCampaign checks if an account can send messages (v8.0 simplified)
func (m *ClientManager) CanSendCampaign(phone string) (bool, string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists {
		return false, "account not found"
	}

	if !acc.Connected || !acc.LoggedIn {
		return false, "account not connected"
	}

	// Check health - only BLOCKED matters in v8.0
	if health := m.GetAccountHealth(phone); health != nil {
		if health.Status == StatusBlocked {
			return false, "account is BLOCKED - do not use for 48h"
		}
	}

	return true, ""
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

// v8.0: Removed SetAccountIsNew - no warmup system

// v8.0: Removed GetAccountStageInfo - no more stages
