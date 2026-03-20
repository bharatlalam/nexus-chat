require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('./pool');
const logger = require('../utils/logger');

async function seed() {
  logger.info('Seeding database...');

  const hash = await bcrypt.hash('admin1234', 12);
  const { rows: [admin] } = await query(
    `INSERT INTO users (username, email, password_hash, display_name, role)
     VALUES ('admin', 'admin@nexus.chat', $1, 'Admin', 'admin')
     ON CONFLICT (email) DO UPDATE SET display_name='Admin'
     RETURNING id`,
    [hash]
  );
  logger.info('✓ Admin: admin@nexus.chat / admin1234');

  const rooms = [
    { name: 'general',  slug: 'general',  desc: 'Team-wide chat' },
    { name: 'dev-talk', slug: 'dev-talk', desc: 'Engineering' },
    { name: 'design',   slug: 'design',   desc: 'Design' },
    { name: 'random',   slug: 'random',   desc: 'Off-topic' },
  ];

  for (const r of rooms) {
    const { rows: [room] } = await query(
      `INSERT INTO rooms (name, slug, description, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET description=EXCLUDED.description
       RETURNING id`,
      [r.name, r.slug, r.desc, admin.id]
    );
    await query(
      "INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING",
      [room.id, admin.id]
    );
    logger.info(`✓ Room: #${r.slug}`);
  }

  logger.info('Seed complete');
  await pool.end();
}

seed().catch(err => { logger.error('Seed failed:', err); process.exit(1); });