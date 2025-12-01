package whatsapp

import (
	"log"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types/events"
)

// ReceivedMessage represents an incoming message
type ReceivedMessage struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
	IsGroup   bool      `json:"is_group"`
	GroupName string    `json:"group_name,omitempty"`
}

// MessageReceiver handles incoming messages
type MessageReceiver struct {
	messages     []ReceivedMessage
	messagesByTo map[string][]ReceivedMessage // Messages indexed by recipient phone
	mu           sync.RWMutex
	maxMessages  int // Max messages to keep in memory
}

// Global message receiver
var globalReceiver = &MessageReceiver{
	messages:     make([]ReceivedMessage, 0),
	messagesByTo: make(map[string][]ReceivedMessage),
	maxMessages:  1000,
}

// GetMessageReceiver returns the global message receiver
func GetMessageReceiver() *MessageReceiver {
	return globalReceiver
}

// AddMessage adds a received message
func (r *MessageReceiver) AddMessage(msg ReceivedMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Add to main list
	r.messages = append([]ReceivedMessage{msg}, r.messages...)

	// Trim if too many
	if len(r.messages) > r.maxMessages {
		r.messages = r.messages[:r.maxMessages]
	}

	// Add to indexed map
	if _, exists := r.messagesByTo[msg.To]; !exists {
		r.messagesByTo[msg.To] = make([]ReceivedMessage, 0)
	}
	r.messagesByTo[msg.To] = append([]ReceivedMessage{msg}, r.messagesByTo[msg.To]...)

	// Trim per-account list
	if len(r.messagesByTo[msg.To]) > 100 {
		r.messagesByTo[msg.To] = r.messagesByTo[msg.To][:100]
	}
}

// GetRecentMessages returns recent messages
func (r *MessageReceiver) GetRecentMessages(limit int) []ReceivedMessage {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if limit <= 0 || limit > len(r.messages) {
		limit = len(r.messages)
	}

	result := make([]ReceivedMessage, limit)
	copy(result, r.messages[:limit])
	return result
}

// GetMessagesForAccount returns messages received by a specific account
func (r *MessageReceiver) GetMessagesForAccount(phone string) []ReceivedMessage {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if msgs, exists := r.messagesByTo[phone]; exists {
		result := make([]ReceivedMessage, len(msgs))
		copy(result, msgs)
		return result
	}
	return []ReceivedMessage{}
}

// GetMessageCount returns total message count
func (r *MessageReceiver) GetMessageCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.messages)
}

// GetLastMessageTime returns the time of the last received message
func (r *MessageReceiver) GetLastMessageTime() *time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.messages) > 0 {
		return &r.messages[0].Timestamp
	}
	return nil
}

// SetupMessageHandler sets up the message handler for an account
func (m *ClientManager) SetupMessageHandler(phone string) {
	m.mu.RLock()
	acc, exists := m.accounts[phone]
	m.mu.RUnlock()

	if !exists || acc.Client == nil {
		return
	}

	// Add event handler for messages
	acc.Client.AddEventHandler(func(evt interface{}) {
		switch v := evt.(type) {
		case *events.Message:
			// Handle incoming message
			m.handleIncomingMessage(phone, v)
		}
	})

	log.Printf("[Receiver] 📥 Message handler setup for %s", phone)
}

// handleIncomingMessage processes an incoming message
func (m *ClientManager) handleIncomingMessage(toPhone string, evt *events.Message) {
	if evt == nil || evt.Message == nil {
		return
	}

	// Extract message text
	var messageText string
	if evt.Message.Conversation != nil {
		messageText = *evt.Message.Conversation
	} else if evt.Message.ExtendedTextMessage != nil && evt.Message.ExtendedTextMessage.Text != nil {
		messageText = *evt.Message.ExtendedTextMessage.Text
	}

	if messageText == "" {
		return // Skip non-text messages
	}

	// Create received message
	msg := ReceivedMessage{
		ID:        evt.Info.ID,
		From:      "+" + evt.Info.Sender.User,
		To:        toPhone,
		Message:   messageText,
		Timestamp: evt.Info.Timestamp,
		IsGroup:   evt.Info.IsGroup,
	}

	if evt.Info.IsGroup {
		msg.GroupName = evt.Info.Chat.User
	}

	// Add to receiver
	GetMessageReceiver().AddMessage(msg)

	// Update account health - message received means connection is good
	if health := m.GetAccountHealth(toPhone); health != nil {
		health.LastMessageReceived = time.Now()
		health.Status = StatusHealthy
	}

	log.Printf("[Receiver] 📥 %s received from %s: %s", toPhone, msg.From, truncateMessage(messageText, 50))
}

// truncateMessage truncates a message for logging
func truncateMessage(msg string, maxLen int) string {
	if len(msg) <= maxLen {
		return msg
	}
	return msg[:maxLen] + "..."
}

// SetupAllMessageHandlers sets up message handlers for all connected accounts
func (m *ClientManager) SetupAllMessageHandlers() {
	m.mu.RLock()
	phones := make([]string, 0)
	for phone, acc := range m.accounts {
		if acc.Connected && acc.LoggedIn {
			phones = append(phones, phone)
		}
	}
	m.mu.RUnlock()

	for _, phone := range phones {
		m.SetupMessageHandler(phone)
	}

	log.Printf("[Receiver] 📥 Setup message handlers for %d accounts", len(phones))
}

// GetReceivedMessages returns recent received messages (for API)
func (m *ClientManager) GetReceivedMessages(limit int) []ReceivedMessage {
	return GetMessageReceiver().GetRecentMessages(limit)
}

// GetReceivedMessagesForAccount returns messages for a specific account
func (m *ClientManager) GetReceivedMessagesForAccount(phone string) []ReceivedMessage {
	return GetMessageReceiver().GetMessagesForAccount(phone)
}

