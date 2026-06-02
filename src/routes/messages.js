const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/room/:roomId', requireAuth, asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;
  const { rows: [member] } = await query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });
  const params = [roomId, limit + 1, req.user.userId];
  let where = 'WHERE m.room_id=$1 AND m.deleted_at IS NULL AND (m.is_private = FALSE OR m.private_user_id = $3)';
  if (before) { where += ' AND m.created_at < $4'; params.push(before); }
  const { rows } = await query(
    `SELECT m.*,
            u.username, u.display_name, u.avatar_url,
            COALESCE(
              json_agg(json_build_object('emoji', r.emoji, 'count', r.cnt))
              FILTER (WHERE r.emoji IS NOT NULL), '[]'
            ) AS reactions,
            CASE WHEN m.reply_to IS NOT NULL THEN
              json_build_object(
                'id', rm2.id,
                'content', rm2.content,
                'username', ru.username,
                'sender', json_build_object(
                  'id', ru.id,
                  'display_name', ru.display_name,
                  'avatar_url', ru.avatar_url
                )
              )
            ELSE NULL END AS reply_to_msg
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN messages rm2 ON rm2.id = m.reply_to
     LEFT JOIN users ru ON ru.id = rm2.sender_id
     LEFT JOIN (
       SELECT message_id, emoji, COUNT(*) AS cnt
       FROM reactions GROUP BY message_id, emoji
     ) r ON r.message_id = m.id
     ${where}
     GROUP BY m.id, u.id, rm2.id, rm2.content, ru.id, ru.username, ru.display_name, ru.avatar_url
     ORDER BY m.created_at DESC LIMIT $2`,
    params
  );
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  rows.reverse();
  res.json({ messages: rows, hasMore, nextCursor: hasMore ? rows[0]?.created_at : null });
}));

// CLEAR CHAT — delete all messages in a room for the requesting user
router.delete('/room/:roomId/clear', requireAuth, asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const { rows: [member] } = await query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
    [roomId, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'Access denied' });

  await query(
    `UPDATE messages SET deleted_at=NOW()
     WHERE room_id=$1 AND deleted_at IS NULL`,
    [roomId]
  );
  res.json({ ok: true });
}));

// VIEW ONE-TIME IMAGE — mark as viewed and return url
router.post('/:id/view-once', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [msg] } = await query(
    `SELECT m.* FROM messages m
     JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [req.params.id, req.user.userId]
  );
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  // If already viewed, delete it
  if (msg.view_once_viewed) {
    await query(
      'UPDATE messages SET deleted_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    return res.status(410).json({ error: 'Image already viewed' });
  }

  // Mark as viewed
  await query(
    'UPDATE messages SET view_once_viewed=TRUE WHERE id=$1',
    [req.params.id]
  );

  const imageUrl = msg.content.replace('[ONCE]:', '');
  res.json({ ok: true, url: imageUrl });
}));

router.get('/search', requireAuth, asyncHandler(async (req, res) => {
  const { q, roomId } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });
  let sql = `
    SELECT m.id, m.content, m.created_at, m.room_id,
           u.display_name, u.avatar_url,
           r.name AS room_name, r.slug AS room_slug
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN rooms r ON r.id = m.room_id
    JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
    WHERE m.deleted_at IS NULL AND m.content ILIKE $2`;
  const params = [req.user.userId, `%${q.trim()}%`];
  if (roomId) { sql += ' AND m.room_id = $3'; params.push(roomId); }
  sql += ' ORDER BY m.created_at DESC LIMIT 50';
  const { rows } = await query(sql, params);
  res.json({ results: rows, query: q });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [msg] } = await query(
    `SELECT m.*, u.username, u.display_name, u.avatar_url
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [req.params.id, req.user.userId]
  );
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json({ message: msg });
}));

module.exports = router;