'use strict';

const { emit }         = require('./broadcast');
const { runLiteAgent } = require('./lite-agent');
const { query }        = require('../lib/supabase');
const logger           = require('../lib/logger');
const { HTTP, TABLES, SSE, SCRAPER } = require('../utils/constants');

/**
 * POST /api/scraper-agent
 *
 * Body:
 * {
 *   sessionId:   string,
 *   snippets: [{
 *     number:  number,
 *     text:    string,
 *     type:    'code' | 'research',
 *     url:     string,
 *     title:   string,
 *   }],
 *   pageContext: { url, title, content } | null,
 *   autoPrompt:  string | null,
 * }
 */
async function scraperAgent(req, res) {
  const { userId }                              = req.user;
  const { sessionId, snippets, pageContext, autoPrompt } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'sessionId is required',
    });
  }

  if (!Array.isArray(snippets) || snippets.length === 0) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'snippets array is required and must not be empty',
    });
  }

  // Sanitise — enforce limits, never trust client
  const validSnippets = snippets
    .slice(0, SCRAPER.MAX_SNIPPETS_COUNT)
    .map((s) => ({
      number: s.number,
      text:   typeof s.text === 'string' ? s.text.slice(0, SCRAPER.MAX_SNIPPET_LENGTH) : '',
      type:   s.type === 'code' ? 'code' : 'research',
      url:    typeof s.url   === 'string' ? s.url   : null,
      title:  typeof s.title === 'string' ? s.title : null,
    }))
    .filter((s) => s.text.length > 0);

  if (validSnippets.length === 0) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'No valid snippet content after sanitisation',
    });
  }

  // ── Upsert session ────────────────────────────────────────────────────────
  // sessions schema: id, user_id, page_url, page_title, created_at
  try {
    await query(TABLES.SESSIONS, 'upsert', {
      data: {
        id:         sessionId,
        user_id:    userId,
        page_url:   pageContext?.url   || null,
        page_title: pageContext?.title || null,
      },
      onConflict: 'id',
    });
  } catch (err) {
    logger.warn('scraper-agent', 'Failed to upsert session', err);
    // Non-fatal — continue
  }

  // ── Save snippets ─────────────────────────────────────────────────────────
  // snippets schema: id, user_id, session_id, number, type, content, source_url, pinned, created_at
  let savedCount = 0;
  const savedSnippets = [];

  for (const snippet of validSnippets) {
    try {
      const rows = await query(TABLES.SNIPPETS, 'upsert', {
        data: {
          user_id:    userId,
          session_id: sessionId,
          number:     snippet.number,
          type:       snippet.type,
          content:    snippet.text,       // ✅ schema column is 'content' not 'text'
          source_url: snippet.url || null,
          pinned:     false,
          created_at: new Date().toISOString(),
        },
        onConflict: 'user_id,session_id,number',
      });
      savedCount++;
      if (rows?.[0]) savedSnippets.push(rows[0]);
    } catch (err) {
      logger.error('scraper-agent', `Failed to save snippet #${snippet.number}`, err);
      // Continue — save as many as possible (LAW 9 — no silent failures but non-fatal)
    }
  }

  logger.info('scraper-agent', `Saved ${savedCount}/${validSnippets.length} snippets`, {
    userId,
    sessionId,
  });

  // ── SSE push to dashboard ─────────────────────────────────────────────────
  try {
    await emit(userId, {
      type:    SSE.EVENT_TYPES.FINDING,
      content: {
        event:     'snippets_synced',
        sessionId,
        count:     savedCount,
        snippets:  savedSnippets.map((s) => ({
          number:  s.number,
          type:    s.type,
          preview: s.content?.slice(0, 120) || '',  // ✅ 'content' not 'text'
          url:     s.source_url,
        })),
        pageTitle: pageContext?.title || null,
      },
    });
  } catch (err) {
    logger.warn('scraper-agent', 'SSE emit failed', err);
    // Non-fatal
  }

  // ── Optional lite-agent auto-run ──────────────────────────────────────────
  let agentResult = null;

  if (autoPrompt && typeof autoPrompt === 'string' && autoPrompt.trim()) {
    logger.debug('scraper-agent', 'Auto-running lite-agent', {
      prompt: autoPrompt.slice(0, 60),
    });

    try {
      agentResult = await runLiteAgent({
        userId,
        message:     autoPrompt.trim(),
        pageContext,
        snippets:    validSnippets,
      });

      // Push agent reply to dashboard
      await emit(userId, {
        type:    SSE.EVENT_TYPES.FINDING,
        content: {
          event:     'lite_agent_reply',
          sessionId,
          reply:     agentResult.reply,
          model:     agentResult.model,
          prompt:    autoPrompt.trim(),
        },
      }).catch((err) => {
        logger.warn('scraper-agent', 'SSE emit for agent reply failed', err);
      });
    } catch (err) {
      logger.error('scraper-agent', 'Lite-agent auto-run failed', err);
      agentResult = { error: err.message };
    }
  }

  // ── Response ──────────────────────────────────────────────────────────────
  return res.status(HTTP.OK).json({
    ok:         true,
    saved:      savedCount,
    sessionId,
    agentReply: agentResult?.reply  || null,
    agentModel: agentResult?.model  || null,
    agentError: agentResult?.error  || null,
    timestamp:  new Date().toISOString(),
  });
}

module.exports = scraperAgent;
