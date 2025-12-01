const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const dotenv = require('dotenv');

const logger = require('./utils/logger');
const accountsRouter = require('./api/routes/accounts');
const sendRouter = require('./api/routes/send');
const campaignsRouter = require('./api/routes/campaigns');
const { query } = require('./config/database');

dotenv.config();

const app = express();

// v8.0: Simple and clean master server

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '8.0', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/accounts', accountsRouter);
app.use('/api/send', sendRouter);
app.use('/api/campaigns', campaignsRouter);

// Alias: GET /api/campaign/:id/status (singular)
app.get('/api/campaign/:id/status', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        const c = result.rows[0];
        res.json({ total: c.total, sent: c.sent, failed: c.failed, status: c.status });
    } catch (err) {
        next(err);
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error(`Error: ${err.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Daily reset at midnight
function scheduleDailyReset() {
    const now = new Date();
    const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const msToMidnight = night.getTime() - now.getTime();

    setTimeout(() => {
        resetDailyCounts();
        setInterval(resetDailyCounts, 24 * 60 * 60 * 1000);
    }, msToMidnight);

    logger.info(`Daily reset scheduled for ${night.toISOString()}`);
}

async function resetDailyCounts() {
    try {
        await query('UPDATE accounts SET messages_today = 0');
        logger.info('Daily message counts reset');
    } catch (err) {
        logger.error(`Daily reset failed: ${err.message}`);
    }
}

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    logger.info(`🚀 Master server v8.0 started on port ${PORT}`);
    scheduleDailyReset();
});

module.exports = app;
