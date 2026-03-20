const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// Follow a user
router.post('/:userId', requireAuth, asyncHandler(async (req, res) => {
  const followerId  = req.user.userId;
  const followingId = req.params.userId;

  if (followerId === followingId)
    return res.status(400).json({ error: 'Cannot follow yourself' });

  await query(
    'INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [followerId, followingId]
  );
  res.json({ ok: true, following: true });
}));

// Unfollow a user
router.delete('/:userId', requireAuth, asyncHandler(async (req, res) => {
  await query(
    'DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',
    [req.user.userId, req.params.userId]
  );
  res.json({ ok: true, following: false });
}));

// Get people I follow
router.get('/following', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen
     FROM follows f
     JOIN users u ON u.id = f.following_id
     WHERE f.follower_id = $1
     ORDER BY u.is_online DESC, u.display_name`,
    [req.user.userId]
  );
  res.json({ users: rows });
}));

// Get my followers
router.get('/followers', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen
     FROM follows f
     JOIN users u ON u.id = f.follower_id
     WHERE f.following_id = $1
     ORDER BY u.is_online DESC, u.display_name`,
    [req.user.userId]
  );
  res.json({ users: rows });
}));

// Check if I follow a specific user
router.get('/check/:userId', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2',
    [req.user.userId, req.params.userId]
  );
  res.json({ following: rows.length > 0 });
}));

module.exports = router;