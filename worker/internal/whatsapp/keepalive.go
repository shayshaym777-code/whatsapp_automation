package whatsapp

import (
	"context"
	"log"
	"math/rand"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

const (
	// KeepAliveInterval - base interval for keep alive check
	KeepAliveInterval = 30 * time.Minute // Check every 30 min

	// HealthCheckInterval - how often to check account health
	HealthCheckInterval = 5 * time.Minute
	
	// TempBlockCheckInterval - how often to check if temp blocked accounts are available
	TempBlockCheckInterval = 1 * time.Hour // Check every hour
	
	// DefaultTempBlockDuration - default temp block duration (WhatsApp restricts for ~5 hours)
	DefaultTempBlockDuration = 5 * time.Hour
)

// Keep alive config per stage - less messages for new accounts, more touches
type KeepAliveConfig struct {
	MessagesPerDay   int           // How many keep alive messages per day
	TouchesPerDay    int           // How many "touches" (no message) per day  
	MinInterval      time.Duration // Minimum time between actions
}

// Stage-based keep alive configuration
var keepAliveByStage = map[string]KeepAliveConfig{
	"newborn": {MessagesPerDay: 1, TouchesPerDay: 8, MinInterval: 2 * time.Hour},   // Day 0-3: 1 msg, 8 touches
	"infant":  {MessagesPerDay: 2, TouchesPerDay: 6, MinInterval: 90 * time.Minute}, // Day 4-7: 2 msgs, 6 touches
	"child":   {MessagesPerDay: 3, TouchesPerDay: 5, MinInterval: 60 * time.Minute}, // Day 8-14: 3 msgs, 5 touches
	"teen":    {MessagesPerDay: 4, TouchesPerDay: 4, MinInterval: 45 * time.Minute}, // Day 15-30: 4 msgs, 4 touches
	"adult":   {MessagesPerDay: 6, TouchesPerDay: 3, MinInterval: 30 * time.Minute}, // Day 31+: 6 msgs, 3 touches
}

// Track daily actions per account
var keepAliveDailyActions = make(map[string]*DailyKeepAliveStats)

type DailyKeepAliveStats struct {
	Date           string
	MessagesSent   int
	TouchesDone    int
	LastActionTime time.Time
}

// Keep alive messages - short and natural
var keepAliveMessages = []string{
	"Hi 👋",
	"Hey",
	"מה קורה?",
	"👍",
	"✌️",
	"🙂",
	"yo",
	"hey",
	"sup",
	"hi",
}

// External phone numbers for keep alive - NOT our accounts!
// These are real numbers to send keep alive to (looks more natural)
var keepAliveTargetPhones = []string{
	"972557042301",
	"972502492495",
	"972535251110",
	"972508572614",
	"972506595779",
	"972547449724",
	"972587959957",
	"972506461221",
	"972524493395",
	"972525204958",
	"972536200412",
	"972523963939",
	"972503801200",
	"972504885005",
	"972504441987",
	"972509212327",
	"972525904818",
	"972545688632",
	"972544878211",
	"972548352757",
	"972534325821",
	"972526635197",
	"972525000963",
	"972585538805",
	"972526161676",
	"972546882912",
	"972526341867",
	"972538222661",
	"972544437792",
	"972505438438",
	"972542548337",
	"972546109493",
	"972586272776",
	"972528206358",
	"972548836499",
	"972529382987",
	"972537262058",
	"972523951114",
	"972584449967",
	"972533443306",
	"972544465781",
	"972508923226",
	"972522000065",
	"972585200032",
	"972542677772",
	"972549198510",
	"972502281601",
	"972547995532",
	"972556886913",
	"972502170020",
	"972558817372",
	"972559695072",
	"972522420357",
	"972547174377",
	"972528876633",
	"972527338887",
	"972556668936",
	"972509748484",
	"972523663774",
	"972533365999",
	"972509344850",
	"972538248114",
	"972525116467",
	"972507330647",
	"972509456568",
}

// AccountHealthStatus represents the health state of an account
type AccountHealthStatus string

const (
	StatusHealthy      AccountHealthStatus = "HEALTHY"
	StatusDisconnected AccountHealthStatus = "DISCONNECTED"
	StatusBlocked      AccountHealthStatus = "BLOCKED"
	StatusSuspicious   AccountHealthStatus = "SUSPICIOUS"
	StatusTempBlocked  AccountHealthStatus = "TEMP_BLOCKED" // Temporarily blocked (usually 6 hours)
)

// AccountHealth tracks health info for an account
type AccountHealth struct {
	Phone               string
	Status              AccountHealthStatus
	LastAlive           time.Time
	LastMessageSent     time.Time
	LastMessageReceived time.Time
	LastError           string
	ConsecutiveFailures int
	MessagesToday       int
	
	// Temporary block tracking
	TempBlockedAt       time.Time // When account was temp blocked
	TempBlockDuration   time.Duration // How long the block lasts (usually 6 hours)
	LastBlockCheck      time.Time // Last time we checked if block expired
}

// keepAliveStop channel to stop keep alive
var keepAliveStop chan struct{}

// accountHealthMap tracks health for all accounts
var accountHealthMap = make(map[string]*AccountHealth)

// StartKeepAlive starts the keep alive scheduler
func (m *ClientManager) StartKeepAlive() {
	if keepAliveStop != nil {
		close(keepAliveStop)
	}

	keepAliveStop = make(chan struct{})
	stopCh := keepAliveStop

	// Keep alive ticker - every 30 min
	keepAliveTicker := time.NewTicker(KeepAliveInterval)

	// Health check ticker - every 5 minutes
	healthTicker := time.NewTicker(HealthCheckInterval)
	
	// Temp block check ticker - every 5 hours
	tempBlockTicker := time.NewTicker(TempBlockCheckInterval)

	go func(stop <-chan struct{}) {
		log.Println("[KeepAlive] Started - keep alive every 30min, health check every 5min, block check every 5h")
		defer keepAliveTicker.Stop()
		defer healthTicker.Stop()
		defer tempBlockTicker.Stop()

		// Run health check immediately
		m.checkAllAccountsHealth()

		for {
			select {
			case <-keepAliveTicker.C:
				m.sendKeepAliveMessages()
			case <-healthTicker.C:
				m.checkAllAccountsHealth()
			case <-tempBlockTicker.C:
				m.checkTempBlockedAccounts()
			case <-stop:
				log.Println("[KeepAlive] Stopped")
				return
			}
		}
	}(stopCh)
}

// StopKeepAlive stops the keep alive scheduler
func (m *ClientManager) StopKeepAlive() {
	if keepAliveStop != nil {
		close(keepAliveStop)
		keepAliveStop = nil
		log.Println("[KeepAlive] Stopped")
	}
}

// sendKeepAliveMessages performs keep alive actions based on account stage
// New accounts: less messages, more touches (presence, typing, etc)
// Older accounts: more messages allowed
func (m *ClientManager) sendKeepAliveMessages() {
	activeAccounts := m.GetActiveAccounts()

	if len(activeAccounts) == 0 {
		log.Println("[KeepAlive] No active accounts for keep alive")
		return
	}

	log.Printf("[KeepAlive] Processing keep alive for %d accounts", len(activeAccounts))
	today := time.Now().Format("2006-01-02")

	for _, acc := range activeAccounts {
		// Check if account is temp blocked - send touch instead of message
		health := m.getOrCreateHealth(acc.Phone)
		if health.Status == StatusTempBlocked {
			// Send a touch to keep the account "warm" even when blocked
			m.SendTouchToBlockedAccount(acc.Phone)
			continue
		}
		
		// For unstable accounts - don't skip, just reduce activity
		// NEVER disconnect or stop trying!
		
		// Get or create daily stats
		stats := m.getOrCreateDailyStats(acc.Phone, today)
		
		// Get stage config
		stage := m.getAccountStage(acc)
		config := keepAliveByStage[stage]
		if config.MessagesPerDay == 0 {
			config = keepAliveByStage["adult"] // Default
		}
		
		// Reduce activity for accounts with many disconnects (but not unstable yet)
		if acc.DisconnectCount > 5 {
			config.MinInterval = config.MinInterval * 2 // Double the interval
			log.Printf("[KeepAlive] 🐢 Reduced activity for %s (disconnects: %d)", acc.Phone, acc.DisconnectCount)
		}

		// Check minimum interval
		if time.Since(stats.LastActionTime) < config.MinInterval {
			continue // Too soon for this account
		}

		// Decide: message or touch?
		canSendMessage := stats.MessagesSent < config.MessagesPerDay
		canDoTouch := stats.TouchesDone < config.TouchesPerDay
		
		if !canSendMessage && !canDoTouch {
			continue // Daily limit reached
		}

		// Prefer touches for new accounts (70% touch, 30% message)
		// For older accounts (50% touch, 50% message)
		doTouch := false
		if canDoTouch && canSendMessage {
			touchChance := 70 // New accounts prefer touches
			if stage == "adult" || stage == "teen" {
				touchChance = 50
			}
			doTouch = rand.Intn(100) < touchChance
		} else if canDoTouch {
			doTouch = true
		}

		if doTouch {
			// Do a "touch" - presence activity without sending message
			m.performKeepAliveTouch(acc)
			stats.TouchesDone++
			stats.LastActionTime = time.Now()
			log.Printf("[KeepAlive] 👆 Touch done: %s (stage: %s, touches: %d/%d)", 
				acc.Phone, stage, stats.TouchesDone, config.TouchesPerDay)
		} else if canSendMessage {
			// For warmup/keep alive: prefer internal accounts first, then external
			// New accounts (< 3 days) MUST only send to internal accounts!
			var targetPhone string
			var message string
			
			daysSinceCreation := time.Since(acc.CreatedAt).Hours() / 24
			isNewAccount := daysSinceCreation < 3 || stage == "newborn" || stage == "infant"
			
			if isNewAccount {
				// New accounts: ONLY internal accounts (warmup between friends)
				targetPhone = m.getRandomInternalAccountForKeepAlive(acc.Phone)
				if targetPhone == "" {
					// No internal account available - do touch instead
					m.performKeepAliveTouch(acc)
					stats.TouchesDone++
					stats.LastActionTime = time.Now()
					log.Printf("[KeepAlive] 👆 Touch (no internal target): %s", acc.Phone)
					continue
				}
				log.Printf("[KeepAlive] 🔥 Warmup (internal): %s -> %s", acc.Phone, targetPhone)
			} else if len(keepAliveTargetPhones) > 0 {
				// Older accounts: can send to external numbers
				targetPhone = keepAliveTargetPhones[rand.Intn(len(keepAliveTargetPhones))]
			} else {
				// Fallback to internal
				targetPhone = m.getRandomInternalAccountForKeepAlive(acc.Phone)
				if targetPhone == "" {
					continue
				}
			}
			
			message = keepAliveMessages[rand.Intn(len(keepAliveMessages))]
			err := m.sendKeepAliveMessage(acc, targetPhone, message)
			
			if err != nil {
				health.ConsecutiveFailures++
				health.LastError = err.Error()
				
				// Check if it's a temporary block (usually 6 hours)
				if isTempBlockedError(err) {
					m.markAccountTempBlocked(acc.Phone, err)
					log.Printf("[KeepAlive] ⏸️ TEMP BLOCKED: %s - will retry in 5 hours", acc.Phone)
				} else if isBlockedError(err) {
					// Permanent block - but still keep trying!
					health.Status = StatusBlocked
					log.Printf("[KeepAlive] 🔴 BLOCKED: %s - %v (will keep trying)", acc.Phone, err)
				} else {
					health.Status = StatusSuspicious
					log.Printf("[KeepAlive] ⚠️ Failed: %s - %v", acc.Phone, err)
				}
			} else {
				health.Status = StatusHealthy
				health.LastAlive = time.Now()
				health.LastMessageSent = time.Now()
				health.ConsecutiveFailures = 0
				health.TempBlockedAt = time.Time{} // Clear any temp block
				stats.MessagesSent++
				stats.LastActionTime = time.Now()
				log.Printf("[KeepAlive] ✅ Message sent: %s -> %s (stage: %s, msgs: %d/%d)", 
					acc.Phone, targetPhone, stage, stats.MessagesSent, config.MessagesPerDay)
			}
		}

		// Random delay between accounts (10-30 seconds)
		delay := 10 + rand.Intn(20)
		time.Sleep(time.Duration(delay) * time.Second)
	}
}

// performKeepAliveTouch does presence activity without sending a message
func (m *ClientManager) performKeepAliveTouch(acc *AccountClient) {
	if acc.Client == nil {
		return
	}

	ctx := context.Background()
	
	// Random touch activity
	activities := []string{"presence", "typing", "read"}
	activity := activities[rand.Intn(len(activities))]

	switch activity {
	case "presence":
		// Just mark as online
		_ = acc.Client.SendPresence(ctx, types.PresenceAvailable)
		time.Sleep(time.Duration(2+rand.Intn(3)) * time.Second)
		_ = acc.Client.SendPresence(ctx, types.PresenceUnavailable)
		
	case "typing":
		// Start typing in a random chat then stop
		if len(keepAliveTargetPhones) > 0 {
			targetPhone := keepAliveTargetPhones[rand.Intn(len(keepAliveTargetPhones))]
			jid := types.NewJID(targetPhone, types.DefaultUserServer)
			_ = acc.Client.SendChatPresence(ctx, jid, types.ChatPresenceComposing, types.ChatPresenceMediaText)
			time.Sleep(time.Duration(1+rand.Intn(2)) * time.Second)
			_ = acc.Client.SendChatPresence(ctx, jid, types.ChatPresencePaused, types.ChatPresenceMediaText)
		}
		
	case "read":
		// Get contacts and mark something as read
		contacts, err := acc.Client.Store.Contacts.GetAllContacts(ctx)
		if err == nil && len(contacts) > 0 {
			// Just accessing contacts is activity
			_ = len(contacts)
		}
	}
}

// getOrCreateDailyStats gets or creates daily stats for an account
func (m *ClientManager) getOrCreateDailyStats(phone, date string) *DailyKeepAliveStats {
	key := phone + "_" + date
	if stats, exists := keepAliveDailyActions[key]; exists {
		return stats
	}
	
	stats := &DailyKeepAliveStats{
		Date:         date,
		MessagesSent: 0,
		TouchesDone:  0,
	}
	keepAliveDailyActions[key] = stats
	
	// Clean old entries (keep only today)
	for k := range keepAliveDailyActions {
		if !strings.HasSuffix(k, "_"+date) {
			delete(keepAliveDailyActions, k)
		}
	}
	
	return stats
}

// getAccountStage determines the warmup stage of an account
func (m *ClientManager) getAccountStage(acc *AccountClient) string {
	if acc.CreatedAt.IsZero() {
		return "adult" // Unknown = treat as adult
	}
	
	days := int(time.Since(acc.CreatedAt).Hours() / 24)
	
	switch {
	case days <= 3:
		return "newborn"
	case days <= 7:
		return "infant"
	case days <= 14:
		return "child"
	case days <= 30:
		return "teen"
	default:
		return "adult"
	}
}

// sendKeepAliveMessage sends a single keep alive message
func (m *ClientManager) sendKeepAliveMessage(from *AccountClient, toPhone string, message string) error {
	toPhoneSanitized := sanitizePhone(toPhone)
	toJID := types.NewJID(toPhoneSanitized, types.DefaultUserServer)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	msg := &waE2E.Message{
		Conversation: proto.String(message),
	}

	_, err := from.Client.SendMessage(ctx, toJID, msg)
	return err
}

// checkAllAccountsHealth checks health status of all accounts
func (m *ClientManager) checkAllAccountsHealth() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for phone, acc := range m.accounts {
		health := m.getOrCreateHealth(phone)

		// Check connection status
		if !acc.Connected {
			health.Status = StatusDisconnected
			log.Printf("[HealthCheck] 🟡 %s: DISCONNECTED", phone)
			
			// Attempt reconnect
			go m.attemptReconnect(phone)
			continue
		}

		if !acc.LoggedIn {
			health.Status = StatusDisconnected
			log.Printf("[HealthCheck] 🟡 %s: NOT LOGGED IN", phone)
			continue
		}

		// Check for suspicious activity (no messages for too long)
		if health.ConsecutiveFailures > 3 {
			health.Status = StatusSuspicious
			log.Printf("[HealthCheck] 🟠 %s: SUSPICIOUS (failures: %d)", phone, health.ConsecutiveFailures)
			continue
		}

		// If we got here and status was bad, it might be recovered
		if health.Status != StatusBlocked {
			health.Status = StatusHealthy
		}
	}
}

