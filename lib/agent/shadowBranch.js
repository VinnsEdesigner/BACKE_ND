'use strict';

const { query }   = require('../supabase');
const logger      = require('../logger');
const { TABLES, GITHUB } = require('../../utils/constants');
// BUG12 FIX: import broadcastEmitter to warn user when shadow fails
const broadcastEmitter = require('./broadcastEmitter');

// ── SHADOW BRANCH ─────────────────────────────────────────────────────────────
// Auto-backup before any destructive GitHub operation.
// Only fires for: write_file, delete_file, replace_file.
// NOT for: read_file, web_search, list_files.
// ai-sandbox branch kept 48hrs then auto-deleted.

const SANDBOX_BRANCH = GITHUB.SANDBOX_BRANCH; // 'ai-sandbox'

let _octokit = null;
function octokit() {
  if (!_octokit) _octokit = new Octokit({ auth: process.env.GITHUB_PAT });
  return _octokit;
}

/**
 * Create a shadow backup of a file before destructive operation.
 * Ensures ai-sandbox branch exists, commits current file state to it.
 *
 * @param {string} userId
 * @param {string} repo
 * @param {string} filePath
 * @param {string} operation  - 'write' | 'delete' | 'replace'
 * @returns {{ branchName: string, sha: string }} shadow branch info
 */
async function create(userId, repo, filePath, operation) {
  const branchName = SANDBOX_BRANCH;

  try {
    // 1. Ensure ai-sandbox branch exists
    await ensureSandboxBranch(repo);

    // 2. Read current file content from main
    let currentContent = null;
    let currentSha     = null;

    try {
      const fileRes = await octokit().rest.repos.getContent({
        owner: GITHUB.OWNER,
        repo,
        path:  filePath,
        ref:   GITHUB.DEFAULT_BRANCH,
      });
      currentContent = fileRes.data.content; // base64
      currentSha     = fileRes.data.sha;
    } catch (err) {
      if (err.status === 404) {
        // File doesn't exist yet — nothing to back up
        logger.debug('shadowBranch:create', `File ${filePath} doesn't exist yet — no backup needed`);
      } else {
        throw err;
      }
    }

    // 3. If file exists, commit current state to ai-sandbox
    if (currentContent && currentSha) {
      // Check if file exists in sandbox already
      let existingSha = null;
      try {
        const existing = await octokit().rest.repos.getContent({
          owner: GITHUB.OWNER,
          repo,
          path:  filePath,
          ref:   branchName,
        });
        existingSha = existing.data.sha;
      } catch {
        // File doesn't exist in sandbox yet — ok
      }

      await octokit().rest.repos.createOrUpdateFileContents({
        owner:   GITHUB.OWNER,
        repo,
        path:    filePath,
        message: `shadow backup: ${filePath} before ${operation}`,
        content: currentContent,
        branch:  branchName,
        ...(existingSha ? { sha: existingSha } : {}),
      });

      logger.info('shadowBranch:create', `Backed up ${filePath} to ${branchName}`, { repo, operation });
    }

    // 4. Register in Supabase shadow_branches table
    await query(TABLES.SHADOW_BRANCHES, 'insert', {
      data: {
        user_id:     userId,
        repo,
        branch_name: branchName,
        file_path:   filePath,
        operation,
        created_at:  new Date().toISOString(),
      },
    });

    return { branchName, sha: currentSha };
    } catch (err) {
    logger.error('shadowBranch:create', `Failed to create shadow backup for ${filePath}`, err);
    // BUG12 FIX: emit SSE warning so user knows backup failed before destructive op
    broadcastEmitter.warning(userId, {
      event:   'shadow_backup_failed',
      repo,
      path:    filePath,
      message: `Shadow backup failed: ${err.message}. Write will proceed without backup.`,
    }).catch(() => {});
    return { branchName, sha: null };
  }

/**
 * Rollback a file from ai-sandbox to main branch.
 *
 * @param {string} repo
 * @param {string} filePath
 * @returns {boolean} success
 */
async function rollback(repo, filePath) {
  try {
    // Get file content from sandbox
    const sandboxFile = await octokit().rest.repos.getContent({
      owner: GITHUB.OWNER,
      repo,
      path:  filePath,
      ref:   SANDBOX_BRANCH,
    });

    // Get current file SHA on main (needed for update)
    let mainSha = null;
    try {
      const mainFile = await octokit().rest.repos.getContent({
        owner: GITHUB.OWNER,
        repo,
        path:  filePath,
        ref:   GITHUB.DEFAULT_BRANCH,
      });
      mainSha = mainFile.data.sha;
    } catch {
      // File might not exist on main anymore — ok
    }

    // Restore to main
    await octokit().rest.repos.createOrUpdateFileContents({
      owner:   GITHUB.OWNER,
      repo,
      path:    filePath,
      message: `rollback: restored ${filePath} from ai-sandbox`,
      content: sandboxFile.data.content,
      branch:  GITHUB.DEFAULT_BRANCH,
      ...(mainSha ? { sha: mainSha } : {}),
    });

    logger.info('shadowBranch:rollback', `Rolled back ${filePath} from ${SANDBOX_BRANCH}`, { repo });
    return true;
  } catch (err) {
    logger.error('shadowBranch:rollback', `Failed to rollback ${filePath}`, err);
    throw err;
  }
}

// ── INTERNALS ─────────────────────────────────────────────────────────────────

async function ensureSandboxBranch(repo) {
  try {
    await octokit().rest.repos.getBranch({
      owner: GITHUB.OWNER,
      repo,
      branch: SANDBOX_BRANCH,
    });
    // Branch exists
  } catch (err) {
    if (err.status === 404) {
      // Create ai-sandbox from main
      const mainRef = await octokit().rest.git.getRef({
        owner: GITHUB.OWNER,
        repo,
        ref:   `heads/${GITHUB.DEFAULT_BRANCH}`,
      });

      await octokit().rest.git.createRef({
        owner: GITHUB.OWNER,
        repo,
        ref:   `refs/heads/${SANDBOX_BRANCH}`,
        sha:   mainRef.data.object.sha,
      });

      logger.info('shadowBranch:ensureSandbox', `Created ${SANDBOX_BRANCH} branch in ${repo}`);
    } else {
      throw err;
    }
  }
}

module.exports = { create, rollback };
