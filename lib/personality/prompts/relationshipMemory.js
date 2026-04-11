/**
 * @file relationshipMemory.js
 * @location /backend/lib/personality/prompts/relationshipMemory.js
 *
 * @purpose
 * Loads Vinns' stored preferences and habits from the personality table
 * and formats them into a compact prompt block. This is dynamic — it
 * reflects what Nexy has learned about Vinns over time via the
 * 'remember' tool and silent style adaptation.
 *
 * @exports
 *   getRelationshipBlock(userId) → Promise<string>
 *
 * @imports
 *   ../../supabase   → query()
 *   ../../logger     → structured logger
 *   ../../../utils/constants → TABLES
 *
 * @tables
 *   personality → reads key/value rows for userId
 *
 * @dependency-level 2
 */

'use strict';

const { query }  = require('../../supabase');
const logger     = require('../../logger').child('relationshipMemory');
const { TABLES } = require('../../../utils/constants');

// Max personality rows to load — prevents runaway token usage
const MAX_PERSONALITY_ROWS = 30;

// Keys to always exclude from the prompt block —
// these are internal/system keys not meant for AI context
const EXCLUDED_KEYS = new Set([
  'system_version',
  'last_sync',
  'install_date',
]);

/**
 * Load and format Vinns' stored preferences into a prompt block.
 * Returns empty string if no preferences stored yet — never throws.
 *
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function getRelationshipBlock(userId) {
  if (!userId) return '';

  try {
    const rows = await query(TABLES.PERSONALITY, 'select', {
      filters: { user_id: userId },
      order:   { column: 'updated_at', ascending: false },
      limit:   MAX_PERSONALITY_ROWS,
    });

    if (!rows || rows.length === 0) return '';

    // Deduplicate by key — keep most recently updated value
    const latestByKey = new Map();
    for (const row of rows) {
      if (!row.key || EXCLUDED_KEYS.has(row.key)) continue;
      if (!latestByKey.has(row.key)) {
        latestByKey.set(row.key, row.value || '');
      }
    }

    if (latestByKey.size === 0) return '';

    const lines = Array.from(latestByKey.entries())
      .map(([key, value]) => `- ${key}: ${String(value).slice(0, 200)}`)
      .join('\n');

    return `[VINNS' STORED PREFERENCES — LEARNED OVER TIME]\n${lines}`.trim();
  } catch (err) {
    // Non-fatal — Nexy still works without personality rows
    logger.warn('getRelationshipBlock', 'Failed to load personality rows', {
      userId,
      error: err.message,
    });
    return '';
  }
}

module.exports = { getRelationshipBlock };
