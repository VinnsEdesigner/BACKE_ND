'use strict';

const logger = require('../logger');

// ── VALIDATOR ─────────────────────────────────────────────────────────────────
// Validates tool outputs before proceeding to next step.
// Prevents cascading failures from bad tool results.

/**
 * Validate a tool result.
 *
 * @param {string} toolName - name of the tool that ran
 * @param {*}      result   - tool return value
 * @returns {{ valid: boolean, reason: string }}
 */
function check(toolName, result) {
  if (result === null || result === undefined) {
    return { valid: false, reason: `${toolName} returned null/undefined` };
  }

  switch (toolName) {

    case 'write_file':
    case 'delete_file': {
      // GitHub API returns commit SHA on success
      const hasSha = result?.sha || result?.commit?.sha || result?.content?.sha;
      if (!hasSha) {
        return { valid: false, reason: `${toolName} did not return a commit SHA` };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'read_file': {
      const hasContent = typeof result?.content === 'string' && result.content.length > 0;
      if (!hasContent) {
        return { valid: false, reason: 'read_file returned empty content' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'list_files': {
      if (!Array.isArray(result)) {
        return { valid: false, reason: 'list_files did not return an array' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'create_branch': {
      const hasRef = result?.ref || result?.object?.sha;
      if (!hasRef) {
        return { valid: false, reason: 'create_branch did not return a ref' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'create_pr': {
      const hasPrNumber = typeof result?.number === 'number';
      if (!hasPrNumber) {
        return { valid: false, reason: 'create_pr did not return a PR number' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'merge_pr': {
      const merged = result?.merged === true;
      if (!merged) {
        return { valid: false, reason: `merge_pr failed: ${result?.message || 'unknown reason'}` };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'web_search': {
      if (!Array.isArray(result) || result.length === 0) {
        return { valid: false, reason: 'web_search returned no results' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'read_url': {
      if (typeof result !== 'string' || result.trim().length === 0) {
        return { valid: false, reason: 'read_url returned empty content' };
      }
      return { valid: true, reason: 'ok' };
    }

    case 'remember': {
      // Remember always succeeds unless it throws
      return { valid: true, reason: 'ok' };
    }

    default: {
      // Unknown tool — pass through
      logger.warn('validator:check', `No validation rule for tool: ${toolName}`);
      return { valid: true, reason: 'no_rule' };
    }
  }
}

module.exports = { check };
