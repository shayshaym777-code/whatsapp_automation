/**
 * QueueProcessor - Background worker that processes the message queue
 * 
 * Features:
 * - Polls for free accounts
 * - Assigns queued messages to free accounts
 * - Applies anti-ban delays between messages
 * - Updates message status (pending→sending→sent→delivered/failed)
 * - Dynamic load balancing as accounts become free
 */

const Redis = require('ioredis');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const accountPool = require('./AccountPool');
const antiBanEngine = require('./AntiBanEngine');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

class QueueProcessor {
    constructor() {
        // Queue keys
        this.pendingQueueKey = 'queue:pending';
        this.processingKey = 'queue:processing';
        this.completedKey = 'queue:completed';
        this.failedKey = 'queue:failed';
        this.statsKey = 'queue:stats';
        
        // Processing state
        this.isRunning = false;
        this.processingInterval = null;
        this.pollIntervalMs = 1000; // Check queue every second
        
        // Batch settings
        this.maxConcurrentPerAccount = 1; // One message at a time per account
        this.maxBatchSize = 50; // Max messages to process per poll
    }

    /**
     * Add message to pending queue
     */
    async enqueue(message) {
        const id = uuidv4();
        const queueItem = {
            id,
            ...message,
            status: 'pending',
            createdAt: new Date().toISOString(),
            attempts: 0,
        };
        
        // Add to pending queue (sorted by priority and time)
        const score = message.priority || Date.now();
        await redis.zadd(this.pendingQueueKey, score, JSON.stringify(queueItem));
        
        // Update stats
        await redis.hincrby(this.statsKey, 'totalEnqueued', 1);
        await redis.hincrby(this.statsKey, 'pending', 1);
        
        logger.info({ msg: 'Message enqueued', id, toPhone: message.toPhone });
        return id;
    }

    /**
     * Add multiple messages to queue
     */
    async enqueueBulk(messages, campaignId = null) {
        const ids = [];
        const campaign = campaignId || uuidv4();
        
        for (const msg of messages) {
            const id = await this.enqueue({
                ...msg,
                campaignId: campaign,
            });
            ids.push(id);
        }
        
        return { campaignId: campaign, messageIds: ids, count: ids.length };
    }

    /**
     * Get pending messages for processing
     */
    async getPendingMessages(limit = 50) {
        const items = await redis.zrange(this.pendingQueueKey, 0, limit - 1);
        return items.map(item => JSON.parse(item));
    }

    /**
     * Move message from pending to processing
     */
    async markProcessing(message) {
        const updated = {
            ...message,
            status: 'processing',
            startedAt: new Date().toISOString(),
            attempts: (message.attempts || 0) + 1,
        };
        
        // Remove from pending
        await redis.zrem(this.pendingQueueKey, JSON.stringify(message));
        
        // Add to processing set
        await redis.hset(this.processingKey, message.id, JSON.stringify(updated));
        
        // Update stats
        await redis.hincrby(this.statsKey, 'pending', -1);
        await redis.hincrby(this.statsKey, 'processing', 1);
        
        return updated;
    }

    /**
     * Mark message as completed
     */
    async markCompleted(message, result) {
        const completed = {
            ...message,
            status: 'completed',
            completedAt: new Date().toISOString(),
            result,
        };
        
        // Remove from processing
        await redis.hdel(this.processingKey, message.id);
        
        // Add to completed (with TTL)
        await redis.lpush(this.completedKey, JSON.stringify(completed));
        await redis.ltrim(this.completedKey, 0, 9999); // Keep last 10k
        
        // Update stats
        await redis.hincrby(this.statsKey, 'processing', -1);
        await redis.hincrby(this.statsKey, 'completed', 1);
        
        logger.info({ msg: 'Message completed', id: message.id, toPhone: message.toPhone });
    }

    /**
     * Mark message as failed
     */
    async markFailed(message, error, requeue = true) {
        const maxAttempts = 3;
        
        if (requeue && message.attempts < maxAttempts) {
            // Requeue with lower priority
            const requeued = {
                ...message,
                status: 'pending',
                lastError: error,
                attempts: message.attempts,
            };
            
            // Remove from processing
            await redis.hdel(this.processingKey, message.id);
            
            // Add back to pending with lower priority (higher score = later)
            const score = Date.now() + (message.attempts * 60000); // Delay retry
            await redis.zadd(this.pendingQueueKey, score, JSON.stringify(requeued));
            
            // Update stats
            await redis.hincrby(this.statsKey, 'processing', -1);
            await redis.hincrby(this.statsKey, 'pending', 1);
            await redis.hincrby(this.statsKey, 'retries', 1);
            
            logger.warn({ msg: 'Message requeued', id: message.id, attempt: message.attempts, error });
        } else {
            // Move to failed queue
            const failed = {
                ...message,
                status: 'failed',
                failedAt: new Date().toISOString(),
                error,
            };
            
            await redis.hdel(this.processingKey, message.id);
            await redis.lpush(this.failedKey, JSON.stringify(failed));
            await redis.ltrim(this.failedKey, 0, 999); // Keep last 1k
            
            // Update stats
            await redis.hincrby(this.statsKey, 'processing', -1);
            await redis.hincrby(this.statsKey, 'failed', 1);
            
            logger.error({ msg: 'Message failed permanently', id: message.id, error });
        }
    }

