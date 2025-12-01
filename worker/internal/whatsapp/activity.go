package whatsapp

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
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
	ActivityMarkRead      ActivityType = iota // 👀 Mark chat as read
	ActivityPresence                          // 🟢 Online → Offline
	ActivityTypeAndCancel                     // ✍️ Type and cancel
	ActivityViewStatus                        // 📷 View status
	ActivityVoiceNote                         // 🎤 Send empty voice note
	ActivityIdle                              // 😴 Do nothing
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
	ActivityMarkRead:      "👀 Marked chat as read",
	ActivityPresence:      "🟢 Online → Offline",
	ActivityTypeAndCancel: "✍️ Started typing (cancelled)",
	ActivityViewStatus:    "📷 Viewed status",
	ActivityVoiceNote:     "🎤 Sent voice note",
	ActivityIdle:          "😴 Idle - no action",
}

// Activity weights (total = 100)
var activityWeights = []int{
	20, // 👀 Mark read - 20%
	20, // 🟢 Presence - 20%
	20, // ✍️ Type and cancel - 20%
	10, // 📷 View status - 10%
	15, // 🎤 Voice note - 15%
	15, // 😴 Idle - 15%
}

// activityLogs stores recent activities per account
var activityLogs = make(map[string][]ActivityLog)
var activityLogsMu sync.RWMutex
var activityStopChannels = make(map[string]chan struct{})
var activityStopMu sync.Mutex

// Prerecorded silence OGG files (base64 encoded minimal opus silence)
// These are tiny OGG files with opus codec containing silence
var silenceFiles = map[int][]byte{
	3: generateMinimalSilence(3),
	4: generateMinimalSilence(4),
	5: generateMinimalSilence(5),
	6: generateMinimalSilence(6),
	7: generateMinimalSilence(7),
}

// generateMinimalSilence creates a minimal silent OGG/Opus file
// This is a simplified version - in production you'd use pre-recorded files
func generateMinimalSilence(seconds int) []byte {
	// Minimal OGG Opus header + silence frames
	// This is a basic structure - WhatsApp accepts this format
	header := []byte{
		// OGG page header
		0x4F, 0x67, 0x67, 0x53, // "OggS"
		0x00,                   // version
		0x02,                   // header type (BOS)
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // granule position
		0x00, 0x00, 0x00, 0x00, // serial number
		0x00, 0x00, 0x00, 0x00, // page sequence
		0x00, 0x00, 0x00, 0x00, // CRC (will be ignored for our purpose)
		0x01,       // segment count
		0x13,       // segment size (19 bytes)
		0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
		0x01,       // version
		0x01,       // channel count (mono)
		0x38, 0x01, // pre-skip
		0x80, 0xBB, 0x00, 0x00, // sample rate (48000)
		0x00, 0x00, // output gain
		0x00, // channel mapping
	}

	// Add comment header page
	comment := []byte{
		0x4F, 0x67, 0x67, 0x53, // "OggS"
		0x00,                   // version
		0x00,                   // header type
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // granule position
		0x00, 0x00, 0x00, 0x00, // serial number
		0x01, 0x00, 0x00, 0x00, // page sequence
		0x00, 0x00, 0x00, 0x00, // CRC
		0x01,       // segment count
		0x10,       // segment size (16 bytes)
		0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, // "OpusTags"
		0x00, 0x00, 0x00, 0x00, // vendor string length
		0x00, 0x00, 0x00, 0x00, // user comment list length
	}

	// Add audio data pages with silence
	// Each frame is 20ms of silence
	framesNeeded := seconds * 50 // 50 frames per second (20ms each)
	silenceFrame := []byte{0xF8, 0xFF, 0xFE} // Opus silence frame

	audio := make([]byte, 0)
	for i := 0; i < framesNeeded; i++ {
		audio = append(audio, silenceFrame...)
	}

	// Wrap audio in OGG page
	audioPage := []byte{
		0x4F, 0x67, 0x67, 0x53, // "OggS"
		0x00,                   // version
		0x04,                   // header type (EOS)
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // granule position
		0x00, 0x00, 0x00, 0x00, // serial number
		0x02, 0x00, 0x00, 0x00, // page sequence
		0x00, 0x00, 0x00, 0x00, // CRC
		byte(len(audio) / 255), // segment count
	}

	// Add segment table
	remaining := len(audio)
	for remaining > 0 {
		if remaining >= 255 {
			audioPage = append(audioPage, 0xFF)
			remaining -= 255
		} else {
			audioPage = append(audioPage, byte(remaining))
			remaining = 0
		}
	}

	audioPage = append(audioPage, audio...)

	result := make([]byte, 0, len(header)+len(comment)+len(audioPage))
	result = append(result, header...)
	result = append(result, comment...)
	result = append(result, audioPage...)

	return result
}

// StartHumanActivitySimulator starts the activity simulator for an account
func (m *ClientManager) StartHumanActivitySimulator(phone string) {
	activityStopMu.Lock()
	// Stop existing simulator if running
	if stopCh, exists := activityStopChannels[phone]; exists {
		select {
		case <-stopCh:
			// Already closed
		default:
			close(stopCh)
		}
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
				m.performWeightedActivity(phone)
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
		select {
		case <-stopCh:
			// Already closed
		default:
			close(stopCh)
		}
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
			go m.StartHumanActivitySimulator(phone)
		}
	}
}

