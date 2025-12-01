const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// Telegram configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8014432452';

// Worker URLs configuration
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001', country: 'US' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001', country: 'IL' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001', country: 'GB' },
    { id: 'worker-4', url: process.env.WORKER_4_URL || 'http://worker-4:3001', country: 'US' },
];

// v7.0 Stage configuration
const STAGES = {
    'WARMING': { minDays: 1, maxDays: 3, dailyLimit: 5, power: 0, canCampaign: false },
    'Baby': { minDays: 4, maxDays: 7, dailyLimit: 15, power: 15, canCampaign: true },
    'Toddler': { minDays: 8, maxDays: 14, dailyLimit: 30, power: 30, canCampaign: true },
    'Teen': { minDays: 15, maxDays: 30, dailyLimit: 50, power: 50, canCampaign: true },
    'Adult': { minDays: 31, maxDays: 60, dailyLimit: 100, power: 100, canCampaign: true },
    'Veteran': { minDays: 61, maxDays: 9999, dailyLimit: 200, power: 200, canCampaign: true },
};

// Send Telegram alert
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('[Telegram] Alert sent');
    } catch (err) {
        console.error('[Telegram] Failed to send alert:', err.message);
    }
}

// Get available accounts (HEALTHY + not WARMING stage)
async function getAvailableAccounts() {
    try {
        const result = await query(`
            SELECT a.phone, a.status, a.is_new, a.stage, a.power, a.max_per_day, a.messages_today,
                   (SELECT COUNT(*) FROM sessions s WHERE s.phone = a.phone AND s.status = 'CONNECTED') as active_sessions
            FROM accounts a
            WHERE a.status = 'HEALTHY' AND a.stage != 'WARMING'
            ORDER BY a.power DESC
        `);
        return result.rows;
    } catch (err) {
        console.error('[Send] Failed to get accounts:', err);
        return [];
    }
}

// Calculate power score for an account
function calculatePowerScore(account) {
    const stage = STAGES[account.stage] || STAGES['Adult'];
    const remaining = stage.dailyLimit - (account.messages_today || 0);
    if (remaining <= 0) return 0;

    const capacityRatio = remaining / stage.dailyLimit;
    return Math.floor(stage.power * capacityRatio);
}

// Distribute contacts by power score
function distributeByPower(accounts, totalContacts) {
    const distribution = {};

    // Calculate total power
    let totalPower = 0;
    const accountsWithPower = accounts.map(acc => {
        const power = calculatePowerScore(acc);
        const stage = STAGES[acc.stage] || STAGES['Adult'];
        const remaining = stage.dailyLimit - (acc.messages_today || 0);
        return { ...acc, effectivePower: power, remaining: Math.max(0, remaining) };
    }).filter(acc => acc.effectivePower > 0 && acc.remaining > 0);

    accountsWithPower.forEach(acc => {
        totalPower += acc.effectivePower;
    });

    if (totalPower === 0) return distribution;

    // Distribute proportionally
    let assigned = 0;
    accountsWithPower.forEach(acc => {
        let share = Math.floor((acc.effectivePower / totalPower) * totalContacts);
        if (share > acc.remaining) share = acc.remaining;
        distribution[acc.phone] = share;
        assigned += share;
    });

    // Distribute remainder
    let remainder = totalContacts - assigned;
    for (const acc of accountsWithPower) {
        if (remainder <= 0) break;
        if (distribution[acc.phone] < acc.remaining) {
            distribution[acc.phone]++;
            remainder--;
        }
    }

    return distribution;
}

