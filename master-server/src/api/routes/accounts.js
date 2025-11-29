import { Router } from 'express';
import { query } from '../../config/database.js';

const router = Router();

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

export default router;


