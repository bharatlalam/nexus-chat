const { Server } = require('socket.io');
const { verifyToken } = require('../middleware/auth');
const { query } = require('../db/pool');
const {
  setUserOnline, setUserOffline, refreshPresence,
  setTyping, clearTyping, getTypingUsers, getRedisSub,
} = require('../services/redis');
const { streamAIReply, shouldTriggerAI } = require('../services/ai');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 10000,
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));
      const decoded = verifyToken(token);
      const { rows } = await query(
        'SELECT id, username, display_name, avatar_url, role FROM users WHERE id=$1',
        [decoded.userId]
      );
      if (!rows.length) return next(new Error('User not found'));
      socket.user = rows[0];
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    logger.info(`Socket connected: ${user.username} (${socket.id})`);

    socket.join(`user:${user.id}`);

    await setUserOnline(user.id);
    socket.broadcast.emit('user:online', { userId: user.id });

    const { rows: memberships } = await query(
      'SELECT room_id FROM room_members WHERE user_id=$1', [user.id]
    );
    for (const m of memberships) socket.join(`room:${m.room_id}`);

    socket.on('message:send', async (data, ack) => {
      try {
        const { roomId, content, contentType = 'text', replyTo, isPrivateAI = false } = data;
        if (!roomId || !content?.trim()) return;

        const { rows: mem } = await query(
          'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
          [roomId, user.id]
        );
        if (!mem.length) return socket.emit('error', { message: 'Not a room member' });

        const msgId = uuidv4();
        const { rows: [msg] } = await query(
          `INSERT INTO messages
             (id, room_id, sender_id, sender_type, content, content_type, reply_to, is_private, private_user_id)
           VALUES ($1,$2,$3,'human',$4,$5,$6,$7,$8) RETURNING *`,
          [msgId, roomId, user.id, content.trim(), contentType, replyTo || null, isPrivateAI, isPrivateAI ? user.id : null]
        );

        let replyToMsg = null;
        if (msg.reply_to) {
          const { rows: [replyMsg] } = await query(
            `SELECT m.id, m.content, u.username,
                    json_build_object('id', u.id, 'display_name', u.display_name, 'avatar_url', u.avatar_url) AS sender
             FROM messages m
             LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.id = $1`,
            [msg.reply_to]
          );
          replyToMsg = replyMsg || null;
        }

        const msgPayload = {
          ...msg,
          sender: {
            id: user.id, username: user.username,
            displayName: user.display_name, avatarUrl: user.avatar_url,
          },
          reply_to_msg: replyToMsg,
        };

        if (isPrivateAI) {
          socket.emit('message:new', msgPayload);
        } else {
          io.to(`room:${roomId}`).emit('message:new', msgPayload);
        }

        if (ack) ack({ ok: true, messageId: msgId });

        if (shouldTriggerAI(content)) {
          handleAIResponse(roomId, content, msgId, isPrivateAI, user.id, socket);
        }
      } catch (err) {
        logger.error('message:send error', err);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('typing:start', async ({ roomId }) => {
      if (!roomId) return;
      await setTyping(roomId, user.id, user.display_name || user.username);
      socket.to(`room:${roomId}`).emit('typing:update', {
        roomId, userId: user.id,
        displayName: user.display_name || user.username, action: 'start',
      });
    });

    socket.on('typing:stop', async ({ roomId }) => {
      if (!roomId) return;
      await clearTyping(roomId, user.id);
      socket.to(`room:${roomId}`).emit('typing:update', { roomId, userId: user.id, action: 'stop' });
    });

    socket.on('room:join', async ({ roomId }, ack) => {
      try {
        const { rows } = await query(
          'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, user.id]
        );
        if (!rows.length) return ack?.({ ok: false, error: 'Not a member' });
        socket.join(`room:${roomId}`);
        const typing = await getTypingUsers(roomId);
        ack?.({ ok: true, typing });
      } catch (err) { logger.error('room:join error', err); }
    });

    socket.on('reaction:toggle', async ({ messageId, emoji }, ack) => {
      try {
        const { rows: ex } = await query(
          'SELECT 1 FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',
          [messageId, user.id, emoji]
        );
        if (ex.length) {
          await query('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',
            [messageId, user.id, emoji]);
        } else {
          await query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)',
            [messageId, user.id, emoji]);
        }
        const { rows: counts } = await query(
          `SELECT emoji, COUNT(*) AS count FROM reactions WHERE message_id=$1 GROUP BY emoji`,
          [messageId]
        );
        const { rows: [msgRow] } = await query('SELECT room_id FROM messages WHERE id=$1', [messageId]);
        if (msgRow) io.to(`room:${msgRow.room_id}`).emit('reaction:updated', { messageId, reactions: counts });
        ack?.({ ok: true });
      } catch (err) { logger.error('reaction:toggle error', err); }
    });

    socket.on('message:edit', async ({ messageId, content }, ack) => {
      try {
        const { rows: [msg] } = await query(
          `UPDATE messages SET content=$1, edited_at=NOW()
           WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING *`,
          [content.trim(), messageId, user.id]
        );
        if (!msg) return ack?.({ ok: false, error: 'Not found or not owner' });
        io.to(`room:${msg.room_id}`).emit('message:edited', {
          messageId, content: msg.content, editedAt: msg.edited_at,
        });
        ack?.({ ok: true });
      } catch (err) { logger.error('message:edit error', err); }
    });

    socket.on('message:delete', async ({ messageId }, ack) => {
      try {
        const { rows: [msg] } = await query(
          `UPDATE messages SET deleted_at=NOW()
           WHERE id=$1 AND sender_id=$2 AND deleted_at IS NULL RETURNING room_id`,
          [messageId, user.id]
        );
        if (!msg) return ack?.({ ok: false, error: 'Not found or not owner' });
        io.to(`room:${msg.room_id}`).emit('message:deleted', { messageId });
        ack?.({ ok: true });
      } catch (err) { logger.error('message:delete error', err); }
    });

    socket.on('ping:presence', async () => { await refreshPresence(user.id); });

    socket.on('disconnect', async () => {
      logger.info(`Socket disconnected: ${user.username}`);
      await setUserOffline(user.id);
      await query('UPDATE users SET is_online=FALSE, last_seen=NOW() WHERE id=$1', [user.id]);
      io.emit('user:offline', { userId: user.id, lastSeen: new Date() });
    });
  });

  subscribeRedisChannels();
  logger.info('Socket.io ready');
  return io;
}