// attemptReconnect tries to reconnect a disconnected account
func (m *ClientManager) attemptReconnect(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || acc == nil {
		return
	}

	// Don't reconnect if already connected
	if acc.Connected && acc.LoggedIn {
		return
	}

	// Don't reconnect if blocked
	health := m.getOrCreateHealth(phone)
	if health.Status == StatusBlocked {
		log.Printf("[Reconnect] Skipping blocked account: %s", phone)
		return
	}

	log.Printf("[Reconnect] 🔄 Attempting reconnect for %s", phone)

	// Try to reconnect
	if acc.Client != nil {
		err := acc.Client.Connect()
		if err != nil {
			log.Printf("[Reconnect] Failed to reconnect %s: %v", phone, err)
			health.ConsecutiveFailures++
			health.LastError = err.Error()
		} else {
			// Wait for connection
			time.Sleep(3 * time.Second)
			
			if acc.Client.IsLoggedIn() {
				log.Printf("[Reconnect] ✅ Successfully reconnected %s", phone)
				acc.Connected = true
				acc.LoggedIn = true
				health.Status = StatusHealthy
				health.ConsecutiveFailures = 0
			}
		}
	}
}

// getOrCreateHealth gets or creates health tracking for an account
func (m *ClientManager) getOrCreateHealth(phone string) *AccountHealth {
	if health, exists := accountHealthMap[phone]; exists {
		return health
	}

	health := &AccountHealth{
		Phone:  phone,
		Status: StatusHealthy,
	}
	accountHealthMap[phone] = health
	return health
}

