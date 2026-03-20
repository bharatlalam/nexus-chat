const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient, redisSub, redisPub;

async function connectRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  redisClient = new Redis(url);
  redisSub    = new Redis(url);
  redisPub    = new Redis(url);
  await redisClient.ping();
}

function getRedis()    { return redisClient; }
function getRedisSub() { return redisSub; }
function getRedisPub() { return redisPub; }

const TTL = 60;

async function setUserOnline(userId) {
  await redisClient.setex(`presence:${userId}`, TTL, '1');
  await redisPub.publish('presence', JSON.stringify({ userId, status: 'online' }));
}

async function setUserOffline(userId) {
  await redisClient.del(`presence:${userId}`);
  await redisPub.publish('presence', JSON.stringify({ userId, status: 'offline' }));
}

async function isUserOnline(userId) {
  return (await redisClient.get(`presence:${userId}`)) !== null;
}

async function refreshPresence(userId) {
  await redisClient.expire(`presence:${userId}`, TTL);
}

async function setTyping(roomId, userId, displayName) {
  await redisClient.setex(`typing:${roomId}:${userId}`, 5, displayName);
  await redisPub.publish('typing', JSON.stringify({ roomId, userId, displayName, action: 'start' }));
}

async function clearTyping(roomId, userId) {
  await redisClient.del(`typing:${roomId}:${userId}`);
  await redisPub.publish('typing', JSON.stringify({ roomId, userId, action: 'stop' }));
}

async function getTypingUsers(roomId) {
  const keys = await redisClient.keys(`typing:${roomId}:*`);
  if (!keys.length) return [];
  const vals = await redisClient.mget(...keys);
  return keys.map((k, i) => ({
    userId: k.split(':')[2],
    displayName: vals[i],
  })).filter(u => u.displayName);
}

async function cacheToken(userId, token, ttlSeconds) {
  await redisClient.setex(`session:${userId}`, ttlSeconds, token);
}

async function invalidateToken(userId) {
  await redisClient.del(`session:${userId}`);
}

async function publishToRoom(roomId, event, payload) {
  await redisPub.publish(`room:${roomId}`, JSON.stringify({ event, payload }));
}

module.exports = {
  connectRedis, getRedis, getRedisSub, getRedisPub,
  setUserOnline, setUserOffline, isUserOnline, refreshPresence,
  setTyping, clearTyping, getTypingUsers,
  cacheToken, invalidateToken, publishToRoom,
};