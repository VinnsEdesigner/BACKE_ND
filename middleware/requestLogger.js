'use strict';

const { query } = require('../lib/supabase');
const logger    = require('../lib/logger');
const { TABLES } = require('../utils/constants');

// ── REQUEST LOGGER ────────────────────────────────────────────────────────────
// Logs every API request to Supabase logs table.
// Captures: endpoint, method, duration, status, tokens, model, errors.
// Non-fatal — never blocks a request.

function requestLogger(req, res, next) {
  const start    = Date.now();
  const { path, method } = req;

  // Capture response finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const userId   = req.user?.userId || null;

    // Only log API routes
    if (!path.startsWith('/api/')) return;

    // Skip high-frequency noise routes
    const SKIP = ['/api/warmup', '/api/health', '/api/broadcast'];
    if (SKIP.some((s) => path.startsWith(s))) return;

    // Log async — never block response
    query(TABLES.LOGS, 'insert', {
      data: {
        user_id:     userId,
        endpoint:    path,
        method,
        status:      res.statusCode,
        duration_ms: duration,
        model:       res.locals?.model     || null,
        tokens_used: res.locals?.tokens    || null,
        error:       res.locals?.error     || null,
        created_at:  new Date().toISOString(),
      },
    }).catch((err) => {
      logger.warn('requestLogger', 'Failed to persist log', err);
    });
  });

  next();
}

module.exports = requestLogger;
