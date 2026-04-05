'use strict';

const freedom = require('../personality/freedom');
const logger  = require('../logger');

// ── CONFIRMATION GATE ─────────────────────────────────────────────────────────
// Fires BEFORE any destructive operation.
// Generates confirmation card data for Terminal UI.
// shouldConfirm() decides if gate is needed based on autonomy level.

/**
 * Check if a confirmation is needed before an action.
 *
 * @param {string} userId
 * @param {string} action  - tool name (e.g. 'write_file', 'merge_pr')
 * @returns {boolean}
 */
async function shouldConfirm(userId, action) {
  const ask = await freedom.shouldAsk(userId, action);
  logger.debug('confirmationGate', `${action} → ask: ${ask}`, { userId });
  return ask;
}

/**
 * Build a confirmation card payload for the Terminal UI.
 *
 * plan: {
 *   action:      string,   // tool name
 *   description: string,   // human-readable description
 *   details:     object,   // tool args summary
 *   risk:        'low' | 'medium' | 'high',
 * }
 *
 * Returns card data — Terminal renders this as a confirm-card component.
 */
function buildCard(plan) {
  return {
    type:        'confirmation',
    action:      plan.action,
    description: plan.description || `Run: ${plan.action}`,
    details:     plan.details     || {},
    risk:        plan.risk        || 'medium',
    timestamp:   new Date().toISOString(),
    // UI renders these as buttons:
    options: [
      { label: '✅ Proceed',      value: 'proceed' },
      { label: '✏️ Modify plan',  value: 'modify'  },
      { label: '❌ Cancel',       value: 'cancel'  },
    ],
  };
}

/**
 * Determine risk level for an action.
 */
function riskLevel(action) {
  const HIGH   = ['delete_file', 'merge_pr'];
  const MEDIUM = ['write_file', 'create_pr', 'update_repo_settings'];
  if (HIGH.includes(action))   return 'high';
  if (MEDIUM.includes(action)) return 'medium';
  return 'low';
}

module.exports = { shouldConfirm, buildCard, riskLevel };
