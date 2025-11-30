const dotenv = require('dotenv');
const app = require('./app');
const logger = require('./utils/logger');

dotenv.config();

const port = process.env.PORT || 5000;

app.listen(port, () => {
    logger.info(`Master server listening on port ${port}`);
});
