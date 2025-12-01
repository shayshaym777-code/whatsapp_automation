package whatsapp

import (
	"time"
)

// v7.0 Warmup Stages
// Each stage has different daily limits and power scores
const (
	StageWarming = "WARMING" // Day 1-3: Only internal warmup, no campaigns
	StageBaby    = "Baby"    // Day 4-7: Light activity
	StageToddler = "Toddler" // Day 8-14: Moderate activity
	StageTeen    = "Teen"    // Day 15-30: Normal activity
	StageAdult   = "Adult"   // Day 31-60: Full activity
	StageVeteran = "Veteran" // Day 60+: Maximum capacity
)

// StageConfig defines the configuration for each warmup stage
type StageConfig struct {
	Name        string
	MinDays     int
	MaxDays     int
	DailyLimit  int
	Power       int  // Power score for load distribution
	CanCampaign bool // Can participate in campaigns
}

// WarmupStages defines all stage configurations (v7.0)
var WarmupStages = map[string]StageConfig{
	StageWarming: {
		Name:        StageWarming,
		MinDays:     1,
		MaxDays:     3,
		DailyLimit:  5,
		Power:       0,
		CanCampaign: false, // Only internal warmup
	},
	StageBaby: {
		Name:        StageBaby,
		MinDays:     4,
		MaxDays:     7,
		DailyLimit:  15,
		Power:       15,
		CanCampaign: true,
	},
	StageToddler: {
		Name:        StageToddler,
		MinDays:     8,
		MaxDays:     14,
		DailyLimit:  30,
		Power:       30,
		CanCampaign: true,
	},
	StageTeen: {
		Name:        StageTeen,
		MinDays:     15,
		MaxDays:     30,
		DailyLimit:  50,
		Power:       50,
		CanCampaign: true,
	},
	StageAdult: {
		Name:        StageAdult,
		MinDays:     31,
		MaxDays:     60,
		DailyLimit:  100,
		Power:       100,
		CanCampaign: true,
	},
	StageVeteran: {
		Name:        StageVeteran,
		MinDays:     61,
		MaxDays:     9999,
		DailyLimit:  200,
		Power:       200,
		CanCampaign: true,
	},
}

// GetStageForDays returns the stage configuration based on days since creation
func GetStageForDays(days int) StageConfig {
	for _, stage := range WarmupStages {
		if days >= stage.MinDays && days <= stage.MaxDays {
			return stage
		}
	}
	// Default to Adult if no match
	return WarmupStages[StageAdult]
}

// GetStageForAccount returns the stage for an account based on its creation date and is_new flag
func GetStageForAccount(createdAt time.Time, isNew bool) StageConfig {
	// If not marked as new, treat as Adult immediately
	if !isNew {
		return WarmupStages[StageAdult]
	}

	// Calculate days since creation
	days := int(time.Since(createdAt).Hours() / 24)
	if days < 1 {
		days = 1
	}

	return GetStageForDays(days)
}

// GetPowerForStage returns the power score for a stage name
func GetPowerForStage(stageName string) int {
	if stage, ok := WarmupStages[stageName]; ok {
		return stage.Power
	}
	return 100 // Default
}

// GetDailyLimitForStage returns the daily message limit for a stage name
func GetDailyLimitForStageV7(stageName string) int {
	if stage, ok := WarmupStages[stageName]; ok {
		return stage.DailyLimit
	}
	return 100 // Default
}

// CanSendCampaignMessages checks if a stage can participate in campaigns
func CanSendCampaignMessages(stageName string) bool {
	if stage, ok := WarmupStages[stageName]; ok {
		return stage.CanCampaign
	}
	return true // Default to yes
}

// CalculatePowerScore calculates total power score for load distribution
// Power is based on stage and remaining daily capacity
func CalculatePowerScore(stageName string, messagesToday int) int {
	stage, ok := WarmupStages[stageName]
	if !ok {
		return 0
	}

	// Base power from stage
	basePower := stage.Power

	// Reduce power based on how much of daily limit is used
	remaining := stage.DailyLimit - messagesToday
	if remaining <= 0 {
		return 0 // No capacity left
	}

	// Scale power by remaining capacity percentage
	capacityRatio := float64(remaining) / float64(stage.DailyLimit)
	effectivePower := int(float64(basePower) * capacityRatio)

	return effectivePower
}

// DistributeByPower distributes contacts among accounts based on their power scores
func DistributeByPower(accounts []AccountPowerInfo, totalContacts int) map[string]int {
	distribution := make(map[string]int)

	// Calculate total power
	totalPower := 0
	for _, acc := range accounts {
		if acc.Power > 0 && acc.CanSend {
			totalPower += acc.Power
		}
	}

	if totalPower == 0 {
		return distribution
	}

	// Distribute proportionally
	assigned := 0
	for _, acc := range accounts {
		if acc.Power > 0 && acc.CanSend {
			// Calculate share based on power ratio
			share := (acc.Power * totalContacts) / totalPower

			// Don't exceed remaining capacity
			if share > acc.Remaining {
				share = acc.Remaining
			}

			distribution[acc.Phone] = share
			assigned += share
		}
	}

	// Distribute any remainder to highest power accounts
	remainder := totalContacts - assigned
	for remainder > 0 {
		for _, acc := range accounts {
			if remainder <= 0 {
				break
			}
			if acc.Power > 0 && acc.CanSend && distribution[acc.Phone] < acc.Remaining {
				distribution[acc.Phone]++
				remainder--
			}
		}
		// Safety: break if we couldn't assign any more
		if remainder == totalContacts-assigned {
			break
		}
	}

	return distribution
}

// AccountPowerInfo holds account info for power distribution
type AccountPowerInfo struct {
	Phone     string
	Stage     string
	Power     int
	Remaining int  // Remaining daily capacity
	CanSend   bool // Is healthy and can send
}
