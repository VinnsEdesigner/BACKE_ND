/**
 * @file dynamicContext.js
 * @location /backend/lib/personality/prompts/dynamicContext.js
 *
 * @purpose
 * Assembles the live runtime state block for each request.
 * Includes: current model health, active tasks, session snippet
 * count, and any proactive observations from selfDiagnose.
 * This block changes per request — it reflects what is happening
 * RIGHT NOW in the system.
 *
 * @exports
 *   getDynamicContextBlock(userId, agentContext) → Promise<string>
 *
 * @imports
 *   ../../lib/ai              → modelStatus()
 *   ../../lib/agent/taskState → listActive()
 *   ../../lib/supabase        → query()
 *   ../../lib/logger          → structured logger
 *   ../../../utils/constants  → TABLES, PROVIDER_STATUS
 *
 * @tables
 *   snippets → count for current session
 *   tasks    → active task count
 *
 * @dependency-level 4
 */

'use strict';

const { modelStatus }  = require('../../ai');
const taskState        = require('../../agent/taskState');
const { query }        = require('../../supabase');
const logger           = require('../../logger').child('dynamicContext');
const { TABLES, PROVIDER_STATUS } = require('../../../utils/constants');

/**
 * Format provider health into a compact readable line.
 *
 * @param {Object} statuses - from ai.modelStatus()
 * @returns {string}
 */
function formatModelHealth(statuses) {
  if (!statuses || typeof statuses !== 'object') return '';

  const lines = Object.entries(statuses).map(([provider, state]) => {
    const icon = state.available
      ? '✅'
      : state.status === PROVIDER_STATUS.RATE_LIMITED
        ? '⚠️ (rate limited)'
        : '❌ (down)';

    const until = state.downUntil
      ? ` — recovers ${state.downUntil}`
      : '';

    return `  ${provider}: ${icon}${until}`;
  });

  return lines.join('\n');
}

/**
 * Get current session snippet count.
 * Returns 0 on error — non-fatal.
 *
 * @param {string} userId
 * @param {string|null} sessionId
 * @returns {Promise<number>}
 */
async function getSnippetCount(userId, sessionId) {
  if (!userId || !sessionId) return 0;
  try {
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId, session_id: sessionId },
      count:   'exact',  // BUG5 FIX: now actually handled by supabase.js
    });
    // supabase returns count in header, rows._count when count option used
    return rows?._count ?? rows?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get active task count for user.
 * Returns 0 on error — non-fatal.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getActiveTaskCount(userId) {
  if (!userId) return 0;
  try {
    const active = await taskState.listActive(userId);
    return Array.isArray(active) ? active.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Assemble the live dynamic context block.
 *
 * @param {string} userId
 * @param {Object} agentContext
 * @param {string} [agentContext.intent]
 * @param {string} [agentContext.repo]
 * @param {string} [agentContext.branch]
 * @param {string} [agentContext.sessionId]
 * @param {boolean} [agentContext.readOnly]
 * @returns {Promise<string>}
 */
async function getDynamicContextBlock(userId, agentContext = {}) {
  const {
    intent    = 'chat',
    repo      = null,
    branch    = 'main',
    sessionId = null,
    readOnly  = false,
  } = agentContext;

  const parts = [];

  // ── Model health ──────────────────────────────────────────────────────────
  try {
    const statuses    = modelStatus();
    const healthBlock = formatModelHealth(statuses);

    // Only surface health if something is degraded
    const hasIssue = Object.values(statuses).some((s) => !s.available);

    if (hasIssue) {
      parts.push(`[CURRENT MODEL HEALTH — DEGRADED]\n${healthBlock}`);
    } else {
      parts.push(`[CURRENT MODEL HEALTH — ALL OK]\n${healthBlock}`);
    }
  } catch (err) {
    logger.warn('getDynamicContextBlock', 'Failed to get model status', { error: err.message });
  }

  // ── Active repo/branch context ────────────────────────────────────────────
  if (repo) {
    parts.push(`[ACTIVE CONTEXT]\nRepo: ${repo} | Branch: ${branch} | Intent: ${intent}`);
  } else {
    parts.push(`[ACTIVE CONTEXT]\nIntent: ${intent} | No specific repo targeted`);
  }

  // ── Session snippet count ─────────────────────────────────────────────────
  if (sessionId) {
    const snippetCount = await getSnippetCount(userId, sessionId);
    if (snippetCount > 0) {
      parts.push(`Session snippets staged: ${snippetCount}`);
    }
  }

  // ── Active tasks ──────────────────────────────────────────────────────────
  const activeTaskCount = await getActiveTaskCount(userId);
  if (activeTaskCount > 0) {
    parts.push(`Active tasks running: ${activeTaskCount}`);
  }

  // ── Execution context ─────────────────────────────────────────────────────
  if (readOnly) {
    parts.push(`Execution context: bookmarklet (read-only tools — no write_file, delete_file, run_command)`);
  } else {
    parts.push(`Execution context: dashboard (full tool access)`);
  }

  if (parts.length === 0) return '';

  return `[RUNTIME STATE]\n${parts.join('\n')}`.trim();
}

module.exports = { getDynamicContextBlock };
