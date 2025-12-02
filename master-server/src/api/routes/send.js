const { Router } = require('express');
const { query } = require('../../config/database');
const axios = require('axios');
const queueProcessor = require('../../services/QueueProcessor');

const router = Router();

// v9.0: New sending mechanism with queue and priority system
// - Uses all available senders
// - Priority: existing chats first, then new contacts
// - Anti-ban: 15 msg/min, delays 1-7 sec, pauses every 10/50/100

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8014432452';

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

// Helper function to normalize phone numbers
function normalizePhone(phone) {
    if (!phone) return phone;
    
    if (phone.startsWith('+')) {
        return phone;
    }
    
    const cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.length >= 10) {
        if (cleaned.startsWith('972')) return '+' + cleaned;
        if (cleaned.startsWith('1') && cleaned.length === 11) return '+' + cleaned;
        if (cleaned.startsWith('44')) return '+' + cleaned;
        if (cleaned.startsWith('49')) return '+' + cleaned;
        if (cleaned.startsWith('33')) return '+' + cleaned;
        
        if (cleaned.length >= 10) {
            return '+' + cleaned;
        }
    }
    
    return '+' + cleaned;
}

// POST /api/send - Add messages to queue
router.post('/', async (req, res, next) => {
    try {
        const { contacts, message } = req.body;

        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'contacts array required' });
        }
        if (!message) {
            return res.status(400).json({ error: 'message required' });
        }

        // Normalize phone numbers
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

        // Create campaign
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

        // Add messages to queue with priority
        // Priority: 10 for existing chats, 0 for new contacts
        const queueInserts = [];
        
        for (const contact of normalizedContacts) {
            // Check if there's existing chat
            const existingChat = await query(`
                SELECT sender_phone
                FROM chat_history
                WHERE recipient_phone = $1
                LIMIT 1
            `, [contact.phone]);

            const priority = existingChat.rows.length > 0 ? 10 : 0;

            queueInserts.push({
                campaign_id: campaignId,
                recipient_phone: contact.phone,
                recipient_name: contact.name,
                message_template: message,
                priority: priority
            });
        }

        // Insert all into queue
        for (const item of queueInserts) {
            await query(`
                INSERT INTO message_queue (campaign_id, recipient_phone, recipient_name, message_template, priority)
                VALUES ($1, $2, $3, $4, $5)
            `, [item.campaign_id, item.recipient_phone, item.recipient_name, item.message_template, item.priority]);
        }

        console.log(`[Send] Added ${queueInserts.length} messages to queue for campaign ${campaignId}`);

        // Start queue processor if not running
        queueProcessor.start();

        // Return immediately
        res.json({
            success: true,
            campaign_id: campaignId,
            total: normalizedContacts.length,
            queued: queueInserts.length,
            message: 'Messages added to queue. Processing will start when 2+ messages are waiting.'
        });

    } catch (err) {
        next(err);
    }
});

module.exports = router;
