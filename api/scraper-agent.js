/**
 * @file scraper-agent.js
 * @location /backend/api/scraper-agent.js
 *
 * @purpose
 * Receives snippet sync requests from the VENOM bookmarklet.
 * Persists snippets to Supabase, pushes SSE update to dashboard,
 * and optionally runs the lite agent for auto-prompt responses.
 *
 * Real-time persistence contract (bookmarklet conversation history):
 *   1. User autoPrompt message persisted to conversations BEFORE agent runs
 *   2. Recent session conversation history loaded from DB
 *   3. History passed to runLiteAgent for context
 *   4. Agent reply persisted to conversations AFTER agent responds
 *   5. Dashboard receives SSE with reply
 *
 * This ensures bookmarklet history is never lost — every turn is in
 * Supabase before the next turn begins.
 *
 * @exports
 *   scraperAgent (default export)
 *
 * @imports
 *   ./broadcast         → emit (SSE push to dashboard)
 *   ./lite-agent        → runLiteAgent (direct call, no HTTP)
 *   ../lib/supabase     → query
 *   ../lib/logger       → structured logger
 *   ../utils/constants  → HTTP, TABLES, SSE, SCRAPER, SNIPPET_TYPES
 *
 * @tables
 *   sessions
 *     UPSERT: id, user_id, page_url, page_title, name,
 *             created_at, updated_at
 *
 *   snippets
 *     UPSERT: user_id, session_id, number, type, content,
 *             source_url, pinned, metadata, mime_type,
 *             file_size, created_at
 *     onConflict: user_id,session_id,number
 *
 *   conversations
 *     INSERT: user_id, session_id, role, content,
 *             card_type, metadata, created_at
 *     (both user message and assistant reply)
 *
 * @sse-events
 *   finding → snippets_synced   (after snippets saved)
 *   finding → lite_agent_reply  (after agent responds)
 *
 * @env-vars
 *   none directly
 *
 * @dependency-level 8
 */

'use strict';

const { emit }         = require('./broadcast');
const { runLiteAgent } = require('./lite-agent');
const { query }        = require('../lib/supabase');
const logger           = require('../lib/logger');
const {
  HTTP,
  TABLES,
  SSE,
  SCRAPER,
  SNIPPET_TYPES,
} = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// VALID SNIPPET TYPES
// Derived from SNIPPET_TYPES constant — single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set(Object.values(SNIPPET_TYPES));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a conversation message to Supabase.
 * Non-fatal — logs warning but never blocks request on DB failure.
 *
 * @param {string}      userId
 * @param {string}      sessionId
 * @param {'user'|'assistant'} role
 * @param {string}      content
 * @param {string}      [cardType='text']
 * @param {Object}      [metadata={}]
 */
async function persistConversation(userId, sessionId, role, content, cardType = 'text', metadata = {}) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id:    userId,
        session_id: sessionId || null,
        role,
        content:    typeof content === 'string' ? content : JSON.stringify(content),
        card_type:  cardType,
        metadata:   metadata || {},
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Non-fatal — bookmarklet must not fail because of a DB write
    logger.warn('scraper-agent:persistConversation', 'Failed to persist conversation turn', {
      userId,
      sessionId,
      role,
      error: err.message,
    });
  }
}

/**
 * Load recent conversation history for a session.
 * Used to give runLiteAgent memory of prior turns in this session.
 * Returns empty array on failure — non-fatal.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {number} [limit=20]
 * @returns {Promise<Array<{ role: string, content: string }>>}
 */
async function loadSessionHistory(userId, sessionId, limit = 20) {
  if (!sessionId) return [];

  try {
    const rows = await query(TABLES.CONVERSATIONS, 'select', {
      filters: {
        user_id:    userId,
        session_id: sessionId,
      },
      order: { column: 'created_at', ascending: true },
      limit,
    });

    if (!rows || rows.length === 0) return [];

    return rows
      .filter((r) => r.role && r.content)
      .map((r) => ({
        role:    r.role,
        content: String(r.content).slice(0, 1000),
      }));
  } catch (err) {
    logger.warn('scraper-agent:loadSessionHistory', 'Failed to load session history', {
      userId,
      sessionId,
      error: err.message,
    });
    return [];
  }
}