// GetAccountHealth returns health status for an account
func (m *ClientManager) GetAccountHealth(phone string) *AccountHealth {
	if health, exists := accountHealthMap[phone]; exists {
		return health
	}
	return nil
}

// GetAllAccountsHealth returns health status for all accounts
func (m *ClientManager) GetAllAccountsHealth() map[string]*AccountHealth {
	return accountHealthMap
}

// isBlockedError checks if an error indicates the account is blocked
func isBlockedError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	blockIndicators := []string{
		"banned",
		"blocked",
		"restricted",
		"unusual activity",
		"account suspended",
		"temporarily unavailable",
		"not authorized",
	}
	for _, indicator := range blockIndicators {
		if strings.Contains(errStr, indicator) {
			return true
		}
	}
	return false
}

// isTempBlockedError checks if error indicates temporary restriction (~5 hours)
// WhatsApp shows: "Your account is restricted right now"
// You CAN reply to existing chats, but CANNOT start new chats
func isTempBlockedError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	tempBlockIndicators := []string{
		"restricted",      // "Your account is restricted"
		"temporarily",
		"try again later",
		"wait",
		"too many",
		"rate limit",
		"spam",
		"automated",
		"bulk",
	}
	for _, indicator := range tempBlockIndicators {
		if strings.Contains(errStr, indicator) {
			return true
		}
	}
	return false
}

