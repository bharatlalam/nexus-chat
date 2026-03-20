const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { search } = req.query;
  let sql = `SELECT id, username, display_name, avatar_url, bio, is_online, last_seen, status
             FROM users WHERE id != $1`;
  const params = [req.user.userId];
  if (search?.trim()) {
    sql += ` AND (username ILIKE $2 OR display_name ILIKE $2)`;
    params.push(`%${search.trim()}%`);
  }
  sql += ` ORDER BY is_online DESC, display_name`;
  const { rows } = await query(sql, params);
  res.json({ users: rows });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [user] } = await query(
    `SELECT id, username, display_name, avatar_url, bio, is_online, last_seen, status, created_at
     FROM users WHERE id=$1`,
    [req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
}));

router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const { displayName, avatarUrl, bio, status } = req.body;

  const VALID_STATUSES = ['online', 'busy', 'away', 'offline'];
  if (status && !VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  const { rows: [user] } = await query(
    `UPDATE users SET
       display_name = COALESCE($1, display_name),
       avatar_url   = COALESCE($2, avatar_url),
       bio          = COALESCE($3, bio),
       status       = COALESCE($4, status),
       updated_at   = NOW()
     WHERE id=$5
     RETURNING id, username, display_name, avatar_url, bio, status`,
    [displayName, avatarUrl, bio, status, req.user.userId]
  );
  res.json({ user });
}));

module.exports = router;