/**
 * @file vision.js
 * @location /backend/api/vision.js
 *
 * @purpose
 * HTTP endpoint for image analysis via the Gemini/Gemma vision chain.
 * Accepts three image source modes:
 *   1. snippetId  → loads image URL from Supabase snippets table
 *   2. imageUrl   → public URL passed directly
 *   3. base64     → inline base64 image data (max 4MB)
 *
 * Persists analysis result to conversations table so dashboard
 * terminal can render it as an agent-reply card.
 * Emits SSE finding event so dashboard image-card updates in real time.
 *
 * @exports
 *   visionHandler (default)  → POST /api/vision
 *
 * @imports
 *   ../lib/agent/visionHandler   → analyzeImage, analyzeBase64
 *   ../lib/supabase              → query
 *   ../lib/agent/broadcastEmitter → finding, trace
 *   ../lib/logger                → structured logger
 *   ../utils/constants           → HTTP, TABLES, VISION,
 *                                  SNIPPET_TYPES, SSE
 *
 * @tables
 *   snippets
 *     SELECT: id, user_id, type, content, mime_type
 *     (ownership + type verification only)
 *
 *   conversations
 *     INSERT: user_id, session_id, role, content,
 *             card_type, metadata, created_at
 *     (persists analysis as assistant message)
 *
 * @sse-events
 *   finding → vision_complete (analysis ready)
 *   trace   → vision_thinking (model selected)
 *
 * @env-vars
 *   none directly — visionHandler + ai.js handle GEMINI_API_KEY
 *
 * @dependency-level 8
 */

'use strict';

const { analyzeImage, analyzeBase64 } = require('../lib/agent/visionHandler');
const { query }              = require('../lib/supabase');
const broadcastEmitter       = require('../lib/agent/broadcastEmitter');
const logger                 = require('../lib/logger');
const {
  HTTP,
  TABLES,
  VISION,
  SNIPPET_TYPES,
} = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist vision analysis result as an assistant conversation message.
 * Non-fatal — never blocks response on DB failure.
 *
 * @param {string}      userId
 * @param {string|null} sessionId
 * @param {string}      analysis
 * @param {Object}      meta       - { model, tokens_used, source, snippetId? }
 */
async function persistAnalysis(userId, sessionId, analysis, meta) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id:    userId,
        session_id: sessionId || null,
        role:       'assistant',
        content:    analysis,               // LAW 11 — always 'content'
        card_type:  'text',
        metadata:   {
          source:      'vision',
          model:       meta.model       || null,
          tokens_used: meta.tokens_used || 0,
          snippetId:   meta.snippetId   || null,
        },
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('api:vision', 'Failed to persist analysis to conversations', {
      userId,
      sessionId,
      error: err.message,
    });
  }
}

/**
 * Validate that a snippet belongs to the user and is image type.
 * Returns the snippet row or null if not found / wrong type.
 *
 * @param {string} snippetId
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function verifySnippetOwnership(snippetId, userId) {
  try {
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: {
        id:      snippetId,
        user_id: userId,
        type:    SNIPPET_TYPES.IMAGE,
      },
      limit: 1,
    });
    return rows?.[0] || null;
  } catch (err) {
    logger.error('api:vision', 'Snippet ownership check failed', {
      snippetId,
      userId,
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — POST /api/vision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/vision
 *
 * Body:
 * {
 *   imageUrl?:  string,   public image URL
 *   base64?:    string,   raw base64 (no data URI prefix — or with, we strip it)
 *   mimeType?:  string,   required for imageUrl and base64 paths
 *   question?:  string,   what to ask about the image
 *   snippetId?: string,   UUID of image-type snippet in Supabase
 *   sessionId?: string,   for conversation persistence
 * }
 *
 * Response:
 * {
 *   analysis:    string,
 *   model:       string,
 *   tokens_used: number,
 *   snippetId?:  string,
 *   imageUrl?:   string,
 * }
 *
 * @param {Object} req
 * @param {Object} res
 */
