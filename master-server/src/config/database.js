const { Pool } = require('pg');
const logger = require('../utils/logger');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
    logger.error('Unexpected PG client error', { error: err.message });
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
