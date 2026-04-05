'use strict';

const logger = require('../logger');
const { AGENT } = require('../../utils/constants');

// ── RETRY HANDLER ─────────────────────────────────────────────────────────────
// Smart retry with exponential backoff.
// attempt 1 → immediate retry
// attempt 2 → wait 1s
// attempt 3 → wait 3s
// attempt 4 → wait 8s
// attempt 5 → give up → throws

const BACKOFF_MS = [0, 1000, 3000, 8000]; // index = attempt number (0-based)

/**
 * Run a function with automatic retry on failure.
 *
 * @param {Function} fn       - async function to retry
 * @param {object}   options
 *   maxAttempts {number}     - max attempts (default: AGENT.MAX_RETRIES = 5)
 *   label       {string}     - label for logging
 *   shouldRetry {Function}   - (error) → boolean, default: always retry
 *
 * @returns result of fn on success
 * @throws  last error after all attempts exhausted
 */
async function run(fn, options = {}) {
  const {
    maxAttempts = AGENT.MAX_RETRIES,
    label       = 'operation',
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info('retryHandler', `${label} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (err) {
      lastError = err;

      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(err)) {
        logger.error('retryHandler', `${label} failed after ${attempt + 1} attempt(s)`, err);
        throw err;
      }

      const waitMs = BACKOFF_MS[attempt] ?? 8000;
      logger.warn('retryHandler', `${label} attempt ${attempt + 1} failed → retry in ${waitMs}ms`, {
        error: err.message,
      });

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  throw lastError;
}

module.exports = { run };
