const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Simple and clean - no warmup, no stages, no power scores

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8014432452';

// Worker URLs
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
    { id: 'worker-4', url: process.env.WORKER_4_URL || 'http://worker-4:3001', country: 'US' },
];

// Send Telegram alert
async function sendTelegramAlert(message) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error('[Telegram] Failed:', err.message);
    }
}

// Get healthy accounts
async function getHealthyAccounts() {
    try {
        const result = await query(`
            SELECT a.phone, a.country, a.proxy_id,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED') as sessions
            FROM accounts a
            WHERE a.status = 'HEALTHY'
        `);
        return result.rows.filter(a => a.sessions > 0);
    } catch (err) {
        console.error('[Send] DB error:', err);
        return [];
    }
}

// POST /api/send - Main send endpoint
router.post('/', async (req, res, next) => {
    try {
        const { contacts, message } = req.body;

        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'contacts array required' });
        }
        if (!message) {
            return res.status(400).json({ error: 'message required' });
        }

        // 1. Get healthy accounts
        const accounts = await getHealthyAccounts();

        if (accounts.length === 0) {
            await sendTelegramAlert('⚠️ <b>אין מכשירים!</b>\n\nNo healthy accounts available.');
            return res.status(503).json({ error: 'No healthy accounts' });
        }

        if (accounts.length < 2) {
            await sendTelegramAlert(`⚠️ <b>מעט מכשירים</b>\n\nOnly ${accounts.length} account(s) available.`);
        }

        // 2. Create campaign
        const campaignResult = await query(`
            INSERT INTO campaigns (total, message_template, status, started_at)
            VALUES ($1, $2, 'in_progress', NOW())
            RETURNING id
        `, [contacts.length, message]);

        const campaignId = campaignResult.rows[0].id;

        // 3. Distribute contacts evenly
        const perAccount = Math.ceil(contacts.length / accounts.length);
        const distribution = {};
        let contactIndex = 0;

        for (const account of accounts) {
            const count = Math.min(perAccount, contacts.length - contactIndex);
            distribution[account.phone] = contacts.slice(contactIndex, contactIndex + count);
            contactIndex += count;
        }

        // 4. Start sending in background
        processCampaign(campaignId, distribution, message);

        // 5. Return immediately
        res.json({
            success: true,
            campaign_id: campaignId,
            total: contacts.length,
            accounts_used: accounts.length
        });

    } catch (err) {
        next(err);
    }
});

// Process campaign in background
async function processCampaign(campaignId, distribution, message) {
    const startTime = Date.now();
    let sent = 0;
    let failed = 0;

    // Send from all accounts in parallel
    const sendPromises = Object.entries(distribution).map(async ([phone, contacts]) => {
        const worker = WORKERS[0]; // TODO: Get correct worker for phone

        for (const contact of contacts) {
            try {
                const toPhone = typeof contact === 'object' ? contact.phone : contact;
                const name = typeof contact === 'object' ? (contact.name || '') : '';

                await axios.post(`${worker.url}/send`, {
                    from_phone: phone,
                    to_phone: toPhone,
                    message: message,
                    name: name
                }, { timeout: 30000 });

                sent++;

                // Log
                await query(`
                    INSERT INTO send_log (campaign_id, phone, recipient, status)
                    VALUES ($1, $2, $3, 'SENT')
                `, [campaignId, phone, toPhone]);

            } catch (err) {
                failed++;
                console.error(`[Campaign ${campaignId}] Failed from ${phone}:`, err.message);

                await query(`
                    INSERT INTO send_log (campaign_id, phone, recipient, status, error)
                    VALUES ($1, $2, $3, 'FAILED', $4)
                `, [campaignId, phone, typeof contact === 'object' ? contact.phone : contact, err.message]);
            }
        }
    });

    await Promise.all(sendPromises);

    // Update campaign
    const duration = Math.round((Date.now() - startTime) / 1000);
    await query(`
        UPDATE campaigns 
        SET status = 'completed', sent = $1, failed = $2, completed_at = NOW()
        WHERE id = $3
    `, [sent, failed, campaignId]);

    // Send completion alert
    const durationStr = duration > 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;
    await sendTelegramAlert(`✅ <b>קמפיין הסתיים!</b>\n\n📤 Sent: ${sent}\n❌ Failed: ${failed}\n⏱️ Duration: ${durationStr}`);

    console.log(`[Campaign ${campaignId}] Done: ${sent} sent, ${failed} failed, ${durationStr}`);
}

// GET /api/campaign/:id/status
router.get('/campaign/:id/status', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query('SELECT * FROM campaigns WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const c = result.rows[0];

        res.json({
            total: c.total,
            sent: c.sent,
            failed: c.failed,
            status: c.status
        });

    } catch (err) {
        next(err);
    }
});

module.exports = router;
