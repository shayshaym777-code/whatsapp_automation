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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

module.exports = router;
