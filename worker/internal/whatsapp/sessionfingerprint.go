package whatsapp

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"
)

// SessionFingerprint represents a unique browser fingerprint for a session
type SessionFingerprint struct {
	UserAgent    string
	ScreenWidth  int
	ScreenHeight int
	Timezone     string
	Language     string
	ProxyID      string
	ProxyIP      string
}

// FingerprintPool manages unique fingerprints for sessions
type FingerprintPool struct {
	usedFingerprints map[string]bool // Track used combinations
	mu               sync.Mutex
}

// NewFingerprintPool creates a new fingerprint pool
func NewFingerprintPool() *FingerprintPool {
	return &FingerprintPool{
		usedFingerprints: make(map[string]bool),
	}
}

// User agent pool - realistic browser fingerprints
var userAgentPool = []string{
	// Chrome on Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	
	// Firefox on Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
	
	// Chrome on macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	
	// Firefox on macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
	
	// Edge on Windows
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0",
	
	// Chrome on Linux
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
	
	// Safari on macOS
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
}

// Screen resolutions pool - common desktop resolutions
var screenPool = []struct {
	Width  int
	Height int
}{
	{1920, 1080},  // Full HD (most common)
	{2560, 1440},  // QHD
	{1366, 768},   // HD
	{1440, 900},   // WXGA+
	{1536, 864},   // HD+
	{1280, 720},   // HD
	{1680, 1050},  // WSXGA+
	{1600, 900},   // HD+
	{2560, 1080},  // UltraWide
	{3840, 2160},  // 4K
	{1280, 1024},  // SXGA
	{1920, 1200},  // WUXGA
}

// Timezones by country
var timezonesByCountry = map[string][]string{
	"US": {
		"America/New_York",      // Eastern
		"America/Los_Angeles",   // Pacific
		"America/Chicago",       // Central
		"America/Denver",        // Mountain
		"America/Phoenix",       // Arizona
		"America/Detroit",       // Eastern
		"America/Indianapolis",  // Eastern
		"America/Seattle",       // Pacific (alias)
	},
	"IL": {
		"Asia/Jerusalem",
		"Asia/Tel_Aviv", // Alias
	},
	"GB": {
		"Europe/London",
		"Europe/Belfast",
	},
	"DE": {
		"Europe/Berlin",
		"Europe/Munich",
	},
	"FR": {
		"Europe/Paris",
	},
	"CA": {
		"America/Toronto",
		"America/Vancouver",
		"America/Montreal",
	},
}

// Languages by country
var languagesByCountry = map[string][]string{
	"US": {"en-US"},
	"IL": {"he-IL", "en-IL"},
	"GB": {"en-GB"},
	"DE": {"de-DE", "en-DE"},
	"FR": {"fr-FR", "en-FR"},
	"CA": {"en-CA", "fr-CA"},
}

// GenerateSessionFingerprint generates a unique fingerprint for a session
// Ensures no duplicate fingerprints are used for the same phone
func (fp *FingerprintPool) GenerateSessionFingerprint(phone string, sessionNumber int, country string) (*SessionFingerprint, error) {
	fp.mu.Lock()
	defer fp.mu.Unlock()

	// Get country-specific pools
	timezones := timezonesByCountry[country]
	if len(timezones) == 0 {
		timezones = timezonesByCountry["US"] // Default to US
	}

	languages := languagesByCountry[country]
	if len(languages) == 0 {
		languages = []string{"en-US"}
	}

	// Try to generate unique fingerprint (max 100 attempts)
	for attempt := 0; attempt < 100; attempt++ {
		// Random selections
		userAgent := randomChoice(userAgentPool)
		screen := screenPool[randomInt(len(screenPool))]
		timezone := randomChoice(timezones)
		language := randomChoice(languages)

		// Create fingerprint key for uniqueness check
		key := fmt.Sprintf("%s_%s_%dx%d_%s", phone, userAgent[:50], screen.Width, screen.Height, timezone)

		// Check if this combination is already used for this phone
		if !fp.usedFingerprints[key] {
			fp.usedFingerprints[key] = true

			return &SessionFingerprint{
				UserAgent:    userAgent,
				ScreenWidth:  screen.Width,
				ScreenHeight: screen.Height,
				Timezone:     timezone,
				Language:     language,
			}, nil
		}
	}

	// If we couldn't find a unique combination, generate a slightly modified one
	return &SessionFingerprint{
		UserAgent:    fmt.Sprintf("%s Session%d", randomChoice(userAgentPool), sessionNumber),
		ScreenWidth:  screenPool[sessionNumber-1].Width,
		ScreenHeight: screenPool[sessionNumber-1].Height,
		Timezone:     timezones[sessionNumber%len(timezones)],
		Language:     languages[0],
	}, nil
}

// GenerateAllSessionFingerprints generates 4 unique fingerprints for a phone
func (fp *FingerprintPool) GenerateAllSessionFingerprints(phone string, country string) ([]*SessionFingerprint, error) {
	fingerprints := make([]*SessionFingerprint, 4)

	for i := 1; i <= 4; i++ {
		fingerprint, err := fp.GenerateSessionFingerprint(phone, i, country)
		if err != nil {
			return nil, fmt.Errorf("failed to generate fingerprint for session %d: %w", i, err)
		}
		fingerprints[i-1] = fingerprint
	}

	return fingerprints, nil
}

// ClearFingerprintsForPhone removes all fingerprints for a phone (when account is deleted)
func (fp *FingerprintPool) ClearFingerprintsForPhone(phone string) {
	fp.mu.Lock()
	defer fp.mu.Unlock()

	// Remove all keys that start with this phone
	for key := range fp.usedFingerprints {
		if len(key) > len(phone) && key[:len(phone)] == phone {
			delete(fp.usedFingerprints, key)
		}
	}
}

// GetCountryFromPhone extracts country code from phone number
func GetCountryFromPhone(phone string) string {
	// Remove + and spaces
	cleanPhone := phone
	if len(cleanPhone) > 0 && cleanPhone[0] == '+' {
		cleanPhone = cleanPhone[1:]
	}

	// Check country codes
	switch {
	case len(cleanPhone) >= 1 && cleanPhone[0] == '1':
		return "US" // US/Canada
	case len(cleanPhone) >= 3 && cleanPhone[:3] == "972":
		return "IL" // Israel
	case len(cleanPhone) >= 2 && cleanPhone[:2] == "44":
		return "GB" // UK
	case len(cleanPhone) >= 2 && cleanPhone[:2] == "49":
		return "DE" // Germany
	case len(cleanPhone) >= 2 && cleanPhone[:2] == "33":
		return "FR" // France
	default:
		return "US" // Default
	}
}

// Helper functions
func randomChoice(pool []string) string {
	if len(pool) == 0 {
		return ""
	}
	return pool[randomInt(len(pool))]
}

func randomInt(max int) int {
	if max <= 0 {
		return 0
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 0
	}
	return int(n.Int64())
}

// Global fingerprint pool instance
var globalFingerprintPool *FingerprintPool
var fingerprintPoolOnce sync.Once

// GetFingerprintPool returns the global fingerprint pool
func GetFingerprintPool() *FingerprintPool {
	fingerprintPoolOnce.Do(func() {
		globalFingerprintPool = NewFingerprintPool()
	})
	return globalFingerprintPool
}

