'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('../lib/supabase');
const logger = require('../lib/logger');
const { HTTP, JWT, TABLES } = require('../utils/constants');

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// PIN-based auth. PIN stored in HF env vars as ACCESS_PIN.
// No OAuth. No user management. Solo tool.

async function login(req, res) {
  const { pin } = req.body;

  if (!pin) {
    return res.status(HTTP.BAD_REQUEST).json({
      error: 'bad_request',
      message: 'PIN required',
    });
  }

  const validPin = process.env.ACCESS_PIN;
  if (!validPin) {
    logger.error('auth:login', 'ACCESS_PIN not set in env vars');
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error: 'server_error',
      message: 'Auth not configured',
    });
  }

  if (pin !== validPin) {
    logger.warn('auth:login', 'Invalid PIN attempt', { ip: req.ip });
    return res.status(HTTP.UNAUTHORIZED).json({
      error: 'invalid_pin',
      message: 'Invalid PIN',
    });
  }

  // Issue JWT
  const userId = process.env.GITHUB_USERNAME; // solo tool — userId = github username
  const token = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: JWT.EXPIRES_IN, algorithm: JWT.ALGORITHM }
  );

  // Upsert user record
  try {
    await query(TABLES.USERS, 'upsert', {
      data: {
        id: userId,
        github_username: userId,
        last_login: new Date().toISOString(),
      },
      onConflict: 'id',
    });
  } catch (err) {
    // Non-fatal — token still issued
    logger.warn('auth:login', 'Failed to upsert user record', err);
  }

  logger.info('auth:login', 'Login successful', { userId });

  return res.status(HTTP.OK).json({
    token,
    user: { id: userId },
    expires_in: JWT.EXPIRES_IN,
  });
}

// ── REFRESH ───────────────────────────────────────────────────────────────────

async function refresh(req, res) {
  // req.user is set by verifyToken middleware
  const { userId } = req.user;

  const token = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: JWT.EXPIRES_IN, algorithm: JWT.ALGORITHM }
  );

  logger.info('auth:refresh', 'Token refreshed', { userId });

  return res.status(HTTP.OK).json({
    token,
    expires_in: JWT.EXPIRES_IN,
  });
}

// ── VERIFY ────────────────────────────────────────────────────────────────────

async function verify(req, res) {
  // If we reach here, verifyToken middleware already validated the token
  return res.status(HTTP.OK).json({
    valid: true,
    user: req.user,
  });
}

module.exports = { login, refresh, verify };
