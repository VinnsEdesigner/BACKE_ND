/**
 * @file fetchToSnippets.js
 * @location /backend/lib/agent/fetchToSnippets.js
 *
 * @purpose
 * Agent tool implementation for fetch_to_snippets.
 * Fetches content from a URL based on the declared snippet type,
 * then saves it to the Supabase snippets table.
 *
 * Type behaviour:
 *   'research' → fetch page text via Jina reader (Firecrawl fallback)
 *                → save as text content (truncated to MAX_SNIPPET_LENGTH)
 *   'code'     → fetch raw file/page content
 *                → save as code content (truncated to MAX_SNIPPET_LENGTH)
 *   'file'     → fetch content if text-based extension
 *                → save content + file metadata in metadata JSONB
 *                → enforces MAX_TEXT_FILE_BYTES limit
 *   'image'    → do NOT fetch image binary (LAW 22)
 *                → save URL as content + inferred metadata
 *                → no base64, no binary in Supabase
 *
 * @exports
 *   fetchToSnippets(params) → Promise<SavedSnippet>
 *
 * @imports
 *   ../supabase           → query()
 *   ../searchRouter       → not used directly (Jina used via fetch)
 *   ../logger             → structured logger
 *   ../../utils/constants → TABLES, SNIPPET_TYPES, SCRAPER, VISION
 *
 * @tables
 *   snippets
 *     READ:   SELECT MAX(number) for next number generation
 *     WRITE:  INSERT new snippet row
 *     columns used:
 *       user_id, session_id, number, type, content,
 *       source_url, pinned, metadata, mime_type,
 *       file_size, created_at
 *
 * @sse-events
 *   none — caller (executor.js / api/vision.js) emits SSE
 *
 * @env-vars
 *   FIRECRAWL_API_KEY — used in Firecrawl fallback
 *
 * @dependency-level 4
 */

'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger').child('fetchToSnippets');
const {
  TABLES,
  SNIPPET_TYPES,
  SCRAPER,
  VISION,
} = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// MIME TYPE INFERENCE
// Infer MIME type from URL file extension.
// Used for image snippets where mime_type is not explicitly provided.
// ─────────────────────────────────────────────────────────────────────────────

const EXTENSION_MIME_MAP = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
  bmp:  'image/bmp',
  svg:  'image/svg+xml',
};

/**
 * Infer MIME type from a URL's file extension.
 * Falls back to 'image/jpeg' for unknown extensions.
 *
 * @param {string} url
 * @returns {string}
 */
function inferMimeType(url) {
  if (!url || typeof url !== 'string') return 'image/jpeg';

  try {
    const pathname  = new URL(url).pathname;
    const ext       = pathname.split('.').pop()?.toLowerCase().trim();
    return EXTENSION_MIME_MAP[ext] || 'image/jpeg';
  } catch {
    return 'image/jpeg';
  }
}

/**
 * Infer file extension from URL pathname.
 *
 * @param {string} url
 * @returns {string} lowercase extension without dot, or ''
 */
function inferExtension(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('.').pop()?.toLowerCase().trim() || '';
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT SNIPPET NUMBER
// Gets the next available snippet number for a user+session.
// Scoped to session if sessionId provided, otherwise user-global.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the next snippet number for a user + optional session.
 * Finds MAX(number) and increments by 1. Starts at 1 if none exist.
 *
 * @param {string}      userId
 * @param {string|null} sessionId
 * @returns {Promise<number>}
 */
async function getNextSnippetNumber(userId, sessionId) {
  try {
    const filters = { user_id: userId };
    if (sessionId) filters.session_id = sessionId;

    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters,
      order:  { column: 'number', ascending: false },
      limit:  1,
      select: 'number',
    });

    if (!rows || rows.length === 0) return 1;

    const maxNumber = rows[0]?.number;
    return (typeof maxNumber === 'number' && !isNaN(maxNumber))
      ? maxNumber + 1
      : 1;
  } catch (err) {
    logger.warn('fetchToSnippets', 'Failed to get max snippet number — defaulting to 1', {
      userId,
      sessionId,
      error: err.message,
    });
    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT FETCHERS
// Each type has its own fetch strategy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch text content from a URL via Jina reader.
 * Falls back to Firecrawl if Jina fails.
 * Returns truncated content string.
 *
 * @param {string} url
 * @returns {Promise<{ content: string, fetchedVia: string }>}
 */
async function fetchTextContent(url) {
  // ── Jina reader (free, no key required) ───────────────────────────────────
  try {
    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data    = await res.json();
      const content = data.data?.content || data.content || '';
      if (content.trim()) {
        logger.debug('fetchToSnippets', `Jina fetch succeeded`, { url: url.slice(0, 80) });
        return {
          content:    content.slice(0, SCRAPER.MAX_SNIPPET_LENGTH),
          fetchedVia: 'jina',
        };
      }
    }
  } catch (err) {
    logger.debug('fetchToSnippets', `Jina fetch failed — trying Firecrawl`, {
      url:   url.slice(0, 80),
      error: err.message,
    });
  }

  // ── Firecrawl fallback ─────────────────────────────────────────────────────
  try {
    const FirecrawlApp = require('@mendable/firecrawl-js');
    const firecrawl    = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
    const result       = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
    const content      = result.markdown || '';

    if (content.trim()) {
      logger.debug('fetchToSnippets', `Firecrawl fetch succeeded`, { url: url.slice(0, 80) });
      return {
        content:    content.slice(0, SCRAPER.MAX_SNIPPET_LENGTH),
        fetchedVia: 'firecrawl',
      };
    }
  } catch (err) {
    logger.warn('fetchToSnippets', `Firecrawl fetch failed`, {
      url:   url.slice(0, 80),
      error: err.message,
    });
  }

  throw new Error(`fetchToSnippets: failed to fetch text content from "${url}" via Jina and Firecrawl`);
}

