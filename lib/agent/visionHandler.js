/**
 * @file visionHandler.js
 * @location /backend/lib/agent/visionHandler.js
 *
 * @purpose
 * Handles all image analysis requests by dispatching to ai.vision().
 * Resolves image sources (URL, base64, or Supabase snippet reference)
 * into a normalized input shape, then calls the Gemini/Gemma vision
 * chain via ai.vision(). Pure function — receives input, returns
 * analysis. Does not persist results (caller's responsibility).
 *
 * Two entry points:
 *   analyzeImage(params, userId)   → URL or snippet ID source
 *   analyzeBase64(params, userId)  → inline base64 source
 *
 * @exports
 *   analyzeImage(params, userId)   → Promise<VisionResult>
 *   analyzeBase64(params, userId)  → Promise<VisionResult>
 *
 * @imports
 *   ../ai              → vision(), (markProvider exported but handled inside ai.vision)
 *   ../supabase        → query()
 *   ../logger          → structured logger
 *   ../../utils/constants → TABLES, VISION, SNIPPET_TYPES
 *
 * @tables
 *   snippets → SELECT by id + user_id (image type only)
 *              columns read: id, content (URL), mime_type, metadata
 *
 * @sse-events
 *   none — caller (api/vision.js or executor.js) emits SSE
 *
 * @env-vars
 *   none directly — ai.js handles GEMINI_API_KEY
 *
 * @dependency-level 4
 */

'use strict';

const { vision }          = require('../ai');
const { query }           = require('../supabase');
const logger              = require('../logger').child('visionHandler');
const { TABLES, VISION, SNIPPET_TYPES } = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_QUESTION    = 'Describe what you see in this image in detail.';
const DEFAULT_MIME_TYPE   = 'image/jpeg';
const MAX_QUESTION_LENGTH = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and validate a question string.
 * Falls back to default if empty or invalid.
 *
 * @param {*} question
 * @returns {string}
 */
function normalizeQuestion(question) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    return DEFAULT_QUESTION;
  }
  return question.trim().slice(0, MAX_QUESTION_LENGTH);
}

/**
 * Validate a MIME type against the supported set.
 * Falls back to DEFAULT_MIME_TYPE with a warning if unsupported.
 *
 * @param {string} mimeType
 * @param {string} context  - for logging
 * @returns {string}
 */
function normalizeMimeType(mimeType, context = '') {
  if (!mimeType || typeof mimeType !== 'string') {
    logger.warn('visionHandler', `Missing mimeType${context ? ` (${context})` : ''} — defaulting to ${DEFAULT_MIME_TYPE}`);
    return DEFAULT_MIME_TYPE;
  }

  const normalized = mimeType.trim().toLowerCase();

  if (!VISION.SUPPORTED_MIME_TYPES.has(normalized)) {
    logger.warn('visionHandler', `Unsupported mimeType "${normalized}"${context ? ` (${context})` : ''} — defaulting to ${DEFAULT_MIME_TYPE}`);
    return DEFAULT_MIME_TYPE;
  }

  return normalized;
}

