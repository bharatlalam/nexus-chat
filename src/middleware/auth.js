const jwt = require('jsonwebtoken');

const JWT_SECRET          = process.env.JWT_SECRET          || 'dev_secret';
const JWT_REFRESH_SECRET  = process.env.JWT_REFRESH_SECRET  || 'dev_refresh';
const JWT_EXPIRES         = process.env.JWT_EXPIRES_IN      || '15m';
const JWT_REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

function signToken(userId, role) {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function signRefreshToken(userId) {
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authorization header missing' });
  try {
    req.user = verifyToken(header.split(' ')[1]);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

module.exports = {
  signToken, signRefreshToken,
  verifyToken, verifyRefreshToken,
  requireAuth, requireRole,
};