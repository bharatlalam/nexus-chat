require('dotenv').config();
const { pool } = require('./pool');
const logger = require('../utils/logger');

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      VARCHAR(32)  UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(64),
  avatar_url    TEXT,
  bio           TEXT,
  role          VARCHAR(16)  NOT NULL DEFAULT 'member'
                             CHECK (role IN ('admin','member')),
  is_online     BOOLEAN      NOT NULL DEFAULT FALSE,
  last_seen     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(64)  NOT NULL,
  slug        VARCHAR(64)  UNIQUE NOT NULL,
  description TEXT,
  type        VARCHAR(16)  NOT NULL DEFAULT 'channel'
                           CHECK (type IN ('channel','dm','group')),
  is_private  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id   UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  role      VARCHAR(16) NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner','admin','member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id      UUID         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
  sender_type  VARCHAR(8)   NOT NULL DEFAULT 'human'
                            CHECK (sender_type IN ('human','ai')),
  content      TEXT         NOT NULL,
  content_type VARCHAR(16)  NOT NULL DEFAULT 'text'
                            CHECK (content_type IN ('text','file','image','system')),
  metadata     JSONB        DEFAULT '{}',
  reply_to     UUID         REFERENCES messages(id) ON DELETE SET NULL,
  edited_at    TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id  UUID  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename    TEXT  NOT NULL,
  mime_type   TEXT  NOT NULL,
  size_bytes  INT   NOT NULL,
  s3_key      TEXT  NOT NULL,
  url         TEXT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id)    ON DELETE CASCADE,
  emoji      VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender       ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user     ON room_members (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower      ON follows (follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following     ON follows (following_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_rooms_updated_at ON rooms;
CREATE TRIGGER trg_rooms_updated_at
  BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    logger.info('Running migrations...');
    await client.query(SCHEMA);
    logger.info('✓ Migrations complete');
  } catch (err) {
    logger.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();