'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── FLAGS ─────────────────────────────────────────────────────────────────────
// Per-user feature flags. Loaded from settings table.
// Maps settings columns directly — no separate table needed.

const DEFAULTS = {
  autonomous_mode:      false,
  web_search:           true,
  file_write:           true,
  auto_commit:          false,
  explain_diffs:        true,
  debug_mode:           false,
  reasoning_log:        false,
  confirmation_prompts: true,
};

/**
 * Get all flags for a user from settings table.
 */
async function get(userId) {
  try {
    const rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    const settings = rows?.[0];
    if (!settings) return { ...DEFAULTS };

    return {
      autonomous_mode:      settings.autonomy_level >= 3,
      web_search:           true, // always on
      file_write:           true, // always on
      auto_commit:          settings.autonomy_level >= 2,
      explain_diffs:        true, // always on
      debug_mode:           settings.reasoning_log   ?? false,
      reasoning_log:        settings.reasoning_log   ?? false,
      confirmation_prompts: settings.confirmation_prompts ?? true,
    };
  } catch (err) {
    logger.error('flags:get', 'Failed to fetch flags', err);
    return { ...DEFAULTS };
  }
}

/**
 * Check a single flag for a user.
 */
async function check(userId, flag) {
  const flags = await get(userId);
  return flags[flag] ?? DEFAULTS[flag] ?? false;
}

/**
 * Set a flag by updating the settings table.
 * Only supports flags that map to settings columns.
 */
async function set(userId, flag, value) {
  const SETTINGS_MAP = {
    reasoning_log:        'reasoning_log',
    confirmation_prompts: 'confirmation_prompts',
  };

  const col = SETTINGS_MAP[flag];
  if (!col) {
    logger.warn('flags:set', `Flag ${flag} not directly settable via settings`, { userId });
    return;
  }

  try {
    await query(TABLES.SETTINGS, 'upsert', {
      data: {
        user_id:    userId,
        [col]:      value,
        updated_at: new Date().toISOString(),
      },
      onConflict: 'user_id',
    });
    logger.debug('flags:set', `Set ${flag} = ${value}`, { userId });
  } catch (err) {
    logger.error('flags:set', `Failed to set flag ${flag}`, err);
    throw err;
  }
}

module.exports = { get, check, set, DEFAULTS };
