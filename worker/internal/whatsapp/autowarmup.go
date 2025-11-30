package whatsapp

import (
	"context"
	"log"
	"math/rand"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

const (
	// WarmupDuration is how long new accounts need warmup (31 days for full maturity)
	WarmupDuration = 31 * 24 * time.Hour

	// WarmupCheckInterval is how often to check if accounts need warmup
	WarmupCheckInterval = 60 * time.Minute // Every hour

	// WarmupMinInterval is minimum time between warmup messages for same account
	WarmupMinInterval = 90 * time.Minute // 1.5 hours minimum

	// WarmupMaxInterval is maximum time between warmup messages for same account
	WarmupMaxInterval = 180 * time.Minute // 3 hours maximum
)

// Warmup messages in Hebrew and English - with spin variations
var warmupMessages = []string{
	// Hebrew greetings
	"היי מה קורה?",
	"מה נשמע?",
	"שלום!",
	"בוקר טוב ☀️",
	"ערב טוב 🌙",
	"מה המצב?",
	"איך הולך?",
	"מה קורה?",
	"הכל טוב?",
	"שלום מה נשמע",
	"היי 👋",
	"מה נשמע אצלך?",
	"איך היום שלך?",
	"מה חדש?",
	"הכל בסדר?",
	// English greetings
	"Hey!",
	"Hi there!",
	"Hello!",
	"What's up?",
	"How are you?",
	"Good morning! ☀️",
	"Good evening! 🌙",
	"Hey there 👋",
	"How's it going?",
	"What's new?",
	// Emojis only (universal)
	"👋",
	"👍",
	"🙂",
	"😊",
	"✌️",
	"🤙",
	// Short casual
	"yo",
	"hey hey",
	"hii",
	"sup",
	"heya",
}

// StartAutoWarmup starts the automatic warmup system for new accounts
func (m *ClientManager) StartAutoWarmup() {
	// Stop existing warmup if running
	if m.warmupStop != nil {
		close(m.warmupStop)
	}

	m.warmupStop = make(chan struct{})
	stopCh := m.warmupStop

	// Check every 30 minutes if any account needs warmup
	ticker := time.NewTicker(WarmupCheckInterval)

	go func(stop <-chan struct{}) {
		log.Println("[AutoWarmup] Started - checking every 30 minutes for accounts needing warmup")
		defer ticker.Stop()

		// Run immediately on start
		m.checkAndSendWarmup()

		for {
			select {
			case <-ticker.C:
				m.checkAndSendWarmup()
			case <-stop:
				log.Println("[AutoWarmup] Stopped")
				return
			}
		}
	}(stopCh)
}

// StopAutoWarmup stops the automatic warmup system
func (m *ClientManager) StopAutoWarmup() {
	if m.warmupStop != nil {
		close(m.warmupStop)
		m.warmupStop = nil
		log.Println("[AutoWarmup] Stopped")
	}
}

// checkAndSendWarmup checks all accounts and sends warmup messages as needed
func (m *ClientManager) checkAndSendWarmup() {
	// Get all active accounts
	activeAccounts := m.GetActiveAccounts()

	if len(activeAccounts) < 2 {
		// Need at least 2 accounts to send warmup messages between them
		return
	}

	// Collect accounts that need warmup
	var accountsNeedingWarmup []*AccountClient
	for _, acc := range activeAccounts {
		if m.needsWarmup(acc) {
			accountsNeedingWarmup = append(accountsNeedingWarmup, acc)
		}
	}

	if len(accountsNeedingWarmup) == 0 {
		return
	}

	log.Printf("[AutoWarmup] %d accounts need warmup messages", len(accountsNeedingWarmup))

	// Send warmup messages
	for i, acc := range accountsNeedingWarmup {
		// Find a target account (round-robin through active accounts)
		targetIndex := (i + 1) % len(activeAccounts)
		target := activeAccounts[targetIndex]

		// Don't send to self
		if target.Phone == acc.Phone {
			targetIndex = (targetIndex + 1) % len(activeAccounts)
			target = activeAccounts[targetIndex]
			// If still same (only 2 accounts and both need warmup), skip
			if target.Phone == acc.Phone {
				continue
			}
		}

		// Pick random warmup message
		message := warmupMessages[rand.Intn(len(warmupMessages))]

		// Send warmup message asynchronously
		go m.sendWarmupMessage(acc, target.Phone, message)

		// Longer delay between sending from different accounts (30-120 seconds)
		delaySeconds := 30 + rand.Intn(90)
		time.Sleep(time.Duration(delaySeconds) * time.Second)
	}
}

// needsWarmup checks if an account needs a warmup message
func (m *ClientManager) needsWarmup(acc *AccountClient) bool {
	// Already completed warmup
	if acc.WarmupComplete {
		return false
	}

	// Check account age
	accountAge := time.Since(acc.CreatedAt)

	// If account is older than warmup duration, mark as complete
	if accountAge >= WarmupDuration {
		m.MarkWarmupComplete(acc.Phone)
		return false
	}

	// Check time since last warmup message
	timeSinceLastWarmup := time.Since(acc.LastWarmupSent)

	// Random interval between 1-2 hours
	requiredInterval := time.Duration(WarmupMinInterval.Minutes()+rand.Float64()*(WarmupMaxInterval-WarmupMinInterval).Minutes()) * time.Minute

	// Need warmup if enough time has passed
	return timeSinceLastWarmup >= requiredInterval
}

// sendWarmupMessage sends a warmup message from one account to another
func (m *ClientManager) sendWarmupMessage(from *AccountClient, toPhone string, message string) {
	// Create JID for recipient
	toPhoneSanitized := sanitizePhone(toPhone)
	toJID := types.NewJID(toPhoneSanitized, types.DefaultUserServer)

	log.Printf("[AutoWarmup] Sending: %s -> %s: %s", from.Phone, toPhone, message)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create message
	msg := &waE2E.Message{
		Conversation: proto.String(message),
	}

	_, err := from.Client.SendMessage(ctx, toJID, msg)
	if err != nil {
		log.Printf("[AutoWarmup] Failed to send from %s to %s: %v", from.Phone, toPhone, err)
		return
	}

	// Update last warmup sent time
	m.UpdateWarmupSent(from.Phone)

	// Notify Master server about warmup message
	go m.NotifyMasterWarmupMessage(from.Phone, toPhone)

	log.Printf("[AutoWarmup] Sent successfully: %s -> %s", from.Phone, toPhone)
}

// GetWarmupStatus returns the warmup status of all accounts
func (m *ClientManager) GetWarmupStatus() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var statuses []map[string]interface{}
	for phone, acc := range m.accounts {
		if !acc.LoggedIn {
			continue
		}

		accountAge := time.Since(acc.CreatedAt)
		remainingWarmup := WarmupDuration - accountAge
		if remainingWarmup < 0 {
			remainingWarmup = 0
		}

		status := map[string]interface{}{
			"phone":             phone,
			"created_at":        acc.CreatedAt.Format(time.RFC3339),
			"account_age_hours": accountAge.Hours(),
			"warmup_complete":   acc.WarmupComplete,
			"remaining_warmup":  remainingWarmup.String(),
		}

		if !acc.LastWarmupSent.IsZero() {
			status["last_warmup_sent"] = acc.LastWarmupSent.Format(time.RFC3339)
			status["time_since_warmup"] = time.Since(acc.LastWarmupSent).String()
		}

		statuses = append(statuses, status)
	}

	return statuses
}

