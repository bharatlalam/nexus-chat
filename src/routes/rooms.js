const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, rm.role AS member_role,
            (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
            (SELECT content FROM messages WHERE room_id=r.id AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages WHERE room_id=r.id AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1) AS last_message_at,
            CASE WHEN r.type='dm' THEN (
              SELECT u.display_name
              FROM room_members rm2
              JOIN users u ON u.id = rm2.user_id
              WHERE rm2.room_id = r.id AND rm2.user_id != $1
              LIMIT 1
            ) ELSE r.name END AS name
     FROM rooms r
     JOIN room_members rm ON rm.room_id = r.id
     WHERE rm.user_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [req.user.userId]
  );
  res.json({ rooms: rows });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [room] } = await query(
    `SELECT r.*, rm.role AS member_role
     FROM rooms r JOIN room_members rm ON rm.room_id=r.id
     WHERE r.id=$1 AND rm.user_id=$2`,
    [req.params.id, req.user.userId]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room });
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { name, description, type = 'channel', isPrivate = false } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Room name required' });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const { rows: [room] } = await query(
    `INSERT INTO rooms (name, slug, description, type, is_private, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), slug, description, type, isPrivate, req.user.userId]
  );
  await query(
    "INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'owner')",
    [room.id, req.user.userId]
  );
  res.status(201).json({ room });
}));

// CREATE OR GET direct message between two users
router.post('/dm/:targetUserId', requireAuth, asyncHandler(async (req, res) => {
  const myId     = req.user.userId;
  const targetId = req.params.targetUserId;

  if (myId === targetId)
    return res.status(400).json({ error: 'Cannot DM yourself' });

  // Check target user exists
  const { rows: [target] } = await query(
    'SELECT id, username, display_name FROM users WHERE id=$1', [targetId]
  );
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Check if DM room already exists between these two users
  const { rows: [existing] } = await query(
    `SELECT r.* FROM rooms r
     JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = $1
     JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = $2
     WHERE r.type = 'dm'
     LIMIT 1`,
    [myId, targetId]
  );

  if (existing) return res.json({ room: existing });

  // Create new DM room with short slug
  const slug = `dm-${[myId, targetId].sort().map(id => id.slice(0,8)).join('-')}`;

  const { rows: [room] } = await query(
    `INSERT INTO rooms (name, slug, type, is_private, created_by)
     VALUES ($1,$2,'dm',true,$3) RETURNING *`,
    [target.display_name || target.username, slug, myId]
  );

  // Add both users
  await query(
    'INSERT INTO room_members (room_id, user_id) VALUES ($1,$2),($1,$3)',
    [room.id, myId, targetId]
  );

  res.status(201).json({ room });
}));

router.post('/:id/join', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [room] } = await query(
    'SELECT * FROM rooms WHERE id=$1', [req.params.id]
  );
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private) return res.status(403).json({ error: 'Private room' });
  await query(
    'INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [room.id, req.user.userId]
  );
  res.json({ ok: true, room });
}));

router.delete('/:id/leave', requireAuth, asyncHandler(async (req, res) => {
  await query(
    'DELETE FROM room_members WHERE room_id=$1 AND user_id=$2',
    [req.params.id, req.user.userId]
  );
  res.json({ ok: true });
}));

router.get('/:id/members', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [isMember] } = await query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
    [req.params.id, req.user.userId]
  );
  if (!isMember) return res.status(403).json({ error: 'Access denied' });
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen,
            rm.role AS member_role, rm.joined_at
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1 ORDER BY u.is_online DESC, u.display_name`,
    [req.params.id]
  );
  res.json({ members: rows });
}));

module.exports = router;