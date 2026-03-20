const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// All admin routes require auth + admin role
router.use(requireAuth);
router.use(requireRole('admin'));

// ── STATS ─────────────────────────────────────────────────
router.get('/stats', asyncHandler(async (req, res) => {
  const [users, messages, rooms, banned] = await Promise.all([
    query('SELECT COUNT(*) FROM users'),
    query('SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL'),
    query('SELECT COUNT(*) FROM rooms'),
    query('SELECT COUNT(*) FROM users WHERE is_banned = TRUE'),
  ]);
  res.json({
    totalUsers:    parseInt(users.rows[0].count),
    totalMessages: parseInt(messages.rows[0].count),
    totalRooms:    parseInt(rooms.rows[0].count),
    bannedUsers:   parseInt(banned.rows[0].count),
  });
}));

// ── ALL USERS ─────────────────────────────────────────────
router.get('/users', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let sql = `SELECT id, username, display_name, avatar_url, email,
                    role, is_online, is_banned, last_seen, created_at
             FROM users`;
  const params = [];
  if (search?.trim()) {
    sql += ` WHERE username ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1`;
    params.push(`%${search.trim()}%`);
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await query(sql, params);
  res.json({ users: rows });
}));

// ── BAN USER ──────────────────────────────────────────────
router.post('/users/:id/ban', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (id === req.user.userId)
    return res.status(400).json({ error: 'Cannot ban yourself' });
  const { rows: [user] } = await query(
    `UPDATE users SET is_banned = TRUE WHERE id = $1 RETURNING id, username, is_banned`,
    [id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user });
}));

// ── UNBAN USER ────────────────────────────────────────────
router.post('/users/:id/unban', asyncHandler(async (req, res) => {
  const { rows: [user] } = await query(
    `UPDATE users SET is_banned = FALSE WHERE id = $1 RETURNING id, username, is_banned`,
    [req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user });
}));

// ── DELETE USER ───────────────────────────────────────────
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (id === req.user.userId)
    return res.status(400).json({ error: 'Cannot delete yourself' });
  await query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ── ALL MESSAGES ──────────────────────────────────────────
router.get('/messages', asyncHandler(async (req, res) => {
  const { search, roomId } = req.query;
  let sql = `
    SELECT m.id, m.content, m.created_at, m.sender_type, m.room_id,
           u.username, u.display_name, u.avatar_url,
           r.name AS room_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    JOIN rooms r ON r.id = m.room_id
    WHERE m.deleted_at IS NULL
  `;
  const params = [];
  if (search?.trim()) {
    params.push(`%${search.trim()}%`);
    sql += ` AND m.content ILIKE $${params.length}`;
  }
  if (roomId) {
    params.push(roomId);
    sql += ` AND m.room_id = $${params.length}`;
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 100';
  const { rows } = await query(sql, params);
  res.json({ messages: rows });
}));

// ── DELETE ANY MESSAGE ────────────────────────────────────
router.delete('/messages/:id', asyncHandler(async (req, res) => {
  await query(
    'UPDATE messages SET deleted_at = NOW() WHERE id = $1',
    [req.params.id]
  );
  res.json({ ok: true });
}));

// ── ALL ROOMS ─────────────────────────────────────────────
router.get('/rooms', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) AS member_count,
            (SELECT COUNT(*) FROM messages WHERE room_id = r.id AND deleted_at IS NULL) AS message_count
     FROM rooms r
     ORDER BY r.created_at DESC`
  );
  res.json({ rooms: rows });
}));

// ── DELETE ROOM ───────────────────────────────────────────
router.delete('/rooms/:id', asyncHandler(async (req, res) => {
  await query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;