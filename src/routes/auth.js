const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { query } = require('../db/pool');
const { signToken, signRefreshToken, verifyRefreshToken, requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { invalidateToken, getRedis } = require('../services/redis');

// EMAIL TRANSPORTER — force IPv4
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,
});

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendOTPEmail = async (email, otp, type = 'register') => {
  const subject = type === 'register' ? 'Verify your Nexus account' : 'Reset your Nexus password';
  const title   = type === 'register' ? 'Email Verification' : 'Password Reset';
  const message = type === 'register'
    ? 'Use the code below to verify your email and complete registration.'
    : 'Use the code below to reset your password.';

  await transporter.sendMail({
    from: `"Nexus Chat" <${process.env.EMAIL_USER}>`,
    to: email,
    subject,
    html: `
      <div style="font-family:monospace;background:#04060d;padding:40px;border-radius:16px;max-width:480px;margin:0 auto;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="display:inline-block;background:linear-gradient(135deg,#00ffe0,#39ff9f);width:48px;height:48px;border-radius:14px;line-height:48px;font-size:24px;font-weight:900;color:#04060d;text-align:center;">N</div>
          <h1 style="color:#ffffff;font-size:22px;margin:16px 0 4px;letter-spacing:-0.5px;">NEXUS<span style="color:#00ffe0;">.</span></h1>
          <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0;">${title}</p>
        </div>
        <p style="color:rgba(255,255,255,0.6);font-size:13px;line-height:1.7;margin-bottom:32px;text-align:center;">${message}</p>
        <div style="background:rgba(0,255,224,0.06);border:1px solid rgba(0,255,224,0.2);border-radius:14px;padding:28px;text-align:center;margin-bottom:32px;">
          <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#00ffe0;">${otp}</div>
          <p style="color:rgba(255,255,255,0.3);font-size:11px;margin:12px 0 0;">Valid for 10 minutes</p>
        </div>
        <p style="color:rgba(255,255,255,0.25);font-size:11px;text-align:center;line-height:1.6;">If you didn't request this, ignore this email.<br/>This code expires in 10 minutes.</p>
      </div>
    `,
  });
};

// SEND OTP FOR REGISTRATION
router.post('/send-otp', asyncHandler(async (req, res) => {
  const { email, username, password, displayName } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email and password required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { rows: [existing] } = await query(
    'SELECT id FROM users WHERE email=$1 OR username=$2',
    [email.toLowerCase(), username.toLowerCase()]
  );
  if (existing) return res.status(400).json({ error: 'Email or username already taken' });

  const otp = generateOTP();
  const redis = getRedis();
  await redis.setex(
    `otp:register:${email.toLowerCase()}`, 600,
    JSON.stringify({ otp, username, email, password, displayName })
  );
  await sendOTPEmail(email, otp, 'register');
  res.json({ ok: true, message: 'OTP sent to your email' });
}));

// VERIFY OTP + COMPLETE REGISTRATION
router.post('/verify-otp', asyncHandler(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  const redis = getRedis();
  const stored = await redis.get(`otp:register:${email.toLowerCase()}`);
  if (!stored) return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });

  const data = JSON.parse(stored);
  if (data.otp !== otp.toString())
    return res.status(400).json({ error: 'Invalid OTP. Please try again.' });

  await redis.del(`otp:register:${email.toLowerCase()}`);

  const hash = await bcrypt.hash(data.password, 12);
  const { rows: [user] } = await query(
    `INSERT INTO users (username, email, password_hash, display_name)
     VALUES ($1,$2,$3,$4)
     RETURNING id, username, email, display_name, role, created_at`,
    [data.username.toLowerCase(), data.email.toLowerCase(), hash, data.displayName || data.username]
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

// FORGOT PASSWORD — SEND OTP
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { rows: [user] } = await query('SELECT id, email FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!user) return res.json({ ok: true, message: 'If this email exists, an OTP has been sent.' });

  const otp = generateOTP();
  const redis = getRedis();
  await redis.setex(
    `otp:reset:${email.toLowerCase()}`, 600,
    JSON.stringify({ otp, userId: user.id })
  );
  await sendOTPEmail(email, otp, 'reset');
  res.json({ ok: true, message: 'OTP sent to your email' });
}));

// RESET PASSWORD
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ error: 'Email, OTP and new password required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const redis = getRedis();
  const stored = await redis.get(`otp:reset:${email.toLowerCase()}`);
  if (!stored) return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });

  const data = JSON.parse(stored);
  if (data.otp !== otp.toString())
    return res.status(400).json({ error: 'Invalid OTP. Please try again.' });

  await redis.del(`otp:reset:${email.toLowerCase()}`);

  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, data.userId]);

  res.json({ ok: true, message: 'Password reset successfully! Please login.' });
}));

// REGISTER — now OTP gated
router.post('/register', asyncHandler(async (req, res) => {
  return res.status(400).json({ error: 'Please use /send-otp and /verify-otp to register.' });
}));

// LOGIN
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { rows: [user] } = await query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

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

// REFRESH
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

// LOGOUT
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

// ME
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