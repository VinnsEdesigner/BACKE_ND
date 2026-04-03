'use strict';

const cors = require('cors');

const ALLOWED_ORIGINS = [
  'https://vinnsEdesigner.github.io',  // dashboard
  'http://localhost:3000',              // local dev
  'http://localhost:5500',              // live server dev
];

const corsMiddleware = cors({
  origin(origin, callback) {
    // Allow requests with no origin (bookmarklet, mobile apps, curl)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
  credentials: true,
  maxAge: 86400, // 24hr preflight cache
});

module.exports = corsMiddleware;
