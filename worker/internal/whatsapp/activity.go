package whatsapp

import (
	"context"
	"log"
	"math/rand"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
)

const (
	// ActivityMinInterval - minimum time between activities (15 minutes)
	ActivityMinInterval = 15 * time.Minute
	// ActivityMaxInterval - maximum time between activities (45 minutes)
	ActivityMaxInterval = 45 * time.Minute
)

// ActivityType represents a type of human activity
type ActivityType int

const (
	ActivityOpenChat ActivityType = iota
	ActivityScrollChats
	ActivitySearchContact
	ActivityViewStatus
	ActivityOpenSettings
	ActivityTypeAndDelete
)

// ActivityLog represents a logged activity
type ActivityLog struct {
	Time        time.Time    `json:"time"`
	Phone       string       `json:"phone"`
	Activity    ActivityType `json:"activity"`
	Description string       `json:"description"`
	Details     string       `json:"details,omitempty"`
}

// activityNames maps activity types to display names
var activityNames = map[ActivityType]string{
	ActivityOpenChat:      "👀 Opened chat",
	ActivityScrollChats:   "📜 Scrolled chat list",
	ActivitySearchContact: "🔍 Searched contacts",
	ActivityViewStatus:    "📷 Viewed status",
	ActivityOpenSettings:  "⚙️ Opened settings",
	ActivityTypeAndDelete: "✍️ Started typing (cancelled)",
}

// activityLogs stores recent activities per account
var activityLogs = make(map[string][]ActivityLog)
var activityLogsMu sync.RWMutex
var activityStopChannels = make(map[string]chan struct{})
var activityStopMu sync.Mutex

// StartHumanActivitySimulator starts the activity simulator for an account
func (m *ClientManager) StartHumanActivitySimulator(phone string) {
	activityStopMu.Lock()
	// Stop existing simulator if running
	if stopCh, exists := activityStopChannels[phone]; exists {
		close(stopCh)
	}
	stopCh := make(chan struct{})
	activityStopChannels[phone] = stopCh
	activityStopMu.Unlock()

	go func(stop <-chan struct{}) {
		log.Printf("[Activity] 🤖 Started human activity simulator for %s", phone)

		for {
			// Random wait between 15-45 minutes
			waitMinutes := rand.Intn(int(ActivityMaxInterval-ActivityMinInterval)/int(time.Minute)) + int(ActivityMinInterval/time.Minute)
			waitDuration := time.Duration(waitMinutes) * time.Minute

			select {
			case <-time.After(waitDuration):
				m.performRandomActivity(phone)
			case <-stop:
				log.Printf("[Activity] 🛑 Stopped activity simulator for %s", phone)
				return
			}
		}
	}(stopCh)
}

// StopHumanActivitySimulator stops the activity simulator for an account
func (m *ClientManager) StopHumanActivitySimulator(phone string) {
	activityStopMu.Lock()
	defer activityStopMu.Unlock()

	if stopCh, exists := activityStopChannels[phone]; exists {
		close(stopCh)
		delete(activityStopChannels, phone)
		log.Printf("[Activity] 🛑 Stopped activity simulator for %s", phone)
	}
}

// StartAllActivitySimulators starts activity simulators for all connected accounts
func (m *ClientManager) StartAllActivitySimulators() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for phone, acc := range m.accounts {
		if acc.Connected && acc.LoggedIn {
			m.StartHumanActivitySimulator(phone)
		}
	}
}

// StopAllActivitySimulators stops all activity simulators
func (m *ClientManager) StopAllActivitySimulators() {
	activityStopMu.Lock()
	defer activityStopMu.Unlock()

	for phone, stopCh := range activityStopChannels {
		close(stopCh)
		log.Printf("[Activity] 🛑 Stopped activity simulator for %s", phone)
	}
	activityStopChannels = make(map[string]chan struct{})
}

// performRandomActivity performs a random human-like activity
func (m *ClientManager) performRandomActivity(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || !acc.Connected || !acc.LoggedIn || acc.Client == nil {
		return
	}

	// Pick random activity
	activity := ActivityType(rand.Intn(6))

	var details string

	switch activity {
	case ActivityOpenChat:
		details = m.activityOpenChat(acc)
	case ActivityScrollChats:
		details = m.activityScrollChats(acc)
	case ActivitySearchContact:
		details = m.activitySearchContact(acc)
	case ActivityViewStatus:
		details = m.activityViewStatus(acc)
	case ActivityOpenSettings:
		details = m.activityOpenSettings(acc)
	case ActivityTypeAndDelete:
		details = m.activityTypeAndDelete(acc)
	}

	// Log the activity
	m.logActivity(phone, activity, details)

	log.Printf("[Activity] 🤖 %s: %s %s", phone, activityNames[activity], details)
}

