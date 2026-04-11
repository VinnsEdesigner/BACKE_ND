/**
 * @file server.js
 * @location /backend/server.js
 *
 * @purpose
 * Express application entry point.
 * Mounts all middleware and route handlers.
 * Starts HTTP server on PORT (default 7860 for HF Spaces).
 *
 * Changes from previous version:
 *   → Added: import visionHandler from api/vision.js
 *   → Added: POST /api/vision route (Phase 4, protected + rate-limited)
 *   → Everything else unchanged
 *
 * @exports
 *   app — Express instance (for testing)
 *
 * @dependency-level 9
 */

'use strict';

require('dotenv').config();

const { checkEnv } = require('./utils/env-check');
checkEnv();

const express = require('express');
const logger  = require('./lib/logger');

// ── Middleware ─────────────────────────────────────────────────────────────────
const corsMiddleware = require('./middleware/cors');
const verifyToken    = require('./middleware/verify-token');
const rateLimit      = require('./middleware/rate-limit');
const requestLogger  = require('./middleware/requestLogger');

// ── Route handlers ─────────────────────────────────────────────────────────────
const { login, refresh, verify }                     = require('./api/auth');
const health                                          = require('./api/health');
const warmup                                          = require('./api/warmup');
const testModels                                      = require('./api/test-models');
const { subscribe: broadcastSubscribe }               = require('./api/broadcast');
const scraperAgent                                    = require('./api/scraper-agent');
const { liteAgent }                                   = require('./api/lite-agent');
const sync                                            = require('./api/sync');
const { getSettings, patchSettings }                  = require('./api/settings');
const { listSessions, getSession,
        createSession, updateSession,
        deleteSession }                               = require('./api/session');
const { githubHandler,
        rollbackHandler,
        treeHandler }                                 = require('./api/github');
const { agent, switchModel, agentStatus }             = require('./api/agent');
const { search: searchHandler, searchStatus }         = require('./api/search');
const visionHandler                                   = require('./api/vision');   // ← NEW

// ── App ────────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 7860;

// ── Global middleware ──────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.use((req, res, next) => {
  logger.debug('server', `${req.method} ${req.path}`);
  next();
});

// ── Public routes ──────────────────────────────────────────────────────────────
app.get('/api/health',      health);
app.get('/api/warmup',      warmup);
app.get('/api/test-models', testModels);
app.post('/api/auth/login', login);

// ── Scraper bundle — public, CORS open ────────────────────────────────────────
// GET /scraper.js → serves build/scraper.js
// Cache-Control: no-cache so every bookmarklet load gets latest build
app.get('/scraper.js', (req, res) => {
  const path = require('path');
  const fs   = require('fs');
  const filePath = path.join(__dirname, 'build', 'scraper.js');

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('// scraper.js not built yet');
  }

  res.setHeader('Content-Type',  'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(filePath);
});

// ── Protected routes (JWT required) ───────────────────────────────────────────
app.use('/api', verifyToken);

app.post('/api/auth/refresh', refresh);
app.get('/api/auth/verify',   verify);
app.get('/api/broadcast',     broadcastSubscribe);

// ── Rate-limited routes ────────────────────────────────────────────────────────
app.use('/api', rateLimit);

// Phase 2 — Scraper pipeline
app.post('/api/scraper-agent', scraperAgent);
app.post('/api/lite-agent',    liteAgent);
app.get('/api/sync',           sync);

// Phase 3 — GitHub + Sessions + Settings
app.get('/api/settings',         getSettings);
app.patch('/api/settings',       patchSettings);
app.get('/api/session',          listSessions);
app.post('/api/session',         createSession);
app.get('/api/session/:id',      getSession);
app.patch('/api/session/:id',    updateSession);
app.delete('/api/session/:id',   deleteSession);
app.post('/api/github',          githubHandler);
app.post('/api/github/rollback', rollbackHandler);
app.get('/api/github/tree',      treeHandler);

// Phase 4 — AI Agent + Search + Vision
app.post('/api/agent',         agent);
app.patch('/api/active-model', switchModel);
app.get('/api/agent/status',   agentStatus);
app.post('/api/search',        searchHandler);
app.get('/api/search/status',  searchStatus);
app.post('/api/vision',        visionHandler);   // ← NEW

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:   'not_found',
    message: `Route ${req.method} ${req.path} does not exist`,
  });
});

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('server', 'Unhandled error', err);
  res.status(500).json({
    error:   'internal_server_error',
    message: 'Something went wrong',
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server', `🚀 Nexus running on port ${PORT}`, {
    env:      process.env.NODE_ENV || 'development',
    hf_space: process.env.HF_SPACE_URL || 'not set',
  });
});

module.exports = app;
