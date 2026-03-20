const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../db/pool');
const { signToken, signRefreshToken, verifyRefreshToken, requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { invalidateToken } = require('../services/redis');

router.post('/register', asyncHandler(async (req, res) => {
  const { username, email, password, displayName } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email and password required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = await bcrypt.hash(password, 12);
  const { rows: [user] } = await query(
    `INSERT INTO users (username, email, password_hash, display_name)
     VALUES ($1,$2,$3,$4)
     RETURNING id, username, email, display_name, role, created_at`,
    [username.toLowerCase(), email.toLowerCase(), hash, displayName || username]
  );

  const { rows: [general] } = await query("SELECT id FROM rooms WHERE slug='general' LIMIT 1");
  if (general) {
    await query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [general.id, user.id]);
  }

  const accessToken  = signToken(user.id, user.role);
  const refreshToken = signRefreshToken(user.id);
  const tokenHash    = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
    [user.id, tokenHash]
  );
  res.status(201).json({ user, accessToken, refreshToken });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { rows: [user] } = await query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)  return res.status(401).json({ error: 'Invalid credentials' });

  await query('UPDATE users SET is_online=TRUE WHERE id=$1', [user.id]);

  const accessToken  = signToken(user.id, user.role);
  const refreshToken = signRefreshToken(user.id);
  const tokenHash    = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
    [user.id, tokenHash]
  );

  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, accessToken, refreshToken });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  const decoded   = verifyRefreshToken(refreshToken);
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const { rows: [stored] } = await query(
    `SELECT * FROM refresh_tokens WHERE user_id=$1 AND token_hash=$2 AND expires_at > NOW()`,
    [decoded.userId, tokenHash]
  );
  if (!stored) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  const { rows: [user] } = await query('SELECT id, role FROM users WHERE id=$1', [decoded.userId]);
  const newAccess  = signToken(user.id, user.role);
  const newRefresh = signRefreshToken(user.id);
  const newHash    = crypto.createHash('sha256').update(newRefresh).digest('hex');

  await query('DELETE FROM refresh_tokens WHERE id=$1', [stored.id]);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, NOW() + INTERVAL '7 days')`,
    [user.id, newHash]
  );
  res.json({ accessToken: newAccess, refreshToken: newRefresh });
}));

router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await query('DELETE FROM refresh_tokens WHERE user_id=$1 AND token_hash=$2',
      [req.user.userId, hash]);
  }
  await invalidateToken(req.user.userId);
  await query('UPDATE users SET is_online=FALSE, last_seen=NOW() WHERE id=$1', [req.user.userId]);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [user] } = await query(
    `SELECT id, username, email, display_name, avatar_url, role, is_online, last_seen, created_at
     FROM users WHERE id=$1`,
    [req.user.userId]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
}));

module.exports = router;