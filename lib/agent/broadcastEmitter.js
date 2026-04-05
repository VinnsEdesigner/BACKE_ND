'use strict';

const { emit: broadcastEmit } = require('../../api/broadcast');
const logger = require('../logger');
const { SSE } = require('../../utils/constants');

// ── BROADCAST EMITTER ─────────────────────────────────────────────────────────
// Internal helper for agent modules to push SSE events to dashboard.
// Wraps api/broadcast.emit() with typed convenience methods.
// All calls are non-fatal — agent never crashes on SSE failure.

/**
 * Emit a typed event to the user's dashboard.
 */
async function emit(userId, type, content) {
  try {
    await broadcastEmit(userId, { type, content });
  } catch (err) {
    // Non-fatal — SSE failure never blocks agent execution
    logger.warn('broadcastEmitter:emit', `Failed to emit ${type}`, err);
  }
}

/**
 * Emit a thinking stream trace entry.
 * Shows in the Terminal "behind the scenes" collapsible box.
 */
async function trace(userId, message) {
  await emit(userId, SSE.EVENT_TYPES.TRACE, {
    message,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit an agent finding (unsolicited discovery).
 * Shows as purple broadcast card in Terminal.
 */
async function finding(userId, content) {
  await emit(userId, SSE.EVENT_TYPES.FINDING, content);
}

/**
 * Emit a warning.
 */
async function warning(userId, content) {
  await emit(userId, SSE.EVENT_TYPES.WARNING, content);
}

/**
 * Emit a task completion event.
 */
async function complete(userId, content) {
  await emit(userId, SSE.EVENT_TYPES.COMPLETE, content);
}

/**
 * Emit a pulse/system status update.
 */
async function pulse(userId, content) {
  await emit(userId, SSE.EVENT_TYPES.PULSE, content);
}

module.exports = { emit, trace, finding, warning, complete, pulse };
