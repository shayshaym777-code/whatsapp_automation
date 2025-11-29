import dotenv from 'dotenv';
import app from './app.js';
import { logger } from './utils/logger.js';

dotenv.config();

const port = process.env.PORT || 5000;

app.listen(port, () => {
    logger.info(`Master server listening on port ${port}`);
});


