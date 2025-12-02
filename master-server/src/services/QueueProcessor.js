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

            // Calculate total sending capacity
            const totalCapacity = availableSenders.length * 15; // 15 messages per minute per sender
            logger.info(`[QueueProcessor] 📤 Processing ${pendingCount} messages (${uniqueContacts} contacts: ${contactsWithChat} existing, ${newContacts} new) with ${availableSenders.length} senders (capacity: ${totalCapacity} msg/min)`);

            // Sort contacts by priority (existing chats first)
            // Take up to availableSenders.length * 2 contacts to maximize parallel sending
            const batchSize = Math.min(availableSenders.length * 2, 50); // Max 50 per batch
            const contacts = await this.getContactsByPriority(batchSize);

            if (contacts.length === 0) {
                this.isProcessing = false;
                return;
            }

            let sentCount = 0;
            let failedCount = 0;
            let retryCount = 0;

            for (const contact of contacts) {
                let messageSent = false;
                let attempts = 0;
                const maxImmediateRetries = 2; // Try up to 2 times immediately

                // Try to send with immediate retries
                while (!messageSent && attempts < maxImmediateRetries) {
                    attempts++;

                    // Find best sender for this contact
                    const sender = await this.findBestSender(contact.recipient_phone, availableSenders);

                    if (!sender) {
                        break; // No sender available - will retry in next batch
                    }

                    // Send message
                    const success = await this.sendMessage(sender, contact);

                    if (success) {
                        sentCount++;
                        messageSent = true;
                        // Update sender availability
                        await this.updateSenderAfterSend(sender.phone);
                    } else {
                        // Check if message was reset to pending for retry
                        const checkStatus = await query(`
                            SELECT status, retry_count FROM message_queue WHERE id = $1
                        `, [contact.id]);

                        const status = checkStatus.rows[0]?.status;

                        if (status === 'pending' && attempts < maxImmediateRetries) {
                            // Message was reset to pending - try again immediately
                            logger.info(`[QueueProcessor] 🔄 Immediate retry ${attempts}/${maxImmediateRetries} for ${contact.recipient_phone}`);
                            // Small delay before retry (1-2 seconds)
                            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
                            // Refresh contact data (retry_count might have changed)
                            const refreshedContact = await query(`
                                SELECT id, recipient_phone, recipient_name, message_template, priority, campaign_id
                                FROM message_queue WHERE id = $1
                            `, [contact.id]);
                            if (refreshedContact.rows.length > 0) {
                                Object.assign(contact, refreshedContact.rows[0]);
                            }
                        } else if (status === 'failed') {
                            // Message failed permanently
                            failedCount++;
                            break;
                        } else if (status === 'pending') {
                            // Will retry in next batch
                            retryCount++;
                            break;
                        }
                    }
                }

                // If still not sent after immediate retries, it will be retried in next batch
                if (!messageSent && attempts >= maxImmediateRetries) {
                    const checkStatus = await query(`
                        SELECT status FROM message_queue WHERE id = $1
                    `, [contact.id]);

                    if (checkStatus.rows[0]?.status === 'pending') {
                        retryCount++;
                    } else if (checkStatus.rows[0]?.status === 'failed') {
                        failedCount++;
                    }
                }
            }

            // Log batch completion
            if (sentCount > 0 || failedCount > 0 || retryCount > 0) {
                let logMsg = `[QueueProcessor] 📊 Batch: ${sentCount} sent`;
                if (failedCount > 0) logMsg += `, ${failedCount} failed`;
                if (retryCount > 0) logMsg += `, ${retryCount} will retry`;
                logger.info(logMsg);
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
    async getContactsByPriority(limit = 50) {
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
                LIMIT $1
            `, [limit]);
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
        // Get all healthy accounts from workers
        const allAccounts = [];

        for (const worker of this.workers) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                if (response.data && response.data.accounts) {
                    const workerAccounts = response.data.accounts.filter(acc => acc.logged_in && acc.connected);

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
                let dbAccount = await query(`
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

                // Account not in DB - create it automatically
                if (dbAccount.rows.length === 0) {
                    try {
                        await query(`
                            INSERT INTO accounts (phone, created_at, messages_last_minute, last_message_minute_reset)
                            VALUES ($1, NOW(), 0, NOW())
                            ON CONFLICT (phone) DO NOTHING
                        `, [account.phone]);

                        // Retry getting account from DB
                        dbAccount = await query(`
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
                            continue; // Failed to create or fetch
                        }
                    } catch (err) {
                        continue; // Skip this account if creation fails
                    }
                }

                // Now process the account (either existing or newly created)
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
                    // Reset counter after 1 minute (allows 15 messages per minute per sender)
                    await query(`
                        UPDATE accounts
                        SET messages_last_minute = 0,
                            last_message_minute_reset = NOW()
                        WHERE phone = $1
                    `, [account.phone]);
                    messagesLastMinute = 0;
                }

                // 3. Not over 15 messages per minute (strict limit)
                if (messagesLastMinute >= 15) {
                    // Sender has reached 15 messages/minute limit - skip until reset
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

                // Log sent number in green (prominent)
                logger.info(`[QueueProcessor] 🟢 Sent to: ${contact.recipient_phone}`);
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

            // Check if this is a permanent failure (blocked account) or temporary
            const isPermanentFailure = errorMsg.includes('blocked') || errorMsg.includes('banned') || errorMsg.includes('restricted');

            if (isPermanentFailure) {
                // Permanent failure - mark as failed
                await query(`
                    UPDATE message_queue
                    SET status = 'failed',
                        processed_at = NOW()
                    WHERE id = $1
                `, [contact.id]);
            } else {
                // Temporary failure - reset to pending for retry (max 3 retries)
                const retryResult = await query(`
                    SELECT retry_count FROM message_queue WHERE id = $1
                `, [contact.id]);

                const currentRetryCount = retryResult.rows[0]?.retry_count || 0;
                const newRetryCount = currentRetryCount + 1;

                if (newRetryCount < 3) {
                    // Retry - reset to pending (will be retried in next batch)
                    await query(`
                        UPDATE message_queue
                        SET status = 'pending',
                            retry_count = $1,
                            assigned_sender = NULL,
                            processed_at = NULL
                        WHERE id = $2
                    `, [newRetryCount, contact.id]);
                    logger.info(`[QueueProcessor] 🔄 Retry ${newRetryCount}/3 for ${contact.recipient_phone} - will retry in next batch`);
                } else {
                    // Max retries reached - mark as failed permanently
                    await query(`
                        UPDATE message_queue
                        SET status = 'failed',
                            retry_count = $1,
                            processed_at = NOW()
                        WHERE id = $2
                    `, [newRetryCount, contact.id]);
                    logger.error(`[QueueProcessor] ❌ Max retries (${newRetryCount}) reached for ${contact.recipient_phone} - marking as failed`);
                }
            }

            return false;
        }
    }

    // Update sender after sending
    async updateSenderAfterSend(senderPhone) {
        // Update counters: messages_last_minute is reset every minute (max 15 per minute per sender)
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
        
        // Log if approaching limit (for monitoring)
        const accountStats = await query(`
            SELECT messages_last_minute FROM accounts WHERE phone = $1
        `, [senderPhone]);
        
        const currentCount = accountStats.rows[0]?.messages_last_minute || 0;
        if (currentCount >= 14) {
            logger.warn(`[QueueProcessor] ⚠️ ${senderPhone} approaching limit: ${currentCount}/15 messages this minute`);
        }
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
                // Get list of failed phone numbers
                const failedPhones = await query(`
                    SELECT DISTINCT recipient_phone, recipient_name
                    FROM message_queue
                    WHERE campaign_id = $1 AND status = 'failed'
                    ORDER BY recipient_phone
                `, [campaign.id]);

                // Mark campaign as completed
                await query(`
                    UPDATE campaigns
                    SET status = 'completed', completed_at = NOW()
                    WHERE id = $1
                `, [campaign.id]);

                // Log detailed completion summary
                const successRate = campaign.total > 0 ? ((campaign.sent / campaign.total) * 100).toFixed(1) : 0;
                logger.info(`[QueueProcessor] ✅ Campaign ${campaign.id} COMPLETED:`);
                logger.info(`[QueueProcessor] 📊 Summary: ${campaign.sent}/${campaign.total} sent (${successRate}%), ${campaign.failed} failed`);

                // Log failed numbers if any
                if (failedPhones.rows.length > 0) {
                    logger.error(`[QueueProcessor] ❌ Failed numbers (${failedPhones.rows.length}):`);
                    const failedList = failedPhones.rows.map((row, idx) => {
                        const name = row.recipient_name ? ` (${row.recipient_name})` : '';
                        return `${idx + 1}. ${row.recipient_phone}${name}`;
                    }).join('\n');
                    logger.error(`[QueueProcessor] ${failedList}`);
                }

                // Send Telegram alert
                let telegramMessage = `✅ Campaign ${campaign.id} completed!\nSent: ${campaign.sent}/${campaign.total} (${successRate}%)\nFailed: ${campaign.failed}`;

                if (failedPhones.rows.length > 0 && failedPhones.rows.length <= 20) {
                    // Include failed numbers if not too many
                    const failedNumbers = failedPhones.rows.map(r => r.recipient_phone).join(', ');
                    telegramMessage += `\n\n❌ Failed:\n${failedNumbers}`;
                } else if (failedPhones.rows.length > 20) {
                    telegramMessage += `\n\n❌ ${failedPhones.rows.length} numbers failed (too many to list)`;
                }

                try {
                    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || '8357127187:AAGdBAIC-4Kmu1JA5KmaPxJKhQc-htlvF9w'}/sendMessage`, {
                        chat_id: process.env.TELEGRAM_CHAT_ID || '8014432452',
                        text: telegramMessage
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

