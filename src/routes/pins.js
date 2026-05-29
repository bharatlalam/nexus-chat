const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// Get pinned messages for a room
router.get('/:roomId', requireAuth, asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { rows: [member] } = await query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });

  const { rows } = await query(
    `SELECT pm.*, m.content, m.content_type, m.created_at AS message_created_at,
            u.display_name, u.avatar_url,
            pu.display_name AS pinned_by_name
     FROM pinned_messages pm
     JOIN messages m ON m.id = pm.message_id
     JOIN users u ON u.id = m.sender_id
     JOIN users pu ON pu.id = pm.pinned_by
     WHERE pm.room_id = $1
     ORDER BY pm.pinned_at DESC`,
    [roomId]
  );
  res.json({ pins: rows });
}));

// Pin a message
router.post('/:roomId/:messageId', requireAuth, asyncHandler(async (req, res) => {
  const { roomId, messageId } = req.params;
  const { rows: [member] } = await query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });

  await query(
    `INSERT INTO pinned_messages (room_id, message_id, pinned_by)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [roomId, messageId, req.user.userId]
  );
  res.json({ ok: true });
}));

// Unpin a message
router.delete('/:roomId/:messageId', requireAuth, asyncHandler(async (req, res) => {
  const { roomId, messageId } = req.params;
  const { rows: [member] } = await query(
    'SELECT role FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });

  await query(
    'DELETE FROM pinned_messages WHERE room_id=$1 AND message_id=$2',
    [roomId, messageId]
  );
  res.json({ ok: true });
}));

module.exports = router;