const Groq = require('groq-sdk');
const { query } = require('../db/pool');
const logger = require('../utils/logger');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.AI_MODEL || 'llama-3.1-8b-instant';
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS) || 1024;

const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  `You are Aria, a helpful AI assistant in Nexus Chat. Be concise and friendly.`;

async function getRoomContext(roomId, limit = 20) {
  const { rows } = await query(
    `SELECT m.content, m.sender_type, u.display_name
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1
       AND m.deleted_at IS NULL
       AND m.content_type = 'text'
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [roomId, limit]
  );
  return rows.reverse();
}

function buildMessages(contextRows, userMessage) {
  const messages = [];
  for (const row of contextRows) {
    if (row.sender_type === 'ai') {
      messages.push({ role: 'assistant', content: row.content });
    } else {
      messages.push({ role: 'user', content: `[${row.display_name || 'User'}]: ${row.content}` });
    }
  }
  if (!contextRows.length || contextRows[contextRows.length - 1].content !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}

async function streamAIReply(roomId, userMessage, onChunk) {
  const context  = await getRoomContext(roomId);
  const messages = buildMessages(context, userMessage);
  logger.info(`AI stream — room:${roomId} msgs:${messages.length}`);

  let full = '';

  const stream = await client.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      full += text;
      if (onChunk) onChunk(text);
    }
  }

  logger.info(`AI done — ${full.length} chars`);
  return { content: full };
}

function shouldTriggerAI(content) {
  return /(@aria|@ai)\b/i.test(content) || /^aria[,:\s]/i.test(content.trim());
}

module.exports = { streamAIReply, shouldTriggerAI };