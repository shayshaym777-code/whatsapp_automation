const winston = require('winston');

// Custom format to properly stringify objects
const customFormat = winston.format.printf(({ level, message, timestamp, ...rest }) => {
    // If message is an object, stringify it
    let msg = message;
    if (typeof message === 'object') {
        msg = JSON.stringify(message, null, 2);
    }

    // Add any additional fields
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';

    return `${timestamp} [${level}]: ${msg}${extra}`;
});

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        customFormat
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                customFormat
            )
        })
    ]
});

// Helper function to ensure proper logging
logger.logInfo = (msg, data = {}) => {
    if (typeof msg === 'object') {
        logger.info(JSON.stringify(msg, null, 2));
    } else if (Object.keys(data).length > 0) {
        logger.info(`${msg} ${JSON.stringify(data)}`);
    } else {
        logger.info(msg);
    }
};

logger.logError = (msg, error = null) => {
    if (error) {
        logger.error(`${msg}: ${error.message || error}`);
        if (error.stack) {
            logger.debug(error.stack);
        }
    } else if (typeof msg === 'object') {
        logger.error(JSON.stringify(msg, null, 2));
    } else {
        logger.error(msg);
    }
};

// Support both CommonJS and ESM imports
module.exports = logger;
module.exports.logger = logger;
module.exports.default = logger;