/**
 * Fetch raw file content from a URL.
 * Enforces MAX_TEXT_FILE_BYTES limit.
 * Only fetches if extension is in SCRAPER.SUPPORTED_TEXT_EXTS.
 *
 * @param {string} url
 * @param {string} ext  - file extension (lowercase, no dot)
 * @returns {Promise<{ content: string, fileSize: number, fetchedVia: string }>}
 */
async function fetchFileContent(url, ext) {
  // If extension not in supported set — skip content fetch
  if (!SCRAPER.SUPPORTED_TEXT_EXTS.has(ext)) {
    logger.debug('fetchToSnippets', `Extension "${ext}" not in supported text exts — metadata only`, {
      url: url.slice(0, 80),
    });
    return { content: '', fileSize: 0, fetchedVia: 'skipped' };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Check content-length before reading body
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > SCRAPER.MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `File too large: ${Math.round(contentLength / 1024)}KB exceeds ` +
        `${Math.round(SCRAPER.MAX_TEXT_FILE_BYTES / 1024)}KB limit`
      );
    }

    const text     = await res.text();
    const fileSize = Buffer.byteLength(text, 'utf8');

    if (fileSize > SCRAPER.MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `File content too large: ${Math.round(fileSize / 1024)}KB exceeds ` +
        `${Math.round(SCRAPER.MAX_TEXT_FILE_BYTES / 1024)}KB limit`
      );
    }

    return {
      content:    text.slice(0, SCRAPER.MAX_SNIPPET_LENGTH),
      fileSize,
      fetchedVia: 'direct',
    };
  } catch (err) {
    logger.warn('fetchToSnippets', `File fetch failed`, {
      url:   url.slice(0, 80),
      error: err.message,
    });
    throw new Error(`fetchToSnippets: failed to fetch file from "${url}": ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SNIPPET SAVERS
// Each type builds its own DB row shape.
// All use snippets.content column (never .text — LAW 11).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a research snippet to Supabase.
 *
 * @param {Object} params
 * @returns {Promise<Object>} saved snippet row
 */
async function saveResearchSnippet({ userId, sessionId, number, content, url, label, fetchedVia }) {
  const row = {
    user_id:    userId,
    session_id: sessionId || null,
    number,
    type:       SNIPPET_TYPES.RESEARCH,
    content:    content || '',          // LAW 11: always 'content', never 'text'
    source_url: url,
    pinned:     false,
    metadata:   {
      label:      label || null,
      fetchedVia,
      fetchedAt:  new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  };

  const rows = await query(TABLES.SNIPPETS, 'insert', { data: row });
  return rows?.[0] || row;
}

/**
 * Save a code snippet to Supabase.
 *
 * @param {Object} params
 * @returns {Promise<Object>} saved snippet row
 */
async function saveCodeSnippet({ userId, sessionId, number, content, url, label, fetchedVia }) {
  const row = {
    user_id:    userId,
    session_id: sessionId || null,
    number,
    type:       SNIPPET_TYPES.CODE,
    content:    content || '',
    source_url: url,
    pinned:     false,
    metadata:   {
      label:      label || null,
      fetchedVia,
      fetchedAt:  new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  };

  const rows = await query(TABLES.SNIPPETS, 'insert', { data: row });
  return rows?.[0] || row;
}

/**
 * Save a file snippet to Supabase.
 * Content may be empty if extension is not in SUPPORTED_TEXT_EXTS.
 *
 * @param {Object} params
 * @returns {Promise<Object>} saved snippet row
 */
async function saveFileSnippet({
  userId, sessionId, number, content,
  url, label, ext, fileSize, fetchedVia,
}) {
  const row = {
    user_id:    userId,
    session_id: sessionId || null,
    number,
    type:       SNIPPET_TYPES.FILE,
    content:    content || url,         // fall back to URL if no text content
    source_url: url,
    pinned:     false,
    file_size:  fileSize || null,
    metadata:   {
      label:      label || null,
      extension:  ext || null,
      fetchedVia,
      fetchedAt:  new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  };

  const rows = await query(TABLES.SNIPPETS, 'insert', { data: row });
  return rows?.[0] || row;
}

/**
 * Save an image snippet to Supabase.
 * Content = URL string (LAW 22 — no base64 in DB).
 * Metadata = { mimeType, label, fetchedAt }.
 *
 * @param {Object} params
 * @returns {Promise<Object>} saved snippet row
 */
async function saveImageSnippet({ userId, sessionId, number, url, label, mimeType }) {
  const inferredMime = mimeType || inferMimeType(url);

  const row = {
    user_id:    userId,
    session_id: sessionId || null,
    number,
    type:       SNIPPET_TYPES.IMAGE,
    content:    url,                    // LAW 22: URL only, never base64
    source_url: url,
    pinned:     false,
    mime_type:  inferredMime,
    metadata:   {
      label:      label || null,
      mimeType:   inferredMime,
      fetchedAt:  new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  };

  const rows = await query(TABLES.SNIPPETS, 'insert', { data: row });
  return rows?.[0] || row;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FetchToSnippetsParams
 * @property {string}      url        - URL to fetch content from
 * @property {string}      type       - 'code' | 'research' | 'image' | 'file'
 * @property {string}      [label]    - human-readable label for the snippet
 * @property {string}      userId     - required
 * @property {string|null} [sessionId] - current session UUID (nullable)
 * @property {string}      [mimeType] - explicit MIME type (image type only)
 */

/**
 * @typedef {Object} SavedSnippet
 * @property {string} id
 * @property {number} number
 * @property {string} type
 * @property {string} content
 * @property {string} source_url
 * @property {Object} metadata
 */

/**
 * Fetch content from a URL and save it as a Supabase snippet.
 * Entry point for the fetch_to_snippets agent tool.
 *
 * @param {FetchToSnippetsParams} params
 * @returns {Promise<SavedSnippet>}
 */
async function fetchToSnippets(params) {
  const {
    url,
    type,
    label     = null,
    userId,
    sessionId = null,
    mimeType  = null,
  } = params || {};

  // ── Input validation ───────────────────────────────────────────────────────
  if (!url || typeof url !== 'string' || !url.trim()) {
    throw new Error('fetchToSnippets: url is required');
  }
  if (!userId) {
    throw new Error('fetchToSnippets: userId is required');
  }

  const validTypes = Object.values(SNIPPET_TYPES);
  if (!type || !validTypes.includes(type)) {
    throw new Error(
      `fetchToSnippets: invalid type "${type}" — must be one of: ${validTypes.join(', ')}`
    );
  }

  const normalizedUrl = url.trim();

  logger.info('fetchToSnippets', `Fetching ${type} snippet`, {
    url:       normalizedUrl.slice(0, 80),
    type,
    userId,
    sessionId,
  });

  // ── Get next snippet number ────────────────────────────────────────────────
  const number = await getNextSnippetNumber(userId, sessionId);

  // ── Dispatch by type ───────────────────────────────────────────────────────
  try {
    switch (type) {

      case SNIPPET_TYPES.RESEARCH: {
        const { content, fetchedVia } = await fetchTextContent(normalizedUrl);
        const saved = await saveResearchSnippet({
          userId,
          sessionId,
          number,
          content,
          url:       normalizedUrl,
          label,
          fetchedVia,
        });
        logger.info('fetchToSnippets', `Research snippet #${number} saved`, {
          userId, chars: content.length,
        });
        return saved;
      }

      case SNIPPET_TYPES.CODE: {
        const { content, fetchedVia } = await fetchTextContent(normalizedUrl);
        const saved = await saveCodeSnippet({
          userId,
          sessionId,
          number,
          content,
          url:       normalizedUrl,
          label,
          fetchedVia,
        });
        logger.info('fetchToSnippets', `Code snippet #${number} saved`, {
          userId, chars: content.length,
        });
        return saved;
      }

      case SNIPPET_TYPES.FILE: {
        const ext = inferExtension(normalizedUrl);
        const { content, fileSize, fetchedVia } = await fetchFileContent(normalizedUrl, ext);
        const saved = await saveFileSnippet({
          userId,
          sessionId,
          number,
          content,
          url:       normalizedUrl,
          label,
          ext,
          fileSize,
          fetchedVia,
        });
        logger.info('fetchToSnippets', `File snippet #${number} saved`, {
          userId, ext, fileSize,
        });
        return saved;
      }

      case SNIPPET_TYPES.IMAGE: {
        // LAW 22: never fetch image binary — save URL + metadata only
        const saved = await saveImageSnippet({
          userId,
          sessionId,
          number,
          url:      normalizedUrl,
          label,
          mimeType,
        });
        logger.info('fetchToSnippets', `Image snippet #${number} saved`, {
          userId, url: normalizedUrl.slice(0, 80),
        });
        return saved;
      }

      default:
        // Should never reach here due to validation above
        throw new Error(`fetchToSnippets: unhandled type "${type}"`);
    }
  } catch (err) {
    // Re-throw with context — LAW 9
    logger.error('fetchToSnippets', `Failed to fetch and save ${type} snippet`, {
      url:   normalizedUrl.slice(0, 80),
      type,
      userId,
      error: err.message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { fetchToSnippets };