/**
 * Load an image-type snippet from Supabase by ID.
 * Enforces user_id scoping — never allows cross-user access.
 * Returns null if not found or wrong type.
 *
 * @param {string} snippetId
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function loadSnippetById(snippetId, userId) {
  if (!snippetId || !userId) return null;

  try {
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: {
        id:      snippetId,
        user_id: userId,
        type:    SNIPPET_TYPES.IMAGE,
      },
      limit: 1,
    });

    if (!rows || rows.length === 0) {
      logger.warn('visionHandler', `Snippet not found or not image type`, {
        snippetId,
        userId,
      });
      return null;
    }

    return rows[0];
  } catch (err) {
    logger.error('visionHandler', 'Failed to load snippet from Supabase', {
      snippetId,
      userId,
      error: err.message,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULT SHAPE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} VisionResult
 * @property {string}  analysis    - text analysis from vision model
 * @property {string}  model       - model string that produced the result
 * @property {number}  tokens_used - total tokens consumed
 * @property {string}  source      - 'url' | 'snippet' | 'base64'
 * @property {string}  [snippetId] - if source was a snippet
 * @property {string}  [imageUrl]  - resolved URL used for analysis
 */

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE IMAGE — URL OR SNIPPET ID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze an image from a public URL or a Supabase snippet reference.
 *
 * Priority:
 *   1. snippetId → load snippet → use snippet.content as URL
 *   2. imageUrl  → use directly
 *   Must provide at least one.
 *
 * @param {Object} params
 * @param {string} [params.imageUrl]   - public image URL
 * @param {string} [params.snippetId]  - UUID of image-type snippet
 * @param {string} [params.question]   - what to ask about the image
 * @param {string} [params.mimeType]   - MIME type (required for imageUrl path)
 * @param {number} [params.maxTokens]  - override default max tokens
 * @param {string} userId              - required for snippet security scoping
 * @returns {Promise<VisionResult>}
 */
