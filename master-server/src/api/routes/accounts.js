const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Simple status - CONNECTED (🟢) or DISCONNECTED (🔴)
// At least 1 session connected = CONNECTED

// Worker URLs
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
    { id: 'worker-4', url: process.env.WORKER_4_URL || 'http://worker-4:3001', country: 'US' },
];

// Helper: Get account status based on sessions
// 🟢 CONNECTED = at least 1 session connected
// 🔴 DISCONNECTED = all sessions down
function getAccountStatus(connectedSessions) {
    return connectedSessions > 0 ? 'CONNECTED' : 'DISCONNECTED';
}

// GET /api/accounts - List all accounts with session count
router.get('/', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT a.phone, a.country, a.proxy_id, a.messages_today,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone) as total_sessions,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED') as connected_sessions
            FROM accounts a
            ORDER BY a.created_at DESC
        `);

        const accounts = result.rows.map(a => {
            const connected = parseInt(a.connected_sessions) || 0;
            const total = parseInt(a.total_sessions) || 0;
            return {
                phone: a.phone,
                status: getAccountStatus(connected),  // 🟢 or 🔴
                sessions: `${connected}/${total}`,    // "3/4"
                connected_sessions: connected,
                total_sessions: total,
                country: a.country,
                messages_today: a.messages_today || 0
            };
        });

        const connectedCount = accounts.filter(a => a.status === 'CONNECTED').length;

        res.json({
            accounts,
            total_connected: connectedCount,
            total_accounts: accounts.length
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:phone - Get single account
router.get('/:phone', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT a.*, 
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED') as sessions
            FROM accounts a
            WHERE a.phone = $1
        `, [req.params.phone]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts - Create account
router.post('/', async (req, res, next) => {
    try {
        const { phone, country, proxy_id } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'phone required' });
        }

        const result = await query(`
            INSERT INTO accounts (phone, country, proxy_id, status)
            VALUES ($1, $2, $3, 'HEALTHY')
            ON CONFLICT (phone) DO UPDATE SET
                country = COALESCE($2, accounts.country),
                proxy_id = COALESCE($3, accounts.proxy_id)
            RETURNING *
        `, [phone, country || 'US', proxy_id]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// PUT /api/accounts/:phone/block - Mark as blocked
router.put('/:phone/block', async (req, res, next) => {
    try {
        const result = await query(`
            UPDATE accounts 
            SET status = 'BLOCKED', blocked_at = NOW()
            WHERE phone = $1
            RETURNING *
        `, [req.params.phone]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json({ success: true, message: 'Account blocked - do not use for 48h' });
    } catch (err) {
        next(err);
    }
});

// PUT /api/accounts/:phone/unblock - Unblock account
router.put('/:phone/unblock', async (req, res, next) => {
    try {
        const result = await query(`
            UPDATE accounts 
            SET status = 'HEALTHY', blocked_at = NULL
            WHERE phone = $1
            RETURNING *
        `, [req.params.phone]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json({ success: true, message: 'Account unblocked' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/accounts/:phone
router.delete('/:phone', async (req, res, next) => {
    try {
        await query('DELETE FROM accounts WHERE phone = $1', [req.params.phone]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:phone/sessions - Get sessions for account
router.get('/:phone/sessions', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT * FROM sessions WHERE phone = $1 ORDER BY session_number
        `, [req.params.phone]);

        const connected = result.rows.filter(s => s.status === 'CONNECTED').length;

        res.json({
            phone: req.params.phone,
            total: result.rows.length,
            connected,
            sessions: result.rows
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
