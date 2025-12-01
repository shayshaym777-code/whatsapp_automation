const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// Worker URLs configuration
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
    { id: 'worker-4', url: process.env.WORKER_4_URL || 'http://worker-4:3001', country: 'US' },
];

// v7.0 Stage configuration
const STAGES = {
    'WARMING': { minDays: 1, maxDays: 3, dailyLimit: 5, power: 0 },
    'Baby': { minDays: 4, maxDays: 7, dailyLimit: 15, power: 15 },
    'Toddler': { minDays: 8, maxDays: 14, dailyLimit: 30, power: 30 },
    'Teen': { minDays: 15, maxDays: 30, dailyLimit: 50, power: 50 },
    'Adult': { minDays: 31, maxDays: 60, dailyLimit: 100, power: 100 },
    'Veteran': { minDays: 61, maxDays: 9999, dailyLimit: 200, power: 200 },
};

// GET /api/accounts - v7.0 with sessions count
router.get('/', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT a.*,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone) as total_sessions,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED') as active_sessions,
                   (SELECT session_number FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED' ORDER BY session_number LIMIT 1) as active_session
            FROM accounts a
            ORDER BY a.created_at DESC LIMIT 200
        `);
        
        // Add stage info
        const accounts = result.rows.map(acc => {
            const stage = STAGES[acc.stage] || STAGES['Adult'];
            return {
                ...acc,
                sessions: acc.total_sessions || 0,
                active_session: acc.active_session || null,
                max_per_day: stage.dailyLimit,
                power: stage.power
            };
        });
        
        res.json({ accounts });
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
        await query('DELETE FROM accounts WHERE phone = $1', [req.params.phone]);
        res.status(204).send();
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/mark-new - v7.0: Mark account as new (triggers 3-day warmup)
router.post('/:phone/mark-new', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        // Update account to is_new = true and stage = WARMING
        const result = await query(`
            UPDATE accounts 
            SET is_new = TRUE, 
                stage = 'WARMING',
                power = 0,
                max_per_day = 5,
                updated_at = NOW()
            WHERE phone = $1
            RETURNING *
        `, [phone]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        console.log(`[Accounts] Account ${phone} marked as NEW - entering 3-day warmup`);

        res.json({
            success: true,
            message: 'Account marked as new - 3 day warmup started',
            account: result.rows[0]
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/unmark-new - v7.0: Remove new flag (skip warmup)
router.post('/:phone/unmark-new', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        // Update account to is_new = false and stage = Adult
        const result = await query(`
            UPDATE accounts 
            SET is_new = FALSE, 
                stage = 'Adult',
                power = 100,
                max_per_day = 100,
                updated_at = NOW()
            WHERE phone = $1
            RETURNING *
        `, [phone]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        console.log(`[Accounts] Account ${phone} unmarked as new - ready for campaigns`);

        res.json({
            success: true,
            message: 'Account warmup skipped - ready for campaigns',
            account: result.rows[0]
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/:phone/sessions - v7.0: Get all sessions for a phone
router.get('/:phone/sessions', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        const result = await query(`
            SELECT * FROM sessions WHERE phone = $1 ORDER BY session_number
        `, [phone]);

        const connected = result.rows.filter(s => s.status === 'CONNECTED').length;

        res.json({
            phone,
            total_sessions: result.rows.length,
            connected_sessions: connected,
            sessions: result.rows
        });
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

// POST /api/accounts/:phone/register - Register new account for warmup
router.post('/:phone/register', async (req, res, next) => {
    try {
        const phone = req.params.phone;
        const { worker_id, country } = req.body;

        if (!worker_id || !country) {
            return res.status(400).json({ error: 'worker_id and country are required' });
        }

        // Check if account already exists
        const existing = await query(
            'SELECT * FROM warmup_accounts WHERE phone_number = $1',
            [phone]
        );

        if (existing.rows.length > 0) {
            // Account already registered, return existing data
            return res.json({
                success: true,
                message: 'Account already registered for warmup',
                account: existing.rows[0]
            });
        }

        // Register new account for warmup
        const result = await query(
            `INSERT INTO warmup_accounts (phone_number, worker_id, country, stage, max_messages_per_day)
             VALUES ($1, $2, $3, 'new_born', 5)
             RETURNING *`,
            [phone, worker_id, country]
        );

        console.log(`[Warmup] New account registered: ${phone} (${country}) on ${worker_id}`);

        res.status(201).json({
            success: true,
            message: 'Account registered for warmup',
            account: result.rows[0]
        });
    } catch (err) {
        next(err);
    }
});

// Warmup stages configuration
const WARMUP_STAGES = [
    { name: 'new_born', minDays: 0, maxDays: 3, dailyLimit: 5, delaySeconds: 120 },
    { name: 'baby', minDays: 4, maxDays: 7, dailyLimit: 15, delaySeconds: 90 },
    { name: 'toddler', minDays: 8, maxDays: 14, dailyLimit: 30, delaySeconds: 60 },
    { name: 'teen', minDays: 15, maxDays: 30, dailyLimit: 50, delaySeconds: 45 },
    { name: 'adult', minDays: 31, maxDays: 9999, dailyLimit: 100, delaySeconds: 30 },
];

// Helper function to get stage for days
function getStageForDays(days) {
    for (const stage of WARMUP_STAGES) {
        if (days >= stage.minDays && days <= stage.maxDays) {
            return stage;
        }
    }
    return WARMUP_STAGES[WARMUP_STAGES.length - 1];
}

// GET /api/accounts/warmup/stages - Get warmup stages configuration
router.get('/warmup/stages', async (req, res) => {
    res.json({ stages: WARMUP_STAGES });
});

// GET /api/accounts/:phone/warmup - Get warmup status for specific account
router.get('/:phone/warmup', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        const result = await query(
            'SELECT * FROM warmup_accounts WHERE phone_number = $1',
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found in warmup system' });
        }

        const account = result.rows[0];

        // Calculate days since warmup started
        const daysSinceStart = Math.floor(
            (Date.now() - new Date(account.warmup_started_at).getTime()) / (1000 * 60 * 60 * 24)
        );

        // Determine current stage based on days
        const stage = getStageForDays(daysSinceStart);
        const isComplete = daysSinceStart >= 31;

        // Update stage if changed
        if (stage.name !== account.stage || isComplete !== account.is_warmup_complete) {
            await query(
                `UPDATE warmup_accounts 
                 SET stage = $1, max_messages_per_day = $2, is_warmup_complete = $3,
                     warmup_completed_at = CASE WHEN $3 = TRUE AND warmup_completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE warmup_completed_at END
                 WHERE phone_number = $4`,
                [stage.name, stage.dailyLimit, isComplete, phone]
            );
            account.stage = stage.name;
            account.max_messages_per_day = stage.dailyLimit;
            account.is_warmup_complete = isComplete;
        }

        res.json({
            ...account,
            days_since_start: daysSinceStart,
            stage_info: stage,
            can_send_more: account.messages_sent_today < stage.dailyLimit,
            messages_remaining: stage.dailyLimit - account.messages_sent_today,
            delay_seconds: stage.delaySeconds
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/warmup/message-sent - Record warmup message sent
router.post('/:phone/warmup/message-sent', async (req, res, next) => {
    try {
        const phone = req.params.phone;
        const { target_phone } = req.body;

        const result = await query(
            `UPDATE warmup_accounts 
             SET messages_sent_today = messages_sent_today + 1,
                 total_warmup_messages = total_warmup_messages + 1,
                 last_warmup_message_at = CURRENT_TIMESTAMP,
                 last_warmup_target = $2
             WHERE phone_number = $1
             RETURNING *`,
            [phone, target_phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        res.json({
            success: true,
            account: result.rows[0]
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/reset-daily-counts - Reset daily message counts (run at midnight)
router.post('/reset-daily-counts', async (req, res, next) => {
    try {
        const result = await query(
            `UPDATE warmup_accounts SET messages_sent_today = 0 RETURNING phone_number`
        );

        res.json({
            success: true,
            message: `Reset daily counts for ${result.rows.length} accounts`
        });
    } catch (err) {
        next(err);
    }
});

// ============================================
// ACCOUNT HEALTH ENDPOINTS
// ============================================

// GET /api/accounts/:phone/health - Get account health/safety score
router.get('/:phone/health', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        let result = await query(
            'SELECT * FROM account_health WHERE phone_number = $1',
            [phone]
        );

        // Create health record if doesn't exist
        if (result.rows.length === 0) {
            result = await query(
                `INSERT INTO account_health (phone_number) VALUES ($1) RETURNING *`,
                [phone]
            );
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/health/message - Record message sent (updates health)
router.post('/:phone/health/message', async (req, res, next) => {
    try {
        const phone = req.params.phone;
        const { success, error } = req.body;

        if (success) {
            await query(
                `INSERT INTO account_health (phone_number, messages_sent, messages_delivered)
                 VALUES ($1, 1, 1)
                 ON CONFLICT (phone_number) DO UPDATE SET
                     messages_sent = account_health.messages_sent + 1,
                     messages_delivered = account_health.messages_delivered + 1,
                     delivery_rate = (account_health.messages_delivered + 1)::decimal / (account_health.messages_sent + 1) * 100`,
                [phone]
            );
        } else {
            await query(
                `INSERT INTO account_health (phone_number, messages_sent, messages_failed, last_error, last_error_at, error_count)
                 VALUES ($1, 1, 1, $2, CURRENT_TIMESTAMP, 1)
                 ON CONFLICT (phone_number) DO UPDATE SET
                     messages_sent = account_health.messages_sent + 1,
                     messages_failed = account_health.messages_failed + 1,
                     last_error = $2,
                     last_error_at = CURRENT_TIMESTAMP,
                     error_count = account_health.error_count + 1,
                     delivery_rate = account_health.messages_delivered::decimal / (account_health.messages_sent + 1) * 100`,
                [phone, error || 'Unknown error']
            );
        }

        // Recalculate safety score
        const health = await query('SELECT * FROM account_health WHERE phone_number = $1', [phone]);
        if (health.rows.length > 0) {
            const h = health.rows[0];

            // Calculate component scores
            const activityScore = h.messages_sent > 0
                ? (h.messages_delivered / h.messages_sent) * 100
                : 50;

            const trustScore = h.messages_sent > 0
                ? Math.max(0, h.delivery_rate - (h.error_count / h.messages_sent) * 100)
                : 60;

            // Calculate final score
            const safetyScore = Math.round(
                activityScore * 0.3 +
                h.age_score * 0.2 +
                trustScore * 0.3 +
                h.pattern_score * 0.2
            );

            // Determine recommended action
            let action = 'normal';
            if (safetyScore < 60) action = 'stop';
            else if (safetyScore < 70) action = 'pause';
            else if (safetyScore < 80) action = 'very_slow';
            else if (safetyScore < 90) action = 'slow';

            await query(
                `UPDATE account_health SET 
                     safety_score = $1, activity_score = $2, trust_score = $3, recommended_action = $4
                 WHERE phone_number = $5`,
                [safetyScore, activityScore, trustScore, action, phone]
            );
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/health/suspicious - Mark account as suspicious
router.post('/:phone/health/suspicious', async (req, res, next) => {
    try {
        const phone = req.params.phone;
        const { reason, suspend_hours } = req.body;

        const suspendUntil = suspend_hours
            ? new Date(Date.now() + suspend_hours * 60 * 60 * 1000)
            : null;

        await query(
            `INSERT INTO account_health (phone_number, is_suspicious, suspicious_reason, suspended_until, recommended_action)
             VALUES ($1, TRUE, $2, $3, 'stop')
             ON CONFLICT (phone_number) DO UPDATE SET
                 is_suspicious = TRUE,
                 suspicious_reason = $2,
                 suspended_until = $3,
                 recommended_action = 'stop'`,
            [phone, reason, suspendUntil]
        );

        console.log(`[Health] Account ${phone} marked as suspicious: ${reason}`);

        res.json({ success: true, suspended_until: suspendUntil });
    } catch (err) {
        next(err);
    }
});

// POST /api/accounts/:phone/health/clear - Clear suspicious status
router.post('/:phone/health/clear', async (req, res, next) => {
    try {
        const phone = req.params.phone;

        await query(
            `UPDATE account_health SET 
                 is_suspicious = FALSE, 
                 suspicious_reason = NULL, 
                 suspended_until = NULL,
                 recommended_action = 'slow',
                 error_count = 0
             WHERE phone_number = $1`,
            [phone]
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// GET /api/accounts/health/summary - Get health summary for all accounts
router.get('/health/summary', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT 
                COUNT(*) as total_accounts,
                COUNT(*) FILTER (WHERE safety_score >= 80) as healthy_accounts,
                COUNT(*) FILTER (WHERE safety_score >= 60 AND safety_score < 80) as warning_accounts,
                COUNT(*) FILTER (WHERE safety_score < 60) as critical_accounts,
                COUNT(*) FILTER (WHERE is_suspicious = TRUE) as suspicious_accounts,
                AVG(safety_score) as avg_safety_score,
                AVG(delivery_rate) as avg_delivery_rate
            FROM account_health
        `);

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
