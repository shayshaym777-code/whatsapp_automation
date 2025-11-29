const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

class MessageQueue {
    constructor() {
        this.queueKey = 'messages:queue';
    }

    async enqueue(message) {
        const id = uuidv4();
        const payload = {
            id,
            ...message,
            createdAt: new Date().toISOString()
        };
        await redis.lpush(this.queueKey, JSON.stringify(payload));
        logger.debug && logger.debug({ msg: 'enqueued_message', id });
        return id;
    }

    async enqueueBulk(messages) {
        const ids = [];
        for (const msg of messages) {
            const id = await this.enqueue(msg);
            ids.push(id);
        }
        return ids;
    }

    async length() {
        return redis.llen(this.queueKey);
    }

    getClient() {
        return redis;
    }
}

module.exports = new MessageQueue();
