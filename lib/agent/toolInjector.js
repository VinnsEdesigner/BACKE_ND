/**
 * @file toolInjector.js
 * @location /backend/lib/agent/toolInjector.js
 *
 * @purpose
 * Injects relevant tools into the AI prompt based on intent and context.
 * Enforces read-only restriction for bookmarklet context.
 * Supports force mode to bypass intent-based filtering.
 *
 * @exports
 *   inject(intent, options)       → OpenAI-compatible tool schema array
 *   names(intent, options)        → tool names for logging/tracing
 *   injectForContext(intent, context, forceMode) → convenience wrapper
 *
 * @imports
 *   ../tools        → schema, schemaForContext, allSchema, readOnlySchema, etc.
 *   ../logger       → child('toolInjector')
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

const tools = require('../tools');
const logger = require('../logger').child('toolInjector');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CONTEXTS = new Set(['bookmarklet', 'dashboard', 'api']);
const DEFAULT_CONTEXT = 'dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeContext(context) {
  if (!context || typeof context !== 'string') return DEFAULT_CONTEXT;
  const cleaned = context.trim().toLowerCase();
  return VALID_CONTEXTS.has(cleaned) ? cleaned : DEFAULT_CONTEXT;
}

function dedupeArray(arr) {
  return [...new Set(arr)];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INJECTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InjectOptions
 * @property {boolean} [forceMode=false]  - Bypass intent filtering, inject all tools
 * @property {'bookmarklet'|'dashboard'|'api'} [context='dashboard'] - Execution context
 */

/**
 * Get tool schema array to inject for a given intent.
 *
 * @param {string} intent          - Canonical intent from intentClassifier
 * @param {InjectOptions} options
 * @returns {Array} OpenAI-compatible tool schema array
 */
function inject(intent = 'chat', options = {}) {
  const { forceMode = false, context = DEFAULT_CONTEXT } = options;
  const normalizedContext = normalizeContext(context);

  // ── Force mode ─────────────────────────────────────────────────────────────
  // Bypass intent filtering, but STILL respect context restrictions.
  // Bookmarklet force mode only gets read-only tools.
  if (forceMode) {
    if (normalizedContext === 'bookmarklet') {
      const readOnly = tools.readOnlySchema();
      logger.debug(`⚡ Force mode (bookmarklet) — injecting ${readOnly.length} read-only tools`);
      return readOnly;
    }

    const all = tools.allSchema();
    logger.debug(`⚡ Force mode (${normalizedContext}) — injecting all ${all.length} tools`);
    return all;
  }

  // ── Normal mode ────────────────────────────────────────────────────────────
  const schemaArr = tools.schemaForContext(intent, normalizedContext);
  const toolNames = tools.namesForContext(intent, normalizedContext);

  logger.debug(`Intent: ${intent} | Context: ${normalizedContext} → ${schemaArr.length} tools`, {
    tools: toolNames,
  });

  return schemaArr;
}

/**
 * Get tool names for a given intent (for logging/tracing).
 *
 * @param {string} intent
 * @param {InjectOptions} options
 * @returns {string[]} Deduplicated tool names
 */
function names(intent = 'chat', options = {}) {
  const { forceMode = false, context = DEFAULT_CONTEXT } = options;
  const normalizedContext = normalizeContext(context);

  if (forceMode) {
    if (normalizedContext === 'bookmarklet') {
      return tools.readOnlyNames();
    }
    return tools.allNames();
  }

  return dedupeArray(tools.namesForContext(intent, normalizedContext));
}

/**
 * Convenience wrapper for context-aware injection.
 *
 * @param {string} intent
 * @param {'bookmarklet'|'dashboard'|'api'} context
 * @param {boolean} forceMode
 * @returns {Array}
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
