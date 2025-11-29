import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl);
export const redisPubSub = new Redis(redisUrl);

redis.on('error', (err) => {
    logger.error('Redis error', { error: err.message });
});

redis.on('connect', () => {
    logger.info('Redis connected');
});


