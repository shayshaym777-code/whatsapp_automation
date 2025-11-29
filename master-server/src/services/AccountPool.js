/**
 * AccountPool - Manages available WhatsApp accounts across workers
 * 
 * Features:
 * - Track all available accounts per country
 * - Track account status: free, busy, daily_limit_reached
 * - Get free accounts count per country
 * - Mark account as busy when sending
 * - Mark account as free when done
 * - Check remaining daily quota per account
 */

const Redis = require('ioredis');
const axios = require('axios');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

// Worker configuration
const WORKERS = [
    { id: 'worker-1', country: 'US', url: process.env.WORKER_US_URL || 'http://worker-1:3001' },
    { id: 'worker-2', country: 'IL', url: process.env.WORKER_IL_URL || 'http://worker-2:3001' },
    { id: 'worker-3', country: 'GB', url: process.env.WORKER_GB_URL || 'http://worker-3:3001' },
];

// Country code mapping
const COUNTRY_PREFIXES = {
    '+1': 'US',
    '+972': 'IL',
    '+44': 'GB',
    '+49': 'DE',
    '+33': 'FR',
};

class AccountPool {
    constructor() {
        this.accountsKey = 'accounts:pool';
        this.busyKey = 'accounts:busy';
        this.dailyStatsKey = 'accounts:daily';
        this.maxDailyMessages = parseInt(process.env.MAX_MESSAGES_PER_DAY) || 100;
    }

    /**
     * Get country from phone number
     */
    getCountryFromPhone(phone) {
        if (!phone) return 'US';
        const clean = String(phone).replace(/[\s\-()]/g, '');
        
        for (const [prefix, country] of Object.entries(COUNTRY_PREFIXES)) {
            if (clean.startsWith(prefix)) return country;
        }
        return 'US'; // Default
    }

    /**
     * Get worker for a country
     */
    getWorkerForCountry(country) {
        return WORKERS.find(w => w.country === country) || WORKERS[0];
    }

