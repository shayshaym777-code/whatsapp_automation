package config

import (
	"fmt"
	"net/url"
	"os"
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

