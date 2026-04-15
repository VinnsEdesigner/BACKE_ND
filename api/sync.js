'use strict';

const { query } = require('../lib/supabase');
const logger    = require('../lib/logger');
const { HTTP, TABLES } = require('../utils/constants');

const SETTING_DEFAULTS = {
  prompt_injection:     true,
  auto_sync:            true,
  snippet_limit:        20,
  autonomy_level:       1,
  confirmation_prompts: true,
  reasoning_log:        false,
};

/**
 * GET /api/sync
 * FIX: auto-creates settings row if missing so bookmarklet never gets null
 */
async function sync(req, res) {
  const { userId } = req.user;

  try {
    let rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    // FIX: if no row exists, create defaults immediately
    if (!rows || rows.length === 0) {
      logger.info('sync', `No settings for ${userId} — creating defaults`);
      try {
        rows = await query(TABLES.SETTINGS, 'upsert', {
          data: {
            user_id: userId,
            ...SETTING_DEFAULTS,
            updated_at: new Date().toISOString(),
          },
          onConflict: 'user_id',
        });
      } catch (createErr) {
        logger.warn('sync', 'Failed to create default settings', { error: createErr.message });
        // Still return defaults even if DB write fails
        return res.status(HTTP.OK).json({
          ok:        true,
          timestamp: new Date().toISOString(),
          userId,
          settings:  SETTING_DEFAULTS,
        });
      }
    }

    const settings = rows?.[0] || null;

    return res.status(HTTP.OK).json({
      ok:        true,
      timestamp: new Date().toISOString(),
      userId,
      settings: settings
        ? {
            prompt_injection:     settings.prompt_injection      ?? SETTING_DEFAULTS.prompt_injection,
            auto_sync:            settings.auto_sync             ?? SETTING_DEFAULTS.auto_sync,
            snippet_limit:        settings.snippet_limit         ?? SETTING_DEFAULTS.snippet_limit,
            autonomy_level:       settings.autonomy_level        ?? SETTING_DEFAULTS.autonomy_level,
            confirmation_prompts: settings.confirmation_prompts  ?? SETTING_DEFAULTS.confirmation_prompts,
            reasoning_log:        settings.reasoning_log         ?? SETTING_DEFAULTS.reasoning_log,
          }
        : SETTING_DEFAULTS,
    });
  } catch (err) {
    logger.error('sync', 'Failed to fetch settings', err);
    // Return defaults on error — never return null
    return res.status(HTTP.OK).json({
      ok:        true,
      timestamp: new Date().toISOString(),
      userId,
      settings:  SETTING_DEFAULTS,
    });
  }
}

module.exports = sync;
