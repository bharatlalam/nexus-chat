const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  if (status >= 500)
    logger.error(`[${req.method}] ${req.path} — ${status}: ${message}`);
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

function asyncHandler(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { errorHandler, asyncHandler };