'use strict';

const logger  = require('./logger');
const { AGENT } = require('../utils/constants');

// ── TOKENIZER ─────────────────────────────────────────────────────────────────
// Estimates token counts without calling any API.
// Uses the ~4 chars per token heuristic (good enough for budget checks).
// Not exact — real counts vary by model. Designed for budget warnings, not billing.

const CHARS_PER_TOKEN = 4;

/**
 * Count approximate tokens in a string.
 */
function count(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Count approximate tokens across an array of message objects.
 * Each message: { role, content }
 */
function countMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, msg) => {
    const roleTokens    = count(msg.role    || '');
    const contentTokens = count(msg.content || '');
    return total + roleTokens + contentTokens + 4; // 4 overhead per message
  }, 0);
}

/**
 * Check token budget for a messages array against a max.
 * Returns { used, remaining, overBudget, pct }
 */
function budget(messages, max = AGENT.MAX_TOKENS) {
  const used      = countMessages(messages);
  const remaining = Math.max(0, max - used);
  const pct       = Math.round((used / max) * 100);
  const overBudget = used > max;

  if (pct >= AGENT.CONTEXT_WARN_PCT * 100) {
    logger.warn('tokenizer', `Context at ${pct}% of budget`, { used, max, remaining });
  }

  return { used, remaining, overBudget, pct };
}

/**
 * Trim messages array to fit within maxTokens.
 * Removes oldest messages first (keeps system prompt if present).
 * Returns trimmed messages array.
 */
function trimToFit(messages, maxTokens = AGENT.MAX_TOKENS) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // Separate system messages (always keep)
  const system  = messages.filter((m) => m.role === 'system');
  const nonSys  = messages.filter((m) => m.role !== 'system');

  const systemTokens = countMessages(system);
  let remaining      = maxTokens - systemTokens;

  // Add non-system messages from newest → oldest until budget hits
  const kept = [];
  for (let i = nonSys.length - 1; i >= 0; i--) {
    const msgTokens = count(nonSys[i].content || '') + 4;
    if (remaining - msgTokens < 0) break;
    kept.unshift(nonSys[i]);
    remaining -= msgTokens;
  }

  const result = [...system, ...kept];
  if (result.length < messages.length) {
    logger.debug('tokenizer', `Trimmed ${messages.length - result.length} messages to fit budget`, {
      original: messages.length,
      kept:     result.length,
      maxTokens,
    });
  }

  return result;
}

module.exports = { count, countMessages, budget, trimToFit };