    /**
     * Process a single message
     */
    async processMessage(message, account) {
        try {
            // Mark as processing
            const processing = await this.markProcessing(message);
            
            // Mark account as busy
            await accountPool.markBusy(account.phone, message.id);
            
            // Apply anti-ban delay
            const delayMs = antiBanEngine.getDelayMs(account.phone);
            await this.sleep(delayMs);
            
            // Variate message
            const variedMessage = antiBanEngine.variateMessage(message.message);
            
            // Send to worker
            const response = await axios.post(`${account.workerUrl}/send`, {
                from_phone: account.phone,
                to_phone: message.toPhone,
                message: variedMessage,
            }, { timeout: 30000 });
            
            // Record send
            antiBanEngine.recordSend(account.phone);
            await accountPool.recordSend(account.phone);
            
            // Mark completed
            await this.markCompleted(processing, {
                workerId: account.workerId,
                workerResponse: response.data,
                delayMs,
            });
            
            return { success: true, messageId: message.id };
        } catch (error) {
            await this.markFailed(message, error.message);
            return { success: false, messageId: message.id, error: error.message };
        } finally {
            // Mark account as free
            await accountPool.markFree(account.phone);
        }
    }

    /**
     * Main processing loop
     */
    async processQueue() {
        if (!this.isRunning) return;
        
        try {
            // Get pending messages
            const pending = await this.getPendingMessages(this.maxBatchSize);
            if (pending.length === 0) return;
            
            // Group by target country
            const byCountry = {};
            for (const msg of pending) {
                const country = accountPool.getCountryFromPhone(msg.toPhone);
                if (!byCountry[country]) byCountry[country] = [];
                byCountry[country].push(msg);
            }
            
            // Process each country group
            for (const [country, messages] of Object.entries(byCountry)) {
                // Get free accounts for this country
                const freeAccounts = await accountPool.getFreeAccounts(country);
                if (freeAccounts.length === 0) continue;
                
                // Assign messages to accounts
                let accountIndex = 0;
                for (const message of messages) {
                    if (accountIndex >= freeAccounts.length) break;
                    
                    const account = freeAccounts[accountIndex];
                    
                    // Check if account can send
                    const canSend = await accountPool.canSend(account.phone);
                    if (!canSend.allowed) {
                        accountIndex++;
                        continue;
                    }
                    
                    // Process message (don't await - process concurrently)
                    this.processMessage(message, account).catch(err => {
                        logger.error({ msg: 'Process message error', error: err.message });
                    });
                    
                    accountIndex++;
                }
            }
        } catch (error) {
            logger.error({ msg: 'Queue processing error', error: error.message });
        }
    }

    /**
     * Start the queue processor
     */
    start() {
        if (this.isRunning) {
            logger.warn('Queue processor already running');
            return;
        }
        
        this.isRunning = true;
        this.processingInterval = setInterval(() => {
            this.processQueue();
        }, this.pollIntervalMs);
        
        logger.info('Queue processor started');
    }

    /**
     * Stop the queue processor
     */
    stop() {
        this.isRunning = false;
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        logger.info('Queue processor stopped');
    }

    /**
     * Get queue statistics
     */
    async getStats() {
        const stats = await redis.hgetall(this.statsKey);
        const pendingCount = await redis.zcard(this.pendingQueueKey);
        const processingCount = await redis.hlen(this.processingKey);
        
        return {
            pending: pendingCount,
            processing: processingCount,
            completed: parseInt(stats.completed || '0'),
            failed: parseInt(stats.failed || '0'),
            totalEnqueued: parseInt(stats.totalEnqueued || '0'),
            retries: parseInt(stats.retries || '0'),
            isRunning: this.isRunning,
        };
    }

    /**
     * Get queue status with detailed info
     */
    async getStatus() {
        const stats = await this.getStats();
        const poolStatus = await accountPool.getPoolStatus();
        
        // Estimate time to process
        const avgTimePerMessage = 5; // seconds (including delays)
        const estimatedSeconds = stats.pending * avgTimePerMessage / Math.max(poolStatus.free, 1);
        const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
        
        return {
            queue: stats,
            accounts: poolStatus,
            estimatedDuration: `${estimatedMinutes} minutes`,
            estimatedCompletionTime: new Date(Date.now() + estimatedSeconds * 1000).toISOString(),
        };
    }

    /**
     * Clear all queues (for testing)
     */
    async clearAll() {
        await redis.del(this.pendingQueueKey);
        await redis.del(this.processingKey);
        await redis.del(this.completedKey);
        await redis.del(this.failedKey);
        await redis.del(this.statsKey);
        logger.info('All queues cleared');
    }

    /**
     * Helper: Sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export singleton
const processor = new QueueProcessor();

// Auto-start in production
if (process.env.NODE_ENV === 'production' || process.env.AUTO_START_QUEUE === 'true') {
    processor.start();
}

module.exports = processor;

