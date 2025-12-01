const axios = require('axios');
const { query } = require('../config/database');

const workers = [
    {
        id: 'worker-1',
        country: 'US',
        url: process.env.WORKER_US_URL || 'http://worker-1:3001'
    },
    {
        id: 'worker-2',
        country: 'IL',
        url: process.env.WORKER_IL_URL || 'http://worker-2:3001'
    },
    {
        id: 'worker-3',
        country: 'GB',
        url: process.env.WORKER_GB_URL || 'http://worker-3:3001'
    }
];

// Power Score by warmup stage
const POWER_SCORES = {
    'new_born': { power: 5, maxDay: 5, maxHour: 2 },
    'baby': { power: 15, maxDay: 15, maxHour: 5 },
    'toddler': { power: 30, maxDay: 30, maxHour: 10 },
    'teen': { power: 50, maxDay: 50, maxHour: 15 },
    'adult': { power: 100, maxDay: 100, maxHour: 25 },
    'veteran': { power: 200, maxDay: 200, maxHour: 50 }
};

class LoadBalancer {
    constructor() {
        this.roundRobinIndex = {};
        this.accountsCache = new Map(); // phone -> account info
        this.cacheExpiry = 60000; // 1 minute cache
        this.lastCacheUpdate = 0;
    }

    getWorkers() {
        return workers;
    }

    getCountryFromPhone(phone) {
        if (!phone) return 'US';
        const clean = String(phone).replace(/[\s\-()]/g, '');

        if (clean.startsWith('+972')) return 'IL';
        if (clean.startsWith('+1')) return 'US';
        if (clean.startsWith('+44')) return 'GB';

        return 'US';
    }

    getWorkerByCountry(country) {
        return workers.find(w => w.country === country) || workers[0];
    }

    selectWorkerForPhone(phone) {
        const country = this.getCountryFromPhone(phone);
        const available = workers.filter(w => w.country === country);
        const list = available.length > 0 ? available : workers;

        const key = available.length > 0 ? country : 'DEFAULT';
        const current = this.roundRobinIndex[key] || 0;

        const worker = list[current % list.length];
        this.roundRobinIndex[key] = current + 1;
        return worker;
    }

    // Get warmup stage based on account age in days
    getWarmupStage(ageDays) {
        if (ageDays >= 60) return 'veteran';
        if (ageDays >= 31) return 'adult';
        if (ageDays >= 15) return 'teen';
        if (ageDays >= 8) return 'toddler';
        if (ageDays >= 4) return 'baby';
        return 'new_born';
    }

    // Get power score for a stage
    getPowerScore(stage) {
        return POWER_SCORES[stage] || POWER_SCORES['adult'];
    }

