package whatsapp

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

const (
	// WarmupDuration is how long new accounts need warmup (60 days for full maturity to Veteran)
	WarmupDuration = 60 * 24 * time.Hour

	// WarmupCheckInterval is how often to run warmup activities
	WarmupCheckInterval = 30 * time.Minute
)

// WarmupLimits defines how many warmup activities per stage per day
var WarmupLimits = map[string]WarmupConfig{
	"new_born": {MessagesPerDay: 3, ActivitiesPerDay: 5, MinInterval: 2 * time.Hour, MaxInterval: 4 * time.Hour},
	"baby":     {MessagesPerDay: 8, ActivitiesPerDay: 10, MinInterval: 1 * time.Hour, MaxInterval: 2 * time.Hour},
	"toddler":  {MessagesPerDay: 15, ActivitiesPerDay: 15, MinInterval: 45 * time.Minute, MaxInterval: 90 * time.Minute},
	"teen":     {MessagesPerDay: 25, ActivitiesPerDay: 20, MinInterval: 30 * time.Minute, MaxInterval: 60 * time.Minute},
	"adult":    {MessagesPerDay: 40, ActivitiesPerDay: 25, MinInterval: 20 * time.Minute, MaxInterval: 45 * time.Minute},
	"veteran":  {MessagesPerDay: 60, ActivitiesPerDay: 30, MinInterval: 15 * time.Minute, MaxInterval: 30 * time.Minute},
}

type WarmupConfig struct {
	MessagesPerDay   int
	ActivitiesPerDay int
	MinInterval      time.Duration
	MaxInterval      time.Duration
}

// WarmupStats tracks warmup activity for each account
type WarmupStats struct {
	MessagesSentToday    int
	ActivitiesToday      int
	LastActivity         time.Time
	LastMessage          time.Time
	LastDayReset         string
}

var warmupStats = make(map[string]*WarmupStats)

// Warmup messages - casual, human-like
var warmupMessages = []string{
	// Hebrew casual
	"היי מה קורה?", "מה נשמע?", "שלום!", "בוקר טוב ☀️", "ערב טוב 🌙",
	"מה המצב?", "איך הולך?", "הכל טוב?", "מה חדש?", "איך היום?",
	"היי 👋", "מה קורה אצלך?", "שבוע טוב!", "יום טוב!", "מה נשמע חבר?",
	"אהלן!", "מה העניינים?", "הכל בסדר?", "מה איתך?", "נו מה קורה?",
	// English casual
	"Hey!", "Hi there!", "What's up?", "How are you?", "Good morning! ☀️",
	"Hey there 👋", "How's it going?", "What's new?", "Yo!", "Hii",
	"Sup?", "Hey hey", "How's your day?", "All good?",
	// Emojis only
	"👋", "👍", "🙂", "😊", "✌️", "🤙", "💪", "🔥",
	// Longer messages
	"היי! מה נשמע? הכל בסדר?", "שלום! איך הולך היום?",
	"Hey! How's everything going?", "Hi! Hope you're having a good day!",
}

// Self messages - things people send to themselves
var selfMessages = []string{
	"תזכורת", "לבדוק מחר", "קניות:", "רשימה:", "📝", "💡", "⭐",
	"לזכור!", "חשוב!", "TODO", "לעשות:", "רעיון:", "הערה:",
	"לא לשכוח", "בדיקה", "test", "...", "🔔", "📌",
}

// StartAutoWarmup starts the automatic warmup system
func (m *ClientManager) StartAutoWarmup() {
	if m.warmupStop != nil {
		close(m.warmupStop)
	}

	m.warmupStop = make(chan struct{})
	stopCh := m.warmupStop

	ticker := time.NewTicker(WarmupCheckInterval)

	go func(stop <-chan struct{}) {
		log.Println("[Warmup] 🔥 Started - Real warmup system active")
		defer ticker.Stop()

		// Run immediately
		m.runWarmupCycle()

		for {
			select {
			case <-ticker.C:
				m.runWarmupCycle()
			case <-stop:
				log.Println("[Warmup] Stopped")
				return
			}
		}
	}(stopCh)
}

