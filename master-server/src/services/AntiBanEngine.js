class AntiBanEngine {
    constructor() {
        this.accountStats = new Map();
        this.synonyms = this.loadSynonyms();
        this.config = {
            baseDelayMinMs: 1000,
            baseDelayMaxMs: 7000,
            shortBreakEvery: 10,
            shortBreakMinMs: 30000,
            shortBreakMaxMs: 120000,
            longBreakEvery: 50,
            longBreakMinMs: 300000,
            longBreakMaxMs: 900000,
            maxDailyPerAccount: 100
        };
    }

    getOrCreateStats(phone) {
        const todayKey = new Date().toISOString().slice(0, 10);
        const existing = this.accountStats.get(phone);
        if (existing && existing.dayKey === todayKey) {
            return existing;
        }

        const stats = {
            dayKey: todayKey,
            sentToday: existing ? existing.sentToday : 0,
            totalSent: existing ? existing.totalSent : 0
        };
        this.accountStats.set(phone, stats);
        return stats;
    }

    canSend(phone) {
        const stats = this.getOrCreateStats(phone);
        if (stats.sentToday >= this.config.maxDailyPerAccount) {
            return { allowed: false, reason: 'daily_limit' };
        }
        return { allowed: true };
    }

    recordSend(phone) {
        const stats = this.getOrCreateStats(phone);
        stats.sentToday += 1;
        stats.totalSent += 1;
    }

    getDelayMs(phone) {
        const stats = this.getOrCreateStats(phone);
        const nextCount = stats.totalSent + 1;

        let delay = this.randomRange(
            this.config.baseDelayMinMs,
            this.config.baseDelayMaxMs
        );

        if (nextCount > 0 && nextCount % this.config.shortBreakEvery === 0) {
            delay += this.randomRange(
                this.config.shortBreakMinMs,
                this.config.shortBreakMaxMs
            );
        }

        if (nextCount > 0 && nextCount % this.config.longBreakEvery === 0) {
            delay += this.randomRange(
                this.config.longBreakMinMs,
                this.config.longBreakMaxMs
            );
        }

        return delay;
    }

    async applyDelay(phone) {
        const delayMs = this.getDelayMs(phone);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return delayMs;
    }

    variateMessage(original) {
        let text = String(original || '');
        text = this.applySynonyms(text);
        text = this.addWhitespaceVariations(text);
        text = this.varyPunctuation(text);
        return text;
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
            thanks: ['thank you', 'thx', 'many thanks']
        };
    }
}

module.exports = new AntiBanEngine();
