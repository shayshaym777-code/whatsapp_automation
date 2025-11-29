/**
 * Messages API Routes
 * 
 * Endpoints:
 * - POST /send - Send single message
 * - POST /bulk-send - Smart bulk send with distribution
 * - GET /status/:id - Get message status
 * - GET /campaign/:id - Get campaign status
 */

const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const antiBanEngine = require('../../services/AntiBanEngine');
const messageQueue = require('../../services/MessageQueue');
const queueProcessor = require('../../services/QueueProcessor');
const accountPool = require('../../services/AccountPool');
const loadBalancer = require('../../services/LoadBalancer');
const logger = require('../../utils/logger');

const router = express.Router();

// Validation schemas
const singleMessageSchema = Joi.object({
    fromPhone: Joi.string().required(),
    toPhone: Joi.string().required(),
    message: Joi.string().min(1).required(),
});

const contactSchema = Joi.object({
    phone: Joi.string().required(),
    name: Joi.string().optional(),
    variables: Joi.object().optional(),
});

const bulkSendSchema = Joi.object({
    message: Joi.string().min(1).required(),
    contacts: Joi.array().items(contactSchema).min(1).required(),
    fromAccounts: Joi.array().items(Joi.string()).optional(), // Specific accounts to use
    priority: Joi.string().valid('high', 'normal', 'low').default('normal'),
});

// Legacy bulk schema (for backwards compatibility)
const legacyBulkSchema = Joi.object({
    messages: Joi.array().items(singleMessageSchema).min(1).required(),
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Replace template variables in message
 * Supports {{name}}, {{phone}}, {{var_name}}
 */
function replaceVariables(template, contact) {
    let message = template;
    
    // Replace {{name}}
    if (contact.name) {
        message = message.replace(/\{\{name\}\}/gi, contact.name);
    }
    
    // Replace {{phone}}
    message = message.replace(/\{\{phone\}\}/gi, contact.phone);
    
    // Replace custom variables
    if (contact.variables) {
        for (const [key, value] of Object.entries(contact.variables)) {
            const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
            message = message.replace(regex, value);
        }
    }
    
    return message;
}

/**
 * POST /send - Send a single message
 */
router.post('/send', async (req, res, next) => {
    try {
        const { error, value } = singleMessageSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.message });
        }

        const { fromPhone, toPhone, message } = value;

        // Check if account can send
        const canSend = antiBanEngine.canSend(fromPhone);
        if (!canSend.allowed) {
            return res.status(429).json({ 
                error: 'Daily limit reached for this account',
                reason: canSend.reason,
            });
        }

        // Apply anti-ban delay
        const delayMs = antiBanEngine.getDelayMs(fromPhone);
        await sleep(delayMs);

        // Variate message
        const variedMessage = antiBanEngine.variateMessage(message);

        // Send to worker
        const workerResult = await loadBalancer.sendToWorker({
            fromPhone,
            toPhone,
            message: variedMessage,
        });

        // Record send
        antiBanEngine.recordSend(fromPhone);

        return res.status(200).json({
            success: true,
            messageId: uuidv4(),
            delayMs,
            worker: workerResult.workerId,
            workerCountry: workerResult.workerCountry,
            workerResponse: workerResult.response,
        });
    } catch (err) {
        logger.error({ msg: 'send_error', error: err.message });
        return next(err);
    }
});

/**
 * POST /bulk-send - Smart bulk send with automatic distribution
 * 
 * This endpoint:
 * 1. Groups contacts by country
 * 2. Gets free accounts for each country
 * 3. Distributes contacts evenly across accounts
 * 4. Queues overflow if not enough capacity
 * 5. Returns distribution summary
 */
