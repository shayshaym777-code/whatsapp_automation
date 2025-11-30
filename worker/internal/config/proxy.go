package config

import (
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ProxyConfig holds SOCKS5/HTTP proxy configuration
type ProxyConfig struct {
	Host    string
	Port    string
	User    string
	Pass    string
	Type    string // socks5 or http
	Enabled bool
}

// ProxyPool manages multiple proxies with assignment to accounts
type ProxyPool struct {
	proxies       []*ProxyConfig
	currentIndex  int
	useCount      map[int]int // Track usage per proxy
	lastUsed      map[int]time.Time
	maxPerProxy   int // Max messages before rotation (not used in sticky mode)
	cooldownHours int // Hours before reusing same proxy
	mu            sync.Mutex

	// Sticky proxy assignments: phone -> proxy URL
	assignments map[string]string
}

// LoadProxyConfig loads proxy configuration from environment variables
func LoadProxyConfig() *ProxyConfig {
	host := os.Getenv("PROXY_HOST")
	if host == "" {
		return &ProxyConfig{Enabled: false}
	}

	proxyType := os.Getenv("PROXY_TYPE")
	if proxyType == "" {
		proxyType = "socks5" // Default to SOCKS5
	}

	return &ProxyConfig{
		Host:    host,
		Port:    os.Getenv("PROXY_PORT"),
		User:    os.Getenv("PROXY_USER"),
		Pass:    os.Getenv("PROXY_PASS"),
		Type:    proxyType,
		Enabled: true,
	}
}

// LoadProxyPool loads multiple proxies from environment
// Format: PROXY_LIST="host1:port1:user1:pass1,host2:port2:user2:pass2"
// Or uses single proxy if PROXY_LIST not set
func LoadProxyPool() *ProxyPool {
	pool := &ProxyPool{
		proxies:       make([]*ProxyConfig, 0),
		useCount:      make(map[int]int),
		lastUsed:      make(map[int]time.Time),
		maxPerProxy:   15, // Not used in sticky mode
		cooldownHours: 1,  // 1 hour cooldown
		assignments:   make(map[string]string),
	}

	// Try to load proxy list first
	proxyList := os.Getenv("PROXY_LIST")
	proxyType := os.Getenv("PROXY_TYPE")
	if proxyType == "" {
		proxyType = "socks5"
	}

	if proxyList != "" {
		// Parse comma-separated proxy list
		proxies := strings.Split(proxyList, ",")
		for _, p := range proxies {
			parts := strings.Split(strings.TrimSpace(p), ":")
			if len(parts) >= 2 {
				proxy := &ProxyConfig{
					Host:    parts[0],
					Port:    parts[1],
					Type:    proxyType,
					Enabled: true,
				}
				if len(parts) >= 4 {
					proxy.User = parts[2]
					proxy.Pass = parts[3]
				}
				pool.proxies = append(pool.proxies, proxy)
			}
		}
	}

	// If no proxy list, use single proxy config
	if len(pool.proxies) == 0 {
		singleProxy := LoadProxyConfig()
		if singleProxy.Enabled {
			pool.proxies = append(pool.proxies, singleProxy)
		}
	}

	if len(pool.proxies) > 0 {
		log.Printf("[ProxyPool] Loaded %d proxies for rotation", len(pool.proxies))
	}

	return pool
}

// GetNext returns the next available proxy with rotation logic
func (p *ProxyPool) GetNext() *ProxyConfig {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.proxies) == 0 {
		return &ProxyConfig{Enabled: false}
	}

	if len(p.proxies) == 1 {
		return p.proxies[0]
	}

	// Find a proxy that hasn't hit the limit and isn't in cooldown
	now := time.Now()
	cooldownDuration := time.Duration(p.cooldownHours) * time.Hour

	for attempts := 0; attempts < len(p.proxies)*2; attempts++ {
		idx := (p.currentIndex + attempts) % len(p.proxies)

		// Check cooldown
		if lastUsed, ok := p.lastUsed[idx]; ok {
			if now.Sub(lastUsed) < cooldownDuration && p.useCount[idx] >= p.maxPerProxy {
				continue // Skip, still in cooldown
			}
		}

		// Check usage limit
		if p.useCount[idx] >= p.maxPerProxy {
			// Reset if cooldown passed
			if lastUsed, ok := p.lastUsed[idx]; ok {
				if now.Sub(lastUsed) >= cooldownDuration {
					p.useCount[idx] = 0
				} else {
					continue
				}
			}
		}

		// Use this proxy
		p.currentIndex = (idx + 1) % len(p.proxies)
		p.useCount[idx]++
		p.lastUsed[idx] = now

		log.Printf("[ProxyPool] Using proxy %d/%d (used %d times): %s",
			idx+1, len(p.proxies), p.useCount[idx], p.proxies[idx].String())

		return p.proxies[idx]
	}

	// Fallback: reset all and use first
	p.useCount = make(map[int]int)
	p.useCount[0] = 1
	p.lastUsed[0] = now
	p.currentIndex = 1
	return p.proxies[0]
}

