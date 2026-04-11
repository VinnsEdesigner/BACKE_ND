'use strict';

const validator        = require('./validator');
const retryHandler     = require('./retryHandler');
const broadcastEmitter = require('./broadcastEmitter');
const logger           = require('../logger');
const { AGENT }        = require('../../utils/constants');

const toolHandlers = new Map();

function register(toolName, handler) {
  toolHandlers.set(toolName, handler);
  logger.debug('executor:register', `Registered handler for: ${toolName}`);
}

// BUG 4 FIX: accept execContext as 3rd param, forward to handlers
async function run(userId, plan, execContext = {}, streamCallback = null) {
  const steps   = plan.steps || [];
  const results = [];
  let   failedStep = null;

  // Merge userId into execContext so handlers always have it
  const ctx = { userId, ...execContext };

  if (steps.length === 0) {
    logger.warn('executor:run', 'Empty plan — nothing to execute', { userId });
    return { success: true, results: [], failedStep: null };
  }

  logger.info('executor:run', `Executing ${steps.length} steps`, { userId });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { tool, description, args = {} } = step;

    await broadcastEmitter.trace(userId, `step ${i + 1}/${steps.length}: ${description}`);

    const handler = toolHandlers.get(tool);
    if (!handler) {
      logger.warn('executor:run', `No handler for tool: ${tool}`, { userId });
      await broadcastEmitter.trace(userId, `⚠ no handler for ${tool} — skipping`);
      results.push({ step: i + 1, tool, skipped: true, reason: 'no_handler' });
      continue;
    }

    let result;
    try {
      result = await retryHandler.run(
        () => handler(args, ctx),  // BUG 4 FIX: pass full ctx including sessionId
        {
          maxAttempts: AGENT.MAX_RETRIES,
          label:       `${tool} (step ${i + 1})`,
          shouldRetry: (err) => {
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
      return { success: false, results, failedStep };
    }

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
