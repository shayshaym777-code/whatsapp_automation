// Queue Processor - New Sending Mechanism v9.0
// Processes messages with priority: existing chats first, then new contacts
// Uses all available senders with anti-ban (15 msg/min, delays, pauses)

const { query } = require('../config/database');
const axios = require('axios');
const logger = require('../utils/logger');

class QueueProcessor {
    constructor() {
        this.isProcessing = false;
        this.processingInterval = null;
        this.lastTableErrorLog = null;
        this.lastNoSendersLog = null;
        this.workers = [
            { id: 'worker-1', url: process.env.WORKER_1_URL || 'http://worker-1:3001' },
            { id: 'worker-2', url: process.env.WORKER_2_URL || 'http://worker-2:3002' },
            { id: 'worker-3', url: process.env.WORKER_3_URL || 'http://worker-3:3003' }
        ];
    }

    // Start processing queue
    start() {
        if (this.processingInterval) {
            return; // Already running
        }

        logger.info('[QueueProcessor] 🚀 Starting queue processor');

        // Process queue every 500ms
        this.processingInterval = setInterval(() => {
            this.processQueue().catch(err => {
                logger.error(`[QueueProcessor] Error: ${err.message}`);
            });
        }, 500);
    }

    // Stop processing
    stop() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
            logger.info('[QueueProcessor] ⏹️ Stopped queue processor');
        }
    }

    // Main processing loop
    async processQueue() {
        if (this.isProcessing) {
            return; // Already processing
        }

        try {
            this.isProcessing = true;

            // Check if we have at least 2 messages waiting
            const pendingCount = await this.getPendingCount();

            if (pendingCount === null || pendingCount < 2) {
                this.isProcessing = false;
                return; // Wait for more messages or table not ready
            }

            // Get unique contacts count
            const uniqueContacts = await this.getUniqueContactsCount();
            const contactsWithChat = await this.getContactsWithChatCount();
            const newContacts = uniqueContacts - contactsWithChat;

            // Get available senders
            const availableSenders = await this.getAvailableSenders();
            
            if (availableSenders.length === 0) {
                // Only log once per minute to avoid spam
                const now = Date.now();
                if (!this.lastNoSendersLog || (now - this.lastNoSendersLog) > 60000) {
                    logger.warn('[QueueProcessor] ⚠️ No available senders');
                    this.lastNoSendersLog = now;
                }
                this.isProcessing = false;
                return;
            }

            logger.info(`[QueueProcessor] 📤 Processing ${pendingCount} messages (${uniqueContacts} contacts: ${contactsWithChat} existing, ${newContacts} new) with ${availableSenders.length} senders`);

            // Sort contacts by priority (existing chats first)
            const contacts = await this.getContactsByPriority();

            if (contacts.length === 0) {
                this.isProcessing = false;
                return;
            }

            let sentCount = 0;
            let failedCount = 0;

            for (const contact of contacts) {
                // Find best sender for this contact
                const sender = await this.findBestSender(contact.recipient_phone, availableSenders);

                if (!sender) {
                    continue; // No sender available for this contact
                }

                // Send message
                const success = await this.sendMessage(sender, contact);

                if (success) {
                    sentCount++;
                    // Update sender availability
                    await this.updateSenderAfterSend(sender.phone);
                } else {
                    failedCount++;
                }
            }

            // Log batch completion
            if (sentCount > 0 || failedCount > 0) {
                logger.info(`[QueueProcessor] 📊 Batch: ${sentCount} sent, ${failedCount} failed`);
            }

            // Check if campaign is complete
            await this.checkCampaignCompletion();

        } catch (err) {
            logger.error(`[QueueProcessor] ❌ Process error: ${err.message}`);
        } finally {
            this.isProcessing = false;
        }
    }

    // Get count of pending messages
    async getPendingCount() {
        try {
            const result = await query(`
                SELECT COUNT(*) as count
                FROM message_queue
                WHERE status = 'pending'
            `);
            return parseInt(result.rows[0].count);
        } catch (err) {
            // If table doesn't exist yet, return null (will retry later)
            if (err.message && err.message.includes('does not exist')) {
                // Only log once per minute to avoid spam
                const now = Date.now();
                if (!this.lastTableErrorLog || (now - this.lastTableErrorLog) > 60000) {
                    logger.warn('[QueueProcessor] message_queue table not found, waiting for migration...');
                    this.lastTableErrorLog = now;
                }
                return null;
            }
            throw err;
        }
    }

    // Get unique contacts count in queue
    async getUniqueContactsCount() {
        try {
            const result = await query(`
                SELECT COUNT(DISTINCT recipient_phone) as count
                FROM message_queue
                WHERE status = 'pending'
            `);
            return parseInt(result.rows[0].count) || 0;
        } catch (err) {
            return 0;
        }
    }

    // Get contacts with existing chat count
    async getContactsWithChatCount() {
        try {
            const result = await query(`
                SELECT COUNT(DISTINCT q.recipient_phone) as count
                FROM message_queue q
                INNER JOIN chat_history ch ON ch.recipient_phone = q.recipient_phone
                WHERE q.status = 'pending'
            `);
            return parseInt(result.rows[0].count) || 0;
        } catch (err) {
            return 0;
        }
    }

    // Get contacts sorted by priority (existing chats first)
    async getContactsByPriority() {
        try {
            const result = await query(`
                SELECT 
                    q.id,
                    q.campaign_id,
                    q.recipient_phone,
                    q.recipient_name,
                    q.message_template,
                    q.priority,
                    CASE WHEN ch.sender_phone IS NOT NULL THEN true ELSE false END as has_existing_chat
                FROM message_queue q
                LEFT JOIN chat_history ch ON ch.recipient_phone = q.recipient_phone
                WHERE q.status = 'pending'
                ORDER BY 
                    has_existing_chat DESC,  -- Existing chats first
                    q.priority DESC,
                    q.created_at ASC
                LIMIT 10
            `);
            return result.rows;
        } catch (err) {
            // If table doesn't exist yet, return empty array
            if (err.message && err.message.includes('does not exist')) {
                logger.warn('[QueueProcessor] Tables not found, waiting for migration...');
                return [];
            }
            throw err;
        }
    }

    // Get available senders
    async getAvailableSenders() {
        logger.info(`[QueueProcessor] 🔍 getAvailableSenders() called`);

        // Get all healthy accounts from workers
        const allAccounts = [];
        let totalAccountsFromWorkers = 0;

        logger.info(`[QueueProcessor] 🔍 Checking ${this.workers.length} workers`);

        for (const worker of this.workers) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                if (response.data && response.data.accounts) {
                    const workerAccounts = response.data.accounts.filter(acc => acc.logged_in && acc.connected);
                    totalAccountsFromWorkers += response.data.accounts.length;

                    for (const acc of workerAccounts) {
                        allAccounts.push({
                            phone: acc.phone,
                            worker_url: worker.url,
                            ...acc
                        });
                    }
                }
            } catch (err) {
                // Silent fail - don't log every error
            }
        }

        if (allAccounts.length === 0) {
            return [];
        }

        // Filter by availability criteria
        const available = [];
        const now = new Date();

        for (const account of allAccounts) {
            try {
                // Get account stats from DB
                const dbAccount = await query(`
                    SELECT 
                        phone,
                        messages_last_minute,
                        last_message_at,
                        last_message_minute_reset,
                        blocked_at,
                        created_at,
                        total_messages_sent,
                        successful_messages
                    FROM accounts
                    WHERE phone = $1
                `, [account.phone]);

                if (dbAccount.rows.length === 0) {
                    // Account not in DB - create it automatically
                    try {
                        await query(`
                        INSERT INTO accounts (phone, created_at, messages_last_minute, last_message_minute_reset)
                        VALUES ($1, NOW(), 0, NOW())
                        ON CONFLICT (phone) DO NOTHING
                    `, [account.phone]);

                        // Retry getting account from DB
                        const retryAccount = await query(`
                        SELECT 
                            phone,
                            messages_last_minute,
                            last_message_at,
                            last_message_minute_reset,
                            blocked_at,
                            created_at,
                            total_messages_sent,
                            successful_messages
                        FROM accounts
                        WHERE phone = $1
                    `, [account.phone]);

                        if (retryAccount.rows.length === 0) {
                            continue;
                        }

                        // Use the newly created account
                        const acc = retryAccount.rows[0];

                        // Check if available (skip blocked check for new accounts)
                        let messagesLastMinute = acc.messages_last_minute || 0;
                        const lastReset = acc.last_message_minute_reset ? new Date(acc.last_message_minute_reset) : new Date(0);
                        const minutesSinceReset = (now - lastReset) / (1000 * 60);

                        if (minutesSinceReset >= 1) {
                            messagesLastMinute = 0;
                        }

                        if (messagesLastMinute >= 15) {
                            continue;
                        }

                        if (acc.last_message_at) {
                            const secondsSinceLastMessage = (now - new Date(acc.last_message_at)) / 1000;
                            if (secondsSinceLastMessage < 4) {
                                continue;
                            }
                        }

                        available.push({
                            phone: account.phone,
                            worker_url: account.worker_url,
                            messages_last_minute: messagesLastMinute,
                            last_message_at: acc.last_message_at,
                            created_at: acc.created_at,
                            total_messages_sent: acc.total_messages_sent || 0,
                            successful_messages: acc.successful_messages || 0
                        });
                        continue;
                    } catch (err) {
                        continue;
                    }
                } catch (err) {
                    continue;
                }

                try {

                    const acc = dbAccount.rows[0];

                    // 1. Not blocked
                    if (acc.blocked_at && new Date(acc.blocked_at) > new Date(Date.now() - 48 * 60 * 60 * 1000)) {
                        continue;
                    }

                    // 2. Check messages per minute (reset if needed)
                    let messagesLastMinute = acc.messages_last_minute || 0;
                    const lastReset = acc.last_message_minute_reset ? new Date(acc.last_message_minute_reset) : new Date(0);
                    const minutesSinceReset = (now - lastReset) / (1000 * 60);

                    if (minutesSinceReset >= 1) {
                        // Reset counter
                        await query(`
                    UPDATE accounts
                    SET messages_last_minute = 0,
                        last_message_minute_reset = NOW()
                    WHERE phone = $1
                `, [account.phone]);
                        messagesLastMinute = 0;
                    }

                    // 3. Not over 15 messages per minute
                    if (messagesLastMinute >= 15) {
                        continue;
                    }

                    // 4. Cooldown: at least 4 seconds since last message
                    if (acc.last_message_at) {
                        const secondsSinceLastMessage = (now - new Date(acc.last_message_at)) / 1000;
                        if (secondsSinceLastMessage < 4) {
                            continue;
                        }
                    }

                    available.push({
                        phone: account.phone,
                        worker_url: account.worker_url,
                        messages_last_minute: messagesLastMinute,
                        last_message_at: acc.last_message_at,
                        created_at: acc.created_at,
                        total_messages_sent: acc.total_messages_sent || 0,
                        successful_messages: acc.successful_messages || 0
                    });
                } catch (err) {
                    logger.error(`[QueueProcessor] ❌ Error processing account ${account.phone}: ${err.message}`);
                    logger.error(`[QueueProcessor] ❌ Error stack: ${err.stack}`);
                    continue;
                }
            }

        return available;
        }

    // Find best sender for recipient
    async findBestSender(recipientPhone, availableSenders) {
            // Check if any sender has existing chat with recipient
            const existingChats = await query(`
            SELECT sender_phone, last_message_at
            FROM chat_history
            WHERE recipient_phone = $1
            AND sender_phone = ANY($2::text[])
            ORDER BY last_message_at DESC
        `, [recipientPhone, availableSenders.map(s => s.phone)]);

            if (existingChats.rows.length > 0) {
                // Use sender with most recent chat
                const senderPhone = existingChats.rows[0].sender_phone;
                return availableSenders.find(s => s.phone === senderPhone);
            }

            // No existing chat - select by score
            const scoredSenders = availableSenders.map(sender => ({
                ...sender,
                score: this.calculateSenderScore(sender)
            }));

            scoredSenders.sort((a, b) => b.score - a.score);
            return scoredSenders[0];
        }

        // Calculate sender score
        calculateSenderScore(sender) {
            let score = 0;

            // 1. Account age (0-30 points)
            const accountAgeDays = sender.created_at
                ? (Date.now() - new Date(sender.created_at)) / (1000 * 60 * 60 * 24)
                : 0;
            score += Math.min(accountAgeDays, 30);

            // 2. Total messages sent (0-20 points)
            const totalSent = sender.total_messages_sent || 0;
            score += Math.min(totalSent / 100, 20);

            // 3. Time since last message
            if (sender.last_message_at) {
                const minutesSinceLastMessage = (Date.now() - new Date(sender.last_message_at)) / (1000 * 60);
                if (minutesSinceLastMessage < 1) {
                    score -= 10;
                } else if (minutesSinceLastMessage < 5) {
                    score -= 5;
                } else if (minutesSinceLastMessage > 30) {
                    score += 10;
                }
            }

            // 4. Today's load (negative)
            // This would need messages_today field - simplified for now
            score -= (sender.messages_last_minute || 0) * 2;

            // 5. Success rate (0-20 points)
            const totalSentForRate = sender.total_messages_sent || 1;
            const successRate = (sender.successful_messages || 0) / totalSentForRate;
            score += successRate * 20;

            return score;
        }

    // Send message - returns true on success, false on failure
    async sendMessage(sender, contact) {
            try {
                // Mark as processing
                await query(`
                UPDATE message_queue
                SET status = 'processing',
                    assigned_sender = $1,
                    processed_at = NOW()
                WHERE id = $2
            `, [sender.phone, contact.id]);

                // Send to worker
                const response = await axios.post(`${sender.worker_url}/send`, {
                    from_phone: sender.phone,
                    to_phone: contact.recipient_phone,
                    message: contact.message_template,
                    name: contact.recipient_name || ''
                }, { timeout: 30000 });

                if (response.data && response.data.success) {
                    // Mark as sent
                    await query(`
                    UPDATE message_queue
                    SET status = 'sent'
                    WHERE id = $1
                `, [contact.id]);

                    // Update chat history
                    await query(`
                    INSERT INTO chat_history (sender_phone, recipient_phone, last_message_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (sender_phone, recipient_phone)
                    DO UPDATE SET last_message_at = NOW()
                `, [sender.phone, contact.recipient_phone]);

                    logger.info(`[QueueProcessor] ✅ Sent from ${sender.phone} to ${contact.recipient_phone}`);
                    return true;
                } else {
                    throw new Error('Worker did not confirm success');
                }

            } catch (err) {
                const errorMsg = err.message || err.toString();

                // Check if account is blocked
                if (errorMsg.includes('blocked') || errorMsg.includes('banned') || errorMsg.includes('restricted')) {
                    logger.error(`[QueueProcessor] 🚨 BLOCKED: ${sender.phone} - Account blocked!`);

                    // Mark account as blocked in DB
                    await query(`
                    UPDATE accounts
                    SET blocked_at = NOW()
                    WHERE phone = $1
                `, [sender.phone]);
                }

                logger.error(`[QueueProcessor] ❌ Failed to send ${contact.id} (${contact.recipient_phone}) from ${sender.phone}: ${errorMsg}`);

                // Mark as failed
                await query(`
                UPDATE message_queue
                SET status = 'failed'
                WHERE id = $1
            `, [contact.id]);

                return false;
            }
        }

    // Update sender after sending
    async updateSenderAfterSend(senderPhone) {
            await query(`
            UPDATE accounts
            SET 
                messages_last_minute = messages_last_minute + 1,
                messages_today = messages_today + 1,
                total_messages_sent = COALESCE(total_messages_sent, 0) + 1,
                successful_messages = COALESCE(successful_messages, 0) + 1,
                last_message_at = NOW()
            WHERE phone = $1
        `, [senderPhone]);
        }

    // Check and log campaign completion
    async checkCampaignCompletion() {
            try {
                const campaigns = await query(`
                SELECT 
                    c.id,
                    c.total,
                    COUNT(CASE WHEN q.status = 'sent' THEN 1 END) as sent,
                    COUNT(CASE WHEN q.status = 'failed' THEN 1 END) as failed,
                    COUNT(CASE WHEN q.status IN ('pending', 'processing') THEN 1 END) as pending
                FROM campaigns c
                LEFT JOIN message_queue q ON q.campaign_id = c.id
                WHERE c.status = 'in_progress'
                GROUP BY c.id, c.total
                HAVING COUNT(CASE WHEN q.status IN ('pending', 'processing') THEN 1 END) = 0
            `);

                for (const campaign of campaigns.rows) {
                    // Mark campaign as completed
                    await query(`
                    UPDATE campaigns
                    SET status = 'completed', completed_at = NOW()
                    WHERE id = $1
                `, [campaign.id]);

                    logger.info(`[QueueProcessor] ✅ Campaign ${campaign.id} COMPLETED: ${campaign.sent}/${campaign.total} sent, ${campaign.failed} failed`);

                    // Send Telegram alert
                    const message = `✅ Campaign ${campaign.id} completed!\nSent: ${campaign.sent}/${campaign.total}\nFailed: ${campaign.failed}`;
                    try {
                        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w'}/sendMessage`, {
                            chat_id: process.env.TELEGRAM_CHAT_ID || '8014432452',
                            text: message
                        });
                    } catch (err) {
                        // Ignore telegram errors
                    }
                }
            } catch (err) {
                // Ignore errors in completion check
            }
        }
    }

module.exports = new QueueProcessor();

