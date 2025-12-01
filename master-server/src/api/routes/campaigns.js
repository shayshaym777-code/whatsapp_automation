const { Router } = require('express');
const { query } = require('../../config/database');

const router = Router();

// GET /api/campaigns - List all campaigns
router.get('/', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100');
        res.json({ campaigns: result.rows });
    } catch (err) {
        next(err);
    }
});

// GET /api/campaigns/:id - Get campaign by ID (v7.0)
router.get('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            SELECT * FROM campaigns WHERE campaign_id = $1 OR id::text = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// GET /api/campaigns/:id/status - Get campaign status (v7.0)
router.get('/:id/status', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            SELECT * FROM campaigns WHERE campaign_id = $1 OR id::text = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const campaign = result.rows[0];

        res.json({
            status: campaign.status,
            total: campaign.total_contacts,
            sent: campaign.sent_count,
            failed: campaign.failed_count,
            started_at: campaign.started_at,
            completed_at: campaign.completed_at
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/campaigns - Create a new campaign (legacy)
router.post('/', async (req, res, next) => {
    try {
        const {
            name,
            message_template: messageTemplate,
            total_contacts: totalContacts = 0
        } = req.body;

        const result = await query(`
            INSERT INTO campaigns (name, message_template, total_contacts, status)
            VALUES ($1, $2, $3, 'pending')
            RETURNING *
        `, [name || `Campaign ${Date.now()}`, messageTemplate, totalContacts]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// PUT /api/campaigns/:id/pause - Pause a campaign
router.put('/:id/pause', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            UPDATE campaigns SET status = 'paused', updated_at = NOW()
            WHERE (campaign_id = $1 OR id::text = $1) AND status = 'in_progress'
            RETURNING *
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found or not in progress' });
        }

        res.json({ success: true, campaign: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

// PUT /api/campaigns/:id/cancel - Cancel a campaign
router.put('/:id/cancel', async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            UPDATE campaigns SET status = 'cancelled', updated_at = NOW()
            WHERE (campaign_id = $1 OR id::text = $1) AND status IN ('pending', 'in_progress', 'paused')
            RETURNING *
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found or already completed' });
        }

        res.json({ success: true, campaign: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
