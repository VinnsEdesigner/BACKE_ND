'use strict';

const { query }  = require('../lib/supabase');
const { emit }   = require('./broadcast');
const logger     = require('../lib/logger');
const { HTTP, TABLES, SSE } = require('../utils/constants');

// ── SETTINGS SCHEMA ───────────────────────────────────────────────────────────
// Columns that live in the settings table.
// Any key not in this list is silently ignored on PATCH.

const ALLOWED_KEYS = new Set([
  'autonomy_level',
  'confirmation_prompts',
  'reasoning_log',
  'auto_sync',
  'prompt_injection',
  'snippet_limit',
]);

// ── DEFAULTS ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  autonomy_level:       1,
  confirmation_prompts: true,
  reasoning_log:        false,
  auto_sync:            true,
  prompt_injection:     true,
  snippet_limit:        20,
};

// ── GET /api/settings ─────────────────────────────────────────────────────────

async function getSettings(req, res) {
  const { userId } = req.user;

  try {
    const rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    const settings = rows?.[0]
      ? sanitize(rows[0])
      : { ...DEFAULTS };

    return res.status(HTTP.OK).json({
      ok:       true,
      settings,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('settings:get', 'Failed to fetch settings', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'settings_fetch_failed',
      message: 'Could not fetch settings',
    });
  }
}

// ── PATCH /api/settings ───────────────────────────────────────────────────────
// Receives a delta — only changed keys.
// 1.5s debounce enforced on client side (AGENT.DEBOUNCE_SETTINGS_MS).
// Server side: always applies immediately, SSE pushes to all clients.

async function patchSettings(req, res) {
  const { userId } = req.user;
  const patch      = req.body;

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'Body must be a settings object',
    });
  }

  // Filter to only allowed keys
  const delta = {};
  for (const [key, value] of Object.entries(patch)) {
    if (ALLOWED_KEYS.has(key)) {
      delta[key] = coerce(key, value);
    }
  }

  if (Object.keys(delta).length === 0) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'No valid settings keys in patch',
    });
  }

  try {
    const rows = await query(TABLES.SETTINGS, 'upsert', {
      data: {
        user_id:    userId,
        ...delta,
        updated_at: new Date().toISOString(),
      },
      onConflict: 'user_id',
    });

    const updated = rows?.[0] ? sanitize(rows[0]) : { ...DEFAULTS, ...delta };

    logger.info('settings:patch', 'Settings updated', { userId, delta });

    // SSE push — dashboard + bookmarklet (on next poll) both get the update
    await emit(userId, {
      type:    SSE.EVENT_TYPES.PULSE,
      content: {
        event:    'settings_updated',
        settings: updated,
      },
    }).catch((err) => {
      logger.warn('settings:patch', 'SSE emit failed', err);
    });

    return res.status(HTTP.OK).json({
      ok:       true,
      settings: updated,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('settings:patch', 'Failed to patch settings', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'settings_patch_failed',
      message: 'Could not update settings',
    });
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Strip DB-only columns, return only UI-facing settings.
 */
function sanitize(row) {
  return {
    autonomy_level:       row.autonomy_level       ?? DEFAULTS.autonomy_level,
    confirmation_prompts: row.confirmation_prompts ?? DEFAULTS.confirmation_prompts,
    reasoning_log:        row.reasoning_log        ?? DEFAULTS.reasoning_log,
    auto_sync:            row.auto_sync            ?? DEFAULTS.auto_sync,
    prompt_injection:     row.prompt_injection     ?? DEFAULTS.prompt_injection,
    snippet_limit:        row.snippet_limit        ?? DEFAULTS.snippet_limit,
  };
}

/**
 * Coerce values to correct types per key.
 * Prevents type mismatches from client sending strings for booleans.
 */
function coerce(key, value) {
  const boolKeys = ['confirmation_prompts', 'reasoning_log', 'auto_sync', 'prompt_injection'];
  const intKeys  = ['autonomy_level', 'snippet_limit'];

  if (boolKeys.includes(key)) {
    if (typeof value === 'boolean') return value;
    if (value === 'true'  || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return Boolean(value);
  }

  if (intKeys.includes(key)) {
    const n = parseInt(value, 10);
    if (key === 'autonomy_level') return Math.max(0, Math.min(3, n));
    if (key === 'snippet_limit')  return Math.max(1, Math.min(20, n));
    return n;
  }

  return value;
}

module.exports = { getSettings, patchSettings };
