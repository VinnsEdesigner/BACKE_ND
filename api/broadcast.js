'use strict';

const { query } = require('../lib/supabase');
const logger = require('../lib/logger');
const { HTTP, SSE, TABLES } = require('../utils/constants');

// Active SSE connections: Map<userId, Set<res>>
const connections = new Map();

// ── SUBSCRIBE (GET /api/broadcast) ───────────────────────────────────────────

async function subscribe(req, res) {
  const { userId } = req.user;
  const lastEventId = req.headers['last-event-id'] || null;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering on HF Spaces
  res.flushHeaders();

  // Register connection
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId).add(res);

  logger.info('broadcast:subscribe', 'SSE client connected', {
    userId,
    lastEventId,
    totalConnections: connections.get(userId).size,
  });

  // Replay missed messages if client reconnecting
  if (lastEventId) {
    await replayMissed(userId, lastEventId, res);
  }

  // Heartbeat — 15s ping to keep connection alive + prevent tab sleep
  const heartbeat = setInterval(() => {
    sendToRes(res, {
      id: `hb-${Date.now()}`,
      type: SSE.EVENT_TYPES.HEARTBEAT,
      content: 'ping',
      timestamp: new Date().toISOString(),
    });
  }, SSE.HEARTBEAT_INTERVAL_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const userConns = connections.get(userId);
    if (userConns) {
      userConns.delete(res);
      if (userConns.size === 0) connections.delete(userId);
    }
    logger.info('broadcast:subscribe', 'SSE client disconnected', { userId });
  });
}

// ── EMIT (called internally by broadcastEmitter) ──────────────────────────────

async function emit(userId, message) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: message.type,
    content: message.content,
    timestamp: new Date().toISOString(),
  };

  const userConns = connections.get(userId);

  if (userConns && userConns.size > 0) {
    // Dashboard online — push immediately
    for (const res of userConns) {
      sendToRes(res, event);
    }
    logger.debug('broadcast:emit', 'Pushed to live connections', {
      userId,
      type: event.type,
      connections: userConns.size,
    });
  } else {
    // Dashboard offline — buffer in Supabase
    try {
      await query(TABLES.BROADCAST_QUEUE, 'insert', {
        data: {
          user_id: userId,
          event_id: event.id,
          type: event.type,
          content: event.content,
          created_at: event.timestamp,
        },
      });
      logger.debug('broadcast:emit', 'Buffered to broadcast_queue', {
        userId,
        type: event.type,
      });
    } catch (err) {
      logger.error('broadcast:emit', 'Failed to buffer message', err);
    }
  }
}

// ── REPLAY MISSED MESSAGES ────────────────────────────────────────────────────

async function replayMissed(userId, lastEventId, res) {
  try {
    const rows = await query(TABLES.BROADCAST_QUEUE, 'select', {
      filters: { user_id: userId },
      order: { column: 'created_at', ascending: true },
    });

    if (!rows || rows.length === 0) return;

    logger.info('broadcast:replay', `Replaying ${rows.length} buffered messages`, { userId });

    for (const row of rows) {
      sendToRes(res, {
        id: row.event_id,
        type: row.type,
        content: row.content,
        timestamp: row.created_at,
      });
    }

    // Clear delivered messages
    await query(TABLES.BROADCAST_QUEUE, 'delete', {
      filters: { user_id: userId },
    });
  } catch (err) {
    logger.error('broadcast:replay', 'Failed to replay messages', err);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function sendToRes(res, event) {
  try {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (err) {
    // Connection already closed — ignore
  }
}

// ── ACTIVE CONNECTION COUNT (for health checks) ───────────────────────────────

function getConnectionCount() {
  let total = 0;
  for (const conns of connections.values()) total += conns.size;
  return total;
}

module.exports = { subscribe, emit, getConnectionCount };
