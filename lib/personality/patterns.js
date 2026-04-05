'use strict';

const memory = require('./memory');
const logger = require('../logger');

// ── PATTERNS ──────────────────────────────────────────────────────────────────
// Detects and stores recurring patterns in user requests.
// In-memory detection + persisted to memory table.

const PREFIX = 'pattern:';

/**
 * Detect patterns from a messages array.
 * Returns array of detected pattern strings.
 */
function detect(messages) {
  if (!Array.isArray(messages)) return [];

  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => (m.content || '').toLowerCase());

  const patterns = [];

  // TypeScript preference
  if (userMessages.filter((m) => m.includes('typescript') || m.includes(' ts ')).length >= 2) {
    patterns.push('ts_preferred');
  }

  // Verbose comments preference
  if (userMessages.filter((m) => m.includes('comment') || m.includes('explain')).length >= 2) {
    patterns.push('verbose_comments');
  }

  // Small functions preference
  if (userMessages.filter((m) => m.includes('small') || m.includes('simple') || m.includes('clean')).length >= 2) {
    patterns.push('prefers_small_functions');
  }

  // No frameworks preference
  if (userMessages.filter((m) => m.includes('vanilla') || m.includes('no framework')).length >= 1) {
    patterns.push('no_frameworks');
  }

  return patterns;
}

/**
 * Get stored patterns for a user.
 */
async function get(userId) {
  const { facts } = await memory.get(userId);
  return facts
    .filter((f) => f.key.startsWith(PREFIX))
    .map((f) => f.key.replace(PREFIX, ''));
}

/**
 * Save detected patterns to memory.
 */
async function save(userId, patterns) {
  for (const pattern of patterns) {
    try {
      await memory.save(userId, `${PREFIX}${pattern}`, 'true');
    } catch (err) {
      logger.warn('patterns:save', `Failed to save pattern ${pattern}`, err);
    }
  }
}

module.exports = { detect, get, save };
