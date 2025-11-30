const { Router } = require('express');
const { query } = require('../../config/database');

const router = Router();

router.get('/', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({ status: 'ok' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