// GetRandom returns a random proxy (for new connections)
func (p *ProxyPool) GetRandom() *ProxyConfig {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.proxies) == 0 {
		return &ProxyConfig{Enabled: false}
	}

	if len(p.proxies) == 1 {
		return p.proxies[0]
	}

	idx := rand.Intn(len(p.proxies))
	return p.proxies[idx]
}

// AssignProxyToPhone assigns a dedicated proxy to a phone number
// If already assigned, returns the existing proxy
// If not assigned, finds the least-used proxy and assigns it
func (p *ProxyPool) AssignProxyToPhone(phone string) *ProxyConfig {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.proxies) == 0 {
		return &ProxyConfig{Enabled: false}
	}

	// Check if already assigned
	if proxyURL, exists := p.assignments[phone]; exists {
		// Find and return the assigned proxy
		for _, proxy := range p.proxies {
			if proxy.GetURL() == proxyURL {
				log.Printf("[ProxyPool] Phone %s already assigned to proxy: %s", phone, proxy.String())
				return proxy
			}
		}
		// Assigned proxy no longer exists, reassign
		delete(p.assignments, phone)
	}

	// Find the least-used proxy
	usageCounts := make(map[int]int)
	for _, assignedURL := range p.assignments {
		for i, proxy := range p.proxies {
			if proxy.GetURL() == assignedURL {
				usageCounts[i]++
				break
			}
		}
	}

	// Find proxy with minimum assignments
	minIdx := 0
	minCount := usageCounts[0]
	for i := range p.proxies {
		if usageCounts[i] < minCount {
			minCount = usageCounts[i]
			minIdx = i
		}
	}

	// Assign this proxy to the phone
	selectedProxy := p.proxies[minIdx]
	p.assignments[phone] = selectedProxy.GetURL()

	log.Printf("[ProxyPool] Assigned phone %s to proxy %d/%d: %s (total on this proxy: %d)",
		phone, minIdx+1, len(p.proxies), selectedProxy.String(), usageCounts[minIdx]+1)

	return selectedProxy
}

// SetAssignment sets a proxy assignment for a phone (used when loading from meta)
func (p *ProxyPool) SetAssignment(phone, proxyURL string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.assignments[phone] = proxyURL
	log.Printf("[ProxyPool] Restored assignment: %s -> %s", phone, proxyURL[:min(50, len(proxyURL))]+"...")
}

// GetAssignment returns the assigned proxy URL for a phone
func (p *ProxyPool) GetAssignment(phone string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.assignments[phone]
}

// RemoveAssignment removes a proxy assignment (when account is removed)
func (p *ProxyPool) RemoveAssignment(phone string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.assignments, phone)
	log.Printf("[ProxyPool] Removed assignment for phone: %s", phone)
}

