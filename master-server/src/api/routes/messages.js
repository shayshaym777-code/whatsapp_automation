const express = require('express');
const Joi = require('joi');
const antiBanEngine = require('../../services/AntiBanEngine');
const messageQueue = require('../../services/MessageQueue');
const loadBalancer = require('../../services/LoadBalancer');
const logger = require('../../utils/logger');

const router = express.Router();

const singleMessageSchema = Joi.object({
    fromPhone: Joi.string().required(),
    toPhone: Joi.string().required(),
    message: Joi.string().min(1).required()
});

const bulkSchema = Joi.object({
    messages: Joi.array().items(singleMessageSchema).min(1).required()
});

// Campaign schema - send to multiple recipients with automatic distribution
const campaignSchema = Joi.object({
    recipients: Joi.array().items(Joi.string()).min(1).required(),
    message: Joi.string().min(1).required()
});

// External bulk send schema (message + contacts format)
// Used by external systems integrating with this API
const externalBulkSchema = Joi.object({
    message: Joi.string().min(1).required(),
    contacts: Joi.array().items(
        Joi.object({
            phone: Joi.string().required(),
            name: Joi.string().optional().allow('')
        })
    ).min(1).required()
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Send single message
router.post('/send', async (req, res, next) => {
    try {
        const { error, value } = singleMessageSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { fromPhone, toPhone, message } = value;

        const canSend = antiBanEngine.canSend(fromPhone);
        if (!canSend.allowed) {
            return res.status(429).json({ error: 'Daily limit reached for this account' });
        }

        const delayMs = antiBanEngine.getDelayMs(fromPhone);
        await sleep(delayMs);

        const variedMessage = antiBanEngine.variateMessage(message);

        const queueId = await messageQueue.enqueue({
            type: 'single',
            fromPhone,
            toPhone,
            message: variedMessage
        });

        const workerResult = await loadBalancer.sendToWorker({
            fromPhone,
            toPhone,
            message: variedMessage
        });

        antiBanEngine.recordSend(fromPhone);

        return res.status(200).json({
            success: true,
            delayMs,
            queueId,
            worker: workerResult.workerId,
            workerCountry: workerResult.workerCountry,
            workerResponse: workerResult.response
        });
    } catch (err) {
        logger.error({ msg: 'send_error', error: err.message });
        return next(err);
    }
});

// Send bulk messages - supports TWO formats:
// Format 1 (internal): { messages: [{ fromPhone, toPhone, message }] }
// Format 2 (external): { message: "...", contacts: [{ phone, name }] }
router.post('/bulk-send', async (req, res, next) => {
    try {
        // ========================================
        // FORMAT 2: External format (message + contacts)
        // ========================================
        if (req.body.message && req.body.contacts) {
            const { error, value } = externalBulkSchema.validate(req.body);
            if (error) {
                return res.status(400).json({ error: error.message });
            }

            const { message, contacts } = value;

            logger.info(`Bulk send (external format): ${contacts.length} contacts`);

            // Replace {{name}} placeholders and create messages
            const messages = contacts.map(contact => {
                let personalizedMessage = message;
                if (contact.name) {
                    personalizedMessage = message.replace(/\{\{name\}\}/gi, contact.name);
                }
                return {
                    toPhone: contact.phone,
                    message: antiBanEngine.variateMessage(personalizedMessage)
                };
            });

            // Use Power Score distribution
            const result = await loadBalancer.sendCampaign(messages);

            logger.info(`Bulk send complete: ${result.results.length} sent, ${result.errors.length} failed`);

            return res.status(200).json({
                success: true,
                totalContacts: contacts.length,
                sent: result.results.length,
                failed: result.errors.length,
                results: result.results,
                errors: result.errors
            });
        }

        // ========================================
        // FORMAT 1: Internal format (messages array)
        // ========================================
        const { error, value } = bulkSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { messages } = value;

        logger.info(`Bulk send (internal format): ${messages.length} messages`);

        for (const msg of messages) {
            const canSend = antiBanEngine.canSend(msg.fromPhone);
            if (!canSend.allowed) {
                return res.status(429).json({
                    error: 'Daily limit reached for account',
                    account: msg.fromPhone
                });
            }
        }

        const results = [];

        for (const msg of messages) {
            const delayMs = antiBanEngine.getDelayMs(msg.fromPhone);
            await sleep(delayMs);

            const variedMessage = antiBanEngine.variateMessage(msg.message);

            const queueId = await messageQueue.enqueue({
                type: 'bulk',
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                message: variedMessage
            });

            const workerResult = await loadBalancer.sendToWorker({
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                message: variedMessage
            });

            antiBanEngine.recordSend(msg.fromPhone);

            results.push({
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                delayMs,
                queueId,
                worker: workerResult.workerId,
                workerCountry: workerResult.workerCountry,
                workerResponse: workerResult.response
            });
        }

        return res.status(200).json({
            success: true,
            count: results.length,
            results
        });
    } catch (err) {
        logger.error(`Bulk send error: ${err.message}`);
        return next(err);
    }
});

// Send campaign with automatic Power Score distribution
// This distributes messages across all available accounts based on their power
router.post('/campaign', async (req, res, next) => {
    try {
        const { error, value } = campaignSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { recipients, message } = value;

        // Create messages array for distribution
        const messages = recipients.map(toPhone => ({
            toPhone,
            message: antiBanEngine.variateMessage(message)
        }));

        logger.info({ msg: 'campaign_start', recipients: recipients.length });

        // Use Power Score distribution
        const result = await loadBalancer.sendCampaign(messages);

        logger.info({
            msg: 'campaign_complete',
            sent: result.results.length,
            errors: result.errors.length
        });

        return res.status(200).json({
            success: true,
            totalRecipients: recipients.length,
            sent: result.results.length,
            failed: result.errors.length,
            results: result.results,
            errors: result.errors
        });
    } catch (err) {
        logger.error({ msg: 'campaign_error', error: err.message });
        return next(err);
    }
});

// ============================================
// EXTERNAL API - For integration with other systems
// ============================================

// External bulk send - accepts message + contacts format
// POST /api/messages/bulk-send with { message: "...", contacts: [...] }
router.post('/external-send', async (req, res, next) => {
    try {
        const { error, value } = externalBulkSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { message, contacts } = value;

        logger.info(`External send request: ${contacts.length} contacts`);

        // Replace {{name}} placeholders with actual names
        const messages = contacts.map(contact => {
            let personalizedMessage = message;
            if (contact.name) {
                personalizedMessage = message.replace(/\{\{name\}\}/gi, contact.name);
            }
            return {
                toPhone: contact.phone,
                message: antiBanEngine.variateMessage(personalizedMessage)
            };
        });

        // Use Power Score distribution to send
        const result = await loadBalancer.sendCampaign(messages);

        logger.info(`External send complete: ${result.results.length} sent, ${result.errors.length} failed`);

        return res.status(200).json({
            success: true,
            totalContacts: contacts.length,
            sent: result.results.length,
            failed: result.errors.length,
            results: result.results,
            errors: result.errors
        });
    } catch (err) {
        logger.error(`External send error: ${err.message}`);
        return next(err);
    }
});

// Also support the same format on bulk-send endpoint for backwards compatibility
router.post('/bulk-send-v2', async (req, res, next) => {
    try {
        // Check if it's the new format (message + contacts)
        if (req.body.message && req.body.contacts) {
            const { error, value } = externalBulkSchema.validate(req.body);
            if (error) {
                return res.status(400).json({ error: error.message });
            }

            const { message, contacts } = value;

            logger.info(`Bulk send v2: ${contacts.length} contacts`);

            const messages = contacts.map(contact => {
                let personalizedMessage = message;
                if (contact.name) {
                    personalizedMessage = message.replace(/\{\{name\}\}/gi, contact.name);
                }
                return {
                    toPhone: contact.phone,
                    message: antiBanEngine.variateMessage(personalizedMessage)
                };
            });

            const result = await loadBalancer.sendCampaign(messages);

            return res.status(200).json({
                success: true,
                totalContacts: contacts.length,
                sent: result.results.length,
                failed: result.errors.length,
                results: result.results,
                errors: result.errors
            });
        }

        // Otherwise, use the old format (messages array)
        const { error, value } = bulkSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { messages } = value;

        for (const msg of messages) {
            const canSend = antiBanEngine.canSend(msg.fromPhone);
            if (!canSend.allowed) {
                return res.status(429).json({
                    error: 'Daily limit reached for account',
                    account: msg.fromPhone
                });
            }
        }

        const results = [];

        for (const msg of messages) {
            const delayMs = antiBanEngine.getDelayMs(msg.fromPhone);
            await sleep(delayMs);

            const variedMessage = antiBanEngine.variateMessage(msg.message);

            const queueId = await messageQueue.enqueue({
                type: 'bulk',
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                message: variedMessage
            });

            const workerResult = await loadBalancer.sendToWorker({
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                message: variedMessage
            });

            antiBanEngine.recordSend(msg.fromPhone);

            results.push({
                fromPhone: msg.fromPhone,
                toPhone: msg.toPhone,
                delayMs,
                queueId,
                worker: workerResult.workerId,
                workerCountry: workerResult.workerCountry,
                workerResponse: workerResult.response
            });
        }

        return res.status(200).json({
            success: true,
            count: results.length,
            results
        });
    } catch (err) {
        logger.error(`Bulk send v2 error: ${err.message}`);
        return next(err);
    }
});

// Preview campaign distribution without sending
router.post('/campaign/preview', async (req, res, next) => {
    try {
        const { recipients } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'recipients array is required' });
        }

        const preview = await loadBalancer.getDistributionPreview(recipients.length);

        return res.status(200).json({
            success: true,
            preview
        });
    } catch (err) {
        logger.error({ msg: 'campaign_preview_error', error: err.message });
        return next(err);
    }
});

