package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// DeviceFingerprint represents a deterministic device identity derived from a seed.
// Each worker gets a unique fingerprint to avoid detection.
type DeviceFingerprint struct {
	DeviceID     string // 16 hex chars from SHA256
	MACAddress   string // XX:XX:XX:XX:XX:XX format
	ComputerName string // DESKTOP-XXXXXXX format
	UserAgent    string // WhatsApp version string
	Timezone     string // Based on country
	Language     string // Based on country
	ProxyCountry string // Original country code
}

// countryConfig holds timezone and language for each country
type countryConfig struct {
	Timezone string
	Language string
}

var countryConfigs = map[string]countryConfig{
	"US": {Timezone: "America/New_York", Language: "en-US"},
	"IL": {Timezone: "Asia/Jerusalem", Language: "he-IL"},
	"GB": {Timezone: "Europe/London", Language: "en-GB"},
	"DE": {Timezone: "Europe/Berlin", Language: "de-DE"},
	"FR": {Timezone: "Europe/Paris", Language: "fr-FR"},
	"CA": {Timezone: "America/Toronto", Language: "en-CA"},
	"AU": {Timezone: "Australia/Sydney", Language: "en-AU"},
	"BR": {Timezone: "America/Sao_Paulo", Language: "pt-BR"},
	"IN": {Timezone: "Asia/Kolkata", Language: "en-IN"},
	"JP": {Timezone: "Asia/Tokyo", Language: "ja-JP"},
}

// WhatsApp version strings for user agent randomization
var whatsappVersions = []string{
	"2.24.1.6",
	"2.24.2.76",
	"2.24.3.79",
	"2.24.4.78",
	"2.24.5.78",
	"2.24.6.82",
	"2.24.7.80",
	"2.24.8.83",
}

// Generate creates a DETERMINISTIC fingerprint from a DEVICE_SEED.
// Same seed + same country = same fingerprint (for consistency across restarts).
// Different seeds = different fingerprints (for anti-ban).
func Generate(seed string, proxyCountry string) DeviceFingerprint {
	if seed == "" {
		seed = "default-seed"
	}
	if proxyCountry == "" {
		proxyCountry = "US"
	}

	// Create deterministic hash from seed
	sum := sha256.Sum256([]byte(seed))
	hashHex := hex.EncodeToString(sum[:])

	// DeviceID: first 16 hex chars
	deviceID := hashHex[:16]

	// MAC address: take chars 16-28 and format as 6 octets
	macRaw := hashHex[16:28]
	// Set locally administered bit (second nibble should be 2, 6, A, or E)
	macBytes := []byte(macRaw)
	// Force second char to be even (locally administered, unicast)
	if macBytes[1] >= '0' && macBytes[1] <= '9' {
		macBytes[1] = '2'
	} else {
		macBytes[1] = 'a'
	}
	macRaw = string(macBytes)
	mac := fmt.Sprintf("%s:%s:%s:%s:%s:%s",
		strings.ToUpper(macRaw[0:2]),
		strings.ToUpper(macRaw[2:4]),
		strings.ToUpper(macRaw[4:6]),
		strings.ToUpper(macRaw[6:8]),
		strings.ToUpper(macRaw[8:10]),
		strings.ToUpper(macRaw[10:12]),
	)

	// Computer name: DESKTOP-XXXXXXX format using chars 28-35
	computerSuffix := strings.ToUpper(hashHex[28:35])
	computerName := fmt.Sprintf("DESKTOP-%s", computerSuffix)

	// WhatsApp version: pick deterministically based on hash
	versionIndex := int(sum[0]) % len(whatsappVersions)
	waVersion := whatsappVersions[versionIndex]

	// User agent string (mimics WhatsApp Web)
	userAgent := fmt.Sprintf("WhatsApp/%s Windows/10.0.19045", waVersion)

	// Get country-specific config
	config, ok := countryConfigs[strings.ToUpper(proxyCountry)]
	if !ok {
		config = countryConfigs["US"] // Default to US
	}

	return DeviceFingerprint{
		DeviceID:     deviceID,
		MACAddress:   mac,
		ComputerName: computerName,
		UserAgent:    userAgent,
		Timezone:     config.Timezone,
		Language:     config.Language,
		ProxyCountry: proxyCountry,
	}
}

// ToMap returns the fingerprint as a map for JSON serialization
func (f DeviceFingerprint) ToMap() map[string]string {
	return map[string]string{
		"device_id":     f.DeviceID,
		"mac_address":   f.MACAddress,
		"computer_name": f.ComputerName,
		"user_agent":    f.UserAgent,
		"timezone":      f.Timezone,
		"language":      f.Language,
		"proxy_country": f.ProxyCountry,
	}
}
