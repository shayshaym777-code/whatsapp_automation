package antiban

import (
	"math/rand"
	"strings"
	"time"
)

// ============================================
// ANTI-BAN ENGINE
// Implements all anti-ban algorithms
// ============================================

// WarmupStage defines the stages of account warmup
type WarmupStage struct {
	Name         string
	MinDays      int
	MaxDays      int
	DailyLimit   int
	DelaySeconds int // Base delay between messages
}

// WarmupStages defines the progression of account warmup
var WarmupStages = []WarmupStage{
	{Name: "new_born", MinDays: 0, MaxDays: 3, DailyLimit: 5, DelaySeconds: 120},
	{Name: "baby", MinDays: 4, MaxDays: 7, DailyLimit: 15, DelaySeconds: 90},
	{Name: "toddler", MinDays: 8, MaxDays: 14, DailyLimit: 30, DelaySeconds: 60},
	{Name: "teen", MinDays: 15, MaxDays: 30, DailyLimit: 50, DelaySeconds: 45},
	{Name: "adult", MinDays: 31, MaxDays: 9999, DailyLimit: 100, DelaySeconds: 30},
}

// GetStageForDays returns the warmup stage for a given number of days
func GetStageForDays(days int) WarmupStage {
	for _, stage := range WarmupStages {
		if days >= stage.MinDays && days <= stage.MaxDays {
			return stage
		}
	}
	return WarmupStages[len(WarmupStages)-1] // Default to adult
}

// ============================================
// TIMING RANDOMIZATION
// ============================================

// TimingConfig holds timing configuration
type TimingConfig struct {
	BaseDelayMs     int // Base delay in milliseconds
	JitterMs        int // Random jitter ±
	ShortBreakAfter int // Messages before short break
	LongBreakAfter  int // Messages before long break
	ShortBreakMs    int // Short break duration
	LongBreakMs     int // Long break duration
}

// DefaultTimingConfig returns default timing configuration
func DefaultTimingConfig() TimingConfig {
	return TimingConfig{
		BaseDelayMs:     3000,  // 3 seconds base
		JitterMs:        2000,  // ±2 seconds
		ShortBreakAfter: 10,    // Every 10 messages
		LongBreakAfter:  50,    // Every 50 messages
		ShortBreakMs:    60000, // 1 minute
		LongBreakMs:     300000, // 5 minutes
	}
}

// CalculateDelay returns the delay to wait before sending next message
func CalculateDelay(messageCount int, config TimingConfig) time.Duration {
	// Check if we need a long break
	if messageCount > 0 && messageCount%config.LongBreakAfter == 0 {
		// Long break: 5-15 minutes
		breakMs := config.LongBreakMs + rand.Intn(config.LongBreakMs*2)
		return time.Duration(breakMs) * time.Millisecond
	}

	// Check if we need a short break
	if messageCount > 0 && messageCount%config.ShortBreakAfter == 0 {
		// Short break: 30-120 seconds
		breakMs := config.ShortBreakMs + rand.Intn(config.ShortBreakMs)
		return time.Duration(breakMs) * time.Millisecond
	}

	// Normal delay with jitter
	delay := config.BaseDelayMs + rand.Intn(config.JitterMs*2) - config.JitterMs
	if delay < 1000 {
		delay = 1000 // Minimum 1 second
	}

	return time.Duration(delay) * time.Millisecond
}

// CalculateWarmupDelay returns delay for warmup messages (longer)
func CalculateWarmupDelay() time.Duration {
	// Warmup messages: 30 seconds to 2 minutes
	delaySeconds := 30 + rand.Intn(90)
	return time.Duration(delaySeconds) * time.Second
}

// ============================================
// TYPING SIMULATION
// ============================================

// TypingSimulation calculates how long to "type" a message
func TypingSimulation(message string) time.Duration {
	// Average typing speed: 50-200ms per character
	charCount := len(message)
	
	// Per character delay
	perCharMs := 50 + rand.Intn(150)
	typingTime := charCount * perCharMs

	// Add word pauses (100-300ms between words)
	wordCount := len(strings.Fields(message))
	wordPauseMs := wordCount * (100 + rand.Intn(200))

	// Add "thinking" pause before sending (2-5 seconds)
	thinkingMs := 2000 + rand.Intn(3000)

	totalMs := typingTime + wordPauseMs + thinkingMs
	
	// Cap at 30 seconds for very long messages
	if totalMs > 30000 {
		totalMs = 30000
	}

	return time.Duration(totalMs) * time.Millisecond
}

// ============================================
// MESSAGE VARIATION (SPIN TAGS)
// ============================================

// SpinTags replaces {option1|option2|option3} with random choice
func SpinTags(message string) string {
	result := message
	
	for {
		start := strings.Index(result, "{")
		if start == -1 {
			break
		}
		
		end := strings.Index(result[start:], "}")
		if end == -1 {
			break
		}
		end += start

		// Extract options
		options := strings.Split(result[start+1:end], "|")
		if len(options) == 0 {
			break
		}

		// Pick random option
		chosen := options[rand.Intn(len(options))]
		
		// Replace in result
		result = result[:start] + chosen + result[end+1:]
	}

	return result
}

