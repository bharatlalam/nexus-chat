const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'nexus_chat',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      }
);

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error:', err);
});

async function connectDB() {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
}

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  logger.debug(`query [${Date.now() - start}ms] ${text.slice(0, 80)}`);
  return res;
}

async function getClient() {
  const client = await pool.connect();
  const origRelease = client.release.bind(client);
  const timeout = setTimeout(() => {
    logger.warn('Client held for >5s — possible connection leak');
  }, 5000);
  client.release = () => {
    clearTimeout(timeout);
    return origRelease();
  };
  return client;
}

module.exports = { pool, query, getClient, connectDB };