// POST /api/send - v7.0 Main send endpoint
router.post('/', async (req, res, next) => {
    try {
        const { contacts, message, options = {} } = req.body;

        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'contacts array is required' });
        }

        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }

        // Get available accounts
        const accounts = await getAvailableAccounts();

        if (accounts.length === 0) {
            await sendTelegramAlert('⚠️ <b>LOW DEVICES</b>\n\nNo healthy accounts available!');
            return res.status(503).json({ error: 'No healthy accounts available' });
        }

        if (accounts.length < 2) {
            await sendTelegramAlert(`⚠️ <b>LOW DEVICES</b>\n\nOnly ${accounts.length} healthy accounts available!`);
        }

        // Create campaign record
        const campaignResult = await query(`
            INSERT INTO campaigns (name, message_template, total_contacts, status)
            VALUES ($1, $2, $3, 'in_progress')
            RETURNING *
        `, [`Campaign ${Date.now()}`, message, contacts.length]);

        const campaign = campaignResult.rows[0];

        // Distribute contacts by power
        const distribution = distributeByPower(accounts, contacts.length);

        // Calculate estimated time (20-25 msgs/min = ~3 sec/msg)
        const maxMessages = Math.max(...Object.values(distribution));
        const estimatedMinutes = Math.ceil(maxMessages * 3 / 60);

        // Start sending in background
        processCampaign(campaign.id, contacts, message, distribution, options);

        res.json({
            success: true,
            campaign_id: campaign.campaign_id,
            total: contacts.length,
            distributed: distribution,
            estimated_time: `${estimatedMinutes} minutes`
        });

    } catch (err) {
        next(err);
    }
});

// Process campaign in background
async function processCampaign(campaignId, contacts, message, distribution, options) {
    const startTime = Date.now();
    let sent = 0;
    let failed = 0;

    // Prepare contact assignments
    const assignments = [];
    let contactIndex = 0;

    for (const [phone, count] of Object.entries(distribution)) {
        for (let i = 0; i < count && contactIndex < contacts.length; i++) {
            assignments.push({
                fromPhone: phone,
                contact: contacts[contactIndex]
            });
            contactIndex++;
        }
    }

    // Send messages concurrently from each account
    const accountGroups = {};
    assignments.forEach(a => {
        if (!accountGroups[a.fromPhone]) accountGroups[a.fromPhone] = [];
        accountGroups[a.fromPhone].push(a.contact);
    });

    const sendPromises = Object.entries(accountGroups).map(async ([phone, phoneContacts]) => {
        // Find worker for this phone
        const worker = WORKERS[0]; // TODO: Get correct worker for phone

        for (const contact of phoneContacts) {
            try {
                const toPhone = typeof contact === 'object' ? contact.phone : contact;
                const name = typeof contact === 'object' ? contact.name : '';
                const personalizedMessage = message.replace(/{name}/g, name);

                await axios.post(`${worker.url}/send`, {
                    from_phone: phone,
                    to_phone: toPhone,
                    message: personalizedMessage
                }, { timeout: 30000 });

                sent++;

                // Log to send_log
                await query(`
                    INSERT INTO send_log (phone, recipient, content, status, campaign_id)
                    VALUES ($1, $2, $3, 'SENT', $4)
                `, [phone, toPhone, personalizedMessage.substring(0, 100), campaignId]);

            } catch (err) {
                failed++;
                console.error(`[Campaign ${campaignId}] Failed to send from ${phone}:`, err.message);

                await query(`
                    INSERT INTO send_log (phone, recipient, content, status, error, campaign_id)
                    VALUES ($1, $2, $3, 'FAILED', $4, $5)
                `, [phone, typeof contact === 'object' ? contact.phone : contact, message.substring(0, 100), err.message, campaignId]);
            }
        }
    });

    await Promise.all(sendPromises);

    // Update campaign status
    const duration = Math.round((Date.now() - startTime) / 1000);
    await query(`
        UPDATE campaigns 
        SET status = 'completed', sent_count = $1, failed_count = $2, completed_at = NOW()
        WHERE id = $3
    `, [sent, failed, campaignId]);

    // Send completion alert
    const durationStr = duration > 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;
    await sendTelegramAlert(`✅ <b>CAMPAIGN DONE</b>\n\n📤 Sent: ${sent}/${contacts.length}\n❌ Failed: ${failed}\n⏱️ Duration: ${durationStr}`);

    console.log(`[Campaign ${campaignId}] Completed: ${sent} sent, ${failed} failed, ${durationStr}`);
}

// GET /api/campaign/:id/status - Get campaign status
router.get('/campaign/:id/status', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            SELECT * FROM campaigns WHERE campaign_id = $1 OR id::text = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const campaign = result.rows[0];

        res.json({
            status: campaign.status,
            total: campaign.total_contacts,
            sent: campaign.sent_count,
            failed: campaign.failed_count,
            started_at: campaign.started_at,
            completed_at: campaign.completed_at
        });

    } catch (err) {
        next(err);
    }
});

module.exports = router;

