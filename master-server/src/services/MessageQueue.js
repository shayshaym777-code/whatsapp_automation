/**
 * MessageQueue - Redis-backed message queue with priority support
 * 
 * This is a simpler interface that delegates to QueueProcessor
 * for the actual queue management.
 */

const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

class MessageQueue {
    constructor() {
        this.queueKey = 'messages:queue';
        this.priorityQueueKey = 'messages:priority';
    }

    /**
     * Enqueue a single message
     */
    async enqueue(message, priority = 'normal') {
        const id = uuidv4();
        const payload = {
            id,
            ...message,
            priority,
            status: 'queued',
            createdAt: new Date().toISOString(),
        };
        
        // Use sorted set for priority queue
        const score = priority === 'high' ? 0 : (priority === 'low' ? Date.now() + 3600000 : Date.now());
        await redis.zadd(this.priorityQueueKey, score, JSON.stringify(payload));
        
        logger.info({ msg: 'Message enqueued', id, priority });
        return id;
    }

    /**
     * Enqueue multiple messages
     */
    async enqueueBulk(messages, priority = 'normal') {
        const ids = [];
        const campaignId = uuidv4();
        
        for (const msg of messages) {
            const id = await this.enqueue({
                ...msg,
                campaignId,
            }, priority);
            ids.push(id);
        }
        
        return {
            campaignId,
            messageIds: ids,
            count: ids.length,
        };
    }

    /**
     * Dequeue next message
     */
    async dequeue() {
        const items = await redis.zpopmin(this.priorityQueueKey, 1);
        if (items.length === 0) return null;
        
        const payload = JSON.parse(items[0]);
        return payload;
    }

    /**
     * Peek at next message without removing
     */
    async peek() {
        const items = await redis.zrange(this.priorityQueueKey, 0, 0);
        if (items.length === 0) return null;
        return JSON.parse(items[0]);
    }

    /**
     * Get queue length
     */
    async length() {
        return redis.zcard(this.priorityQueueKey);
    }

    /**
     * Get all pending messages
     */
    async getPending(limit = 100) {
        const items = await redis.zrange(this.priorityQueueKey, 0, limit - 1);
        return items.map(item => JSON.parse(item));
    }

    /**
     * Clear the queue
     */
    async clear() {
        await redis.del(this.priorityQueueKey);
        await redis.del(this.queueKey);
    }

    /**
     * Get Redis client for advanced operations
     */
    getClient() {
        return redis;
    }

    /**
     * Get queue stats
     */
    async getStats() {
        const length = await this.length();
        return {
            pending: length,
            queueKey: this.priorityQueueKey,
        };
    }
}

module.exports = new MessageQueue();
