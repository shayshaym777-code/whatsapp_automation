// Power Score and limits by warmup stage
const STAGE_CONFIG = {
    'new_born': { power: 5, maxDay: 5, maxHour: 2, delayMin: 30000, delayMax: 60000 },
    'baby': { power: 15, maxDay: 15, maxHour: 5, delayMin: 20000, delayMax: 40000 },
    'toddler': { power: 30, maxDay: 30, maxHour: 10, delayMin: 10000, delayMax: 20000 },
    'teen': { power: 50, maxDay: 50, maxHour: 15, delayMin: 5000, delayMax: 10000 },
    'adult': { power: 100, maxDay: 100, maxHour: 25, delayMin: 3000, delayMax: 7000 },
    'veteran': { power: 200, maxDay: 200, maxHour: 50, delayMin: 1000, delayMax: 5000 }
};

class AntiBanEngine {
    constructor() {
        this.accountStats = new Map();
        this.hourlyStats = new Map(); // Track hourly sends
        this.synonyms = this.loadSynonyms();
        this.config = {
            shortBreakEvery: 10,
            shortBreakMinMs: 30000,
            shortBreakMaxMs: 120000,
            longBreakEvery: 50,
            longBreakMinMs: 300000,
            longBreakMaxMs: 900000,
            veryLongBreakEvery: 100,
            veryLongBreakMinMs: 900000,
            veryLongBreakMaxMs: 1800000
        };
    }

    // Get warmup stage based on account age in days
    getStageFromDays(ageDays) {
        if (ageDays >= 60) return 'veteran';
        if (ageDays >= 31) return 'adult';
        if (ageDays >= 15) return 'teen';
        if (ageDays >= 8) return 'toddler';
        if (ageDays >= 4) return 'baby';
        return 'new_born';
    }

    getStageConfig(stage) {
        return STAGE_CONFIG[stage] || STAGE_CONFIG['adult'];
    }

    getOrCreateStats(phone) {
        const todayKey = new Date().toISOString().slice(0, 10);
        const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
        
        let existing = this.accountStats.get(phone);
        
        // Reset daily stats if new day
        if (!existing || existing.dayKey !== todayKey) {
            existing = {
                dayKey: todayKey,
                hourKey: hourKey,
                sentToday: 0,
                sentThisHour: 0,
                totalSent: existing ? existing.totalSent : 0,
                stage: existing ? existing.stage : 'adult',
                ageDays: existing ? existing.ageDays : 30
            };
            this.accountStats.set(phone, existing);
        }
        
        // Reset hourly stats if new hour
        if (existing.hourKey !== hourKey) {
            existing.hourKey = hourKey;
            existing.sentThisHour = 0;
        }
        
        return existing;
    }

    // Set account stage (called when account info is received)
    setAccountStage(phone, stage, ageDays) {
        const stats = this.getOrCreateStats(phone);
        stats.stage = stage || this.getStageFromDays(ageDays || 30);
        stats.ageDays = ageDays || 30;
    }

    canSend(phone) {
        const stats = this.getOrCreateStats(phone);
        const config = this.getStageConfig(stats.stage);

        // Check daily limit
        if (stats.sentToday >= config.maxDay) {
            return { 
                allowed: false, 
                reason: 'daily_limit',
                message: `Daily limit (${config.maxDay}) reached for ${stats.stage} account`
            };
        }

        // Check hourly limit
        if (stats.sentThisHour >= config.maxHour) {
            return { 
                allowed: false, 
                reason: 'hourly_limit',
                message: `Hourly limit (${config.maxHour}) reached for ${stats.stage} account`
            };
        }

        return { 
            allowed: true,
            remaining: {
                daily: config.maxDay - stats.sentToday,
                hourly: config.maxHour - stats.sentThisHour
            }
        };
    }

    recordSend(phone) {
        const stats = this.getOrCreateStats(phone);
        stats.sentToday += 1;
        stats.sentThisHour += 1;
        stats.totalSent += 1;
    }