// StopAutoWarmup stops the warmup system
func (m *ClientManager) StopAutoWarmup() {
	if m.warmupStop != nil {
		close(m.warmupStop)
		m.warmupStop = nil
		log.Println("[Warmup] Stopped")
	}
}

// runWarmupCycle runs a complete warmup cycle for all accounts
func (m *ClientManager) runWarmupCycle() {
	accounts := m.GetActiveAccounts()
	if len(accounts) == 0 {
		return
	}

	log.Printf("[Warmup] 🔄 Running warmup cycle for %d accounts", len(accounts))

	// Reset daily stats if new day
	today := time.Now().Format("2006-01-02")
	for phone, stats := range warmupStats {
		if stats.LastDayReset != today {
			stats.MessagesSentToday = 0
			stats.ActivitiesToday = 0
			stats.LastDayReset = today
			log.Printf("[Warmup] Reset daily stats for %s", phone)
		}
	}

	// Process each account
	for _, acc := range accounts {
		go m.processAccountWarmup(acc, accounts)
		
		// Delay between accounts (10-30 seconds)
		time.Sleep(time.Duration(10+rand.Intn(20)) * time.Second)
	}
}

// processAccountWarmup handles warmup for a single account
func (m *ClientManager) processAccountWarmup(acc *AccountClient, allAccounts []*AccountClient) {
	phone := acc.Phone
	stage := acc.WarmupStage
	if stage == "" {
		stage = m.calculateStage(acc)
	}

	config := WarmupLimits[stage]
	if config.MessagesPerDay == 0 {
		config = WarmupLimits["adult"]
	}

	// Get or create stats
	stats := getWarmupStats(phone)

	// Check if we should do activity now
	timeSinceLastActivity := time.Since(stats.LastActivity)
	requiredInterval := config.MinInterval + time.Duration(rand.Int63n(int64(config.MaxInterval-config.MinInterval)))

	if timeSinceLastActivity < requiredInterval {
		return // Too soon
	}

	// Check daily limits
	if stats.MessagesSentToday >= config.MessagesPerDay && stats.ActivitiesToday >= config.ActivitiesPerDay {
		return // Reached daily limit
	}

	// Decide what to do (weighted random)
	action := m.pickWarmupAction(stats, config)

	switch action {
	case "send_to_other":
		m.warmupSendToOther(acc, allAccounts, stats)
	case "send_to_self":
		m.warmupSendToSelf(acc, stats)
	case "activity":
		m.warmupDoActivity(acc, stats)
	}
}

// pickWarmupAction decides what warmup action to perform
func (m *ClientManager) pickWarmupAction(stats *WarmupStats, config WarmupConfig) string {
	// Weights: send to other (40%), send to self (20%), activity (40%)
	canSendMessage := stats.MessagesSentToday < config.MessagesPerDay
	canDoActivity := stats.ActivitiesToday < config.ActivitiesPerDay

	if !canSendMessage && !canDoActivity {
		return ""
	}

	r := rand.Intn(100)

	if canSendMessage && r < 40 {
		return "send_to_other"
	} else if canSendMessage && r < 60 {
		return "send_to_self"
	} else if canDoActivity {
		return "activity"
	} else if canSendMessage {
		return "send_to_other"
	}

	return ""
}

