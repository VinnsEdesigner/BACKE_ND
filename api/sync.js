'use strict';

const { query } = require('../lib/supabase');
const logger    = require('../lib/logger');
const { HTTP, TABLES } = require('../utils/constants');

/**
 * GET /api/sync
 *
 * Bookmarklet polls this every 15s (SCRAPER.POLL_INTERVAL_MS).
 * Returns latest settings so bookmarklet applies diffs immediately.
 * Auth token in header identifies user — no body needed.
 */
async function sync(req, res) {
  const { userId } = req.user;

  try {
    const rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    const settings = rows?.[0] || null;

    return res.status(HTTP.OK).json({
      ok:        true,
      timestamp: new Date().toISOString(),
      userId,
      // Only return columns that exist in schema
      settings: settings
        ? {
            prompt_injection:     settings.prompt_injection      ?? true,
            auto_sync:            settings.auto_sync             ?? true,
            snippet_limit:        settings.snippet_limit          ?? 20,
            autonomy_level:       settings.autonomy_level         ?? 1,
            confirmation_prompts: settings.confirmation_prompts   ?? true,
            reasoning_log:        settings.reasoning_log          ?? false,
          }
        : null,
    });
  } catch (err) {
    logger.error('sync', 'Failed to fetch settings', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'sync_failed',
      message: 'Could not fetch settings',
    });
  }
}

module.exports = sync;