// markAccountTempBlocked marks an account as temporarily restricted
// WhatsApp restriction lasts ~5 hours, during which:
// - CAN reply to existing chats
// - CANNOT start new chats
func (m *ClientManager) markAccountTempBlocked(phone string, err error) {
	health := m.getOrCreateHealth(phone)
	health.Status = StatusTempBlocked
	health.TempBlockedAt = time.Now()
	health.TempBlockDuration = DefaultTempBlockDuration // 5 hours
	health.LastError = err.Error()
	log.Printf("[Restricted] ⏸️ Account %s restricted for ~5 hours (can reply, cannot start new chats)", phone)
}

// checkTempBlockedAccounts checks if restricted accounts are available again
// Runs every hour to check if the ~5 hour restriction has lifted
func (m *ClientManager) checkTempBlockedAccounts() {
	restrictedCount := 0
	for _, health := range accountHealthMap {
		if health.Status == StatusTempBlocked {
			restrictedCount++
		}
	}
	
	if restrictedCount == 0 {
		return // No restricted accounts
	}
	
	log.Printf("[Restricted] 🔍 Checking %d restricted accounts...", restrictedCount)
	
	for phone, health := range accountHealthMap {
		if health.Status != StatusTempBlocked {
			continue
		}
		
		// Calculate remaining time
		elapsed := time.Since(health.TempBlockedAt)
		remaining := health.TempBlockDuration - elapsed
		
		if remaining > 0 {
			log.Printf("[Restricted] ⏳ Account %s: %v remaining (restricted at %s)", 
				phone, remaining.Round(time.Minute), health.TempBlockedAt.Format("15:04"))
			continue
		}
		
		log.Printf("[Restricted] 🔄 Restriction should be lifted for %s, testing...", phone)
		
		// Try to reconnect and send a test presence
		m.mu.RLock()
		acc, exists := m.accounts[phone]
		m.mu.RUnlock()
		
		if !exists || acc == nil || acc.Client == nil {
			continue
		}
		
		// Try to send presence (lightweight check)
		ctx := context.Background()
		err := acc.Client.SendPresence(ctx, types.PresenceAvailable)
		if err != nil {
			if isTempBlockedError(err) || isBlockedError(err) {
				// Still restricted, wait another hour
				log.Printf("[Restricted] ❌ Account %s still restricted, will check again in 1 hour", phone)
			} else {
				// Different error, might be connection issue - try reconnect
				log.Printf("[Restricted] ⚠️ Account %s connection error: %v, trying reconnect...", phone, err)
				go m.TriggerReconnect(phone)
			}
		} else {
			// Success! Account is available again
			health.Status = StatusHealthy
			health.TempBlockedAt = time.Time{}
			health.LastError = ""
			health.ConsecutiveFailures = 0
			log.Printf("[Restricted] ✅ Account %s restriction lifted! Back to normal.", phone)
			
			// Send offline presence
			_ = acc.Client.SendPresence(ctx, types.PresenceUnavailable)
		}
		
		health.LastBlockCheck = time.Now()
		
		// Small delay between checks
		time.Sleep(5 * time.Second)
	}
}