// Get active accounts with their power scores
router.get('/accounts/power', async (req, res, next) => {
    try {
        const accounts = await loadBalancer.fetchActiveAccounts();

        const summary = accounts.map(acc => ({
            phone: acc.phone,
            stage: acc.stage,
            power: acc.power,
            maxDay: acc.maxDay,
            maxHour: acc.maxHour,
            todayCount: acc.todayCount,
            available: acc.maxDay - acc.todayCount
        }));

        const totalPower = summary.reduce((sum, acc) => sum + acc.power, 0);
        const totalAvailable = summary.reduce((sum, acc) => sum + acc.available, 0);

        return res.status(200).json({
            success: true,
            accounts: summary,
            totalAccounts: summary.length,
            totalPower,
            totalAvailable
        });
    } catch (err) {
        logger.error({ msg: 'power_accounts_error', error: err.message });
        return next(err);
    }
});

// ============================================
// CAPACITY CHECK - Check before sending
// ============================================

// GET /api/messages/capacity - Check how many messages can be sent right now
router.get('/capacity', async (req, res, next) => {
    try {
        const accounts = await loadBalancer.fetchActiveAccounts();

        if (accounts.length === 0) {
            return res.status(200).json({
                success: true,
                ready: false,
                reason: 'no_accounts',
                message: 'אין חשבונות מחוברים',
                totalAccounts: 0,
                availableAccounts: 0,
                totalCapacity: 0,
                accounts: []
            });
        }

        // Calculate capacity for each account
        const accountDetails = [];
        let totalCapacity = 0;
        let availableAccounts = 0;

        for (const acc of accounts) {
            const available = Math.max(0, acc.maxDay - acc.todayCount);

            accountDetails.push({
                phone: acc.phone,
                stage: acc.stage,
                maxDaily: acc.maxDay,
                sentToday: acc.todayCount,
                available: available,
                canSend: available > 0
            });

            if (available > 0) {
                availableAccounts++;
                totalCapacity += available;
            }
        }

        // Sort by available capacity (most available first)
        accountDetails.sort((a, b) => b.available - a.available);

        const ready = totalCapacity > 0;

        return res.status(200).json({
            success: true,
            ready: ready,
            reason: ready ? 'ok' : 'all_accounts_at_limit',
            message: ready
                ? `מוכן לשליחה! ${availableAccounts} חשבונות פנויים, קיבולת: ${totalCapacity} הודעות`
                : 'כל החשבונות הגיעו למגבלה היומית',
            totalAccounts: accounts.length,
            availableAccounts: availableAccounts,
            totalCapacity: totalCapacity,
            accounts: accountDetails
        });
    } catch (err) {
        logger.error(`Capacity check error: ${err.message}`);
        return res.status(200).json({
            success: false,
            ready: false,
            reason: 'error',
            message: `שגיאה בבדיקת קיבולת: ${err.message}`,
            totalAccounts: 0,
            availableAccounts: 0,
            totalCapacity: 0,
            accounts: []
        });
    }
});

