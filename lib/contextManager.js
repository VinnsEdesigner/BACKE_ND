'use strict';

const { query }    = require('./supabase');
const { summarize } = require('./agent/memorySummarizer');
const tokenizer    = require('./tokenizer');
const logger       = require('./logger');
const { TABLES, AGENT } = require('../utils/constants');

// ── CONTEXT MANAGER ───────────────────────────────────────────────────────────
// Keeps conversation history within token budget.
// Token budget: AGENT.MAX_TOKENS max fed into each request.
// Strategy: load messages → count tokens → if over budget → summarise oldest

/**
 * Get conversation messages for a user, trimmed to token budget.
 *
 * @param {string} userId
 * @param {number} maxTokens
 * @returns {Array} messages[]
 */
async function get(userId, maxTokens = AGENT.MAX_TOKENS) {
  try {
    const rows = await query(TABLES.CONVERSATIONS, 'select', {
      filters: { user_id: userId },
      order:   { column: 'created_at', ascending: false },
      limit:   50,
    });

    if (!rows || rows.length === 0) return [];

    // Reverse to chronological
    const messages = rows.reverse().map((r) => ({
      role:    r.role,
      content: r.content || '',
    }));

    // Trim to fit budget
    const trimmed = tokenizer.trimToFit(messages, maxTokens);

    const { pct } = tokenizer.budget(trimmed, maxTokens);
    logger.debug('contextManager:get', `Context at ${pct}% of budget`, { userId });

    return trimmed;
  } catch (err) {
    logger.error('contextManager:get', 'Failed to get context', err);
    return [];
  }
}

/**
 * Append a message to conversation history.
 */
async function append(userId, role, content) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id:    userId,
        role,
        content:    typeof content === 'string' ? content : JSON.stringify(content),
        card_type:  'text',
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('contextManager:append', 'Failed to append message', err);
    // Non-fatal
  }
}

/**
 * Summarise oldest chunk of conversation and replace with summary.
 * Called when context hits AGENT.CONTEXT_WARN_PCT.
 */
async function summariseOld(userId) {
  try {
    const rows = await query(TABLES.CONVERSATIONS, 'select', {
      filters: { user_id: userId },
      order:   { column: 'created_at', ascending: true },
      limit:   20, // summarise oldest 20 messages
    });

    if (!rows || rows.length < 5) return; // not enough to summarise

    const messages = rows.map((r) => ({ role: r.role, content: r.content }));
    const summary  = await summarize(userId, messages, 'auto-summary');

    if (summary) {
      logger.info('contextManager:summariseOld', 'Summarised old context', { userId });
    }
  } catch (err) {
    logger.error('contextManager:summariseOld', 'Failed to summarise', err);
  }
}

/**
 * Clear all conversation history for a user.
 */
async function clear(userId) {
  try {
    const client = require('./supabase').getClient();
    await client
      .from(TABLES.CONVERSATIONS)
      .delete()
      .eq('user_id', userId);
    logger.info('contextManager:clear', 'Context cleared', { userId });
  } catch (err) {
    logger.error('contextManager:clear', 'Failed to clear context', err);
    throw err;
  }
}

module.exports = { get, append, summariseOld, clear };
