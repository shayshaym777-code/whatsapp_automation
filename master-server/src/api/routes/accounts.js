const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');
const workerManager = require('../../services/WorkerManager');

const router = Router();

// v8.0: Get accounts from WORKERS directly
// Status: CONNECTED (at least 1 session) or DISCONNECTED

// Dynamic workers: Support 1-100 workers
function loadWorkers() {
    const workers = [];
    const workerCount = parseInt(process.env.WORKER_COUNT) || 0;

    if (workerCount > 0) {
        // Use WORKER_COUNT if specified
        for (let i = 1; i <= workerCount; i++) {
            const workerId = `worker-${i}`;
            const workerUrl = process.env[`WORKER_${i}_URL`] || `http://worker-${i}:3001`;
            workers.push({ id: workerId, url: workerUrl });
        }
    } else {
        // Auto-detect from WORKER_N_URL env vars (up to 100 workers)
        for (let i = 1; i <= 100; i++) {
            const workerUrl = process.env[`WORKER_${i}_URL`];
            if (workerUrl) {
                const workerId = `worker-${i}`;
                workers.push({ id: workerId, url: workerUrl });
            }
        }

        // Fallback to default 3 workers if none found
        if (workers.length === 0) {
            workers.push(
                { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001' },
                { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001' },
                { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001' }
            );
        }
    }

    return workers;
}

const WORKERS = loadWorkers();

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
                        last_error: acc.last_error || null,
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

// GET /api/accounts/:phone/disconnect-reason - Get why account disconnected
router.get('/:phone/disconnect-reason', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        for (const worker of WORKERS) {
            try {
                const response = await axios.get(`${worker.url}/accounts/${phone}/disconnect-reason`, { timeout: 5000 });
                if (response.data) {
                    return res.json({
                        ...response.data,
                        worker_id: worker.id,
                        worker_url: worker.url
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
// Auto-creates worker if needed (one worker per account OR per session)
router.post('/pair', async (req, res, next) => {
    try {
        const { phone, worker_id, session_number } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'phone required' });
        }

        // Detect country from phone number
        const detectCountry = (phoneNum) => {
            if (!phoneNum) return 'US';
            const clean = phoneNum.replace(/\s/g, '');
            if (clean.startsWith('+972') || clean.startsWith('972')) return 'IL';
            if (clean.startsWith('+1') || clean.startsWith('1')) return 'US';
            if (clean.startsWith('+44') || clean.startsWith('44')) return 'GB';
            return 'US';
        };

        const country = detectCountry(phone);
        let worker;

        // Check if account already exists and get existing sessions
        let existingSessions = [];
        let existingAccount = null;
        for (const w of WORKERS) {
            try {
                const accountsResponse = await axios.get(`${w.url}/accounts`, { timeout: 5000 });
                const accounts = accountsResponse.data?.accounts || [];
                const acc = accounts.find(a => a.phone === phone);
                if (acc) {
                    existingAccount = acc;
                    existingSessions.push({
                        worker_id: w.id,
                        worker_url: w.url,
                        connected: acc.connected || false,
                        logged_in: acc.logged_in || false
                    });
                }
            } catch (err) {
                // Skip failed workers
            }
        }

        // If adding session 2-4, check if we should use existing worker or create new one
        const sessionNum = session_number || 1;
        const isNewSession = sessionNum > 1 && existingSessions.length > 0;

        // If account exists and is already connected, check if it's really connected
        if (existingAccount && existingAccount.logged_in && existingAccount.connected) {
            // Account is already connected - check if this is a duplicate request
            if (sessionNum === 1) {
                return res.json({
                    success: true,
                    status: 'already_connected',
                    phone: phone,
                    logged_in: true,
                    connected: true,
                    message: 'Account is already connected',
                    worker_id: existingSessions[0]?.worker_id
                });
            }
        }

        if (worker_id) {
            // Use specified worker
            worker = WORKERS.find(w => w.id === worker_id) || WORKERS[0];
        } else if (isNewSession) {
            // For session 2-4: Create new worker OR use existing empty worker
            try {
                // Try to find empty worker first
                const emptyWorker = await workerManager.findEmptyWorker();
                if (emptyWorker) {
                    worker = emptyWorker;
                    console.log(`[Accounts] Using existing empty worker ${worker.id} for session ${sessionNum} of ${phone}`);
                } else {
                    // Create new worker for this session
                    worker = await workerManager.getOrCreateWorkerForAccount(`${phone}-session-${sessionNum}`, country);
                    console.log(`[Accounts] Created new worker ${worker.id} for session ${sessionNum} of ${phone}`);
                }
            } catch (err) {
                console.error(`[Accounts] Failed to create worker for session ${sessionNum}, using default: ${err.message}`);
                // Fallback: use first available worker
                worker = WORKERS[0];
            }
        } else {
            // First session: Auto-create worker for this account
            try {
                worker = await workerManager.getOrCreateWorkerForAccount(phone, country);
                console.log(`[Accounts] Using worker ${worker.id} for ${phone} (session ${sessionNum})`);
            } catch (err) {
                console.error(`[Accounts] Failed to create worker, using default: ${err.message}`);
                // Fallback to first available worker
                worker = WORKERS[0];
            }
        }

        if (!worker) {
            return res.status(500).json({ error: 'No worker available' });
        }

        // Request pairing from worker with session_number
        const response = await axios.post(`${worker.url}/accounts/pair`, {
            phone: phone,
            session_number: sessionNum || 1
        }, { timeout: 30000 });

        res.json({
            ...response.data,
            worker_id: worker.id,
            worker_url: worker.url,
            session_number: sessionNum
        });
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
