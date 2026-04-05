'use strict';

const logger = require('../logger');

// ── DECISIONS ─────────────────────────────────────────────────────────────────
// Logs significant agent decisions for debugging and learning.
// In-memory only — resets on server restart. No Supabase persist (saves rows).
// reasoning_log table used only when reasoning_log setting is ON.

const store = new Map(); // userId → decision[]

/**
 * Log a decision.
 * decision: { task, options_considered, chosen, reasoning, outcome? }
 */
function log(userId, decision) {
  if (!store.has(userId)) store.set(userId, []);

  const entry = {
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task:      decision.task      || '',
    options:   decision.options_considered || [],
    chosen:    decision.chosen    || '',
    reasoning: decision.reasoning || '',
    outcome:   decision.outcome   || 'pending',
    timestamp: new Date().toISOString(),
  };

  store.get(userId).push(entry);

  // Keep last 50 per user — prevent memory bloat
  const decisions = store.get(userId);
  if (decisions.length > 50) store.set(userId, decisions.slice(-50));

  logger.debug('decisions:log', `Logged decision: ${entry.chosen}`, { userId });
  return entry.id;
}

/**
 * Get decision history for a user.
 */
function getHistory(userId, limit = 20) {
  const decisions = store.get(userId) || [];
  return decisions.slice(-limit);
}

/**
 * Mark the outcome of a decision (good | bad | neutral).
 */
function markOutcome(userId, id, outcome) {
  const decisions = store.get(userId) || [];
  const entry     = decisions.find((d) => d.id === id);
  if (entry) {
    entry.outcome = outcome;
    logger.debug('decisions:markOutcome', `Marked ${id} as ${outcome}`, { userId });
  }
}

/**
 * Clear all decisions for a user.
 */
function clear(userId) {
  store.delete(userId);
}

module.exports = { log, getHistory, markOutcome, clear };
