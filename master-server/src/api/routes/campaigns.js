import { Router } from 'express';
import { query } from '../../config/database.js';

const router = Router();

// GET /api/campaigns
router.get('/', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// POST /api/campaigns
router.post('/', async (req, res, next) => {
    try {
        const {
            name,
            description,
            message_template: messageTemplate,
            message_type: messageType = 'text',
            media_url: mediaUrl = null,
            target_phones: targetPhones = [],
            priority = 'normal'
        } = req.body;

        const result = await query(
            `INSERT INTO campaigns (name, description, message_template, message_type, media_url, target_phones, target_count, priority)
       VALUES ($1, $2, $3, $4, $5, $6, array_length($6, 1), $7)
       RETURNING *`,
            [name, description, messageTemplate, messageType, mediaUrl, targetPhones, priority]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

export default router;