async function handleAIResponse(roomId, userMessage, triggerMsgId, isPrivate, userId, senderSocket) {
  const aiMsgId = uuidv4();

  if (isPrivate) {
    senderSocket.emit('ai:typing', { roomId, messageId: aiMsgId });
  } else {
    io.to(`room:${roomId}`).emit('ai:typing', { roomId, messageId: aiMsgId });
  }

  let fullContent = '';
  try {
    await streamAIReply(roomId, userMessage, (chunk) => {
      fullContent += chunk;
      if (isPrivate) {
        senderSocket.emit('ai:chunk', { messageId: aiMsgId, chunk, roomId });
      } else {
        io.to(`room:${roomId}`).emit('ai:chunk', { messageId: aiMsgId, chunk, roomId });
      }
    });

    await query(
      `INSERT INTO messages (id, room_id, sender_id, sender_type, content, content_type, reply_to, is_private, private_user_id)
       VALUES ($1,$2,NULL,'ai',$3,'text',$4,$5,$6)`,
      [aiMsgId, roomId, fullContent, triggerMsgId, isPrivate, isPrivate ? userId : null]
    );

    const aiDonePayload = {
      messageId: aiMsgId, roomId,
      content: fullContent, replyTo: triggerMsgId,
      createdAt: new Date(), isPrivate,
      private_user_id: isPrivate ? userId : null,
    };

    if (isPrivate) {
      senderSocket.emit('ai:done', aiDonePayload);
    } else {
      io.to(`room:${roomId}`).emit('ai:done', aiDonePayload);
    }
  } catch (err) {
    logger.error('AI response error:', err);
    senderSocket.emit('ai:error', { roomId, error: 'Aria ran into a problem.' });
  }
}

function subscribeRedisChannels() {
  const sub = getRedisSub();
  sub.subscribe('presence', 'typing', (err) => {
    if (err) logger.error('Redis subscribe error:', err);
  });
  sub.on('message', (channel, message) => {
    try {
      const data = JSON.parse(message);
      if (channel === 'presence') io.emit(`user:${data.status}`, { userId: data.userId });
      if (channel === 'typing' && data.roomId)
        io.to(`room:${data.roomId}`).emit('typing:update', data);
    } catch (err) { logger.error('Redis message parse error:', err); }
  });
}

function getIO() { return io; }
module.exports = { initSocket, getIO };