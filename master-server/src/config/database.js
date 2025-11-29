import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
    logger.error('Unexpected PG client error', { error: err.message });
});

export const query = (text, params) => pool.query(text, params);