// StopAllActivitySimulators stops all activity simulators
func (m *ClientManager) StopAllActivitySimulators() {
	activityStopMu.Lock()
	defer activityStopMu.Unlock()

	for phone, stopCh := range activityStopChannels {
		select {
		case <-stopCh:
			// Already closed
		default:
			close(stopCh)
		}
		log.Printf("[Activity] 🛑 Stopped activity simulator for %s", phone)
	}
	activityStopChannels = make(map[string]chan struct{})
}

// weightedRandom selects an activity based on weights
func weightedRandom() ActivityType {
	total := 0
	for _, w := range activityWeights {
		total += w
	}

	r := rand.Intn(total)
	cumulative := 0

	for i, w := range activityWeights {
		cumulative += w
		if r < cumulative {
			return ActivityType(i)
		}
	}
	return ActivityIdle
}

// performWeightedActivity performs a weighted random human-like activity
func (m *ClientManager) performWeightedActivity(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || !acc.Connected || !acc.LoggedIn || acc.Client == nil {
		return
	}

	// Pick weighted random activity
	activity := weightedRandom()

	var details string

	switch activity {
	case ActivityMarkRead:
		details = m.activityMarkRead(acc)
	case ActivityPresence:
		details = m.activityPresence(acc)
	case ActivityTypeAndCancel:
		details = m.activityTypeAndCancel(acc)
	case ActivityViewStatus:
		details = m.activityViewStatus(acc)
	case ActivityVoiceNote:
		details = m.activityVoiceNote(acc, phone)
	case ActivityIdle:
		details = "" // Do nothing
	}

	// Log the activity
	m.logActivity(phone, activity, details)

	log.Printf("[Activity] 🤖 %s: %s %s", phone, activityNames[activity], details)
}

// activityMarkRead - Mark a random chat as read
func (m *ClientManager) activityMarkRead(acc *AccountClient) string {
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

	return "chat with " + targetJID.User[:min(6, len(targetJID.User))] + "..."
}

// activityPresence - Send online then offline presence
func (m *ClientManager) activityPresence(acc *AccountClient) string {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Go online
	acc.Client.SendPresence(ctx, types.PresenceAvailable)

	// Stay online 5-15 seconds
	time.Sleep(time.Duration(rand.Intn(10)+5) * time.Second)

	// Go offline
	acc.Client.SendPresence(ctx, types.PresenceUnavailable)

	return ""
}

// activityTypeAndCancel - Start typing then cancel
func (m *ClientManager) activityTypeAndCancel(acc *AccountClient) string {
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

// activityVoiceNote - Send empty voice note to another account in the system
func (m *ClientManager) activityVoiceNote(acc *AccountClient, fromPhone string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Get another account from our system to send to
	targetPhone := m.getRandomInternalAccount(fromPhone)
	if targetPhone == "" {
		return "no target available"
	}

	// Create JID
	targetPhoneSanitized := sanitizePhone(targetPhone)
	targetJID := types.NewJID(targetPhoneSanitized, types.DefaultUserServer)

	// Random duration 3-7 seconds
	duration := rand.Intn(5) + 3

	// Get silence audio
	silenceAudio, ok := silenceFiles[duration]
	if !ok {
		silenceAudio = silenceFiles[5] // fallback to 5 seconds
		duration = 5
	}

	// Upload to WhatsApp servers
	uploaded, err := acc.Client.Upload(ctx, silenceAudio, whatsmeow.MediaAudio)
	if err != nil {
		log.Printf("[Activity] Failed to upload voice note: %v", err)
		return "upload failed"
	}

	// Create audio message (voice note)
	audioMsg := &waE2E.AudioMessage{
		URL:           proto.String(uploaded.URL),
		DirectPath:    proto.String(uploaded.DirectPath),
		MediaKey:      uploaded.MediaKey,
		Mimetype:      proto.String("audio/ogg; codecs=opus"),
		FileEncSHA256: uploaded.FileEncSHA256,
		FileSHA256:    uploaded.FileSHA256,
		FileLength:    proto.Uint64(uint64(len(silenceAudio))),
		Seconds:       proto.Uint32(uint32(duration)),
		PTT:           proto.Bool(true), // Push To Talk = voice note!
	}

	// Send
	_, err = acc.Client.SendMessage(ctx, targetJID, &waE2E.Message{
		AudioMessage: audioMsg,
	})

	if err != nil {
		log.Printf("[Activity] Failed to send voice note: %v", err)
		return "send failed"
	}

	return fmt.Sprintf("%ds → %s", duration, targetPhone[:min(10, len(targetPhone))]+"...")
}

// getRandomInternalAccount gets a random account from our system (not self)
func (m *ClientManager) getRandomInternalAccount(excludePhone string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var candidates []string
	for phone, acc := range m.accounts {
		if phone != excludePhone && acc.Connected && acc.LoggedIn {
			candidates = append(candidates, phone)
		}
	}

	if len(candidates) == 0 {
		return ""
	}

	return candidates[rand.Intn(len(candidates))]
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
