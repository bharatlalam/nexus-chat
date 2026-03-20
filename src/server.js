require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initSocket } = require('./socket');
const { connectDB } = require('./db/pool');
const { connectRedis } = require('./services/redis');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 3001;

async function bootstrap() {
  await connectDB();
  logger.info('✓ PostgreSQL connected');
  await connectRedis();
  logger.info('✓ Redis connected');
  const server = http.createServer(app);
  initSocket(server);
  logger.info('✓ Socket.io initialized');
  server.listen(PORT, () => {
    logger.info(`✓ Nexus backend running on port ${PORT}`);
    logger.info(`✓ Aria (${process.env.AI_MODEL}) — AI engine online`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));
}

bootstrap().catch(err => { logger.error('Failed to start:', err); process.exit(1); });