const { Router } = require('express');
const axios = require('axios');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Simple and clean - no warmup, no stages, no power scores
// Contacts are distributed EVENLY among ALL connected accounts
// Any phone can send to any country - no restrictions!

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8014432452';

// Worker URLs
const WORKERS = [
    { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001' },
    { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3001' },
    { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3001' },
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

// v8.0: Get ALL healthy accounts from ALL workers
// No country filtering - any phone can send to any destination
async function getHealthyAccountsFromWorkers() {
    const allAccounts = [];

    for (const worker of WORKERS) {
        try {
            const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
            const accounts = response.data.accounts || [];

            // Filter only connected & logged in accounts
            const healthyAccounts = accounts.filter(a => a.connected && a.logged_in);

            // Add worker info to each account
            healthyAccounts.forEach(acc => {
                allAccounts.push({
                    phone: acc.phone,
                    worker_id: worker.id,
                    worker_url: worker.url
                });
            });

            console.log(`[Send] Worker ${worker.id}: ${healthyAccounts.length} healthy accounts`);
        } catch (err) {
            console.error(`[Send] Failed to get accounts from ${worker.id}:`, err.message);
        }
    }

    return allAccounts;
}

// Helper function to normalize phone numbers
function normalizePhone(phone) {
    if (!phone) return phone;

    // If already has +, return as-is
    if (phone.startsWith('+')) {
        return phone;
    }

    // Remove all non-numeric characters
    const cleaned = phone.replace(/\D/g, '');

    // If starts with country code (e.g., 972, 1, 44), add +
    if (cleaned.length >= 10) {
        // Common country codes
        if (cleaned.startsWith('972')) return '+' + cleaned; // Israel
        if (cleaned.startsWith('1') && cleaned.length === 11) return '+' + cleaned; // US/Canada
        if (cleaned.startsWith('44')) return '+' + cleaned; // UK
        if (cleaned.startsWith('49')) return '+' + cleaned; // Germany
        if (cleaned.startsWith('33')) return '+' + cleaned; // France

        // If no country code detected but has 10+ digits, assume it needs +
        if (cleaned.length >= 10) {
            return '+' + cleaned;
        }
    }

    // If can't determine, return with + anyway (let WhatsApp handle it)
    return '+' + cleaned;
}

// POST /api/send - Main send endpoint
// Distributes contacts EVENLY among ALL healthy accounts
// No country restrictions - any phone sends to any destination
router.post('/', async (req, res, next) => {
    try {
        const { contacts, message } = req.body;

        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'contacts array required' });
        }
        if (!message) {
            return res.status(400).json({ error: 'message required' });
        }

        // Normalize phone numbers - ensure they have + prefix
        const normalizedContacts = contacts.map(contact => {
            if (typeof contact === 'object') {
                return {
                    phone: normalizePhone(contact.phone),
                    name: contact.name || ''
                };
            }
            return {
                phone: normalizePhone(contact),
                name: ''
            };
        });

        console.log(`[Send] Received ${normalizedContacts.length} contacts, normalized phones:`,
            normalizedContacts.map(c => c.phone).join(', '));

        // 1. Get ALL healthy accounts from ALL workers
        const accounts = await getHealthyAccountsFromWorkers();

        if (accounts.length === 0) {
            await sendTelegramAlert('⚠️ <b>אין מכשירים!</b>\n\nNo healthy accounts available.');
            return res.status(503).json({ error: 'No healthy accounts' });
        }

        if (accounts.length < 2) {
            await sendTelegramAlert(`⚠️ <b>מעט מכשירים</b>\n\nOnly ${accounts.length} account(s) available.`);
        }

        // 2. Create campaign in database
        let campaignId;
        try {
            const campaignResult = await query(`
                INSERT INTO campaigns (total, message_template, status, started_at)
                VALUES ($1, $2, 'in_progress', NOW())
                RETURNING id
            `, [normalizedContacts.length, message]);
            campaignId = campaignResult.rows[0].id;
        } catch (dbErr) {
            console.error('[Send] DB error creating campaign:', dbErr.message);
            campaignId = `camp_${Date.now()}`;
        }

        // 3. Distribute contacts EVENLY among ALL accounts
        // No country filtering - any phone sends to any destination
        const perAccount = Math.ceil(normalizedContacts.length / accounts.length);
        const distribution = {};
        let contactIndex = 0;

        for (const account of accounts) {
            const count = Math.min(perAccount, normalizedContacts.length - contactIndex);
            if (count > 0) {
                distribution[account.phone] = {
                    contacts: normalizedContacts.slice(contactIndex, contactIndex + count),
                    worker_url: account.worker_url
                };
                contactIndex += count;
            }
        }

        console.log(`[Campaign ${campaignId}] Distributing ${normalizedContacts.length} contacts to ${accounts.length} accounts:`);
        for (const [phone, data] of Object.entries(distribution)) {
            console.log(`  - ${phone}: ${data.contacts.length} contacts`);
        }

        // 4. Start sending in background
        processCampaign(campaignId, distribution, message);

        // 5. Return immediately
        res.json({
            success: true,
            campaign_id: campaignId,
            total: normalizedContacts.length,
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
        for (const contact of data.contacts) {
            try {
                const toPhone = typeof contact === 'object' ? contact.phone : contact;
                const name = typeof contact === 'object' ? (contact.name || '') : '';

                // Validate phone number format
                if (!toPhone || !toPhone.startsWith('+')) {
                    failed++;
                    const errorMsg = `Invalid phone format: ${toPhone} (must start with +)`;
                    console.error(`[Campaign ${campaignId}] ❌ ${errorMsg}`);
                    try {
                        await query(`
                            INSERT INTO send_log (campaign_id, phone, recipient, status, error)
                            VALUES ($1, $2, $3, 'FAILED', $4)
                        `, [campaignId, phone, toPhone, errorMsg]);
                    } catch (e) { }
                    continue;
                }

                // Send to worker and check response
                console.log(`[Campaign ${campaignId}] 📤 Sending from ${phone} to ${toPhone} (name: "${name}") via ${data.worker_url}`);

                const response = await axios.post(`${data.worker_url}/send`, {
                    from_phone: phone,
                    to_phone: toPhone,
                    message: message,
                    name: name
                }, { timeout: 30000 });

                console.log(`[Campaign ${campaignId}] 📥 Worker response from ${phone} to ${toPhone}:`, JSON.stringify(response.data));

                // Only count as sent if worker confirms success
                if (response.data && response.data.success === true) {
                    sent++;
                    console.log(`[Campaign ${campaignId}] ✅ Sent from ${phone} to ${toPhone} | MessageID: ${response.data.message_id || 'N/A'}`);

                    // Log success (ignore DB errors)
                    try {
                        await query(`
                            INSERT INTO send_log (campaign_id, phone, recipient, status)
                            VALUES ($1, $2, $3, 'SENT')
                        `, [campaignId, phone, toPhone]);
                    } catch (e) { }
                } else {
                    // Worker returned but without success confirmation
                    failed++;
                    const errorMsg = response.data?.error || 'Worker did not confirm success';
                    console.error(`[Campaign ${campaignId}] ⚠️ Worker response without success from ${phone} to ${toPhone}:`, errorMsg);

                    try {
                        await query(`
                            INSERT INTO send_log (campaign_id, phone, recipient, status, error)
                            VALUES ($1, $2, $3, 'FAILED', $4)
                        `, [campaignId, phone, toPhone, errorMsg]);
                    } catch (e) { }
                }

            } catch (err) {
                failed++;
                const errorMsg = err.response?.data?.error || err.message || 'Unknown error';
                console.error(`[Campaign ${campaignId}] ❌ Failed from ${phone} to ${typeof contact === 'object' ? contact.phone : contact}:`, errorMsg);

                try {
                    await query(`
                        INSERT INTO send_log (campaign_id, phone, recipient, status, error)
                        VALUES ($1, $2, $3, 'FAILED', $4)
                    `, [campaignId, phone, typeof contact === 'object' ? contact.phone : contact, errorMsg]);
                } catch (e) { }
            }
        }
    });

    await Promise.all(sendPromises);

    // Update campaign (ignore DB errors)
    const duration = Math.round((Date.now() - startTime) / 1000);
    try {
        await query(`
            UPDATE campaigns 
            SET status = 'completed', sent = $1, failed = $2, completed_at = NOW()
            WHERE id = $3
        `, [sent, failed, campaignId]);
    } catch (e) { }

    // Send completion alert
    const durationStr = duration > 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;
    await sendTelegramAlert(`✅ <b>קמפיין הסתיים!</b>\n\n📤 Sent: ${sent}\n❌ Failed: ${failed}\n⏱️ Duration: ${durationStr}`);

    console.log(`[Campaign ${campaignId}] Done: ${sent} sent, ${failed} failed, ${durationStr}`);
}

// GET /api/send/status - Get send capacity from workers
router.get('/status', async (req, res, next) => {
    try {
        const accounts = await getHealthyAccountsFromWorkers();

        res.json({
            healthy_accounts: accounts.length,
            messages_per_minute: accounts.length * 22, // ~22 msgs/min per device
            accounts: accounts.map(a => ({
                phone: a.phone,
                worker: a.worker_id
            }))
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