    /**
     * Fetch all accounts from all workers
     */
    async refreshAccountsFromWorkers() {
        const accounts = [];
        
        for (const worker of WORKERS) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                const workerAccounts = response.data.accounts || [];
                
                for (const acc of workerAccounts) {
                    if (acc.logged_in) {
                        accounts.push({
                            phone: acc.phone,
                            country: this.getCountryFromPhone(acc.phone),
                            workerId: worker.id,
                            workerUrl: worker.url,
                            workerCountry: worker.country,
                            loggedIn: acc.logged_in,
                            connected: acc.connected,
                        });
                    }
                }
            } catch (error) {
                logger.warn({ msg: 'Failed to fetch accounts from worker', worker: worker.id, error: error.message });
            }
        }

        // Store in Redis
        await redis.set(this.accountsKey, JSON.stringify(accounts));
        return accounts;
    }

    /**
     * Get all accounts from cache or refresh
     */
    async getAllAccounts() {
        const cached = await redis.get(this.accountsKey);
        if (cached) {
            return JSON.parse(cached);
        }
        return this.refreshAccountsFromWorkers();
    }

    /**
     * Get accounts by country
     */
    async getAccountsByCountry(country) {
        const accounts = await this.getAllAccounts();
        return accounts.filter(a => a.country === country || a.workerCountry === country);
    }

    /**
     * Get today's key for daily stats
     */
    getTodayKey() {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * Get daily stats for an account
     */
    async getDailyStats(phone) {
        const key = `${this.dailyStatsKey}:${this.getTodayKey()}:${phone}`;
        const stats = await redis.hgetall(key);
        return {
            sentToday: parseInt(stats.sent || '0'),
            remaining: this.maxDailyMessages - parseInt(stats.sent || '0'),
            lastSentAt: stats.lastSentAt || null,
        };
    }

    /**
     * Increment daily send count for an account
     */
    async recordSend(phone) {
        const key = `${this.dailyStatsKey}:${this.getTodayKey()}:${phone}`;
        await redis.hincrby(key, 'sent', 1);
        await redis.hset(key, 'lastSentAt', new Date().toISOString());
        await redis.expire(key, 86400 * 2); // Expire after 2 days
    }

    /**
     * Check if account can send more messages today
     */
    async canSend(phone) {
        const stats = await this.getDailyStats(phone);
        return {
            allowed: stats.remaining > 0,
            remaining: stats.remaining,
            sentToday: stats.sentToday,
        };
    }

    /**
     * Mark account as busy
     */
    async markBusy(phone, taskId = null) {
        const data = {
            busySince: new Date().toISOString(),
            taskId: taskId || 'unknown',
        };
        await redis.hset(this.busyKey, phone, JSON.stringify(data));
    }

    /**
     * Mark account as free
     */
    async markFree(phone) {
        await redis.hdel(this.busyKey, phone);
    }

    /**
     * Check if account is busy
     */
    async isBusy(phone) {
        const busy = await redis.hget(this.busyKey, phone);
        return busy !== null;
    }

    /**
     * Get all busy accounts
     */
    async getBusyAccounts() {
        const busy = await redis.hgetall(this.busyKey);
        return Object.entries(busy).map(([phone, data]) => ({
            phone,
            ...JSON.parse(data),
        }));
    }

    /**
     * Get free accounts (not busy and under daily limit)
     */
    async getFreeAccounts(country = null) {
        const accounts = await this.getAllAccounts();
        const busyAccounts = await this.getBusyAccounts();
        const busyPhones = new Set(busyAccounts.map(a => a.phone));

        const freeAccounts = [];
        for (const account of accounts) {
            // Filter by country if specified
            if (country && account.country !== country && account.workerCountry !== country) {
                continue;
            }

            // Skip busy accounts
            if (busyPhones.has(account.phone)) {
                continue;
            }

            // Check daily limit
            const canSend = await this.canSend(account.phone);
            if (!canSend.allowed) {
                continue;
            }

            freeAccounts.push({
                ...account,
                remaining: canSend.remaining,
                sentToday: canSend.sentToday,
            });
        }

        return freeAccounts;
    }

    /**
     * Get pool status summary
     */
    async getPoolStatus() {
        const accounts = await this.getAllAccounts();
        const busyAccounts = await this.getBusyAccounts();
        const busyPhones = new Set(busyAccounts.map(a => a.phone));

        const byCountry = {};
        let totalFree = 0;
        let totalBusy = 0;
        let totalLimitReached = 0;

        for (const account of accounts) {
            const country = account.workerCountry;
            if (!byCountry[country]) {
                byCountry[country] = { total: 0, free: 0, busy: 0, limitReached: 0, accounts: [] };
            }

            byCountry[country].total++;

            const isBusy = busyPhones.has(account.phone);
            const canSend = await this.canSend(account.phone);

            const accountStatus = {
                phone: account.phone,
                status: isBusy ? 'busy' : (!canSend.allowed ? 'limit_reached' : 'free'),
                remaining: canSend.remaining,
                sentToday: canSend.sentToday,
            };

            byCountry[country].accounts.push(accountStatus);

            if (isBusy) {
                byCountry[country].busy++;
                totalBusy++;
            } else if (!canSend.allowed) {
                byCountry[country].limitReached++;
                totalLimitReached++;
            } else {
                byCountry[country].free++;
                totalFree++;
            }
        }

        return {
            total: accounts.length,
            free: totalFree,
            busy: totalBusy,
            limitReached: totalLimitReached,
            byCountry,
            workers: WORKERS.map(w => ({ id: w.id, country: w.country })),
        };
    }

    /**
     * Distribute contacts across free accounts
     * Returns distribution plan and any overflow
     */
    async distributeContacts(contacts) {
        // Group contacts by country
        const byCountry = {};
        for (const contact of contacts) {
            const country = this.getCountryFromPhone(contact.phone);
            if (!byCountry[country]) {
                byCountry[country] = [];
            }
            byCountry[country].push(contact);
        }

        const distribution = [];
        const overflow = [];

        for (const [country, countryContacts] of Object.entries(byCountry)) {
            const freeAccounts = await this.getFreeAccounts(country);
            
            if (freeAccounts.length === 0) {
                // No free accounts for this country - add to overflow
                overflow.push(...countryContacts.map(c => ({ ...c, country, reason: 'no_free_accounts' })));
                continue;
            }

            // Calculate how many contacts each account can handle
            let totalCapacity = 0;
            const accountCapacities = freeAccounts.map(acc => {
                const capacity = Math.min(acc.remaining, 20); // Max 20 per batch per account
                totalCapacity += capacity;
                return { ...acc, capacity };
            });

            // Distribute contacts
            let contactIndex = 0;
            for (const account of accountCapacities) {
                const assignedContacts = [];
                const toAssign = Math.min(
                    account.capacity,
                    Math.ceil(countryContacts.length / freeAccounts.length)
                );

                for (let i = 0; i < toAssign && contactIndex < countryContacts.length; i++) {
                    assignedContacts.push(countryContacts[contactIndex]);
                    contactIndex++;
                }

                if (assignedContacts.length > 0) {
                    distribution.push({
                        account: account.phone,
                        workerId: account.workerId,
                        workerUrl: account.workerUrl,
                        country,
                        contacts: assignedContacts,
                        count: assignedContacts.length,
                    });
                }
            }

            // Any remaining contacts go to overflow
            while (contactIndex < countryContacts.length) {
                overflow.push({
                    ...countryContacts[contactIndex],
                    country,
                    reason: 'capacity_exceeded',
                });
                contactIndex++;
            }
        }

        return {
            distribution,
            overflow,
            summary: {
                totalContacts: contacts.length,
                distributed: distribution.reduce((sum, d) => sum + d.count, 0),
                queued: overflow.length,
                accountsUsed: distribution.length,
                byCountry: Object.fromEntries(
                    Object.entries(byCountry).map(([country, contacts]) => [
                        country,
                        {
                            contacts: contacts.length,
                            accounts: distribution.filter(d => d.country === country).length,
                        },
                    ])
                ),
            },
        };
    }
}

module.exports = new AccountPool();

