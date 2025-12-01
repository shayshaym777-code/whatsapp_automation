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

// ProxyUsage tracks usage of a proxy
type ProxyUsage struct {
	MessageCount int
	LastUsed     time.Time
	Blocked      bool
}

// ProxyPool manages multiple proxies with rotation every 10-20 messages
type ProxyPool struct {
	proxies        []*ProxyConfig
	usage          map[int]*ProxyUsage // Track usage per proxy index
	currentIndex   int
	rotateAfter    int           // Messages before rotation (10-20)
	cooldownHours  int           // Hours before reusing same proxy
	mu             sync.Mutex
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
func LoadProxyPool() *ProxyPool {
	pool := &ProxyPool{
		proxies:       make([]*ProxyConfig, 0),
		usage:         make(map[int]*ProxyUsage),
		rotateAfter:   10 + rand.Intn(11), // Random 10-20
		cooldownHours: 24,                 // 24 hours before reusing
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

	// Initialize usage tracking
	for i := range pool.proxies {
		pool.usage[i] = &ProxyUsage{}
	}

	if len(pool.proxies) > 0 {
		log.Printf("[ProxyPool] Loaded %d proxies (rotate every %d messages, 24h cooldown)", 
			len(pool.proxies), pool.rotateAfter)
	}

	return pool
}

// GetProxyForMessage returns the best available proxy for sending a message
// Rotates proxy every 10-20 messages and respects 24h cooldown
func (p *ProxyPool) GetProxyForMessage() *ProxyConfig {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.proxies) == 0 {
		return &ProxyConfig{Enabled: false}
	}

	if len(p.proxies) == 1 {
		p.usage[0].MessageCount++
		p.usage[0].LastUsed = time.Now()
		return p.proxies[0]
	}

	now := time.Now()
	cooldownDuration := time.Duration(p.cooldownHours) * time.Hour

	// Find best available proxy
	bestIdx := -1
	bestScore := -1

	for i := range p.proxies {
		usage := p.usage[i]
		
		// Skip blocked proxies
		if usage.Blocked {
			continue
		}

		// Check if in cooldown (used recently and hit rotation limit)
		if usage.MessageCount >= p.rotateAfter {
			timeSinceUse := now.Sub(usage.LastUsed)
			if timeSinceUse < cooldownDuration {
				// Still in cooldown
				continue
			}
			// Cooldown passed, reset count
			usage.MessageCount = 0
		}

		// Score: prefer proxies with fewer messages sent
		score := p.rotateAfter - usage.MessageCount
		if score > bestScore {
			bestScore = score
			bestIdx = i
		}
	}

	// If no proxy available, reset the oldest one
	if bestIdx == -1 {
		oldestIdx := 0
		oldestTime := now
		for i, usage := range p.usage {
			if !usage.Blocked && usage.LastUsed.Before(oldestTime) {
				oldestTime = usage.LastUsed
				oldestIdx = i
			}
		}
		bestIdx = oldestIdx
		p.usage[bestIdx].MessageCount = 0
		log.Printf("[ProxyPool] All proxies in cooldown, reset proxy %d", bestIdx)
	}

	// Use this proxy
	p.usage[bestIdx].MessageCount++
	p.usage[bestIdx].LastUsed = now
	p.currentIndex = bestIdx

	log.Printf("[ProxyPool] Using proxy %d/%d (msg %d/%d): %s",
		bestIdx+1, len(p.proxies), 
		p.usage[bestIdx].MessageCount, p.rotateAfter,
		p.proxies[bestIdx].String())

	// Check if we should rotate after this message
	if p.usage[bestIdx].MessageCount >= p.rotateAfter {
		// Set new random rotation point for next proxy
		p.rotateAfter = 10 + rand.Intn(11) // 10-20
		log.Printf("[ProxyPool] Proxy %d reached limit, will rotate (next limit: %d)", bestIdx, p.rotateAfter)
	}

	return p.proxies[bestIdx]
}

// ShouldRotate returns true if current proxy should be rotated
func (p *ProxyPool) ShouldRotate() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.currentIndex < 0 || p.currentIndex >= len(p.proxies) {
		return false
	}

	return p.usage[p.currentIndex].MessageCount >= p.rotateAfter
}

// MarkBlocked marks a proxy as blocked (failed too many times)
func (p *ProxyPool) MarkBlocked(proxyIdx int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if proxyIdx >= 0 && proxyIdx < len(p.proxies) {
		p.usage[proxyIdx].Blocked = true
		log.Printf("[ProxyPool] Proxy %d marked as BLOCKED", proxyIdx)
	}
}

// UnblockAll unblocks all proxies (for recovery)
func (p *ProxyPool) UnblockAll() {
	p.mu.Lock()
	defer p.mu.Unlock()

	for i := range p.usage {
		p.usage[i].Blocked = false
	}
	log.Printf("[ProxyPool] All proxies unblocked")
}

// GetCurrentIndex returns the current proxy index
func (p *ProxyPool) GetCurrentIndex() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.currentIndex
}

// GetStats returns proxy pool statistics
func (p *ProxyPool) GetStats() map[string]interface{} {
	p.mu.Lock()
	defer p.mu.Unlock()

	stats := make([]map[string]interface{}, len(p.proxies))
	for i, proxy := range p.proxies {
		usage := p.usage[i]
		stats[i] = map[string]interface{}{
			"index":         i,
			"host":          proxy.Host,
			"port":          proxy.Port,
			"message_count": usage.MessageCount,
			"last_used":     usage.LastUsed,
			"blocked":       usage.Blocked,
			"rotate_after":  p.rotateAfter,
		}
	}

	return map[string]interface{}{
		"mode":           "rotation",
		"description":    "Rotates proxy every 10-20 messages with 24h cooldown",
		"total_proxies":  len(p.proxies),
		"current_index":  p.currentIndex,
		"rotate_after":   p.rotateAfter,
		"cooldown_hours": p.cooldownHours,
		"proxies":        stats,
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
