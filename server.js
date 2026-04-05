'use strict';

// Load env vars first (before anything else)
require('dotenv').config();

// Validate all env vars — exits process if any missing
const { checkEnv } = require('./utils/env-check');
checkEnv();

const express = require('express');
const logger  = require('./lib/logger');

// ── Middleware ─────────────────────────────────────────────────────────────────
const corsMiddleware = require('./middleware/cors');
const verifyToken    = require('./middleware/verify-token');
const rateLimit      = require('./middleware/rate-limit');

// ── Route handlers ─────────────────────────────────────────────────────────────
const { login, refresh, verify }                 = require('./api/auth');
const health                                      = require('./api/health');
const warmup                                      = require('./api/warmup');
const testModels                                  = require('./api/test-models');
const { subscribe: broadcastSubscribe }           = require('./api/broadcast');

// Phase 2
const scraperAgent               = require('./api/scraper-agent');
const { liteAgent }              = require('./api/lite-agent');
const sync                       = require('./api/sync');

// Phase 3
const { getSettings, patchSettings }             = require('./api/settings');
const {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
}                                                 = require('./api/session');
const { githubHandler, rollbackHandler, treeHandler } = require('./api/github');
const { agent, switchModel, agentStatus } = require('./api/agent');
const { search: searchHandler, searchStatus } = require('./api/search');

// ── App setup ──────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 7860;

// ── Global middleware ──────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Lightweight request logging
app.use((req, res, next) => {
  logger.debug('server', `${req.method} ${req.path}`);
  next();
});

// ── Public routes (no auth required) ──────────────────────────────────────────
app.get('/api/health',      health);
app.get('/api/warmup',      warmup);
app.get('/api/test-models', testModels);
app.post('/api/auth/login', login);

// ── Protected routes (JWT required) ───────────────────────────────────────────
app.use('/api', verifyToken);

// Auth
app.post('/api/auth/refresh', refresh);
app.get('/api/auth/verify',   verify);

// SSE broadcast channel (no rate limit — long-lived connection)
app.get('/api/broadcast', broadcastSubscribe);

// Rate limiting applies to all remaining protected routes
app.use('/api', rateLimit);

// ── Phase 2 — Scraper pipeline ─────────────────────────────────────────────────
app.post('/api/scraper-agent', scraperAgent);
app.post('/api/lite-agent',    liteAgent);
app.get('/api/sync',           sync);

// ── Phase 3 — GitHub + Settings + Sessions ────────────────────────────────────
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

// ── Phase 4 placeholder — AI Agent core ───────────────────────────────────────
app.post('/api/agent',         agent);
app.patch('/api/active-model', switchModel);
app.get('/api/agent/status',   agentStatus);
app.post('/api/search',        searchHandler);
app.get('/api/search/status',  searchStatus);

// ── 404 handler ───────────────────────────────────────────────────────────────
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
  logger.info('server', `🚀 Backend running on port ${PORT}`, {
    env:      process.env.NODE_ENV || 'development',
    hf_space: process.env.HF_SPACE_URL || 'not set',
  });
});

module.exports = app;
