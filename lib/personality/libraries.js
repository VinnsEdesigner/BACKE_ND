'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── LIBRARIES ─────────────────────────────────────────────────────────────────
// Tracks preferred libraries per domain.
// Stored in personality table as lib:{domain} keys.

const DEFAULTS = {
  http:    'fetch',
  db:      'supabase-js',
  dates:   'date-fns',
  testing: 'vitest',
  bundler: 'none',
  css:     'vanilla',
};

const PREFIX = 'lib:';

/**
 * Get library preferences for a user.
 */
async function get(userId) {
  try {
    const rows = await query(TABLES.PERSONALITY, 'select', {
      filters: { user_id: userId },
    });

    const libRows = (rows || []).filter((r) => r.key.startsWith(PREFIX));
    const stored  = Object.fromEntries(
      libRows.map((r) => [r.key.replace(PREFIX, ''), r.value])
    );

    return { ...DEFAULTS, ...stored };
  } catch (err) {
    logger.error('libraries:get', 'Failed to fetch libraries', err);
    return { ...DEFAULTS };
  }
}

/**
 * Update library preferences.
 */
async function update(userId, patch) {
  try {
    for (const [domain, lib] of Object.entries(patch)) {
      await query(TABLES.PERSONALITY, 'upsert', {
        data: {
          user_id:    userId,
          key:        `${PREFIX}${domain}`,
          value:      String(lib),
          updated_at: new Date().toISOString(),
        },
        onConflict: 'user_id,key',
      });
    }
    logger.debug('libraries:update', 'Updated library prefs', { userId, patch });
  } catch (err) {
    logger.error('libraries:update', 'Failed to update libraries', err);
    throw err;
  }
}

/**
 * Convert library preferences to prompt instruction string.
 */
async function toInstruction(userId) {
  const libs = await get(userId);
  const lines = Object.entries(libs).map(([domain, lib]) => `- ${domain}: prefer ${lib}`);
  return `[LIBRARY PREFERENCES]\n${lines.join('\n')}`;
}

module.exports = { get, update, toInstruction, DEFAULTS };
