// Request Logger Middleware
// Logs all API requests with details: IP, method, path, status, response time

function requestLogger(req, res, next) {
    const startTime = Date.now();
    const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const method = req.method;
    const path = req.path || req.url;
    const apiKey = req.headers['x-api-key'] ? '***' + req.headers['x-api-key'].slice(-4) : 'none';

    // Log request
    console.log(`[API] ${new Date().toISOString()} | ${method} ${path} | IP: ${clientIP} | Key: ${apiKey}`);

    // Override res.json to log response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
        const duration = Date.now() - startTime;
        const status = res.statusCode;
        
        // Log response
        if (status >= 400) {
            console.error(`[API] ❌ ${method} ${path} | ${status} | ${duration}ms | Error: ${data.error || 'Unknown'}`);
        } else {
            console.log(`[API] ✅ ${method} ${path} | ${status} | ${duration}ms`);
        }
        
        return originalJson(data);
    };

    // Override res.status to capture status code
    const originalStatus = res.status.bind(res);
    res.status = function(code) {
        res.statusCode = code;
        return originalStatus(code);
    };

    next();
}

module.exports = { requestLogger };

