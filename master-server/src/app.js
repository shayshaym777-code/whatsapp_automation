const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const dotenv = require('dotenv');

const logger = require('./utils/logger');
const messagesRouter = require('./api/routes/messages');
const loadBalancer = require('./services/LoadBalancer');

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/workers', (req, res) => {
    res.json(loadBalancer.getWorkers());
});

app.use('/api/messages', messagesRouter);

app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error({ msg: 'unhandled_error', error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    logger.info({ msg: 'server_started', port: PORT });
});

module.exports = app;