/**
 * Sanitize a single snippet from the request body.
 * Validates type, truncates content, preserves metadata for image/file types.
 * Returns null if snippet is invalid or has no usable content.
 *
 * @param {Object} s        - raw snippet from request body
 * @param {number} index    - position in array (for number fallback)
 * @returns {Object|null}
 */
function sanitizeSnippet(s, index) {
  if (!s || typeof s !== 'object') return null;

  // Validate type — use SNIPPET_TYPES enum
  const type = VALID_TYPES.has(s.type) ? s.type : null;
  if (!type) {
    logger.warn('scraper-agent:sanitizeSnippet', `Invalid snippet type "${s.type}" — skipping`);
    return null;
  }

  // Content handling differs by type
  // image type: content = URL string (LAW 22 — no base64)
  // file type:  content = file text OR URL fallback
  // code/research: content = text (truncated)
  let content = '';

  if (type === SNIPPET_TYPES.IMAGE) {
    // For image: content should be a URL
    // scraper sends s.text as the URL for image snippets
    content = typeof s.text === 'string' ? s.text.trim() : '';
    if (!content) return null; // no URL = useless image snippet
  } else {
    // For code/research/file: content is text
    content = typeof s.text === 'string'
      ? s.text.slice(0, SCRAPER.MAX_SNIPPET_LENGTH)
      : '';
    if (!content) return null;
  }

  return {
    number:    typeof s.number === 'number' ? s.number : index + 1,
    type,
    content,
    url:       typeof s.url   === 'string' ? s.url   : null,
    title:     typeof s.title === 'string' ? s.title : null,
    // Preserve metadata for image/file types
    metadata:  s.metadata && typeof s.metadata === 'object' ? s.metadata : null,
    mime_type: type === SNIPPET_TYPES.IMAGE
      ? (typeof s.mime_type === 'string' ? s.mime_type : null)
      : null,
    file_size: (type === SNIPPET_TYPES.IMAGE || type === SNIPPET_TYPES.FILE)
      ? (typeof s.file_size === 'number' ? s.file_size : null)
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — POST /api/scraper-agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} req
 * @param {Object} res
 */
async function scraperAgent(req, res) {
  const { userId } = req.user;
  const {
    sessionId,
    snippets,
    pageContext,
    autoPrompt,
  } = req.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
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

  const cleanSessionId = sessionId.trim();

  // ── Sanitize snippets ──────────────────────────────────────────────────────
  const validSnippets = snippets
    .slice(0, SCRAPER.MAX_SNIPPETS_COUNT)
    .map((s, i) => sanitizeSnippet(s, i))
    .filter(Boolean);

  if (validSnippets.length === 0) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'No valid snippet content after sanitisation',
    });
  }

  // ── Upsert session ─────────────────────────────────────────────────────────
  try {
    await query(TABLES.SESSIONS, 'upsert', {
      data: {
        id:         cleanSessionId,
        user_id:    userId,
        page_url:   pageContext?.url   || null,
        page_title: pageContext?.title || null,
        name:       pageContext?.title || null,  // name = display label
        updated_at: new Date().toISOString(),
      },
      onConflict: 'id',
    });
  } catch (err) {
    // Non-fatal — continue without session record
    logger.warn('scraper-agent', 'Failed to upsert session', {
      sessionId: cleanSessionId,
      error:     err.message,
    });
  }

  // ── Save snippets ──────────────────────────────────────────────────────────
  let savedCount    = 0;
  const savedSnippets = [];

  for (const snippet of validSnippets) {
    try {
      const rows = await query(TABLES.SNIPPETS, 'upsert', {
        data: {
          user_id:    userId,
          session_id: cleanSessionId,
          number:     snippet.number,
          type:       snippet.type,
          content:    snippet.content,      // LAW 11: always 'content', never 'text'
          source_url: snippet.url  || null,
          pinned:     false,
          metadata:   snippet.metadata  || null,
          mime_type:  snippet.mime_type || null,
          file_size:  snippet.file_size || null,
          created_at: new Date().toISOString(),
        },
        onConflict: 'user_id,session_id,number',
      });

      savedCount++;
      if (rows?.[0]) savedSnippets.push(rows[0]);
    } catch (err) {
      // Log individual failure — continue saving rest (LAW 9)
      logger.error('scraper-agent', `Failed to save snippet #${snippet.number}`, {
        userId,
        sessionId: cleanSessionId,
        type:      snippet.type,
        error:     err.message,
      });
    }
  }

  logger.info('scraper-agent', `Saved ${savedCount}/${validSnippets.length} snippets`, {
    userId,
    sessionId: cleanSessionId,
  });

  // ── SSE push — snippets synced ─────────────────────────────────────────────
  try {
    await emit(userId, {
      type:    SSE.EVENT_TYPES.FINDING,
      content: {
        event:     'snippets_synced',
        sessionId: cleanSessionId,
        count:     savedCount,
        snippets:  savedSnippets.map((s) => ({
          number:  s.number,
          type:    s.type,
          preview: (s.content || '').slice(0, 120),
          url:     s.source_url || null,
        })),
        pageTitle: pageContext?.title || null,
      },
    });
  } catch (err) {
    // Non-fatal — dashboard might not be connected
    logger.warn('scraper-agent', 'SSE emit (snippets_synced) failed — non-fatal', {
      error: err.message,
    });
  }

  // ── Auto-prompt: agent run + real-time conversation persistence ────────────
  let agentResult = null;

  if (autoPrompt && typeof autoPrompt === 'string' && autoPrompt.trim()) {
    const promptText = autoPrompt.trim();

    logger.debug('scraper-agent', 'Auto-prompt triggered', {
      userId,
      sessionId: cleanSessionId,
      prompt:    promptText.slice(0, 80),
    });

    // ── 1. Persist user message FIRST (real-time — before agent runs) ────────
    // This ensures history is in DB even if agent fails or times out.
    await persistConversation(
      userId,
      cleanSessionId,
      'user',
      promptText,
      'text',
      {
        source:     'bookmarklet_auto_prompt',
        page_url:   pageContext?.url   || null,
        page_title: pageContext?.title || null,
      }
    );

    // ── 2. Load session history from DB for agent context ────────────────────
    // Loads all prior turns for this session — gives agent full memory.
    const sessionHistory = await loadSessionHistory(userId, cleanSessionId, 20);

    // ── 3. Run lite agent with full session history ───────────────────────────
    try {
      agentResult = await runLiteAgent({
        userId,
        message:     promptText,
        pageContext,
        snippets:    validSnippets.map((s) => ({
          type: s.type,
          text: s.content,  // runLiteAgent expects { type, text } in body format
        })),
        history:     sessionHistory,  // full DB-backed history
        sessionId:   cleanSessionId,
      });

      // ── 4. Persist assistant reply IMMEDIATELY after response ────────────────
      // Real-time — before SSE emit, before response sent.
      // If SSE fails or client disconnects, reply is still in DB.
      await persistConversation(
        userId,
        cleanSessionId,
        'assistant',
        agentResult.reply,
        'text',
        {
          model:       agentResult.model,
          tokens_used: agentResult.tokens_used,
          source:      'lite_agent',
          searched:    agentResult.searched,
          tools_used:  agentResult.tools_used,
        }
      );

      // ── 5. SSE push — agent reply to dashboard ───────────────────────────────
      await emit(userId, {
        type:    SSE.EVENT_TYPES.FINDING,
        content: {
          event:     'lite_agent_reply',
          sessionId: cleanSessionId,
          reply:     agentResult.reply,
          model:     agentResult.model,
          prompt:    promptText,
          tools:     agentResult.tools_used || [],
        },
      }).catch((err) => {
        logger.warn('scraper-agent', 'SSE emit (lite_agent_reply) failed — non-fatal', {
          error: err.message,
        });
      });

    } catch (err) {
      logger.error('scraper-agent', 'Lite-agent auto-run failed', {
        userId,
        sessionId: cleanSessionId,
        error:     err.message,
      });

      // Persist error as assistant message so history reflects what happened
      await persistConversation(
        userId,
        cleanSessionId,
        'assistant',
        `Agent encountered an error: ${err.message}`,
        'text',
        {
          source: 'lite_agent_error',
          error:  err.message,
        }
      );

      agentResult = { error: err.message };
    }
  }

  // ── Response ───────────────────────────────────────────────────────────────
  return res.status(HTTP.OK).json({
    ok:         true,
    saved:      savedCount,
    sessionId:  cleanSessionId,
    agentReply: agentResult?.reply  || null,
    agentModel: agentResult?.model  || null,
    agentError: agentResult?.error  || null,
    timestamp:  new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = scraperAgent;