// AddInvisibleVariation adds zero-width characters for uniqueness
func AddInvisibleVariation(message string) string {
	// Zero-width characters
	zeroWidth := []string{
		"\u200B", // Zero-width space
		"\u200C", // Zero-width non-joiner
		"\u200D", // Zero-width joiner
		"\uFEFF", // Zero-width no-break space
	}

	// Add 1-3 invisible characters at random positions
	result := message
	numChars := 1 + rand.Intn(3)

	for i := 0; i < numChars; i++ {
		char := zeroWidth[rand.Intn(len(zeroWidth))]
		pos := rand.Intn(len(result) + 1)
		result = result[:pos] + char + result[pos:]
	}

	return result
}

// VariateMessage applies all variation techniques
func VariateMessage(message string) string {
	// 1. Apply spin tags
	result := SpinTags(message)
	
	// 2. Add invisible variation
	result = AddInvisibleVariation(result)
	
	return result
}

// ============================================
// SAFETY SCORE
// ============================================

// SafetyScore represents an account's health score
type SafetyScore struct {
	Phone         string
	Score         int     // 0-100
	ActivityScore float64 // Based on message success rate
	AgeScore      float64 // Based on account age
	TrustScore    float64 // Based on delivery rate
	PatternScore  float64 // Based on human-like patterns
}

// CalculateSafetyScore calculates the safety score for an account
func CalculateSafetyScore(
	accountAgeDays int,
	messagesSent int,
	messagesDelivered int,
	errorCount int,
	isSuspicious bool,
) SafetyScore {
	score := SafetyScore{}

	// Activity Score (0.3 weight)
	// Higher if more messages sent successfully
	if messagesSent > 0 {
		successRate := float64(messagesDelivered) / float64(messagesSent)
		score.ActivityScore = successRate * 100
	} else {
		score.ActivityScore = 50 // Neutral for new accounts
	}

	// Age Score (0.2 weight)
	// Higher for older accounts
	switch {
	case accountAgeDays >= 30:
		score.AgeScore = 100
	case accountAgeDays >= 14:
		score.AgeScore = 80
	case accountAgeDays >= 7:
		score.AgeScore = 60
	case accountAgeDays >= 3:
		score.AgeScore = 40
	default:
		score.AgeScore = 20
	}

	// Trust Score (0.3 weight)
	// Based on delivery rate and errors
	if messagesSent > 0 {
		deliveryRate := float64(messagesDelivered) / float64(messagesSent) * 100
		errorRate := float64(errorCount) / float64(messagesSent) * 100
		score.TrustScore = deliveryRate - errorRate
		if score.TrustScore < 0 {
			score.TrustScore = 0
		}
	} else {
		score.TrustScore = 60 // Neutral
	}

	// Pattern Score (0.2 weight)
	// Assume good patterns if not suspicious
	if isSuspicious {
		score.PatternScore = 20
	} else {
		score.PatternScore = 80
	}

	// Calculate final score
	score.Score = int(
		score.ActivityScore*0.3 +
		score.AgeScore*0.2 +
		score.TrustScore*0.3 +
		score.PatternScore*0.2,
	)

	// Clamp to 0-100
	if score.Score > 100 {
		score.Score = 100
	}
	if score.Score < 0 {
		score.Score = 0
	}

	return score
}

// GetRecommendedAction returns recommended action based on safety score
func GetRecommendedAction(score int) string {
	switch {
	case score >= 90:
		return "normal" // Can send at normal rate
	case score >= 80:
		return "slow" // Reduce speed by 20%
	case score >= 70:
		return "very_slow" // Reduce speed by 50%
	case score >= 60:
		return "pause" // Pause and warm up more
	default:
		return "stop" // Stop and investigate
	}
}

// ============================================
// ACCOUNT ROTATION
// ============================================

// AccountRotator manages rotation between accounts
type AccountRotator struct {
	accounts      []string
	currentIndex  int
	messagesCount map[string]int
	maxPerAccount int
}

// NewAccountRotator creates a new account rotator
func NewAccountRotator(accounts []string, maxPerAccount int) *AccountRotator {
	return &AccountRotator{
		accounts:      accounts,
		currentIndex:  0,
		messagesCount: make(map[string]int),
		maxPerAccount: maxPerAccount,
	}
}

// GetNextAccount returns the next account to use
func (r *AccountRotator) GetNextAccount() string {
	if len(r.accounts) == 0 {
		return ""
	}

	// Find an account that hasn't hit the limit
	for i := 0; i < len(r.accounts); i++ {
		idx := (r.currentIndex + i) % len(r.accounts)
		account := r.accounts[idx]
		
		if r.messagesCount[account] < r.maxPerAccount {
			r.currentIndex = (idx + 1) % len(r.accounts)
			return account
		}
	}

	// All accounts at limit, reset and start over
	r.messagesCount = make(map[string]int)
	account := r.accounts[r.currentIndex]
	r.currentIndex = (r.currentIndex + 1) % len(r.accounts)
	return account
}

// RecordMessage records that a message was sent from an account
func (r *AccountRotator) RecordMessage(account string) {
	r.messagesCount[account]++
}

// GetAccountMessageCount returns how many messages an account has sent
func (r *AccountRotator) GetAccountMessageCount(account string) int {
	return r.messagesCount[account]
}

