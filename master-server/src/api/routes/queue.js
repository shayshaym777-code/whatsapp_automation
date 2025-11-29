/**
 * Queue API Routes
 * 
 * Endpoints:
 * - GET /status - Get queue status
 * - GET /stats - Get queue statistics
 * - POST /start - Start queue processor
 * - POST /stop - Stop queue processor
 * - POST /clear - Clear all queues (admin)
 */

const express = require('express');
const queueProcessor = require('../../services/QueueProcessor');
const messageQueue = require('../../services/MessageQueue');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * GET /status - Get detailed queue status
 */
router.get('/status', async (req, res) => {
    try {
        const status = await queueProcessor.getStatus();
        return res.json({
            success: true,
            ...status,
        });
    } catch (err) {
        logger.error({ msg: 'queue_status_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /stats - Get queue statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await queueProcessor.getStats();
        const messageQueueStats = await messageQueue.getStats();
        
        return res.json({
            success: true,
            processor: stats,
            messageQueue: messageQueueStats,
        });
    } catch (err) {
        logger.error({ msg: 'queue_stats_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /pending - Get pending messages
 */
router.get('/pending', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const pending = await queueProcessor.getPendingMessages(limit);
        
        return res.json({
            success: true,
            count: pending.length,
            messages: pending,
        });
    } catch (err) {
        logger.error({ msg: 'queue_pending_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /start - Start queue processor
 */
router.post('/start', async (req, res) => {
    try {
        queueProcessor.start();
        return res.json({
            success: true,
            message: 'Queue processor started',
        });
    } catch (err) {
        logger.error({ msg: 'queue_start_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /stop - Stop queue processor
 */
router.post('/stop', async (req, res) => {
    try {
        queueProcessor.stop();
        return res.json({
            success: true,
            message: 'Queue processor stopped',
        });
    } catch (err) {
        logger.error({ msg: 'queue_stop_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /clear - Clear all queues (admin only)
 */
router.post('/clear', async (req, res) => {
    try {
        const { confirm } = req.body;
        if (confirm !== 'yes') {
            return res.status(400).json({ 
                error: 'Confirmation required',
                message: 'Send { "confirm": "yes" } to clear all queues',
            });
        }
        
        await queueProcessor.clearAll();
        await messageQueue.clear();
        
        return res.json({
            success: true,
            message: 'All queues cleared',
        });
    } catch (err) {
        logger.error({ msg: 'queue_clear_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;