async function visionHandler(req, res) {
  const { userId } = req.user;
  const {
    imageUrl  = null,
    base64    = null,
    mimeType  = null,
    question  = null,
    snippetId = null,
    sessionId = null,
  } = req.body;

  // ── Determine image source mode ────────────────────────────────────────────
  const hasSnippetId = Boolean(snippetId && typeof snippetId === 'string');
  const hasImageUrl  = Boolean(imageUrl  && typeof imageUrl  === 'string');
  const hasBase64    = Boolean(base64    && typeof base64    === 'string');

  if (!hasSnippetId && !hasImageUrl && !hasBase64) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'One of snippetId, imageUrl, or base64 is required',
    });
  }

  // mimeType required for imageUrl and base64 paths
  if ((hasImageUrl || hasBase64) && !mimeType) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'mimeType is required when passing imageUrl or base64',
    });
  }

  // Validate mimeType against supported set (imageUrl + base64 paths)
  if ((hasImageUrl || hasBase64) && mimeType) {
    const normalizedMime = mimeType.trim().toLowerCase();
    if (!VISION.SUPPORTED_MIME_TYPES.has(normalizedMime)) {
      return res.status(HTTP.BAD_REQUEST).json({
        error:   'unsupported_mime_type',
        message: `Unsupported mimeType "${mimeType}". Supported: ${[...VISION.SUPPORTED_MIME_TYPES].join(', ')}`,
      });
    }
  }

  logger.info('api:vision', 'Vision request received', {
    userId,
    mode:      hasSnippetId ? 'snippet' : hasImageUrl ? 'url' : 'base64',
    snippetId: hasSnippetId ? snippetId : undefined,
    mimeType,
    hasQuestion: Boolean(question),
  });

  await broadcastEmitter.trace(userId, `vision → ${hasSnippetId ? 'snippet' : hasImageUrl ? 'url' : 'base64'} mode`).catch(() => {});

  // ── Execute vision analysis ────────────────────────────────────────────────
  let result;

  try {

    // ── Path 1: Snippet ID ───────────────────────────────────────────────────
    if (hasSnippetId) {
      // Verify ownership and type before passing to visionHandler
      const snippet = await verifySnippetOwnership(snippetId, userId);

      if (!snippet) {
        return res.status(HTTP.NOT_FOUND).json({
          error:   'snippet_not_found',
          message: `Snippet "${snippetId}" not found, not accessible, or not an image type`,
        });
      }

      await broadcastEmitter.trace(userId, `vision → analyzing snippet #${snippet.number || snippetId}`).catch(() => {});

      result = await analyzeImage(
        {
          snippetId,
          question:  question || null,
          mimeType:  snippet.mime_type || mimeType || null,
        },
        userId
      );
    }

    // ── Path 2: Direct image URL ─────────────────────────────────────────────
    else if (hasImageUrl) {
      await broadcastEmitter.trace(userId, `vision → analyzing URL`).catch(() => {});

      result = await analyzeImage(
        {
          imageUrl:  imageUrl.trim(),
          question:  question || null,
          mimeType:  mimeType.trim().toLowerCase(),
        },
        userId
      );
    }

    // ── Path 3: Base64 inline data ───────────────────────────────────────────
    else {
      // Strip data URI prefix if caller included it
      let cleanBase64 = base64.trim();
      if (cleanBase64.startsWith('data:')) {
        const commaIdx = cleanBase64.indexOf(',');
        if (commaIdx !== -1) {
          cleanBase64 = cleanBase64.slice(commaIdx + 1);
        }
      }

      await broadcastEmitter.trace(userId, `vision → analyzing base64 image`).catch(() => {});

      result = await analyzeBase64(
        {
          base64Data: cleanBase64,
          mimeType:   mimeType.trim().toLowerCase(),
          question:   question || null,
        },
        userId
      );
    }

  } catch (err) {

    // All vision providers exhausted
    if (err.message === 'vision_unavailable') {
      await broadcastEmitter.warning(userId, {
        event:   'vision_unavailable',
        message: 'All vision providers are currently unavailable',
      }).catch(() => {});

      return res.status(HTTP.SERVICE_UNAVAILABLE).json({
        error:   'vision_unavailable',
        message: 'All vision providers are currently unavailable. Try again shortly.',
      });
    }

    // Inline size limit exceeded
    if (err.message?.includes('inline limit')) {
      return res.status(HTTP.BAD_REQUEST).json({
        error:   'image_too_large',
        message: err.message,
      });
    }

    // Snippet not found (from visionHandler internal check)
    if (err.message?.includes('not found')) {
      return res.status(HTTP.NOT_FOUND).json({
        error:   'snippet_not_found',
        message: err.message,
      });
    }

    logger.error('api:vision', 'Vision analysis failed', {
      userId,
      error: err.message,
    });

    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'vision_failed',
      message: 'Vision analysis encountered an error.',
    });
  }

  // ── Persist analysis result to conversations ───────────────────────────────
  await persistAnalysis(userId, sessionId, result.analysis, {
    model:       result.model,
    tokens_used: result.tokens_used,
    snippetId:   result.snippetId || null,
  });

  // ── SSE — notify dashboard that analysis is ready ──────────────────────────
  await broadcastEmitter.finding(userId, {
    event:       'vision_complete',
    analysis:    result.analysis.slice(0, 300),  // preview only in SSE
    model:       result.model,
    tokens_used: result.tokens_used,
    snippetId:   result.snippetId   || null,
    imageUrl:    result.imageUrl    || null,
    sessionId:   sessionId          || null,
  }).catch((err) => {
    logger.warn('api:vision', 'SSE emit (vision_complete) failed — non-fatal', {
      error: err.message,
    });
  });

  logger.info('api:vision', 'Vision analysis complete', {
    userId,
    model:      result.model,
    tokens:     result.tokens_used,
    snippetId:  result.snippetId || null,
    analysisLen: result.analysis.length,
  });

  // ── Response ───────────────────────────────────────────────────────────────
  return res.status(HTTP.OK).json({
    analysis:    result.analysis,
    model:       result.model,
    tokens_used: result.tokens_used,
    snippetId:   result.snippetId  || null,
    imageUrl:    result.imageUrl   || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = visionHandler;