// warmupSendToOther sends a message to another account in the system
func (m *ClientManager) warmupSendToOther(from *AccountClient, allAccounts []*AccountClient, stats *WarmupStats) {
	if len(allAccounts) < 2 {
		return
	}

	// Pick random target (not self)
	var target *AccountClient
	for attempts := 0; attempts < 5; attempts++ {
		idx := rand.Intn(len(allAccounts))
		if allAccounts[idx].Phone != from.Phone {
			target = allAccounts[idx]
			break
		}
	}

	if target == nil {
		return
	}

	// Pick random message
	message := warmupMessages[rand.Intn(len(warmupMessages))]

	// Send
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	toJID := types.NewJID(sanitizePhone(target.Phone), types.DefaultUserServer)
	msg := &waE2E.Message{Conversation: proto.String(message)}

	_, err := from.Client.SendMessage(ctx, toJID, msg)
	if err != nil {
		log.Printf("[Warmup] ❌ %s -> %s failed: %v", from.Phone, target.Phone, err)
		return
	}

	stats.MessagesSentToday++
	stats.LastMessage = time.Now()
	stats.LastActivity = time.Now()

	log.Printf("[Warmup] 💬 %s -> %s: %s (msgs today: %d)", from.Phone, target.Phone, message, stats.MessagesSentToday)

	// Update account's warmup sent time
	m.UpdateWarmupSent(from.Phone)
}

// warmupSendToSelf sends a message to yourself (common human behavior)
func (m *ClientManager) warmupSendToSelf(acc *AccountClient, stats *WarmupStats) {
	message := selfMessages[rand.Intn(len(selfMessages))]

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Send to self
	selfJID := types.NewJID(sanitizePhone(acc.Phone), types.DefaultUserServer)
	msg := &waE2E.Message{Conversation: proto.String(message)}

	_, err := acc.Client.SendMessage(ctx, selfJID, msg)
	if err != nil {
		log.Printf("[Warmup] ❌ %s -> self failed: %v", acc.Phone, err)
		return
	}

	stats.MessagesSentToday++
	stats.LastMessage = time.Now()
	stats.LastActivity = time.Now()

	log.Printf("[Warmup] 📝 %s -> self: %s (msgs today: %d)", acc.Phone, message, stats.MessagesSentToday)
}

// warmupDoActivity performs a human-like activity
func (m *ClientManager) warmupDoActivity(acc *AccountClient, stats *WarmupStats) {
	activities := []string{
		"presence_online",
		"presence_offline",
		"read_chat",
		"typing",
	}

	activity := activities[rand.Intn(len(activities))]

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	switch activity {
	case "presence_online":
		err = acc.Client.SendPresence(ctx, types.PresenceAvailable)
	case "presence_offline":
		err = acc.Client.SendPresence(ctx, types.PresenceUnavailable)
	case "read_chat":
		// Mark random chat as read (simulated by sending presence)
		err = acc.Client.SendPresence(ctx, types.PresenceAvailable)
	case "typing":
		// Send composing presence to a random account
		allAccounts := m.GetActiveAccounts()
		if len(allAccounts) > 1 {
			for _, target := range allAccounts {
				if target.Phone != acc.Phone {
					targetJID := types.NewJID(sanitizePhone(target.Phone), types.DefaultUserServer)
					acc.Client.SendChatPresence(ctx, targetJID, types.ChatPresenceComposing, types.ChatPresenceMediaText)
					time.Sleep(time.Duration(1+rand.Intn(3)) * time.Second)
					acc.Client.SendChatPresence(ctx, targetJID, types.ChatPresencePaused, types.ChatPresenceMediaText)
					break
				}
			}
		}
	}

	if err != nil {
		log.Printf("[Warmup] ❌ %s activity %s failed: %v", acc.Phone, activity, err)
		return
	}

	stats.ActivitiesToday++
	stats.LastActivity = time.Now()

	log.Printf("[Warmup] 🎯 %s: %s (activities today: %d)", acc.Phone, activity, stats.ActivitiesToday)
}

// calculateStage determines the warmup stage based on account age
func (m *ClientManager) calculateStage(acc *AccountClient) string {
	ageDays := time.Since(acc.CreatedAt).Hours() / 24

	if ageDays >= 60 {
		return "veteran"
	} else if ageDays >= 31 {
		return "adult"
	} else if ageDays >= 15 {
		return "teen"
	} else if ageDays >= 8 {
		return "toddler"
	} else if ageDays >= 4 {
		return "baby"
	}
	return "new_born"
}