// ReassignProxy assigns a new proxy to a phone (when current proxy fails)
func (p *ProxyPool) ReassignProxy(phone string) *ProxyConfig {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.proxies) <= 1 {
		// Only one proxy available, can't reassign
		if len(p.proxies) == 1 {
			return p.proxies[0]
		}
		return &ProxyConfig{Enabled: false}
	}

	// Get current assignment
	currentURL := p.assignments[phone]

	// Find a different proxy
	usageCounts := make(map[int]int)
	for _, assignedURL := range p.assignments {
		for i, proxy := range p.proxies {
			if proxy.GetURL() == assignedURL {
				usageCounts[i]++
				break
			}
		}
	}

	// Find least-used proxy that's different from current
	minIdx := -1
	minCount := 999999
	for i, proxy := range p.proxies {
		if proxy.GetURL() != currentURL && usageCounts[i] < minCount {
			minCount = usageCounts[i]
			minIdx = i
		}
	}

	if minIdx == -1 {
		// All proxies are the same (shouldn't happen), use first different one
		for i, proxy := range p.proxies {
			if proxy.GetURL() != currentURL {
				minIdx = i
				break
			}
		}
	}

	if minIdx == -1 {
		// Fallback to first proxy
		minIdx = 0
	}

	selectedProxy := p.proxies[minIdx]
	p.assignments[phone] = selectedProxy.GetURL()

	log.Printf("[ProxyPool] REASSIGNED phone %s to new proxy %d/%d: %s",
		phone, minIdx+1, len(p.proxies), selectedProxy.String())

	return selectedProxy
}

// GetAssignmentStats returns statistics about proxy assignments
func (p *ProxyPool) GetAssignmentStats() map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Count assignments per proxy
	proxyStats := make([]map[string]interface{}, len(p.proxies))
	for i, proxy := range p.proxies {
		count := 0
		phones := []string{}
		for phone, url := range p.assignments {
			if url == proxy.GetURL() {
				count++
				phones = append(phones, phone)
			}
		}
		proxyStats[i] = map[string]interface{}{
			"index":            i,
			"proxy":            proxy.String(),
			"assigned_count":   count,
			"assigned_phones":  phones,
		}
	}

	return map[string]interface{}{
		"total_proxies":     len(p.proxies),
		"total_assignments": len(p.assignments),
		"proxies":           proxyStats,
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// RecordUsage records that a proxy was used for a message
func (p *ProxyPool) RecordUsage(proxy *ProxyConfig) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for i, px := range p.proxies {
		if px.Host == proxy.Host && px.Port == proxy.Port {
			p.useCount[i]++
			p.lastUsed[i] = time.Now()
			break
		}
	}
}

// GetStats returns proxy pool statistics
func (p *ProxyPool) GetStats() map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()

	stats := make([]map[string]interface{}, len(p.proxies))
	for i, proxy := range p.proxies {
		stats[i] = map[string]interface{}{
			"index":     i,
			"host":      proxy.Host,
			"port":      proxy.Port,
			"use_count": p.useCount[i],
			"last_used": p.lastUsed[i],
		}
	}

	return map[string]interface{}{
		"total_proxies":   len(p.proxies),
		"current_index":   p.currentIndex,
		"max_per_proxy":   p.maxPerProxy,
		"cooldown_hours":  p.cooldownHours,
		"proxies":         stats,
	}
}

// Count returns the number of proxies in the pool
func (p *ProxyPool) Count() int {
	return len(p.proxies)
}

// IsEnabled returns true if at least one proxy is configured
func (p *ProxyPool) IsEnabled() bool {
	return len(p.proxies) > 0
}

// GetURL returns the proxy URL in the format: type://user:pass@host:port
func (p *ProxyConfig) GetURL() string {
	if !p.Enabled {
		return ""
	}

	// Format: socks5://user:pass@host:port
	if p.User != "" && p.Pass != "" {
		return fmt.Sprintf("%s://%s:%s@%s:%s",
			p.Type,
			url.QueryEscape(p.User),
			url.QueryEscape(p.Pass),
			p.Host,
			p.Port)
	}

	return fmt.Sprintf("%s://%s:%s", p.Type, p.Host, p.Port)
}

// GetHostPort returns host:port string
func (p *ProxyConfig) GetHostPort() string {
	if !p.Enabled {
		return ""
	}
	return fmt.Sprintf("%s:%s", p.Host, p.Port)
}

// String returns a safe string representation (without password)
func (p *ProxyConfig) String() string {
	if !p.Enabled {
		return "disabled"
	}
	if p.User != "" {
		return fmt.Sprintf("%s://%s:***@%s:%s", p.Type, p.User, p.Host, p.Port)
	}
	return fmt.Sprintf("%s://%s:%s", p.Type, p.Host, p.Port)
}
