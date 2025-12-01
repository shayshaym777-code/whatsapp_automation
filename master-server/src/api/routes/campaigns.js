const { Router } = require('express');
const { query } = require('../../config/database');

const router = Router();

// v8.0: Simple campaign tracking

// GET /api/campaigns - List campaigns
router.get('/', async (req, res, next) => {
    try {
        const result = await query(`
            SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100
        `);
        res.json({ campaigns: result.rows });
    } catch (err) {
        next(err);
    }
});

// GET /api/campaigns/:id - Get campaign
router.get('/:id', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// GET /api/campaigns/:id/status - Get campaign status (v8.0 format)
router.get('/:id/status', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const c = result.rows[0];

        res.json({
            total: c.total,
            sent: c.sent,
            failed: c.failed,
            status: c.status
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