// POST /api/messages/can-send - Check if a specific amount of messages can be sent
router.post('/can-send', async (req, res, next) => {
    try {
        const { count } = req.body;

        if (!count || count < 1) {
            return res.status(400).json({
                error: 'count is required and must be > 0'
            });
        }

        const accounts = await loadBalancer.fetchActiveAccounts();

        if (accounts.length === 0) {
            return res.status(200).json({
                success: true,
                canSend: false,
                requested: count,
                available: 0,
                shortage: count,
                message: `אין חשבונות מחוברים. צריך לחבר חשבונות לפני שליחה.`,
                accounts: []
            });
        }

        // Calculate total available capacity
        let totalAvailable = 0;
        const accountCapacity = [];

        for (const acc of accounts) {
            const available = Math.max(0, acc.maxDay - acc.todayCount);
            totalAvailable += available;

            if (available > 0) {
                accountCapacity.push({
                    phone: acc.phone,
                    stage: acc.stage,
                    available: available
                });
            }
        }

        const canSend = totalAvailable >= count;
        const shortage = Math.max(0, count - totalAvailable);

        return res.status(200).json({
            success: true,
            canSend: canSend,
            requested: count,
            available: totalAvailable,
            shortage: shortage,
            message: canSend
                ? `✅ אפשר לשלוח ${count} הודעות! (קיבולת פנויה: ${totalAvailable})`
                : `❌ לא ניתן לשלוח ${count} הודעות. קיבולת פנויה: ${totalAvailable}, חסר: ${shortage}`,
            accounts: accountCapacity
        });
    } catch (err) {
        logger.error(`Can-send check error: ${err.message}`);
        return next(err);
    }
});

module.exports = router;
