const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const dotenv = require('dotenv');

const logger = require('./utils/logger');
const messagesRouter = require('./api/routes/messages');
const queueRouter = require('./api/routes/queue');
const accountsRouter = require('./api/routes/accounts');
const loadBalancer = require('./services/LoadBalancer');
const queueProcessor = require('./services/QueueProcessor');
const accountPool = require('./services/AccountPool');

dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    logger.info({ msg: 'request', method: req.method, path: req.path });
    next();
});

// Health check
app.get('/health', async (req, res) => {
    const queueStats = await queueProcessor.getStats();
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        queue: queueStats,
    });
});

// Workers endpoint
app.get('/api/workers', (req, res) => {
    res.json({
        success: true,
        workers: loadBalancer.getWorkers(),
    });
});

// API Routes
app.use('/api/messages', messagesRouter);
app.use('/api/queue', queueRouter);
app.use('/api/accounts', accountsRouter);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error({ msg: 'unhandled_error', error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const PORT = process.env.PORT || 5000;

// Initialize on startup
async function initialize() {
    try {
        // Refresh account pool
        logger.info({ msg: 'Refreshing account pool...' });
        await accountPool.refreshAccountsFromWorkers();
        
        // Start queue processor
        if (process.env.AUTO_START_QUEUE !== 'false') {
            logger.info({ msg: 'Starting queue processor...' });
            queueProcessor.start();
        }
        
        logger.info({ msg: 'Initialization complete' });
    } catch (err) {
        logger.error({ msg: 'Initialization error', error: err.message });
    }
}

app.listen(PORT, () => {
    logger.info({ msg: 'server_started', port: PORT });
    
    // Initialize after short delay to allow workers to start
    setTimeout(initialize, 5000);
});

module.exports = app;
