'use strict';

/**
 * @file requestLogger.js
 * @location /backend/middleware/requestLogger.js
 *
 * Verbose HTTP request/response logger.
 * Logs: method, path, status, duration, userId, body size, error.
 * Every API ping hitting the server will appear in container logs.
 */

const logger = require('../lib/logger');

// Paths too noisy to log at info level — demoted to debug
const NOISY_PATHS = new Set([
  '/api/warmup',
  '/api/broadcast',   // SSE heartbeats spam logs
]);

// Body fields to redact in request logging
const SENSITIVE_BODY_KEYS = new Set(['pin', 'password', 'token', 'secret', 'key']);

function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = SENSITIVE_BODY_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function requestLogger(req, res, next) {
  const start    = Date.now();
  const method   = req.method;
  const path     = req.path;
  const isNoisy  = NOISY_PATHS.has(path);

  // Capture response finish
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const status     = res.statusCode;
    const userId     = req.user?.userId || 'anon';

    // Build meta for the log entry
    const meta = {
      method,
      path,
      status,
      durationMs,
      userId,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    };

    // Include request body summary (never full, never sensitive)
    if (req.body && Object.keys(req.body).length > 0) {
      const redacted = redactBody(req.body);
      // Summarize large bodies — show keys + truncated values
      const bodyKeys = Object.keys(redacted);
      if (bodyKeys.length <= 6) {
        meta.body = redacted;
      } else {
        meta.body = { keys: bodyKeys, size: JSON.stringify(req.body).length };
      }
    }

    // Pick log level based on status + path
    if (status >= 500) {
      logger.error('http', `${method} ${path} → ${status} (${durationMs}ms)`, meta);
    } else if (status >= 400) {
      logger.warn('http', `${method} ${path} → ${status} (${durationMs}ms)`, meta);
    } else if (isNoisy) {
      logger.debug('http', `${method} ${path} → ${status} (${durationMs}ms)`, meta);
    } else {
      logger.info('http', `${method} ${path} → ${status} (${durationMs}ms)`, meta);
    }
  });

  // Log errors that happen during request handling
  res.on('error', (err) => {
    logger.error('http', `${method} ${path} — response error: ${err.message}`, {
      method, path,
      error: err.message,
      stack: err.stack?.slice(0, 300),
    });
  });

  next();
}

module.exports = requestLogger;
