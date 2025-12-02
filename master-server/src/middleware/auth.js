// API Key Authentication Middleware
// Validates X-API-Key header against API_KEY environment variable

function apiKeyAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.API_KEY;
    const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';

    // If no API key is configured, allow all requests (for development)
    if (!expectedKey || expectedKey === 'your-api-key-change-in-production') {
        console.log(`[AUTH] ⚠️  API key not configured - allowing request from ${clientIP}`);
        return next();
    }

    // If API key is required but not provided
    if (!apiKey) {
        console.error(`[AUTH] ❌ REJECTED: No API key provided | IP: ${clientIP} | Path: ${req.path}`);
        return res.status(401).json({ 
            error: 'API key required',
            message: 'Please provide X-API-Key header or Authorization: Bearer <key>'
        });
    }

    // Validate API key
    if (apiKey !== expectedKey) {
        const providedKeyPreview = apiKey.length > 8 ? '***' + apiKey.slice(-4) : '***';
        console.error(`[AUTH] ❌ REJECTED: Invalid API key | IP: ${clientIP} | Path: ${req.path} | Provided: ${providedKeyPreview}`);
        return res.status(403).json({ 
            error: 'Invalid API key',
            message: 'The provided API key is incorrect'
        });
    }

    // Valid API key
    const keyPreview = apiKey.length > 8 ? '***' + apiKey.slice(-4) : '***';
    console.log(`[AUTH] ✅ ACCEPTED: Valid API key | IP: ${clientIP} | Path: ${req.path} | Key: ${keyPreview}`);
    next();
}

module.exports = { apiKeyAuth };

