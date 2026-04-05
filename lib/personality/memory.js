'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── MEMORY ────────────────────────────────────────────────────────────────────
// Persists long-term facts about the user.
// Stored in Supabase personality table: { user_id, key, value, updated_at }

/**
 * Get all memory facts for a user.
 * Returns { facts: [{key, value}], preferences: {key: value} }
 */
async function get(userId) {
  try {
    const rows = await query(TABLES.PERSONALITY, 'select', {
      filters: { user_id: userId },
    });

    const facts = (rows || []).map((r) => ({ key: r.key, value: r.value }));
    const preferences = Object.fromEntries(facts.map((f) => [f.key, f.value]));

    return { facts, preferences };
  } catch (err) {
    logger.error('memory:get', 'Failed to fetch memory', err);
    return { facts: [], preferences: {} };
  }
}

/**
 * Save a fact to memory. Upserts on key.
 */
async function save(userId, key, value) {
  try {
    await query(TABLES.PERSONALITY, 'upsert', {
      data: {
        user_id:    userId,
        key,
        value:      String(value),
        updated_at: new Date().toISOString(),
      },
      onConflict: 'user_id,key',
    });
    logger.debug('memory:save', `Saved ${key}`, { userId });
  } catch (err) {
    logger.error('memory:save', `Failed to save ${key}`, err);
    throw err;
  }
}

/**
 * Delete a specific memory key.
 */
async function forget(userId, key) {
  try {
    const client = require('../supabase').getClient();
    await client
      .from(TABLES.PERSONALITY)
      .delete()
      .eq('user_id', userId)
      .eq('key', key);
    logger.debug('memory:forget', `Forgot ${key}`, { userId });
  } catch (err) {
    logger.error('memory:forget', `Failed to forget ${key}`, err);
    throw err;
  }
}

/**
 * Get a compressed memory block string for prompt injection.
 * Returns empty string if no memories.
 */
async function summarise(userId) {
  const { facts } = await get(userId);
  if (facts.length === 0) return '';

  const lines = facts.map((f) => `- ${f.key}: ${f.value}`);
  return `[USER MEMORY]\n${lines.join('\n')}`;
}

module.exports = { get, save, forget, summarise };
