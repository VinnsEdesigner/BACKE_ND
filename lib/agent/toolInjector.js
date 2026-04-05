'use strict';

const tools  = require('../tools');
const logger = require('../logger');

// ── TOOL INJECTOR ─────────────────────────────────────────────────────────────
// Injects ONLY relevant tools based on intent.
// Conditional injection saves thousands of tokens vs always-on.
// Force mode bypasses classifier → injects ALL tools.

/**
 * Get tool schema array to inject for a given intent.
 *
 * @param {string}  intent    - from intentClassifier
 * @param {boolean} forceMode - bypass classifier, inject all tools
 * @returns {Array} OpenAI-compatible tool schema array
 */
function inject(intent = 'chat', forceMode = false) {
  if (forceMode) {
    const all = tools.allSchema();
    logger.debug('toolInjector', `⚡ Force mode — injecting all ${all.length} tools`);
    return all;
  }

  const schema = tools.schema(intent);
  logger.debug('toolInjector', `Intent: ${intent} → injecting ${schema.length} tools`, {
    tools: tools.namesForIntent(intent),
  });
  return schema;
}

/**
 * Get tool names for a given intent (for logging/tracing).
 */
function names(intent = 'chat', forceMode = false) {
  if (forceMode) return Object.keys(tools.INTENT_TOOLS).flatMap((i) => tools.namesForIntent(i));
  return tools.namesForIntent(intent);
}

module.exports = { inject, names };
