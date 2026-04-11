/**
 * @file toolInjector.js
 * @location /backend/lib/agent/toolInjector.js
 *
 * @purpose
 * Injects the correct set of tools into an agent request based on intent
 * and execution context. Enforces context-level tool constraints without
 * hard-blocking the agent — the agent remains self-aware of its context
 * and self-regulates on grey-area operations.
 *
 * Context rules:
 *   'dashboard'   → all tools for the intent (write + read)
 *   'bookmarklet' → READ_ONLY_TOOLS only (no write_file, delete_file, etc.)
 *   'api'         → same as dashboard (programmatic callers get full access)
 *
 * Force mode:
 *   Bypasses intent-based filtering but STILL respects context.
 *   bookmarklet + forceMode = all read-only tools (not all tools).
 *   dashboard   + forceMode = all tools (full set).
 *
 * @exports
 *   inject(intent, options)                    → OpenAI tool schema array
 *   names(intent, options)                     → string[] tool names
 *   injectForContext(intent, context, force)   → OpenAI tool schema array
 *
 * @imports
 *   ../tools   → schemaForContext, allSchema, readOnlySchema,
 *                namesForContext, allNames, readOnlyNames
 *   ../logger  → child('toolInjector')
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   none
 *
 * @dependency-level 2
 */

'use strict';

const tools  = require('../tools');
const logger = require('../logger').child('toolInjector');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CONTEXTS = new Set(['bookmarklet', 'dashboard', 'api']);
const DEFAULT_CONTEXT = 'dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and validate context string.
 * Falls back to DEFAULT_CONTEXT on unknown or missing value.
 *
 * @param {*} context
 * @returns {'bookmarklet' | 'dashboard' | 'api'}
 */
function normalizeContext(context) {
  if (!context || typeof context !== 'string') return DEFAULT_CONTEXT;
  const cleaned = context.trim().toLowerCase();
  return VALID_CONTEXTS.has(cleaned) ? cleaned : DEFAULT_CONTEXT;
}

/**
 * Normalize intent string.
 * Falls back to 'chat' on unknown or missing value.
 * Avoids crashing on undefined intent from classifier.
 *
 * @param {*} intent
 * @returns {string}
 */
function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'string') return 'chat';
  return intent.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INJECTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InjectOptions
 * @property {boolean}                          [forceMode=false]
 *   Bypass intent filtering. Still respects context constraints.
 * @property {'bookmarklet'|'dashboard'|'api'}  [context='dashboard']
 *   Execution context — controls which tools are permitted.
 */

/**
 * Get the tool schema array to inject for a given intent and context.
 *
 * Force mode behaviour:
 *   bookmarklet → readOnlySchema() (all safe tools, no write tools)
 *   dashboard   → allSchema()      (every registered tool)
 *   api         → allSchema()      (same as dashboard)
 *
 * Normal mode behaviour:
 *   Delegates to tools.schemaForContext(intent, context) which applies
 *   the READ_ONLY_TOOLS filter for bookmarklet automatically.
 *
 * @param {string}        intent
 * @param {InjectOptions} options
 * @returns {Array} OpenAI-compatible tool schema array
 */
function inject(intent = 'chat', options = {}) {
  const {
    forceMode = false,
    context   = DEFAULT_CONTEXT,
  } = options;

  const normalizedIntent  = normalizeIntent(intent);
  const normalizedContext = normalizeContext(context);

  // ── Force mode ─────────────────────────────────────────────────────────────
  if (forceMode) {
    if (normalizedContext === 'bookmarklet') {
      const readOnly = tools.readOnlySchema();
      logger.debug('inject', `⚡ Force mode [bookmarklet] — ${readOnly.length} read-only tools`, {
        tools: tools.readOnlyNames(),
      });
      return readOnly;
    }

    // dashboard or api — full tool set
    const all = tools.allSchema();
    logger.debug('inject', `⚡ Force mode [${normalizedContext}] — ${all.length} tools`, {
      tools: tools.allNames(),
    });
    return all;
  }

  // ── Normal mode ────────────────────────────────────────────────────────────
  const schemaArr = tools.schemaForContext(normalizedIntent, normalizedContext);
  const toolNames = tools.namesForContext(normalizedIntent, normalizedContext);

  logger.debug('inject', `Intent "${normalizedIntent}" [${normalizedContext}] → ${schemaArr.length} tools`, {
    tools: toolNames,
  });

  return schemaArr;
}

/**
 * Get tool names for a given intent and context.
 * Mirrors inject() logic exactly — same filter, returns names instead of schemas.
 * Used for logging, tracing, and SSE broadcast messages.
 *
 * @param {string}        intent
 * @param {InjectOptions} options
 * @returns {string[]} deduplicated tool names
 */
function names(intent = 'chat', options = {}) {
  const {
    forceMode = false,
    context   = DEFAULT_CONTEXT,
  } = options;

  const normalizedIntent  = normalizeIntent(intent);
  const normalizedContext = normalizeContext(context);

  if (forceMode) {
    if (normalizedContext === 'bookmarklet') {
      return tools.readOnlyNames();
    }
    return tools.allNames();
  }

  return tools.namesForContext(normalizedIntent, normalizedContext);
}

/**
 * Convenience wrapper — explicit context and forceMode args instead of options object.
 * Useful when callers construct context and forceMode separately.
 *
 * @param {string}                              intent
 * @param {'bookmarklet'|'dashboard'|'api'}     context
 * @param {boolean}                             [forceMode=false]
 * @returns {Array} OpenAI-compatible tool schema array
 */
function injectForContext(intent, context, forceMode = false) {
  return inject(intent, { context, forceMode });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  inject,
  names,
  injectForContext,
  VALID_CONTEXTS,
  DEFAULT_CONTEXT,
};
