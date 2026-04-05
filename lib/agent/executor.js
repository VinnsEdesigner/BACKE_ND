'use strict';

const validator        = require('./validator');
const retryHandler     = require('./retryHandler');
const broadcastEmitter = require('./broadcastEmitter');
const logger           = require('../logger');
const { AGENT }        = require('../../utils/constants');

// ── EXECUTOR ──────────────────────────────────────────────────────────────────
// Executes a plan from reasoner.js step by step.
// Calls tool handlers, validates results, retries on failure.
// Streams progress via broadcastEmitter trace events.
// Tool handlers are injected via toolHandlers map — wired in api/agent.js.

// Tool handlers registry — populated by api/agent.js at startup
const toolHandlers = new Map();

/**
 * Register a tool handler.
 * Called from api/agent.js after all dependencies are loaded.
 */
function register(toolName, handler) {
  toolHandlers.set(toolName, handler);
  logger.debug('executor:register', `Registered handler for: ${toolName}`);
}

/**
 * Execute a plan step by step.
 *
 * @param {string}   userId
 * @param {object}   plan          - from reasoner.plan()
 * @param {Function} streamCallback - called with each text chunk (SSE streaming)
 *
 * @returns {{ success: boolean, results: Array, failedStep: object|null }}
 */
async function run(userId, plan, streamCallback = null) {
  const steps   = plan.steps || [];
  const results = [];
  let   failedStep = null;

  if (steps.length === 0) {
    logger.warn('executor:run', 'Empty plan — nothing to execute', { userId });
    return { success: true, results: [], failedStep: null };
  }

  logger.info('executor:run', `Executing ${steps.length} steps`, { userId });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { tool, description, args = {} } = step;

    await broadcastEmitter.trace(userId, `step ${i + 1}/${steps.length}: ${description}`);

    // Check handler exists
    const handler = toolHandlers.get(tool);
    if (!handler) {
      logger.warn('executor:run', `No handler for tool: ${tool}`, { userId });
      await broadcastEmitter.trace(userId, `⚠ no handler for ${tool} — skipping`);
      results.push({ step: i + 1, tool, skipped: true, reason: 'no_handler' });
      continue;
    }

    // Execute with retry
    let result;
    try {
      result = await retryHandler.run(
        () => handler(args, { userId, streamCallback }),
        {
          maxAttempts: AGENT.MAX_RETRIES,
          label:       `${tool} (step ${i + 1})`,
          shouldRetry: (err) => {
            // Don't retry auth errors or 404s
            const status = err.status || err.statusCode;
            return status !== 401 && status !== 403 && status !== 404;
          },
        }
      );
    } catch (err) {
      logger.error('executor:run', `Step ${i + 1} failed: ${tool}`, err);
      await broadcastEmitter.trace(userId, `❌ ${tool} failed: ${err.message}`);
      failedStep = { step: i + 1, tool, error: err.message };
      results.push({ step: i + 1, tool, success: false, error: err.message });
      // Stop execution on failure
      return { success: false, results, failedStep };
    }

    // Validate result
    const { valid, reason } = validator.check(tool, result);
    if (!valid) {
      logger.warn('executor:run', `Step ${i + 1} validation failed: ${reason}`, { userId });
      await broadcastEmitter.trace(userId, `⚠ ${tool} validation: ${reason}`);
      failedStep = { step: i + 1, tool, error: reason };
      results.push({ step: i + 1, tool, success: false, error: reason, result });
      return { success: false, results, failedStep };
    }

    await broadcastEmitter.trace(userId, `✅ ${tool} done`);
    results.push({ step: i + 1, tool, success: true, result });
    logger.debug('executor:run', `Step ${i + 1} completed: ${tool}`, { userId });
  }

  logger.info('executor:run', `All ${steps.length} steps completed`, { userId });
  return { success: true, results, failedStep: null };
}

module.exports = { run, register };
