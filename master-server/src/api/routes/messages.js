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

// Send bulk messages (with explicit fromPhone for each)
router.post('/bulk-send', async (req, res, next) => {
    try {
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
        logger.error({ msg: 'bulk_send_error', error: err.message });
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

module.exports = router;