    getDelayMs(phone) {
        const stats = this.getOrCreateStats(phone);
        const stageConfig = this.getStageConfig(stats.stage);
        const nextCount = stats.totalSent + 1;

        // Base delay from stage
        let delay = this.randomRange(stageConfig.delayMin, stageConfig.delayMax);

        // Add jitter (±10%)
        const jitter = delay * 0.1 * (Math.random() * 2 - 1);
        delay += jitter;

        // Short break every 10 messages
        if (nextCount > 0 && nextCount % this.config.shortBreakEvery === 0) {
            delay += this.randomRange(
                this.config.shortBreakMinMs,
                this.config.shortBreakMaxMs
            );
        }

        // Long break every 50 messages
        if (nextCount > 0 && nextCount % this.config.longBreakEvery === 0) {
            delay += this.randomRange(
                this.config.longBreakMinMs,
                this.config.longBreakMaxMs
            );
        }

        // Very long break every 100 messages
        if (nextCount > 0 && nextCount % this.config.veryLongBreakEvery === 0) {
            delay += this.randomRange(
                this.config.veryLongBreakMinMs,
                this.config.veryLongBreakMaxMs
            );
        }

        return Math.round(delay);
    }

    async applyDelay(phone) {
        const delayMs = this.getDelayMs(phone);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return delayMs;
    }

    variateMessage(original) {
        let text = String(original || '');
        
        // Apply spin tags {option1|option2|option3}
        text = this.processSpinTags(text);
        
        // Apply synonyms
        text = this.applySynonyms(text);
        
        // Add zero-width characters for uniqueness
        text = this.addInvisibleChars(text);
        
        // Add whitespace variations
        text = this.addWhitespaceVariations(text);
        
        // Vary punctuation
        text = this.varyPunctuation(text);
        
        // Random emoji (30% chance)
        if (Math.random() < 0.3) {
            text = this.addRandomEmoji(text);
        }
        
        return text;
    }

    processSpinTags(text) {
        // Replace {option1|option2|option3} with random choice
        return text.replace(/\{([^}]+)\}/g, (match, options) => {
            const choices = options.split('|');
            return choices[Math.floor(Math.random() * choices.length)];
        });
    }

    addInvisibleChars(text) {
        const zeroWidth = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
        
        // Add 1-3 invisible characters at random positions
        const numChars = 1 + Math.floor(Math.random() * 3);
        let result = text;
        
        for (let i = 0; i < numChars; i++) {
            const char = zeroWidth[Math.floor(Math.random() * zeroWidth.length)];
            const pos = Math.floor(Math.random() * (result.length + 1));
            result = result.slice(0, pos) + char + result.slice(pos);
        }
        
        return result;
    }

    addRandomEmoji(text) {
        const emojis = ['😊', '👍', '🙏', '✨', '💪', '🔥', '❤️', '👋', '✅', '💯'];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        return text + ' ' + emoji;
    }

    applySynonyms(text) {
        let result = text;
        Object.keys(this.synonyms).forEach((word) => {
            const list = this.synonyms[word];
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            result = result.replace(regex, (match) => {
                if (Math.random() < 0.3) {
                    const synonym = list[Math.floor(Math.random() * list.length)];
                    return synonym;
                }
                return match;
            });
        });
        return result;
    }

    addWhitespaceVariations(text) {
        let result = text;
        if (Math.random() < 0.1) {
            result = result + ' ';
        }
        if (Math.random() < 0.05) {
            result = ' ' + result;
        }
        return result;
    }

    varyPunctuation(text) {
        let result = text;
        if (Math.random() < 0.2) {
            result = result.replace(/!+$/, '!!');
        }
        if (Math.random() < 0.1 && !/[.!?]$/.test(result)) {
            result = result + '.';
        }
        return result;
    }

    randomRange(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    loadSynonyms() {
        return {
            hello: ['hi', 'hey', 'greetings', 'howdy'],
            great: ['awesome', 'amazing', 'wonderful', 'excellent'],
            check: ['look at', 'see', 'view', 'take a look at'],
            thanks: ['thank you', 'thx', 'many thanks'],
            please: ['pls', 'kindly', 'if you could'],
            good: ['nice', 'fine', 'cool', 'great']
        };
    }

    // Get stats for an account
    getAccountStats(phone) {
        const stats = this.getOrCreateStats(phone);
        const config = this.getStageConfig(stats.stage);
        
        return {
            phone,
            stage: stats.stage,
            ageDays: stats.ageDays,
            sentToday: stats.sentToday,
            sentThisHour: stats.sentThisHour,
            maxDay: config.maxDay,
            maxHour: config.maxHour,
            remainingDaily: config.maxDay - stats.sentToday,
            remainingHourly: config.maxHour - stats.sentThisHour
        };
    }

    // Reset daily stats (called by cron job at midnight)
    resetDailyStats() {
        for (const [phone, stats] of this.accountStats) {
            stats.sentToday = 0;
            stats.dayKey = new Date().toISOString().slice(0, 10);
        }
        console.log('[AntiBanEngine] Daily stats reset');
    }
}

module.exports = new AntiBanEngine();
