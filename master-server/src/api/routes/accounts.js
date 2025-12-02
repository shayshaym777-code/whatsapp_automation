const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Get accounts from WORKERS directly
// Status: CONNECTED (at least 1 session) or DISCONNECTED

// Worker URLs
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001' },
];

// GET /api/accounts - Get all accounts from ALL workers
router.get('/', async (req, res, next) => {
    try {
        const allAccounts = [];

        for (const worker of WORKERS) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                const accounts = response.data.accounts || [];

                accounts.forEach(acc => {
                    // Determine status: CONNECTED if logged_in and connected
                    const status = (acc.connected && acc.logged_in) ? 'CONNECTED' : 'DISCONNECTED';

                    allAccounts.push({
                        phone: acc.phone,
                        status: status,
                        connected: acc.connected || false,
                        logged_in: acc.logged_in || false,
                        sessions: acc.sessions || '1/4',
                        connected_sessions: acc.connected ? 1 : 0,
                        total_sessions: 4,
                        messages_today: acc.messages_today || 0,
                        worker_id: worker.id
                    });
                });

            } catch (err) {
                console.error(`[Accounts] Failed to get from ${worker.id}:`, err.message);
            }
        }

        const connectedCount = allAccounts.filter(a => a.status === 'CONNECTED').length;
        const disconnectedCount = allAccounts.filter(a => a.status === 'DISCONNECTED').length;

        res.json({
            accounts: allAccounts,
            total_connected: connectedCount,
            total_disconnected: disconnectedCount,
            total_accounts: allAccounts.length
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:phone - Get single account from workers
router.get('/:phone', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        for (const worker of WORKERS) {
            try {
                const response = await axios.get(`${worker.url}/accounts/${phone}`, { timeout: 5000 });
                if (response.data) {
                    const acc = response.data;
                    return res.json({
                        phone: acc.phone,
                        status: (acc.connected && acc.logged_in) ? 'CONNECTED' : 'DISCONNECTED',
                        connected: acc.connected || false,
                        logged_in: acc.logged_in || false,
                        sessions: acc.sessions || '1/4',
                        messages_today: acc.messages_today || 0,
                        worker_id: worker.id
                    });
                }
            } catch (err) {
                // Try next worker
            }
        }

        res.status(404).json({ error: 'Account not found' });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/pair - Request pairing code from worker
router.post('/pair', async (req, res, next) => {
    try {
        const { phone, worker_id } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'phone required' });
        }

        // Find worker
        const workerId = worker_id || 'worker-1';
        const worker = WORKERS.find(w => w.id === workerId) || WORKERS[0];

        // Request pairing from worker
        const response = await axios.post(`${worker.url}/accounts/pair`, {
            phone: phone
        }, { timeout: 30000 });

        res.json(response.data);
    } catch (err) {
        console.error('[Accounts] Pair error:', err.message);
        res.status(500).json({ error: err.response?.data?.error || err.message });
    }
});

// POST /api/accounts/:phone/disconnect - Disconnect account
router.post('/:phone/disconnect', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        // Try to disconnect from all workers
        for (const worker of WORKERS) {
            try {
                await axios.post(`${worker.url}/accounts/${phone}/disconnect`, {}, { timeout: 5000 });
            } catch (err) {
                // Ignore errors, try all workers
            }
        }

        res.json({ success: true, message: 'Disconnect request sent' });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/reconnect - Reconnect account
router.post('/:phone/reconnect', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        // Try to reconnect from all workers
        for (const worker of WORKERS) {
            try {
                await axios.post(`${worker.url}/accounts/${phone}/reconnect`, {}, { timeout: 5000 });
            } catch (err) {
                // Ignore errors, try all workers
            }
        }

        res.json({ success: true, message: 'Reconnect request sent' });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/accounts/:phone - Delete account from all workers
router.delete('/:phone', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        // Try to delete from all workers
        for (const worker of WORKERS) {
            try {
                await axios.delete(`${worker.url}/accounts/${phone}`, { timeout: 5000 });
            } catch (err) {
                // Ignore errors, try all workers
            }
        }

        res.json({ success: true, message: 'Account deleted' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
