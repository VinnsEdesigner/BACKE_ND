'use strict';

const { emit }          = require('./broadcast');
const { runLiteAgent }  = require('./lite-agent');
const { query }         = require('../lib/supabase');
const logger            = require('../lib/logger');
const { HTTP, TABLES, SSE, SCRAPER } = require('../utils/constants');

// ── POST /api/scraper-agent ───────────────────────────────────────────────────
//
// Body shape (from bookmarklet sync.js):
// {
//   sessionId:   string,          // scraper session ID
//   snippets:    Array<{          // new snippets to save
//     number:    number,          // sequential #1, #2...
//     text:      string,          // captured text
//     type:      'code'|'research',
//     url:       string,          // page URL captured from
//     title:     string,          // page title
//   }>,
//   pageContext: {                // optional — triggers lite-agent auto-run
//     url:       string,
//     title:     string,
//     content:   string,          // DOM text content
//   } | null,
//   autoPrompt:  string | null,   // if set, run lite-agent with this prompt
// }

async function scraperAgent(req, res) {
  const { userId } = req.user;
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

  // Enforce snippet limits (LAW — never trust client)
  const validSnippets = snippets
    .slice(0, SCRAPER.MAX_SNIPPETS_COUNT)
    .map((s) => ({
      ...s,
      text: typeof s.text === 'string'
        ? s.text.slice(0, SCRAPER.MAX_SNIPPET_LENGTH)
        : '',
    }))
    .filter((s) => s.text.length > 0);

  if (validSnippets.length === 0) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'No valid snippet content after sanitisation',
    });
  }

  // ── Upsert session record ─────────────────────────────────────────────────
  try {
    await query(TABLES.SESSIONS, 'upsert', {
      data: {
        id:           sessionId,
        user_id:      userId,
        page_url:     pageContext?.url   || null,
        page_title:   pageContext?.title || null,
        last_active:  new Date().toISOString(),
      },
      onConflict: 'id',
    });
  } catch (err) {
    // Non-fatal — continue with snippet save
    logger.warn('scraper-agent', 'Failed to upsert session', err);
  }

  // ── Save snippets to Supabase ─────────────────────────────────────────────
  let savedCount = 0;
  const savedSnippets = [];

  for (const snippet of validSnippets) {
    try {
      const rows = await query(TABLES.SNIPPETS, 'upsert', {
        data: {
          // Composite key: user + session + snippet number
          user_id:    userId,
          session_id: sessionId,
          number:     snippet.number,
          text:       snippet.text,
          type:       snippet.type || 'research',
          page_url:   snippet.url   || null,
          page_title: snippet.title || null,
          created_at: new Date().toISOString(),
        },
        onConflict: 'user_id,session_id,number',
      });
      savedCount++;
      if (rows?.[0]) savedSnippets.push(rows[0]);
    } catch (err) {
      logger.error('scraper-agent', `Failed to save snippet #${snippet.number}`, err);
      // Continue — save as many as possible
    }
  }

  logger.info('scraper-agent', `Saved ${savedCount}/${validSnippets.length} snippets`, {
    userId,
    sessionId,
  });

  // ── SSE push to dashboard ─────────────────────────────────────────────────
  // Push regardless of lite-agent — dashboard needs to know immediately
  try {
    await emit(userId, {
      type:    SSE.EVENT_TYPES.FINDING,
      content: {
        event:      'snippets_synced',
        sessionId,
        count:      savedCount,
        snippets:   savedSnippets.map((s) => ({
          number: s.number,
          type:   s.type,
          text:   s.text?.slice(0, 120), // preview only in SSE payload
          url:    s.page_url,
        })),
        pageTitle: pageContext?.title || null,
      },
    });
  } catch (err) {
    logger.warn('scraper-agent', 'SSE emit failed', err);
    // Non-fatal — snippets are saved, just won't push live
  }

  // ── Auto-run lite-agent if prompt provided ────────────────────────────────
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

      // Push agent reply to dashboard via SSE
      await emit(userId, {
        type:    SSE.EVENT_TYPES.FINDING,
        content: {
          event:   'lite_agent_reply',
          sessionId,
          reply:   agentResult.reply,
          model:   agentResult.model,
          prompt:  autoPrompt.trim(),
        },
      }).catch((err) => {
        logger.warn('scraper-agent', 'SSE emit for agent reply failed', err);
      });
    } catch (err) {
      logger.error('scraper-agent', 'Lite-agent auto-run failed', err);
      // Non-fatal — snippets already saved and pushed
      agentResult = { error: err.message };
    }
  }

  // ── Response ──────────────────────────────────────────────────────────────
  return res.status(HTTP.OK).json({
    ok:          true,
    saved:       savedCount,
    sessionId,
    agentReply:  agentResult?.reply  || null,
    agentModel:  agentResult?.model  || null,
    agentError:  agentResult?.error  || null,
    timestamp:   new Date().toISOString(),
  });
}

module.exports = scraperAgent;
