'use strict';

const { Redis } = require('@upstash/redis');
const logger = require('../lib/logger');
const { HTTP, RATE_LIMITS } = require('../utils/constants');

let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  _redis = new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });
  return _redis;
}

// Map route prefixes to their per-hour limits
const ROUTE_LIMITS = {
  '/api/agent':         RATE_LIMITS.AGENT,
  '/api/lite-agent':    RATE_LIMITS.LITE_AGENT,
  '/api/scraper-agent': RATE_LIMITS.SCRAPER_AGENT,
  '/api/github':        RATE_LIMITS.GITHUB,
  '/api/search':        RATE_LIMITS.SEARCH,
};

function getLimitForRoute(path) {
  for (const [prefix, limit] of Object.entries(ROUTE_LIMITS)) {
    if (path.startsWith(prefix)) return limit;
  }
  return null; // no limit for this route
}

function rateLimit(req, res, next) {
  const limit = getLimitForRoute(req.path);
  if (!limit) return next(); // route not rate-limited

  const userId = req.user?.userId || req.ip;
  const window = 'hour';
  // BUG6 FIX: use full path sanitized, not just [2] segment
  // /api/agent → 'agent', /api/agent/status → 'agent_status'
  const routeKey = req.path.replace(/^\/api\//, '').replace(/\//g, '_');
  const key = `rl:${userId}:${routeKey}:${window}:${Math.floor(Date.now() / 3_600_000)}`;

  const redis = getRedis();

  // Fire-and-forget rate check (non-blocking)
  redis.incr(key)
    .then((count) => {
      // Set TTL on first request in window
      if (count === 1) {
        redis.expire(key, 3600).catch(() => {});
      }

      const remaining = Math.max(0, limit - count);
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);

      // Warn at 80% usage
      if (count >= limit * 0.8 && count < limit) {
        logger.warn('rate-limit', `${userId} at ${Math.round((count/limit)*100)}% quota`, {
          route: req.path,
          count,
          limit,
        });
      }

      if (count > limit) {
        logger.warn('rate-limit', `${userId} rate limited`, {
          route: req.path,
          count,
          limit,
        });
        return res.status(HTTP.TOO_MANY_REQUESTS).json({
          error: 'rate_limited',
          message: `Limit: ${limit} requests/hour. Resets in ${60 - new Date().getMinutes()} minutes.`,
          remaining: 0,
        });
      }

      next();
    })
    .catch((err) => {
      // Redis failure — fail open (don't block requests)
      logger.error('rate-limit', 'Redis error — failing open', err);
      next();
    });
}

module.exports = rateLimit;
