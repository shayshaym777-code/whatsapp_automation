import { Router } from 'express';
import { query } from '../../config/database.js';
import { redis } from '../../config/redis.js';

const router = Router();

router.get('/', async (req, res) => {
    try {
        await query('SELECT 1');
        await redis.ping();
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

export default router;


