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
	proxyPool   *config.ProxyPool // Pool for proxy rotation

	// Message counting for pauses
	sessionMsgCount int // Messages sent in current session
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
	WarmupStage    string    // Current stage: new_born, baby, toddler, teen, adult, veteran

	// Message tracking for pauses
	SessionMsgCount int // Messages sent in current session (reset on pause)
	TotalMsgToday   int // Total messages sent today

	// Mutex for thread-safe access
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
// Includes anti-ban measures: typing simulation, message variation, pauses, proxy rotation
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

	// === ANTI-BAN: Get stage-based delay ===
	acc.mu.RLock()
	stage := acc.WarmupStage
	sessionCount := acc.SessionMsgCount
	acc.mu.RUnlock()
	
	stageDelay := getDelayByStage(stage)
	
	// === ANTI-BAN: Simulate typing (human-like delay) ===
	typingDelay := calculateTypingDelay(variedMessage)
	
	// Total delay = stage delay + typing simulation
	totalDelay := stageDelay + typingDelay

	// === ANTI-BAN: Apply pauses every 10/50/100 messages ===
	pauseDelay := m.applyPauses(sessionCount + 1)
	if pauseDelay > 0 {
		log.Printf("[%s] Taking a break: %v (after %d messages)", fromPhone, pauseDelay, sessionCount+1)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pauseDelay):
		}
	}

	// === ANTI-BAN: Get rotating proxy ===
	proxy := m.proxyPool.GetProxyForMessage()
	proxyInfo := "none"
	if proxy.Enabled {
		proxyInfo = proxy.String()
	}

	// Send "composing" presence to show typing indicator
	if err := acc.Client.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Printf("[%s] Failed to send presence: %v", fromPhone, err)
	}

	log.Printf("[%s] Sending to %s (stage: %s, delay: %v, proxy: %s)", 
		fromPhone, toPhone, stage, totalDelay, proxyInfo)

	// Wait for total delay
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(totalDelay):
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
			log.Printf("[%s] Proxy error detected, will rotate on next message", fromPhone)
		}
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	// Increment message counters
	acc.mu.Lock()
	acc.SessionMsgCount++
	acc.TotalMsgToday++
	acc.mu.Unlock()

	// Also increment session-wide counter
	m.mu.Lock()
	m.sessionMsgCount++
	m.mu.Unlock()

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
// Every 10 messages: 30-120 seconds
// Every 50 messages: 5-15 minutes
// Every 100 messages: 15-30 minutes
func (m *ClientManager) applyPauses(msgCount int) time.Duration {
	if msgCount%100 == 0 {
		// Long break: 15-30 minutes
		pause := rand.Intn(900) + 900 // 900-1800 seconds
		return time.Duration(pause) * time.Second
	}
	
	if msgCount%50 == 0 {
		// Session break: 5-15 minutes
		pause := rand.Intn(600) + 300 // 300-900 seconds
		return time.Duration(pause) * time.Second
	}
	
	if msgCount%10 == 0 {
		// Short break: 30-120 seconds
		pause := rand.Intn(90) + 30 // 30-120 seconds
		return time.Duration(pause) * time.Second
	}
	
	return 0
}

// getDelayByStage returns the delay based on warmup stage
func getDelayByStage(stage string) time.Duration {
	delays := map[string][2]int{
		"new_born": {30, 60},  // 30-60 seconds
		"baby":     {20, 40},  // 20-40 seconds
		"toddler":  {10, 20},  // 10-20 seconds
		"teen":     {5, 10},   // 5-10 seconds
		"adult":    {3, 7},    // 3-7 seconds
		"veteran":  {1, 5},    // 1-5 seconds
	}

	d, ok := delays[stage]
	if !ok || len(d) != 2 {
		d = delays["adult"] // Default to adult
	}

	// Add jitter
	base := rand.Intn(d[1]-d[0]+1) + d[0]
	jitter := (rand.Float64() - 0.5) * 2 // -1 to +1 second
	
	totalSeconds := float64(base) + jitter
	if totalSeconds < 1 {
		totalSeconds = 1
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

// getWarmupStage determines the warmup stage based on account age
func getWarmupStage(acc *AccountClient) string {
	if acc.WarmupComplete {
		daysSinceCreation := time.Since(acc.CreatedAt).Hours() / 24
		if daysSinceCreation >= 60 {
			return "veteran"
		}
		return "adult"
	}

	daysSinceCreation := time.Since(acc.CreatedAt).Hours() / 24

	if daysSinceCreation <= 3 {
		return "new_born"
	} else if daysSinceCreation <= 7 {
		return "baby"
	} else if daysSinceCreation <= 14 {
		return "toddler"
	} else if daysSinceCreation <= 30 {
		return "teen"
	}
	return "adult"
}

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
	WarmupStage    string `json:"warmup_stage,omitempty"` // Current warmup stage
}

// saveAccountMeta saves account metadata to a JSON file
func (m *ClientManager) saveAccountMeta(phone string, acc *AccountClient) error {
	metaFile := filepath.Join(getSessionsDir(), fmt.Sprintf("%s.meta.json", sanitizePhone(phone)))

	acc.mu.RLock()
	meta := AccountMeta{
		CreatedAt:      acc.CreatedAt.Format(time.RFC3339),
		WarmupComplete: acc.WarmupComplete,
		WarmupStage:    acc.WarmupStage,
	}
	if !acc.LastWarmupSent.IsZero() {
		meta.LastWarmupSent = acc.LastWarmupSent.Format(time.RFC3339)
	}
	acc.mu.RUnlock()

	jsonData, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal meta: %w", err)
	}

	if err := os.WriteFile(metaFile, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write meta file: %w", err)
	}

	log.Printf("[%s] Saved account meta (stage: %s)", phone, acc.WarmupStage)
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
	
	// Restore warmup stage
	if meta.WarmupStage != "" {
		acc.WarmupStage = meta.WarmupStage
	} else {
		// Calculate stage based on age
		acc.WarmupStage = getWarmupStage(acc)
	}
	log.Printf("[%s] Restored account meta (stage: %s, warmup complete: %v)", acc.Phone, acc.WarmupStage, acc.WarmupComplete)
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

// SkipWarmup skips the warmup period for an account (marks it as complete)
func (m *ClientManager) SkipWarmup(phone string) error {
	m.mu.Lock()
	acc, exists := m.accounts[phone]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("account %s not found", phone)
	}

	if acc.WarmupComplete {
		m.mu.Unlock()
		return nil // Already complete
	}

	acc.WarmupComplete = true
	m.mu.Unlock()

	// Save to file
	if err := m.saveAccountMeta(phone, acc); err != nil {
		log.Printf("[%s] Failed to save skip warmup meta: %v", phone, err)
		return err
	}

	log.Printf("[%s] Warmup SKIPPED! Account can now send at full capacity.", phone)
	return nil
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

// GetAccountStats returns statistics for all accounts
func (m *ClientManager) GetAccountStats() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]map[string]interface{}, 0, len(m.accounts))
	for _, acc := range m.accounts {
		acc.mu.RLock()
		result = append(result, map[string]interface{}{
			"phone":            acc.Phone,
			"logged_in":        acc.LoggedIn,
			"connected":        acc.Connected,
			"warmup_stage":     acc.WarmupStage,
			"warmup_complete":  acc.WarmupComplete,
			"session_msgs":     acc.SessionMsgCount,
			"today_msgs":       acc.TotalMsgToday,
		})
		acc.mu.RUnlock()
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
