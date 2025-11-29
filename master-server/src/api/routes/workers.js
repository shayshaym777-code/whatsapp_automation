import { Router } from 'express';
import { query } from '../../config/database.js';

const router = Router();

// GET /api/workers
router.get('/', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM workers ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/workers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM workers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;