router.post('/bulk-send', async (req, res, next) => {
    try {
        // Try new schema first, fall back to legacy
        let contacts = [];
        let messageTemplate = '';
        let priority = 'normal';
        
        const newSchemaResult = bulkSendSchema.validate(req.body);
        if (!newSchemaResult.error) {
            // New format: { message, contacts }
            contacts = newSchemaResult.value.contacts;
            messageTemplate = newSchemaResult.value.message;
            priority = newSchemaResult.value.priority;
        } else {
            // Try legacy format: { messages: [{fromPhone, toPhone, message}] }
            const legacyResult = legacyBulkSchema.validate(req.body);
            if (legacyResult.error) {
                return res.status(400).json({ 
                    error: 'Invalid request format',
                    details: newSchemaResult.error.message,
                });
            }
            
            // Convert legacy format
            for (const msg of legacyResult.value.messages) {
                contacts.push({ phone: msg.toPhone });
                if (!messageTemplate) messageTemplate = msg.message;
            }
        }

        const campaignId = uuidv4();
        logger.info({ msg: 'Bulk send started', campaignId, contactCount: contacts.length });

        // Refresh account pool
        await accountPool.refreshAccountsFromWorkers();

        // Get distribution plan
        const distribution = await accountPool.distributeContacts(contacts);
        
        // Process distributed messages
        const results = [];
        let sentCount = 0;
        let queuedCount = 0;

        // Send to distributed accounts
        for (const batch of distribution.distribution) {
            for (const contact of batch.contacts) {
                // Personalize message
                const personalizedMessage = replaceVariables(messageTemplate, contact);
                const variedMessage = antiBanEngine.variateMessage(personalizedMessage);
                
                // Check if account can send
                const canSend = await accountPool.canSend(batch.account);
                if (!canSend.allowed) {
                    // Queue for later
                    await queueProcessor.enqueue({
                        campaignId,
                        toPhone: contact.phone,
                        message: variedMessage,
                        contact,
                        priority,
                    });
                    queuedCount++;
                    continue;
                }

                try {
                    // Apply delay
                    const delayMs = antiBanEngine.getDelayMs(batch.account);
                    
                    // Send message (async, don't wait for all)
                    const sendPromise = (async () => {
                        await sleep(delayMs);
                        
                        const response = await loadBalancer.sendToWorker({
                            fromPhone: batch.account,
                            toPhone: contact.phone,
                            message: variedMessage,
                        });
                        
                        antiBanEngine.recordSend(batch.account);
                        await accountPool.recordSend(batch.account);
                        
                        return {
                            success: true,
                            toPhone: contact.phone,
                            fromPhone: batch.account,
                            worker: response.workerId,
                        };
                    })();

                    results.push(sendPromise);
                    sentCount++;
                } catch (err) {
                    // Queue failed message for retry
                    await queueProcessor.enqueue({
                        campaignId,
                        toPhone: contact.phone,
                        message: variedMessage,
                        contact,
                        priority,
                        error: err.message,
                    });
                    queuedCount++;
                }
            }
        }

        // Queue overflow contacts
        for (const overflow of distribution.overflow) {
            const personalizedMessage = replaceVariables(messageTemplate, overflow);
            await queueProcessor.enqueue({
                campaignId,
                toPhone: overflow.phone,
                message: antiBanEngine.variateMessage(personalizedMessage),
                contact: overflow,
                priority,
                reason: overflow.reason,
            });
            queuedCount++;
        }

        // Wait for immediate sends to complete (with timeout)
        const sendResults = await Promise.allSettled(
            results.map(p => Promise.race([p, sleep(30000).then(() => ({ timeout: true }))]))
        );

        // Calculate stats
        const successCount = sendResults.filter(r => r.status === 'fulfilled' && r.value?.success).length;
        const failedCount = sendResults.filter(r => r.status === 'rejected' || r.value?.timeout).length;

        // Get queue status
        const queueStats = await queueProcessor.getStats();
        const poolStatus = await accountPool.getPoolStatus();

        // Estimate duration
        const avgTimePerMessage = 5; // seconds
        const estimatedSeconds = queuedCount * avgTimePerMessage / Math.max(poolStatus.free, 1);
        const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

        return res.status(200).json({
            success: true,
            campaignId,
            summary: {
                totalContacts: contacts.length,
                sent: successCount,
                failed: failedCount,
                queued: queuedCount,
                accountsUsed: distribution.distribution.length,
                accountsFree: poolStatus.free,
                distribution: distribution.summary.byCountry,
            },
            estimatedDuration: queuedCount > 0 ? `${estimatedMinutes} minutes` : 'completed',
            queuePosition: queueStats.pending,
            queue: queueStats,
        });
    } catch (err) {
        logger.error({ msg: 'bulk_send_error', error: err.message, stack: err.stack });
        return next(err);
    }
});

/**
 * GET /status/:id - Get message status
 */
router.get('/status/:id', async (req, res) => {
    const { id } = req.params;
    
    // Check in queue processor
    const stats = await queueProcessor.getStats();
    
    return res.json({
        messageId: id,
        queue: stats,
    });
});

/**
 * GET /campaign/:id - Get campaign status
 */
router.get('/campaign/:id', async (req, res) => {
    const { id } = req.params;
    
    const queueStatus = await queueProcessor.getStatus();
    
    return res.json({
        campaignId: id,
        status: queueStatus,
    });
});

module.exports = router;