// activityOpenChat - Open a chat and "read" it
func (m *ClientManager) activityOpenChat(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Get recent contacts from the store
	contacts, err := acc.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil || len(contacts) == 0 {
		// Fallback: just send presence
		acc.Client.SendPresence(ctx, types.PresenceAvailable)
		time.Sleep(time.Duration(rand.Intn(3)+2) * time.Second)
		return ""
	}

	// Pick a random contact
	var targetJID types.JID
	i := 0
	targetIdx := rand.Intn(len(contacts))
	for jid := range contacts {
		if i == targetIdx {
			targetJID = jid
			break
		}
		i++
	}

	// Send "paused" presence (viewing chat)
	acc.Client.SendChatPresence(ctx, targetJID, types.ChatPresencePaused, types.ChatPresenceMediaText)

	// Wait 2-5 seconds (reading)
	time.Sleep(time.Duration(rand.Intn(3)+2) * time.Second)

	return "with " + targetJID.User[:min(6, len(targetJID.User))] + "..."
}

// activityScrollChats - Simulate scrolling through chat list
func (m *ClientManager) activityScrollChats(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Set presence to available (viewing chats)
	acc.Client.SendPresence(ctx, types.PresenceAvailable)

	// Wait 1-3 seconds
	time.Sleep(time.Duration(rand.Intn(2)+1) * time.Second)

	return ""
}

// activitySearchContact - Simulate searching for a contact
func (m *ClientManager) activitySearchContact(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Set presence
	acc.Client.SendPresence(ctx, types.PresenceAvailable)

	// Simulate search delay
	time.Sleep(time.Duration(rand.Intn(2)+1) * time.Second)

	// Generate random search term
	letters := "abcdefghijklmnopqrstuvwxyz"
	searchLen := rand.Intn(2) + 2 // 2-3 letters
	search := ""
	for i := 0; i < searchLen; i++ {
		search += string(letters[rand.Intn(len(letters))])
	}

	return "\"" + search + "\""
}

// activityViewStatus - Simulate viewing status updates
func (m *ClientManager) activityViewStatus(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Set presence
	acc.Client.SendPresence(ctx, types.PresenceAvailable)

	// Try to get status privacy settings (simulates opening status)
	acc.Client.GetStatusPrivacy(ctx)

	// Wait 3-8 seconds (viewing statuses)
	time.Sleep(time.Duration(rand.Intn(5)+3) * time.Second)

	return ""
}

// activityOpenSettings - Simulate opening settings
func (m *ClientManager) activityOpenSettings(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Set presence
	acc.Client.SendPresence(ctx, types.PresenceAvailable)

	// Try to get privacy settings (simulates opening settings)
	acc.Client.GetPrivacySettings(ctx)

	// Wait 1-2 seconds
	time.Sleep(time.Duration(rand.Intn(1)+1) * time.Second)

	return ""
}

// activityTypeAndDelete - Start typing then cancel (delete)
func (m *ClientManager) activityTypeAndDelete(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Get contacts
	contacts, err := acc.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil || len(contacts) == 0 {
		return ""
	}

	// Pick a random contact
	var targetJID types.JID
	i := 0
	targetIdx := rand.Intn(len(contacts))
	for jid := range contacts {
		if i == targetIdx {
			targetJID = jid
			break
		}
		i++
	}

	// Start "typing"
	acc.Client.SendChatPresence(ctx, targetJID, types.ChatPresenceComposing, types.ChatPresenceMediaText)

	// Wait 1-3 seconds
	time.Sleep(time.Duration(rand.Intn(2)+1) * time.Second)

	// Stop typing (as if deleted)
	acc.Client.SendChatPresence(ctx, targetJID, types.ChatPresencePaused, types.ChatPresenceMediaText)

	return "in chat with " + targetJID.User[:min(6, len(targetJID.User))] + "..."
}

// logActivity logs an activity for an account
func (m *ClientManager) logActivity(phone string, activity ActivityType, details string) {
	activityLogsMu.Lock()
	defer activityLogsMu.Unlock()

	logEntry := ActivityLog{
		Time:        time.Now(),
		Phone:       phone,
		Activity:    activity,
		Description: activityNames[activity],
		Details:     details,
	}

	// Add to beginning of log
	logs := activityLogs[phone]
	logs = append([]ActivityLog{logEntry}, logs...)

	// Keep only last 20 entries per account
	if len(logs) > 20 {
		logs = logs[:20]
	}

	activityLogs[phone] = logs
}

// GetActivityLogs returns recent activity logs for an account
func (m *ClientManager) GetActivityLogs(phone string) []ActivityLog {
	activityLogsMu.RLock()
	defer activityLogsMu.RUnlock()

	if logs, exists := activityLogs[phone]; exists {
		return logs
	}
	return []ActivityLog{}
}

// GetAllActivityLogs returns activity logs for all accounts
func (m *ClientManager) GetAllActivityLogs() map[string][]ActivityLog {
	activityLogsMu.RLock()
	defer activityLogsMu.RUnlock()

	result := make(map[string][]ActivityLog)
	for phone, logs := range activityLogs {
		result[phone] = logs
	}
	return result
}

// GetLastActivity returns the time of the last activity for an account
func (m *ClientManager) GetLastActivity(phone string) *time.Time {
	activityLogsMu.RLock()
	defer activityLogsMu.RUnlock()

	if logs, exists := activityLogs[phone]; exists && len(logs) > 0 {
		return &logs[0].Time
	}
	return nil
}

// min helper function
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

