const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// ── GET ALL ACTIVE STORIES (from people I follow + my own) ──
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, u.username, u.display_name, u.avatar_url,
            (SELECT COUNT(*) FROM story_views WHERE story_id = s.id) AS view_count,
            (SELECT COUNT(*) FROM story_views WHERE story_id = s.id AND viewer_id = $1) AS viewed
     FROM stories s
     JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > NOW()
       AND (s.user_id = $1
         OR s.user_id IN (
           SELECT following_id FROM follows WHERE follower_id = $1
         ))
     ORDER BY s.created_at DESC`,
    [req.user.userId]
  );

  // Group by user
  const grouped = {};
  for (const story of rows) {
    if (!grouped[story.user_id]) {
      grouped[story.user_id] = {
        user: {
          id:          story.user_id,
          username:    story.username,
          displayName: story.display_name,
          avatarUrl:   story.avatar_url,
        },
        stories: [],
        hasUnviewed: false,
      };
    }
    grouped[story.user_id].stories.push(story);
    if (parseInt(story.viewed) === 0) {
      grouped[story.user_id].hasUnviewed = true;
    }
  }

  res.json({ stories: Object.values(grouped) });
}));

// ── CREATE STORY ──────────────────────────────────────────
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { type = 'text', content, bgColor = '#0c1424' } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  const { rows: [story] } = await query(
    `INSERT INTO stories (user_id, type, content, bg_color)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.userId, type, content.trim(), bgColor]
  );
  res.status(201).json({ story });
}));

// ── VIEW STORY ────────────────────────────────────────────
router.post('/:id/view', requireAuth, asyncHandler(async (req, res) => {
  await query(
    `INSERT INTO story_views (story_id, viewer_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.user.userId]
  );
  res.json({ ok: true });
}));

// ── GET STORY VIEWERS ─────────────────────────────────────
router.get('/:id/viewers', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, sv.viewed_at
     FROM story_views sv
     JOIN users u ON u.id = sv.viewer_id
     WHERE sv.story_id = $1
     ORDER BY sv.viewed_at DESC`,
    [req.params.id]
  );
  res.json({ viewers: rows });
}));

// ── DELETE MY STORY ───────────────────────────────────────
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await query(
    'DELETE FROM stories WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.userId]
  );
  res.json({ ok: true });
}));

module.exports = router;