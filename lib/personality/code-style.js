'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── CODE STYLE ────────────────────────────────────────────────────────────────
// Tracks and enforces user's code style preferences.
// Detected from code they write + corrections they make to AI output.

const DEFAULTS = {
  indent:       '2spaces',
  quotes:       'single',
  semicolons:   true,
  naming:       'camelCase',
  async_style:  'async/await',
  framework:    'vanilla',
  comments:     'meaningful',
};

// Memory key prefix for code style storage
const PREFIX = 'code_style:';

/**
 * Get code style config for a user.
 * Falls back to DEFAULTS for any missing keys.
 */
async function get(userId) {
  try {
    const rows = await query(TABLES.PERSONALITY, 'select', {
      filters: { user_id: userId },
    });

    const styleRows = (rows || []).filter((r) => r.key.startsWith(PREFIX));
    const stored    = Object.fromEntries(
      styleRows.map((r) => [r.key.replace(PREFIX, ''), r.value])
    );

    return { ...DEFAULTS, ...stored };
  } catch (err) {
    logger.error('code-style:get', 'Failed to fetch code style', err);
    return { ...DEFAULTS };
  }
}

/**
 * Update one or more code style fields.
 */
async function update(userId, patch) {
  try {
    for (const [field, value] of Object.entries(patch)) {
      await query(TABLES.PERSONALITY, 'upsert', {
        data: {
          user_id:    userId,
          key:        `${PREFIX}${field}`,
          value:      String(value),
          updated_at: new Date().toISOString(),
        },
        onConflict: 'user_id,key',
      });
    }
    logger.debug('code-style:update', 'Updated code style', { userId, patch });
  } catch (err) {
    logger.error('code-style:update', 'Failed to update code style', err);
    throw err;
  }
}

/**
 * Convert style config to a prompt instruction string.
 */
async function toInstruction(userId) {
  const style = await get(userId);
  return [
    '[CODE STYLE]',
    `- Indentation: ${style.indent}`,
    `- Quotes: ${style.quotes}`,
    `- Semicolons: ${style.semicolons ? 'yes' : 'no'}`,
    `- Naming: ${style.naming}`,
    `- Async pattern: ${style.async_style}`,
    `- Framework: ${style.framework}`,
    `- Comments: ${style.comments}`,
  ].join('\n');
}

module.exports = { get, update, toInstruction, DEFAULTS };