// getWarmupStats gets or creates warmup stats for a phone
func getWarmupStats(phone string) *WarmupStats {
	if stats, ok := warmupStats[phone]; ok {
		return stats
	}

	stats := &WarmupStats{
		LastDayReset: time.Now().Format("2006-01-02"),
	}
	warmupStats[phone] = stats
	return stats
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
		stage := m.calculateStage(acc)
		config := WarmupLimits[stage]
		stats := getWarmupStats(phone)

		remainingWarmup := WarmupDuration - accountAge
		if remainingWarmup < 0 {
			remainingWarmup = 0
		}

		status := map[string]interface{}{
			"phone":              phone,
			"stage":              stage,
			"account_age_days":   int(accountAge.Hours() / 24),
			"warmup_complete":    acc.WarmupComplete,
			"remaining_days":     int(remainingWarmup.Hours() / 24),
			"messages_today":     stats.MessagesSentToday,
			"messages_limit":     config.MessagesPerDay,
			"activities_today":   stats.ActivitiesToday,
			"activities_limit":   config.ActivitiesPerDay,
			"last_activity":      stats.LastActivity.Format(time.RFC3339),
		}

		statuses = append(statuses, status)
	}

	return statuses
}

// GetAccountsCapacity returns the sending capacity for all accounts
func (m *ClientManager) GetAccountsCapacity() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var capacities []map[string]interface{}
	for phone, acc := range m.accounts {
		if !acc.LoggedIn || !acc.Connected {
			continue
		}

		acc.mu.RLock()
		stage := acc.WarmupStage
		if stage == "" {
			stage = m.calculateStage(acc)
		}
		todayCount := acc.TotalMsgToday
		hourCount := acc.HourMsgCount
		acc.mu.RUnlock()

		limits := getStageLimits(stage)
		availableDaily := limits.MaxDay - todayCount
		availableHourly := limits.MaxHour - hourCount

		if availableDaily < 0 {
			availableDaily = 0
		}
		if availableHourly < 0 {
			availableHourly = 0
		}

		available := availableDaily
		if availableHourly < available {
			available = availableHourly
		}

		capacities = append(capacities, map[string]interface{}{
			"phone":            phone,
			"stage":            stage,
			"max_daily":        limits.MaxDay,
			"max_hourly":       limits.MaxHour,
			"sent_today":       todayCount,
			"sent_this_hour":   hourCount,
			"available_daily":  availableDaily,
			"available_hourly": availableHourly,
			"available":        available,
			"can_send":         available > 0,
		})
	}

	return capacities
}

// GetWarmupSummary returns a summary of warmup activity
func (m *ClientManager) GetWarmupSummary() map[string]interface{} {
	accounts := m.GetActiveAccounts()

	stageCounts := make(map[string]int)
	totalMessages := 0
	totalActivities := 0

	for _, acc := range accounts {
		stage := m.calculateStage(acc)
		stageCounts[stage]++

		stats := getWarmupStats(acc.Phone)
		totalMessages += stats.MessagesSentToday
		totalActivities += stats.ActivitiesToday
	}

	return map[string]interface{}{
		"total_accounts":     len(accounts),
		"stage_distribution": stageCounts,
		"messages_today":     totalMessages,
		"activities_today":   totalActivities,
		"warmup_limits":      WarmupLimits,
	}
}

// ForceWarmupNow forces an immediate warmup cycle (for testing)
func (m *ClientManager) ForceWarmupNow() string {
	accounts := m.GetActiveAccounts()
	if len(accounts) == 0 {
		return "No active accounts"
	}

	go m.runWarmupCycle()
	return fmt.Sprintf("Warmup cycle started for %d accounts", len(accounts))
}
