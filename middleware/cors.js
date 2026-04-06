'use strict';

const cors = require('cors');

const ALLOWED_ORIGINS = [
  'https://vinnsedesigner.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
];

const corsMiddleware = cors({
  origin(origin, callback) {
    // Allow no-origin requests (bookmarklet, curl, mobile)
    if (!origin) return callback(null, true);

    // Allow known origins
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

    // Unknown origin (injected scraper on random sites) — allow but don't crash
    return callback(null, true); // ← was: callback(new Error(...)) which caused 500
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
  credentials: true,
  maxAge: 86400,
});

module.exports = corsMiddleware;
