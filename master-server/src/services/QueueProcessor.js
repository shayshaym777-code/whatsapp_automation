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
        // Dynamic workers: Support 1-100 workers
        // Can be configured via WORKER_COUNT env var or auto-detect from WORKER_N_URL
        this.workers = this.loadWorkers();
        // Reload workers every 5 minutes to pick up new workers
        this.lastWorkersReload = Date.now();
        this.WORKERS_RELOAD_INTERVAL = 5 * 60 * 1000; // 5 minutes
        // Track messages sent per worker for equal distribution
        this.workerMessageCounts = {};
        // Track which recipients already have chats (fast lookup)
        this.recipientsWithChats = new Set();
        // Reset distribution counters every hour for fair distribution
        this.lastDistributionReset = Date.now();
        this.DISTRIBUTION_RESET_INTERVAL = 60 * 60 * 1000; // 1 hour
    }

    // Load workers dynamically (support 1-100 workers)
    loadWorkers() {
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

        logger.info(`[QueueProcessor] Loaded ${workers.length} workers: ${workers.map(w => w.id).join(', ')}`);
        return workers;
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

        // Reset distribution counters every hour for fair distribution
        const now = Date.now();
        if (now - this.lastDistributionReset > this.DISTRIBUTION_RESET_INTERVAL) {
            logger.info(`[QueueProcessor] 🔄 Resetting worker distribution counters for equal distribution`);
            this.workerMessageCounts = {};
            this.lastDistributionReset = now;
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
            const MESSAGES_PER_MINUTE_PER_SENDER = 15; // 15 messages per minute per device
            const totalCapacity = availableSenders.length * MESSAGES_PER_MINUTE_PER_SENDER;
            // Count senders by worker for load balancing info
            const sendersByWorker = {};
            for (const sender of availableSenders) {
                const workerId = sender.worker_id || 'unknown';
                sendersByWorker[workerId] = (sendersByWorker[workerId] || 0) + 1;
            }
            const workerDistribution = Object.entries(sendersByWorker)
                .map(([id, count]) => `${id}:${count}`)
                .join(', ');

            // Show equal distribution status
            const distributionStatus = Object.entries(this.workerMessageCounts)
                .map(([id, count]) => `${id}:${count}`)
                .join(', ') || 'none';

            logger.info(`[QueueProcessor] 📤 Processing ${pendingCount} messages (${uniqueContacts} contacts: ${contactsWithChat} existing, ${newContacts} new) with ${availableSenders.length} senders (capacity: ${totalCapacity} msg/min = ${availableSenders.length} × ${MESSAGES_PER_MINUTE_PER_SENDER}) | Workers: ${workerDistribution} | Distribution: ${distributionStatus}`);

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
                const maxImmediateRetries = 3; // Try up to 3 times immediately before moving on

                // Try to send with immediate retries
                while (!messageSent && attempts < maxImmediateRetries) {
                    attempts++;

                    // Find best sender for this contact
                    const sender = await this.findBestSender(contact.recipient_phone, availableSenders);

                    if (!sender) {
                        // No sender available - will retry in next batch
                        logger.info(`[QueueProcessor] ⏸️ No sender available for ${contact.recipient_phone} - will retry in next batch`);
                        break;
                    }

                    // Send message
                    const success = await this.sendMessage(sender, contact);

                    if (success) {
                        sentCount++;
                        messageSent = true;
                        // Update sender availability
                        await this.updateSenderAfterSend(sender.phone);
                        logger.info(`[QueueProcessor] ✅ Successfully sent to ${contact.recipient_phone} (attempt ${attempts})`);
                    } else {
                        // Wait a moment for DB update to complete
                        await new Promise(resolve => setTimeout(resolve, 100));

                        // Check message status after failure
                        const checkStatus = await query(`
                            SELECT status, retry_count FROM message_queue WHERE id = $1
                        `, [contact.id]);

                        if (!checkStatus.rows || checkStatus.rows.length === 0) {
                            // Message was removed - stop retrying
                            break;
                        }

                        const status = checkStatus.rows[0]?.status;
                        const retryCount = checkStatus.rows[0]?.retry_count || 0;

                        if (status === 'failed') {
                            // Message failed permanently (blocked or max retries)
                            failedCount++;
                            logger.error(`[QueueProcessor] ❌ Permanent failure for ${contact.recipient_phone} (retry count: ${retryCount})`);
                            break;
                        } else if (status === 'pending' && attempts < maxImmediateRetries) {
                            // Message was reset to pending - try again immediately
                            logger.info(`[QueueProcessor] 🔄 Immediate retry ${attempts}/${maxImmediateRetries} for ${contact.recipient_phone} (retry_count: ${retryCount})`);
                            // Small delay before retry (1-2 seconds)
                            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
                            // Refresh contact data (retry_count might have changed)
                            const refreshedContact = await query(`
                                SELECT id, recipient_phone, recipient_name, message_template, priority, campaign_id
                                FROM message_queue WHERE id = $1 AND status = 'pending'
                            `, [contact.id]);
                            if (refreshedContact.rows.length > 0) {
                                Object.assign(contact, refreshedContact.rows[0]);
                            } else {
                                // Contact was removed or status changed - stop retrying
                                break;
                            }
                        } else if (status === 'pending' && attempts >= maxImmediateRetries) {
                            // Max immediate retries reached - will retry in next batch
                            logger.info(`[QueueProcessor] ⏭️ Max immediate retries (${attempts}) reached for ${contact.recipient_phone} - will retry in next batch`);
                            break;
                        } else {
                            // Unknown status - log and continue
                            logger.warn(`[QueueProcessor] ⚠️ Unknown status '${status}' for ${contact.recipient_phone} - will retry in next batch`);
                            break;
                        }
                    }
                }

                // If still not sent after immediate retries, check final status
                if (!messageSent) {
                    const finalStatus = await query(`
                        SELECT status FROM message_queue WHERE id = $1
                    `, [contact.id]);

                    const status = finalStatus.rows[0]?.status;
                    if (status === 'pending') {
                        retryCount++;
                    } else if (status === 'failed') {
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
    // Strategy: Use ALL workers, auto-reconnect if worker disconnects
    async getAvailableSenders() {
        // Reload workers periodically to pick up new ones
        const currentTime = Date.now();
        if (currentTime - this.lastWorkersReload > this.WORKERS_RELOAD_INTERVAL) {
            const newWorkers = this.loadWorkers();
            if (newWorkers.length !== this.workers.length) {
                logger.info(`[QueueProcessor] Reloaded workers: ${this.workers.length} → ${newWorkers.length}`);
                this.workers = newWorkers;
            }
            this.lastWorkersReload = currentTime;
        }

        // Get all healthy accounts from workers
        const allAccounts = [];
        const workerStatus = {}; // Track which workers are healthy
        const failedWorkers = []; // Track workers that failed for reconnect

        for (const worker of this.workers) {
            try {
                const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                if (response.data && response.data.accounts) {
                    const workerAccounts = response.data.accounts.filter(acc => acc.logged_in && acc.connected);
                    workerStatus[worker.id] = { healthy: true, accountCount: workerAccounts.length };

                    for (const acc of workerAccounts) {
                        allAccounts.push({
                            phone: acc.phone,
                            worker_url: worker.url,
                            worker_id: worker.id,
                            ...acc
                        });
                    }
                } else {
                    workerStatus[worker.id] = { healthy: false, accountCount: 0 };
                    failedWorkers.push(worker);
                }
            } catch (err) {
                // Worker is down or not responding - try to reconnect
                workerStatus[worker.id] = { healthy: false, accountCount: 0 };
                failedWorkers.push(worker);
                logger.warn(`[QueueProcessor] ⚠️ Worker ${worker.id} is not responding: ${err.message}`);
            }
        }

        // Auto-reconnect failed workers
        if (failedWorkers.length > 0) {
            logger.info(`[QueueProcessor] 🔄 Attempting to reconnect ${failedWorkers.length} failed worker(s)...`);
            for (const worker of failedWorkers) {
                try {
                    // Try to ping worker health endpoint first
                    await axios.get(`${worker.url}/health`, { timeout: 3000 });
                    logger.info(`[QueueProcessor] ✅ Worker ${worker.id} is back online`);
                } catch (err) {
                    // Worker still down - try to trigger reconnect for all accounts
                    try {
                        const response = await axios.get(`${worker.url}/accounts`, { timeout: 3000 });
                        if (response.data && response.data.accounts) {
                            // Try to reconnect disconnected accounts
                            const disconnectedAccounts = response.data.accounts.filter(
                                acc => acc.logged_in && !acc.connected
                            );
                            for (const acc of disconnectedAccounts) {
                                try {
                                    await axios.post(
                                        `${worker.url}/accounts/${acc.phone}/reconnect`,
                                        {},
                                        { timeout: 5000 }
                                    );
                                    logger.info(`[QueueProcessor] 🔄 Reconnect request sent for ${acc.phone} on ${worker.id}`);
                                } catch (reconnectErr) {
                                    // Ignore reconnect errors - will retry next cycle
                                }
                            }
                        }
                    } catch (reconnectErr) {
                        // Worker completely down - will retry next cycle
                        logger.debug(`[QueueProcessor] Worker ${worker.id} reconnect attempt failed: ${reconnectErr.message}`);
                    }
                }
            }
        }

        // Log worker status - use ALL available workers
        const healthyWorkers = Object.values(workerStatus).filter(w => w.healthy).length;
        const totalAccounts = allAccounts.length;

        if (healthyWorkers < this.workers.length) {
            logger.warn(`[QueueProcessor] ⚠️ Only ${healthyWorkers}/${this.workers.length} workers are healthy | Using ${totalAccounts} accounts from all available workers`);
        } else {
            logger.info(`[QueueProcessor] ✅ All ${this.workers.length} workers are healthy | Using ${totalAccounts} accounts from all workers`);
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
                    // Reset counter after 1 minute (allows 15 messages per minute per device)
                    await query(`
                        UPDATE accounts
                        SET messages_last_minute = 0,
                            last_message_minute_reset = NOW()
                        WHERE phone = $1
                    `, [account.phone]);
                    messagesLastMinute = 0;
                }

                // 3. Not over 15 messages per minute per device (strict limit)
                const MESSAGES_PER_MINUTE_LIMIT = 15;
                if (messagesLastMinute >= MESSAGES_PER_MINUTE_LIMIT) {
                    // Device has reached 15 messages/minute limit - skip until reset
                    continue;
                }

                // 4. Cooldown removed - worker already handles delays (3-7 sec + typing 1-3 sec)
                // The worker adds sufficient delays, so no need for additional cooldown here

                available.push({
                    phone: account.phone,
                    worker_url: account.worker_url,
                    worker_id: account.worker_id || 'unknown',
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
    // Strategy: 
    // 1. Fast check - if recipient already has chat, use that sender
    // 2. Equal distribution - divide remaining recipients equally across workers
    async findBestSender(recipientPhone, availableSenders) {
        // Fast check: if recipient already has chat, use that sender
        const existingChats = await query(`
            SELECT sender_phone, last_message_at
            FROM chat_history
            WHERE recipient_phone = $1
            AND sender_phone = ANY($2::text[])
            ORDER BY last_message_at DESC
            LIMIT 1
        `, [recipientPhone, availableSenders.map(s => s.phone)]);

        if (existingChats.rows.length > 0) {
            // Use sender with most recent chat
            const senderPhone = existingChats.rows[0].sender_phone;
            const sender = availableSenders.find(s => s.phone === senderPhone);
            if (sender) {
                // Track which worker sent this
                const workerId = sender.worker_id || 'unknown';
                this.workerMessageCounts[workerId] = (this.workerMessageCounts[workerId] || 0) + 1;
                return sender;
            }
        }

        // No existing chat - distribute evenly across workers
        // Group senders by worker_id
        const sendersByWorker = {};
        for (const sender of availableSenders) {
            const workerId = sender.worker_id || 'unknown';
            if (!sendersByWorker[workerId]) {
                sendersByWorker[workerId] = [];
            }
            sendersByWorker[workerId].push(sender);
        }

        // Calculate how many messages each worker has sent (for equal distribution)
        const workerMessageCounts = {};
        for (const workerId in sendersByWorker) {
            workerMessageCounts[workerId] = this.workerMessageCounts[workerId] || 0;
        }

        // Find worker with least messages sent (for equal distribution)
        const workerIds = Object.keys(sendersByWorker);
        if (workerIds.length === 0) {
            return null;
        }

        // Sort workers by message count (least first)
        workerIds.sort((a, b) => {
            const countA = workerMessageCounts[a] || 0;
            const countB = workerMessageCounts[b] || 0;
            return countA - countB;
        });

        // Select worker with least messages sent
        const selectedWorkerId = workerIds[0];
        const workerSenders = sendersByWorker[selectedWorkerId];

        // From that worker, select best sender by score
        const scoredSenders = workerSenders.map(sender => ({
            ...sender,
            score: this.calculateSenderScore(sender)
        }));

        scoredSenders.sort((a, b) => b.score - a.score);
        const selectedSender = scoredSenders[0];

        // Update counter for equal distribution
        this.workerMessageCounts[selectedWorkerId] = (this.workerMessageCounts[selectedWorkerId] || 0) + 1;

        return selectedSender;
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
            const isConnectionError = errorMsg.includes('ECONNREFUSED') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('ENOTFOUND') ||
                err.code === 'ECONNREFUSED' ||
                err.code === 'ETIMEDOUT';

            // If worker connection failed, try to reconnect
            if (isConnectionError) {
                logger.warn(`[QueueProcessor] 🔄 Worker ${sender.worker_id} connection failed, attempting reconnect...`);
                try {
                    // Try to reconnect the account
                    await axios.post(
                        `${sender.worker_url}/accounts/${sender.phone}/reconnect`,
                        {},
                        { timeout: 5000 }
                    );
                    logger.info(`[QueueProcessor] ✅ Reconnect request sent for ${sender.phone} on ${sender.worker_id}`);
                } catch (reconnectErr) {
                    logger.warn(`[QueueProcessor] ⚠️ Reconnect attempt failed for ${sender.phone}: ${reconnectErr.message}`);
                }
            }

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
                let currentRetryCount = 0;
                let newRetryCount = 1;

                try {
                    const retryResult = await query(`
                        SELECT retry_count FROM message_queue WHERE id = $1
                    `, [contact.id]);
                    currentRetryCount = retryResult.rows[0]?.retry_count || 0;
                    newRetryCount = currentRetryCount + 1;
                } catch (retryErr) {
                    // If retry_count column doesn't exist, use 0 as default
                    if (retryErr.message && retryErr.message.includes('retry_count')) {
                        logger.warn(`[QueueProcessor] ⚠️ retry_count column not found, using default 0`);
                        currentRetryCount = 0;
                        newRetryCount = 1;
                    } else {
                        throw retryErr;
                    }
                }

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
                    logger.info(`[QueueProcessor] 🔄 Retry ${newRetryCount}/3 for ${contact.recipient_phone} - reset to pending for immediate retry`);
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
        // Update counters: messages_last_minute is reset every minute (max 15 per minute per device)
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
        const MESSAGES_PER_MINUTE_LIMIT = 15;
        if (currentCount >= MESSAGES_PER_MINUTE_LIMIT - 2) {
            logger.warn(`[QueueProcessor] ⚠️ ${senderPhone} approaching limit: ${currentCount}/${MESSAGES_PER_MINUTE_LIMIT} messages this minute`);
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

