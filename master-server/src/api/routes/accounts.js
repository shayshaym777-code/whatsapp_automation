import { Router } from 'express';
import axios from 'axios';
import { query } from '../../config/database.js';

const router = Router();

// Worker URLs configuration
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
];

// GET /api/accounts
router.get('/', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 200');
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts
router.post('/', async (req, res, next) => {
    try {
        const {
            phone_number: phoneNumber,
            country,
            proxy_ip: proxyIp,
            proxy_port: proxyPort,
            proxy_username: proxyUsername,
            proxy_password: proxyPassword,
            proxy_provider: proxyProvider
        } = req.body;

        const result = await query(
            `INSERT INTO accounts (phone_number, country, proxy_ip, proxy_port, proxy_username, proxy_password, proxy_provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
            [phoneNumber, country, proxyIp, proxyPort, proxyUsername, proxyPassword, proxyProvider]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:phone
router.get('/:phone', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM accounts WHERE phone_number = $1', [req.params.phone]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// PUT /api/accounts/:phone
router.put('/:phone', async (req, res, next) => {
    try {
        const { status, trust_score: trustScore } = req.body;
        const result = await query(
            `UPDATE accounts SET status = COALESCE($1, status),
                           trust_score = COALESCE($2, trust_score),
                           updated_at = CURRENT_TIMESTAMP
       WHERE phone_number = $3
       RETURNING *`,
            [status || null, trustScore || null, req.params.phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// DELETE /api/accounts/:phone
router.delete('/:phone', async (req, res, next) => {
    try {
        await query('DELETE FROM accounts WHERE phone_number = $1', [req.params.phone]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/warm-all - Trigger warmup for all eligible accounts
router.post('/warm-all', async (req, res, next) => {
    try {
        const results = [];
        
        for (const worker of WORKERS) {
            try {
                // Get warmup status from each worker
                const response = await axios.get(`${worker.url}/warmup/status`, { timeout: 5000 });
                const accounts = response.data?.accounts || [];
                
                // Count accounts that need warmup
                const needsWarmup = accounts.filter(a => !a.warmup_complete).length;
                results.push({
                    worker: worker.id,
                    country: worker.country,
                    totalAccounts: accounts.length,
                    needsWarmup,
                    status: 'ok'
                });
            } catch (err) {
                results.push({
                    worker: worker.id,
                    country: worker.country,
                    status: 'error',
                    error: err.message
                });
            }
        }

        const totalNeedsWarmup = results.reduce((sum, r) => sum + (r.needsWarmup || 0), 0);
        
        res.json({
            success: true,
            message: `Warmup active for ${totalNeedsWarmup} accounts`,
            workers: results
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/warmup-status - Get warmup status from all workers
router.get('/warmup-status', async (req, res, next) => {
    try {
        const results = [];
        
        for (const worker of WORKERS) {
            try {
                const response = await axios.get(`${worker.url}/warmup/status`, { timeout: 5000 });
                results.push({
                    worker: worker.id,
                    country: worker.country,
                    ...response.data
                });
            } catch (err) {
                results.push({
                    worker: worker.id,
                    country: worker.country,
                    accounts: [],
                    error: err.message
                });
            }
        }

        res.json({ workers: results });
    } catch (err) {
        next(err);
    }
});

export default router;


