/**
 * Accounts API Routes
 * 
 * Endpoints:
 * - GET /pool - Get account pool status
 * - GET /free - Get free accounts
 * - GET /busy - Get busy accounts
 * - POST /refresh - Refresh accounts from workers
 * - GET /:phone/status - Get specific account status
 */

const express = require('express');
const accountPool = require('../../services/AccountPool');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * GET /pool - Get complete account pool status
 */
router.get('/pool', async (req, res) => {
    try {
        const status = await accountPool.getPoolStatus();
        return res.json({
            success: true,
            ...status,
        });
    } catch (err) {
        logger.error({ msg: 'pool_status_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /free - Get free accounts
 */
router.get('/free', async (req, res) => {
    try {
        const { country } = req.query;
        const freeAccounts = await accountPool.getFreeAccounts(country || null);
        
        return res.json({
            success: true,
            count: freeAccounts.length,
            country: country || 'all',
            accounts: freeAccounts,
        });
    } catch (err) {
        logger.error({ msg: 'free_accounts_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /busy - Get busy accounts
 */
router.get('/busy', async (req, res) => {
    try {
        const busyAccounts = await accountPool.getBusyAccounts();
        
        return res.json({
            success: true,
            count: busyAccounts.length,
            accounts: busyAccounts,
        });
    } catch (err) {
        logger.error({ msg: 'busy_accounts_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * POST /refresh - Refresh accounts from all workers
 */
router.post('/refresh', async (req, res) => {
    try {
        const accounts = await accountPool.refreshAccountsFromWorkers();
        
        return res.json({
            success: true,
            message: 'Accounts refreshed',
            count: accounts.length,
            accounts,
        });
    } catch (err) {
        logger.error({ msg: 'refresh_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /:phone/status - Get specific account status
 */
router.get('/:phone/status', async (req, res) => {
    try {
        const { phone } = req.params;
        const decodedPhone = decodeURIComponent(phone);
        
        const canSend = await accountPool.canSend(decodedPhone);
        const isBusy = await accountPool.isBusy(decodedPhone);
        const dailyStats = await accountPool.getDailyStats(decodedPhone);
        
        return res.json({
            success: true,
            phone: decodedPhone,
            status: isBusy ? 'busy' : (canSend.allowed ? 'free' : 'limit_reached'),
            canSend: canSend.allowed,
            remaining: canSend.remaining,
            sentToday: dailyStats.sentToday,
            lastSentAt: dailyStats.lastSentAt,
        });
    } catch (err) {
        logger.error({ msg: 'account_status_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /by-country/:country - Get accounts for a specific country
 */
router.get('/by-country/:country', async (req, res) => {
    try {
        const { country } = req.params;
        const accounts = await accountPool.getAccountsByCountry(country.toUpperCase());
        
        return res.json({
            success: true,
            country: country.toUpperCase(),
            count: accounts.length,
            accounts,
        });
    } catch (err) {
        logger.error({ msg: 'accounts_by_country_error', error: err.message });
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
