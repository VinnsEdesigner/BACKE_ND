'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../lib/logger');
const { HTTP, JWT } = require('../utils/constants');

function verifyToken(req, res, next) {
  // Skip auth for login route
  if (req.path === '/auth/login') return next();
  const authHeader = req.headers['authorization'];
}

if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('verify-token', 'Missing or malformed Authorization header', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(HTTP.UNAUTHORIZED).json({
      error: 'unauthorized',
      message: 'Missing Bearer token',
    });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: [JWT.ALGORITHM],
    });

    req.user = decoded; // { userId, iat, exp }
    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    logger.warn('verify-token', isExpired ? 'Token expired' : 'Invalid token', {
      path: req.path,
      error: err.message,
    });

    return res.status(HTTP.UNAUTHORIZED).json({
      error: isExpired ? 'token_expired' : 'invalid_token',
      message: isExpired ? 'Token expired — please log in again' : 'Invalid token',
    });
  }
}

module.exports = verifyToken;