// getRandomInternalAccountForKeepAlive gets a random internal account for warmup
// Only returns accounts that are connected and healthy
func (m *ClientManager) getRandomInternalAccountForKeepAlive(excludePhone string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	var candidates []string
	for phone, acc := range m.accounts {
		if phone == excludePhone {
			continue
		}
		if !acc.Connected || !acc.LoggedIn {
			continue
		}
		// Check health - don't send to blocked accounts
		if health := m.GetAccountHealth(phone); health != nil {
			if health.Status == StatusBlocked || health.Status == StatusTempBlocked {
				continue
			}
		}
		candidates = append(candidates, phone)
	}
	
	if len(candidates) == 0 {
		return ""
	}
	
	return candidates[rand.Intn(len(candidates))]
}

// SendTouchToBlockedAccount sends a presence touch to a restricted account
// During restriction: CAN reply to existing chats, CANNOT start new chats
// We keep the account "warm" by sending presence
func (m *ClientManager) SendTouchToBlockedAccount(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()
	
	if !exists || acc == nil || acc.Client == nil {
		return
	}
	
	health := m.getOrCreateHealth(phone)
	remaining := health.TempBlockDuration - time.Since(health.TempBlockedAt)
	
	// Just try to connect/send presence - keeps the connection alive
	if !acc.Connected {
		_ = acc.Client.Connect()
		time.Sleep(2 * time.Second)
	}
	
	// Try presence - this should work even when restricted
	ctx := context.Background()
	_ = acc.Client.SendPresence(ctx, types.PresenceAvailable)
	time.Sleep(1 * time.Second)
	_ = acc.Client.SendPresence(ctx, types.PresenceUnavailable)
	
	if remaining > 0 {
		log.Printf("[Restricted] 👆 Touch sent to %s (%v remaining)", phone, remaining.Round(time.Minute))
	} else {
		log.Printf("[Restricted] 👆 Touch sent to %s (checking if available...)", phone)
	}
}

// TriggerReconnect manually triggers reconnect for an account
func (m *ClientManager) TriggerReconnect(phone string) error {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists {
		return nil
	}

	log.Printf("[Reconnect] Manual reconnect triggered for %s", phone)
	
	if acc.Client != nil {
		// Disconnect first
		acc.Client.Disconnect()
		time.Sleep(2 * time.Second)
		
		// Reconnect
		err := acc.Client.Connect()
		if err != nil {
			return err
		}
		
		// Wait and check
		time.Sleep(3 * time.Second)
		
		if acc.Client.IsLoggedIn() {
			acc.Connected = true
			acc.LoggedIn = true
			health := m.getOrCreateHealth(phone)
			health.Status = StatusHealthy
			health.ConsecutiveFailures = 0
			log.Printf("[Reconnect] ✅ Manual reconnect successful for %s", phone)
		}
	}
	
	return nil
}

