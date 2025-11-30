const Redis = require('ioredis');
const logger = require('../utils/logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(redisUrl);
const redisPubSub = new Redis(redisUrl);

redis.on('error', (err) => {
    logger.error('Redis error', { error: err.message });
});

redis.on('connect', () => {
    logger.info('Redis connected');
});

module.exports = { redis, redisPubSub };