    // Fetch all active accounts from workers
    async fetchActiveAccounts() {
        const now = Date.now();
        if (now - this.lastCacheUpdate < this.cacheExpiry && this.accountsCache.size > 0) {
            return Array.from(this.accountsCache.values());
        }

        const accounts = [];
        
        for (const worker of workers) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                if (response.data && response.data.accounts) {
                    for (const acc of response.data.accounts) {
                        if (acc.logged_in && acc.connected) {
                            // Calculate stage from account age
                            const ageHours = acc.account_age_hours || 0;
                            const ageDays = ageHours / 24;
                            const stage = acc.warmup_stage || this.getWarmupStage(ageDays);
                            const powerInfo = this.getPowerScore(stage);

                            const accountInfo = {
                                phone: acc.phone,
                                worker: worker,
                                stage: stage,
                                power: powerInfo.power,
                                maxDay: powerInfo.maxDay,
                                maxHour: powerInfo.maxHour,
                                todayCount: acc.today_msgs || 0,
                                sessionCount: acc.session_msgs || 0
                            };

                            accounts.push(accountInfo);
                            this.accountsCache.set(acc.phone, accountInfo);
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed to fetch accounts from ${worker.id}:`, err.message);
            }
        }

        this.lastCacheUpdate = now;
        return accounts;
    }

    // Distribute messages by Power Score
    async distributeMessagesByPower(messages) {
        const accounts = await this.fetchActiveAccounts();
        
        if (accounts.length === 0) {
            throw new Error('No active accounts available');
        }

        // Calculate total power
        let totalPower = 0;
        for (const acc of accounts) {
            // Only count available capacity
            const available = acc.maxDay - acc.todayCount;
            if (available > 0) {
                totalPower += Math.min(acc.power, available);
            }
        }

        if (totalPower === 0) {
            throw new Error('All accounts have reached their daily limits');
        }

        // Distribute messages
        const distribution = new Map();
        let remaining = messages.length;
        let msgIndex = 0;

        // Sort accounts by power (strongest first)
        accounts.sort((a, b) => b.power - a.power);

        for (const acc of accounts) {
            if (remaining <= 0) break;

            const available = acc.maxDay - acc.todayCount;
            if (available <= 0) continue;

            // Calculate share based on power
            const share = Math.min(acc.power, available) / totalPower;
            let assigned = Math.ceil(messages.length * share);
            
            // Don't exceed available capacity
            assigned = Math.min(assigned, available, remaining);

            if (assigned > 0) {
                distribution.set(acc.phone, {
                    account: acc,
                    messages: messages.slice(msgIndex, msgIndex + assigned)
                });
                msgIndex += assigned;
                remaining -= assigned;
            }
        }

        // Handle any remaining messages (round-robin to accounts with capacity)
        while (remaining > 0) {
            let assigned = false;
            for (const acc of accounts) {
                if (remaining <= 0) break;
                
                const dist = distribution.get(acc.phone);
                const currentAssigned = dist ? dist.messages.length : 0;
                const available = acc.maxDay - acc.todayCount - currentAssigned;
                
                if (available > 0) {
                    if (!dist) {
                        distribution.set(acc.phone, {
                            account: acc,
                            messages: [messages[msgIndex]]
                        });
                    } else {
                        dist.messages.push(messages[msgIndex]);
                    }
                    msgIndex++;
                    remaining--;
                    assigned = true;
                }
            }
            if (!assigned) break; // No more capacity
        }

        return distribution;
    }

    // Send a single message
    async sendToWorker(message) {
        const worker = this.selectWorkerForPhone(message.fromPhone);
        const payload = {
            from_phone: message.fromPhone,
            to_phone: message.toPhone,
            message: message.message
        };

        const response = await axios.post(`${worker.url}/send`, payload, { timeout: 30000 });

        return {
            workerId: worker.id,
            workerCountry: worker.country,
            response: response.data
        };
    }

    // Send campaign with Power Score distribution
    async sendCampaign(messages) {
        const distribution = await this.distributeMessagesByPower(messages);
        const results = [];
        const errors = [];

        console.log(`[LoadBalancer] Distributing ${messages.length} messages across ${distribution.size} accounts`);

        for (const [phone, dist] of distribution) {
            console.log(`[LoadBalancer] Account ${phone} (${dist.account.stage}): ${dist.messages.length} messages`);

            for (const msg of dist.messages) {
                try {
                    const result = await axios.post(`${dist.account.worker.url}/send`, {
                        from_phone: phone,
                        to_phone: msg.toPhone,
                        message: msg.message
                    }, { timeout: 60000 });

                    results.push({
                        success: true,
                        fromPhone: phone,
                        toPhone: msg.toPhone,
                        worker: dist.account.worker.id,
                        response: result.data
                    });
                } catch (err) {
                    errors.push({
                        success: false,
                        fromPhone: phone,
                        toPhone: msg.toPhone,
                        error: err.message
                    });
                }
            }
        }

        return { results, errors, distribution: Object.fromEntries(distribution) };
    }

    // Get distribution preview without sending
    async getDistributionPreview(messageCount) {
        const accounts = await this.fetchActiveAccounts();
        
        if (accounts.length === 0) {
            return { accounts: [], totalPower: 0, distribution: {} };
        }

        // Calculate total power
        let totalPower = 0;
        const preview = [];

        for (const acc of accounts) {
            const available = acc.maxDay - acc.todayCount;
            const effectivePower = Math.min(acc.power, available);
            totalPower += effectivePower;

            preview.push({
                phone: acc.phone,
                stage: acc.stage,
                power: acc.power,
                maxDay: acc.maxDay,
                todayCount: acc.todayCount,
                available: available,
                effectivePower: effectivePower
            });
        }

        // Calculate distribution
        const distribution = {};
        for (const acc of preview) {
            if (acc.effectivePower > 0) {
                const share = acc.effectivePower / totalPower;
                distribution[acc.phone] = {
                    percentage: Math.round(share * 100),
                    estimated: Math.ceil(messageCount * share)
                };
            }
        }

        return {
            accounts: preview,
            totalPower,
            distribution,
            totalMessages: messageCount
        };
    }
}

module.exports = new LoadBalancer();
