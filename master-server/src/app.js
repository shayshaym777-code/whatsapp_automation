const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const dotenv = require('dotenv');

const logger = require('./utils/logger');
const messagesRouter = require('./api/routes/messages');
const accountsRouter = require('./api/routes/accounts');
const loadBalancer = require('./services/LoadBalancer');
const { query } = require('./config/database');

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Workers endpoint
app.get('/api/workers', (req, res) => {
    res.json(loadBalancer.getWorkers());
});

// API Routes
app.use('/api/messages', messagesRouter);
app.use('/api/accounts', accountsRouter);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    if (err.stack) {
        logger.debug(err.stack);
    }
    res.status(500).json({ error: 'Internal Server Error' });
});

// ============================================
// SCHEDULED TASKS
// ============================================

// Reset daily message counts at midnight (every day at 00:00)
function scheduleDailyResetTask() {
    const now = new Date();
    const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // tomorrow
        0, 0, 0 // midnight
    );
    const msToMidnight = night.getTime() - now.getTime();

    // Schedule first run at midnight
    setTimeout(() => {
        resetDailyCounts();
        // Then run every 24 hours
        setInterval(resetDailyCounts, 24 * 60 * 60 * 1000);
    }, msToMidnight);

    logger.info(`Daily reset scheduled for ${night.toISOString()}`);
}

async function resetDailyCounts() {
    try {
        const result = await query(
            `UPDATE warmup_accounts SET messages_sent_today = 0 RETURNING phone_number`
        );
        logger.info(`Daily counts reset for ${result.rows.length} accounts`);

        // Also update warmup stages based on account age
        await updateWarmupStages();
    } catch (err) {
        logger.error(`Daily reset failed: ${err.message}`);
    }
}

async function updateWarmupStages() {
    try {
        // Update stages based on days since warmup started
        const stages = [
            { name: 'baby', minDays: 4, maxDays: 7, limit: 15 },
            { name: 'toddler', minDays: 8, maxDays: 14, limit: 30 },
            { name: 'teen', minDays: 15, maxDays: 30, limit: 50 },
            { name: 'adult', minDays: 31, maxDays: 9999, limit: 100 },
        ];

        for (const stage of stages) {
            await query(
                `UPDATE warmup_accounts 
                 SET stage = $1, max_messages_per_day = $2,
                     is_warmup_complete = CASE WHEN $1 = 'adult' THEN TRUE ELSE is_warmup_complete END,
                     warmup_completed_at = CASE WHEN $1 = 'adult' AND warmup_completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE warmup_completed_at END
                 WHERE EXTRACT(DAY FROM (CURRENT_TIMESTAMP - warmup_started_at)) >= $3
                   AND EXTRACT(DAY FROM (CURRENT_TIMESTAMP - warmup_started_at)) <= $4
                   AND stage != $1`,
                [stage.name, stage.limit, stage.minDays, stage.maxDays]
            );
        }

        logger.info('Warmup stages updated');
    } catch (err) {
        logger.error(`Warmup stages update failed: ${err.message}`);
    }
}

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    logger.info(`🚀 Master server started on port ${PORT}`);
    
    // Start scheduled tasks
    scheduleDailyResetTask();
});

module.exports = app;
