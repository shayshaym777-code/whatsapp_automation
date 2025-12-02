// API Key Authentication Middleware
// Validates X-API-Key header against API_KEY environment variable

function apiKeyAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.API_KEY;

    // If no API key is configured, allow all requests (for development)
    if (!expectedKey || expectedKey === 'your-api-key-change-in-production') {
        return next();
    }

    // If API key is required but not provided
    if (!apiKey) {
        return res.status(401).json({ 
            error: 'API key required',
            message: 'Please provide X-API-Key header or Authorization: Bearer <key>'
        });
    }

    // Validate API key
    if (apiKey !== expectedKey) {
        return res.status(403).json({ 
            error: 'Invalid API key',
            message: 'The provided API key is incorrect'
        });
    }

    next();
}

module.exports = { apiKeyAuth };

