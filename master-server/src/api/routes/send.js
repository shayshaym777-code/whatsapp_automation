const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Simple and clean - no warmup, no stages, no power scores
// Contacts are distributed EVENLY among all connected accounts

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8014432452';

// Worker URLs
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
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

// Get healthy accounts (at least 1 session connected, not blocked)
async function getHealthyAccounts() {
    try {
        // v8.0: Use the get_healthy_accounts function or query directly
        const result = await query(`
            SELECT 
                a.phone, 
                a.country, 
                a.proxy_id,
                COUNT(s.id) FILTER (WHERE s.status = 'CONNECTED') as sessions
            FROM accounts a
            LEFT JOIN sessions s ON a.phone = s.phone
            WHERE a.blocked_at IS NULL OR a.blocked_at < NOW() - INTERVAL '48 hours'
            GROUP BY a.phone, a.country, a.proxy_id
            HAVING COUNT(s.id) FILTER (WHERE s.status = 'CONNECTED') > 0
        `);
        return result.rows;
    } catch (err) {
        console.error('[Send] DB error:', err);
        return [];
    }
}

// Get worker for a phone based on country
function getWorkerForPhone(phone, country) {
    // Match worker by country
    const worker = WORKERS.find(w => w.country === country);
    if (worker) return worker;
    
    // Default to first worker
    return WORKERS[0];
}

// POST /api/send - Main send endpoint
// Distributes contacts EVENLY among all healthy accounts
router.post('/', async (req, res, next) => {
    try {
        const { contacts, message } = req.body;

        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'contacts array required' });
        }
        if (!message) {
            return res.status(400).json({ error: 'message required' });
        }

        // 1. Get healthy accounts (at least 1 session connected)
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

        // 3. Distribute contacts EVENLY among all accounts
        const perAccount = Math.ceil(contacts.length / accounts.length);
        const distribution = {};
        let contactIndex = 0;

        for (const account of accounts) {
            const count = Math.min(perAccount, contacts.length - contactIndex);
            if (count > 0) {
                distribution[account.phone] = {
                    contacts: contacts.slice(contactIndex, contactIndex + count),
                    country: account.country
                };
                contactIndex += count;
            }
        }

        console.log(`[Campaign ${campaignId}] Distributing ${contacts.length} contacts to ${accounts.length} accounts:`);
        for (const [phone, data] of Object.entries(distribution)) {
            console.log(`  - ${phone}: ${data.contacts.length} contacts`);
        }

        // 4. Start sending in background
        processCampaign(campaignId, distribution, message);

        // 5. Return immediately
        res.json({
            success: true,
            campaign_id: campaignId,
            total: contacts.length,
            accounts_used: accounts.length,
            distribution: Object.fromEntries(
                Object.entries(distribution).map(([phone, data]) => [phone, data.contacts.length])
            )
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
    const sendPromises = Object.entries(distribution).map(async ([phone, data]) => {
        const worker = getWorkerForPhone(phone, data.country);

        for (const contact of data.contacts) {
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

                // Log success
                await query(`
                    INSERT INTO send_log (campaign_id, phone, recipient, status)
                    VALUES ($1, $2, $3, 'SENT')
                `, [campaignId, phone, toPhone]);

                // Update account message count
                await query(`
                    UPDATE accounts SET messages_today = messages_today + 1, last_message_at = NOW()
                    WHERE phone = $1
                `, [phone]);

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

// GET /api/send/status - Get send capacity
router.get('/status', async (req, res, next) => {
    try {
        const accounts = await getHealthyAccounts();
        
        res.json({
            healthy_accounts: accounts.length,
            accounts: accounts.map(a => ({
                phone: a.phone,
                sessions: parseInt(a.sessions) || 0,
                country: a.country
            }))
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