async function analyzeImage(params, userId) {
  const {
    imageUrl  = null,
    snippetId = null,
    question  = null,
    mimeType  = null,
    maxTokens = VISION.MAX_TOKENS,
  } = params || {};

  // ── Validate — need at least one image source ──────────────────────────────
  if (!imageUrl && !snippetId) {
    throw new Error('visionHandler.analyzeImage: imageUrl or snippetId is required');
  }

  if (!userId) {
    throw new Error('visionHandler.analyzeImage: userId is required');
  }

  const normalizedQuestion = normalizeQuestion(question);
  let   resolvedUrl        = null;
  let   resolvedMimeType   = null;
  let   source             = 'url';
  let   resolvedSnippetId  = null;

  // ── Snippet path ───────────────────────────────────────────────────────────
  if (snippetId) {
    const snippet = await loadSnippetById(snippetId, userId);

    if (!snippet) {
      throw new Error(`visionHandler.analyzeImage: snippet "${snippetId}" not found or not accessible`);
    }

    if (!snippet.content || typeof snippet.content !== 'string') {
      throw new Error(`visionHandler.analyzeImage: snippet "${snippetId}" has no image URL in content`);
    }

    resolvedUrl       = snippet.content;
    resolvedMimeType  = normalizeMimeType(
      snippet.mime_type || mimeType,
      `snippet:${snippetId}`
    );
    source            = 'snippet';
    resolvedSnippetId = snippetId;

    logger.debug('visionHandler', `Analyzing image from snippet`, {
      snippetId,
      url:      resolvedUrl.slice(0, 80),
      mimeType: resolvedMimeType,
      userId,
    });
  } else {
    // ── Direct URL path ──────────────────────────────────────────────────────
    if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
      throw new Error('visionHandler.analyzeImage: imageUrl must be a non-empty string');
    }

    resolvedUrl      = imageUrl.trim();
    resolvedMimeType = normalizeMimeType(mimeType, 'imageUrl');
    source           = 'url';

    logger.debug('visionHandler', `Analyzing image from URL`, {
      url:      resolvedUrl.slice(0, 80),
      mimeType: resolvedMimeType,
      userId,
    });
  }

  // ── Call ai.vision() ───────────────────────────────────────────────────────
  // ai.vision() manages the full Gemini/Gemma waterfall internally.
  // visionHandler does not re-implement the chain.
  try {
    const result = await vision(
      {
        imageUrl:  resolvedUrl,
        mimeType:  resolvedMimeType,
      },
      normalizedQuestion,
      { maxTokens }
    );

    logger.info('visionHandler', `Vision analysis complete`, {
      model:      result.model,
      tokens:     result.tokens_used,
      source,
      snippetId:  resolvedSnippetId,
      userId,
    });

    return {
      analysis:   result.text,
      model:      result.model,
      tokens_used: result.tokens_used,
      source,
      snippetId:  resolvedSnippetId || undefined,
      imageUrl:   resolvedUrl,
    };
  } catch (err) {
    // vision_unavailable = all vision providers exhausted
    if (err.message === 'vision_unavailable') {
      logger.error('visionHandler', 'All vision providers exhausted', {
        source,
        userId,
      });
      throw err; // re-throw — api/vision.js returns 503
    }
    logger.error('visionHandler', 'Vision analysis failed', {
      error:  err.message,
      source,
      userId,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE BASE64 — INLINE IMAGE DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze an image from inline base64 data.
 * Enforces the 4MB inline limit (VISION.MAX_INLINE_BYTES).
 * Images larger than 4MB must be uploaded and passed as a URL.
 *
 * Base64 string must be raw (no data URI prefix like "data:image/jpeg;base64,").
 * Caller is responsible for stripping the prefix before calling this function.
 *
 * @param {Object} params
 * @param {string} params.base64Data  - raw base64 string (no data URI prefix)
 * @param {string} params.mimeType    - MIME type of the image
 * @param {string} [params.question]  - what to ask about the image
 * @param {number} [params.maxTokens] - override default max tokens
 * @param {string} userId
 * @returns {Promise<VisionResult>}
 */
async function analyzeBase64(params, userId) {
  const {
    base64Data = null,
    mimeType   = null,
    question   = null,
    maxTokens  = VISION.MAX_TOKENS,
  } = params || {};

  if (!userId) {
    throw new Error('visionHandler.analyzeBase64: userId is required');
  }

  if (!base64Data || typeof base64Data !== 'string' || !base64Data.trim()) {
    throw new Error('visionHandler.analyzeBase64: base64Data is required');
  }

  // Strip data URI prefix if caller forgot to remove it
  let cleanBase64 = base64Data.trim();
  if (cleanBase64.startsWith('data:')) {
    const commaIdx = cleanBase64.indexOf(',');
    if (commaIdx !== -1) {
      cleanBase64 = cleanBase64.slice(commaIdx + 1);
    }
  }

  // Enforce 4MB inline limit (LAW 22 / VISION.MAX_INLINE_BYTES)
  const byteSize = Math.ceil((cleanBase64.length * 3) / 4);
  if (byteSize > VISION.MAX_INLINE_BYTES) {
    throw new Error(
      `visionHandler.analyzeBase64: image size ~${Math.round(byteSize / 1024 / 1024)}MB exceeds ` +
      `${VISION.MAX_INLINE_BYTES / 1024 / 1024}MB inline limit — ` +
      `upload the image and pass as imageUrl instead`
    );
  }

  const resolvedMimeType   = normalizeMimeType(mimeType, 'base64');
  const normalizedQuestion = normalizeQuestion(question);

  logger.debug('visionHandler', `Analyzing base64 image`, {
    mimeType:  resolvedMimeType,
    sizeKB:    Math.round(byteSize / 1024),
    userId,
  });

  // ── Call ai.vision() ───────────────────────────────────────────────────────
  try {
    const result = await vision(
      {
        base64Data: cleanBase64,
        mimeType:   resolvedMimeType,
      },
      normalizedQuestion,
      { maxTokens }
    );

    logger.info('visionHandler', `Base64 vision analysis complete`, {
      model:  result.model,
      tokens: result.tokens_used,
      userId,
    });

    return {
      analysis:   result.text,
      model:      result.model,
      tokens_used: result.tokens_used,
      source:     'base64',
    };
  } catch (err) {
    if (err.message === 'vision_unavailable') {
      logger.error('visionHandler', 'All vision providers exhausted (base64 path)', { userId });
      throw err;
    }
    logger.error('visionHandler', 'Base64 vision analysis failed', {
      error: err.message,
      userId,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  analyzeImage,
  analyzeBase64,
};
