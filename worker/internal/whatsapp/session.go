package whatsapp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// SessionsDir is the base directory for session storage
	SessionsDir = "/data/sessions"
)

// SessionManager handles WhatsApp session persistence
type SessionManager struct {
	container *sqlstore.Container
	dbPath    string
	phone     string
}

// NewSessionManager creates a session manager for a specific phone number
func NewSessionManager(phone string) (*SessionManager, error) {
	// Ensure sessions directory exists
	if err := os.MkdirAll(SessionsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create sessions directory: %w", err)
	}

	// Create database path for this phone
	dbPath := filepath.Join(SessionsDir, fmt.Sprintf("%s.db", phone))

	return &SessionManager{
		dbPath: dbPath,
		phone:  phone,
	}, nil
}

// Initialize opens or creates the SQLite database for session storage
func (sm *SessionManager) Initialize(ctx context.Context) error {
	dbLog := waLog.Stdout("SessionDB", "INFO", true)

	dbURI := fmt.Sprintf("file:%s?_foreign_keys=on", sm.dbPath)
	container, err := sqlstore.New(ctx, "sqlite3", dbURI, dbLog)
	if err != nil {
		return fmt.Errorf("failed to open session database: %w", err)
	}

	sm.container = container
	return nil
}

// GetDevice retrieves the stored device or creates a new one
func (sm *SessionManager) GetDevice(ctx context.Context) (*store.Device, error) {
	if sm.container == nil {
		return nil, fmt.Errorf("session manager not initialized")
	}

	device, err := sm.container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get device: %w", err)
	}

	return device, nil
}

// CreateDevice creates a new device entry in the database
func (sm *SessionManager) CreateDevice(ctx context.Context) (*store.Device, error) {
	if sm.container == nil {
		return nil, fmt.Errorf("session manager not initialized")
	}

	device := sm.container.NewDevice()

	if err := sm.container.PutDevice(ctx, device); err != nil {
		return nil, fmt.Errorf("failed to store device: %w", err)
	}

	return device, nil
}

// HasSession checks if a session already exists for this phone
func (sm *SessionManager) HasSession() bool {
	_, err := os.Stat(sm.dbPath)
	return err == nil
}

// GetContainer returns the underlying sqlstore container
func (sm *SessionManager) GetContainer() *sqlstore.Container {
	return sm.container
}

// Close closes the session database connection
func (sm *SessionManager) Close() error {
	if sm.container != nil {
		return sm.container.Close()
	}
	return nil
}

// DeleteSession removes the session file for this phone
func (sm *SessionManager) DeleteSession() error {
	if sm.container != nil {
		sm.container.Close()
		sm.container = nil
	}

	if err := os.Remove(sm.dbPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete session file: %w", err)
	}

	return nil
}

// GetSessionPath returns the path to the session database file
func (sm *SessionManager) GetSessionPath() string {
	return sm.dbPath
}
