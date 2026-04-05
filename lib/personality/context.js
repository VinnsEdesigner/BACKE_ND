'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES, GITHUB } = require('../../utils/constants');

// ── CONTEXT ───────────────────────────────────────────────────────────────────
// Assembles the "current context" block injected into each prompt.
// Pulls: active repo, recent snippets, open task state.

/**
 * Build current context block string for a user.
 *
 * requestMeta: {
 *   repo?:   string,   // active repo
 *   branch?: string,   // active branch
 *   taskId?: string,   // if resuming a task
 * }
 */
async function build(userId, requestMeta = {}) {
  const lines = ['[CURRENT CONTEXT]'];

  // Active repo
  const repo   = requestMeta.repo   || GITHUB.REPOS.BACKEND;
  const branch = requestMeta.branch || GITHUB.DEFAULT_BRANCH;
  lines.push(`Repo: ${GITHUB.OWNER}/${repo} (${branch})`);

  // Recent snippets count
  try {
    const snippets = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId },
      columns: 'id, number, type',
      order:   { column: 'created_at', ascending: false },
      limit:   5,
    });
    if (snippets && snippets.length > 0) {
      lines.push(`Recent snippets: ${snippets.map((s) => `#${s.number}[${s.type}]`).join(', ')}`);
    }
  } catch (err) {
    logger.warn('context:build', 'Failed to fetch snippets', err);
  }

  // Active task if provided
  if (requestMeta.taskId) {
    lines.push(`Active task: ${requestMeta.taskId}`);
  }

  return lines.join('\n');
}

module.exports = { build };
