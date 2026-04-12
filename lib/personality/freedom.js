'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── FREEDOM ───────────────────────────────────────────────────────────────────
// Controls agent autonomy level.
//
// Levels:
//   0 = ask before everything
//   1 = ask before destructive actions only (delete, merge) — DEFAULT
//   2 = ask before multi-file changes
//   3 = fully autonomous — just do it, report after

const DESTRUCTIVE_ACTIONS = [
  'delete_file',
  'merge_pr',
  'update_repo_settings',
];

const MULTI_FILE_ACTIONS = [
  'write_file',
  'create_pr',
];

/**
 * Get autonomy level for a user from settings table.
 */
async function getLevel(userId) {
  try {
    const rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });
    return rows?.[0]?.autonomy_level ?? 1;
  } catch (err) {
    logger.error('freedom:getLevel', 'Failed to fetch autonomy level', err);
    return 1; // safe default
  }
}

/**
 * Set autonomy level in settings table.
 */
async function setLevel(userId, level) {
  const clamped = Math.max(0, Math.min(3, level));
  try {
    // BUG14 FIX: check if row exists first — use update not upsert
    // upsert on first insert would null out all other settings columns
    const existing = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    if (existing && existing.length > 0) {
      // Row exists — safe to update only autonomy_level
      await query(TABLES.SETTINGS, 'update', {
        data:    { autonomy_level: clamped, updated_at: new Date().toISOString() },
        filters: { user_id: userId },
      });
    } else {
      // No row yet — upsert with defaults for all columns
      await query(TABLES.SETTINGS, 'upsert', {
        data: {
          user_id:              userId,
          autonomy_level:       clamped,
          confirmation_prompts: true,
          reasoning_log:        false,
          auto_sync:            true,
          prompt_injection:     true,
          snippet_limit:        20,
          updated_at:           new Date().toISOString(),
        },
        onConflict: 'user_id',
      });
    }
    logger.debug('freedom:setLevel', `Set level ${clamped}`, { userId });
  } catch (err) {
    logger.error('freedom:setLevel', 'Failed to set level', err);
    throw err;
  }
}

/**
 * Check if agent should ask before performing an action.
 * Returns true = ask user first. false = proceed autonomously.
 */
async function shouldAsk(userId, action) {
  const level = await getLevel(userId);

  if (level === 0) return true;  // ask before everything
  if (level === 3) return false; // never ask

  if (level === 1) {
    // Ask only before destructive actions
    return DESTRUCTIVE_ACTIONS.includes(action);
  }

  if (level === 2) {
    // Ask before destructive + multi-file actions
    return DESTRUCTIVE_ACTIONS.includes(action) || MULTI_FILE_ACTIONS.includes(action);
  }

  return false;
}

module.exports = { getLevel, setLevel, shouldAsk, DESTRUCTIVE_ACTIONS };
