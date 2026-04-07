'use strict';
const jwt    = require('jsonwebtoken');
const logger = require('../lib/logger');
const { HTTP, JWT } = require('../utils/constants');

const DEV_TOKEN = process.env.DEV_TOKEN || null;

function verifyToken(req, res, next) {
  if (req.path === '/auth/login') return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('verify-token', 'Missing or malformed Authorization header', {
      path: req.path,
      ip:   req.ip,
    });
    return res.status(HTTP.UNAUTHORIZED).json({
      error:   'unauthorized',
      message: 'Missing Bearer token',
    });
  }

  const token = authHeader.slice(7);

  // ── DEV BYPASS ───────────────────────────────────────────────────────────
  // Only active if DEV_TOKEN env var is set on HF Space
  // Remove this block before going live 🔐
  if (DEV_TOKEN && token === DEV_TOKEN) {
    logger.warn('verify-token', 'DEV_TOKEN bypass used', { path: req.path });
    req.user = { 
  id: '00000000-0000-0000-0000-000000000000', // valid UUID for dev
  email: 'dev@nexus.local', 
  role: 'dev' 
    });
  }
  
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: [JWT.ALGORITHM],
    });
    req.user = decoded;
    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    logger.warn('verify-token', isExpired ? 'Token expired' : 'Invalid token', {
      path:  req.path,
      error: err.message,
    });
    return res.status(HTTP.UNAUTHORIZED).json({
      error:   isExpired ? 'token_expired' : 'invalid_token',
      message: isExpired ? 'Token expired — please log in again' : 'Invalid token',
    });
  }
}

module.exports = verifyToken;
