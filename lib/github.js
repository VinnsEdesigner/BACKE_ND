'use strict';

const { Octokit } = require('octokit');
const logger      = require('./logger');
const { GITHUB }  = require('../utils/constants');

// ── CLIENT (lazy init) ────────────────────────────────────────────────────────

let _octokit = null;

function client() {
  if (_octokit) return _octokit;

  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT not set');

  _octokit = new Octokit({ auth: pat });
  logger.info('github', 'Octokit client initialised');
  return _octokit;
}

// ── READ FILE ─────────────────────────────────────────────────────────────────

/**
 * Read a file from a GitHub repo.
 * Returns { content (utf8 string), sha, path, size }
 */
async function readFile(repo, path, branch = GITHUB.DEFAULT_BRANCH) {
  try {
    const res = await client().rest.repos.getContent({
      owner: GITHUB.OWNER,
      repo,
      path,
      ref: branch,
    });

    const content = Buffer.from(res.data.content, 'base64').toString('utf8');

    logger.debug('github:readFile', `Read ${path}`, { repo, branch, size: res.data.size });

    return {
      content,
      sha:  res.data.sha,
      path: res.data.path,
      size: res.data.size,
    };
  } catch (err) {
    logger.error('github:readFile', `Failed to read ${path}`, err);
    throw err;
  }
}

// ── WRITE FILE ────────────────────────────────────────────────────────────────

/**
 * Create or update a file in a GitHub repo.
 * If file exists, SHA is fetched automatically.
 * Returns GitHub API response (includes commit.sha).
 */
async function writeFile(repo, path, content, message, branch = GITHUB.DEFAULT_BRANCH) {
  try {
    // Get existing SHA if file exists
    let sha;
    try {
      const existing = await client().rest.repos.getContent({
        owner: GITHUB.OWNER,
        repo,
        path,
        ref: branch,
      });
      sha = existing.data.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
      // File doesn't exist yet — no SHA needed
    }

    const encoded = Buffer.from(content, 'utf8').toString('base64');

    const res = await client().rest.repos.createOrUpdateFileContents({
      owner:   GITHUB.OWNER,
      repo,
      path,
      message,
      content: encoded,
      branch,
      ...(sha ? { sha } : {}),
    });

    logger.info('github:writeFile', `Wrote ${path}`, {
      repo,
      branch,
      sha: res.data.commit.sha,
    });

    return res.data;
  } catch (err) {
    logger.error('github:writeFile', `Failed to write ${path}`, err);
    throw err;
  }
}

// ── DELETE FILE ───────────────────────────────────────────────────────────────

/**
 * Delete a file from a GitHub repo.
 * Returns GitHub API response.
 */
async function deleteFile(repo, path, message, branch = GITHUB.DEFAULT_BRANCH) {
  try {
    // Must get SHA before deleting
    const existing = await client().rest.repos.getContent({
      owner: GITHUB.OWNER,
      repo,
      path,
      ref: branch,
    });

    const res = await client().rest.repos.deleteFile({
      owner:   GITHUB.OWNER,
      repo,
      path,
      message,
      sha:     existing.data.sha,
      branch,
    });

    logger.info('github:deleteFile', `Deleted ${path}`, { repo, branch });
    return res.data;
  } catch (err) {
    logger.error('github:deleteFile', `Failed to delete ${path}`, err);
    throw err;
  }
}

// ── LIST FILES ────────────────────────────────────────────────────────────────

/**
 * List files/dirs at a path in a GitHub repo.
 * Returns array of { name, path, type ('file'|'dir'), size, sha }
 */
async function listFiles(repo, path = '', branch = GITHUB.DEFAULT_BRANCH) {
  try {
    const res = await client().rest.repos.getContent({
      owner: GITHUB.OWNER,
      repo,
      path,
      ref: branch,
    });

    const items = Array.isArray(res.data) ? res.data : [res.data];

    logger.debug('github:listFiles', `Listed ${items.length} items at ${path || '/'}`, {
      repo,
      branch,
    });

    return items.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size || 0,
      sha:  item.sha,
    }));
  } catch (err) {
    logger.error('github:listFiles', `Failed to list ${path}`, err);
    throw err;
  }
}

// ── CREATE BRANCH ─────────────────────────────────────────────────────────────

/**
 * Create a new branch from a source branch.
 * Returns the created ref object.
 */
async function createBranch(repo, branchName, fromBranch = GITHUB.DEFAULT_BRANCH) {
  try {
    // Get SHA of source branch tip
    const sourceRef = await client().rest.git.getRef({
      owner: GITHUB.OWNER,
      repo,
      ref:   `heads/${fromBranch}`,
    });

    const res = await client().rest.git.createRef({
      owner: GITHUB.OWNER,
      repo,
      ref:   `refs/heads/${branchName}`,
      sha:   sourceRef.data.object.sha,
    });

    logger.info('github:createBranch', `Created branch ${branchName}`, {
      repo,
      from: fromBranch,
      sha:  res.data.object.sha,
    });

    return res.data;
  } catch (err) {
    logger.error('github:createBranch', `Failed to create branch ${branchName}`, err);
    throw err;
  }
}

// ── CREATE PR ─────────────────────────────────────────────────────────────────

/**
 * Open a pull request.
 * Returns PR object including number, html_url.
 */
async function createPR(repo, title, head, base = GITHUB.DEFAULT_BRANCH, body = '') {
  try {
    const res = await client().rest.pulls.create({
      owner: GITHUB.OWNER,
      repo,
      title,
      head,
      base,
      body,
    });

    logger.info('github:createPR', `Created PR #${res.data.number}`, {
      repo,
      title,
      head,
      base,
    });

    return res.data;
  } catch (err) {
    logger.error('github:createPR', `Failed to create PR`, err);
    throw err;
  }
}

// ── MERGE PR ──────────────────────────────────────────────────────────────────

/**
 * Merge a pull request.
 * Returns merge result { merged: true, sha, message }
 */
async function mergePR(repo, pullNumber, mergeMessage = '') {
  try {
    const res = await client().rest.pulls.merge({
      owner:        GITHUB.OWNER,
      repo,
      pull_number:  pullNumber,
      commit_title: mergeMessage || `Merge PR #${pullNumber}`,
    });

    logger.info('github:mergePR', `Merged PR #${pullNumber}`, {
      repo,
      sha: res.data.sha,
    });

    return res.data;
  } catch (err) {
    logger.error('github:mergePR', `Failed to merge PR #${pullNumber}`, err);
    throw err;
  }
}

// ── LIST PRs ──────────────────────────────────────────────────────────────────

/**
 * List open pull requests.
 * Returns array of PR objects.
 */
async function listPRs(repo, state = 'open') {
  try {
    const res = await client().rest.pulls.list({
      owner: GITHUB.OWNER,
      repo,
      state,
      per_page: 20,
    });

    logger.debug('github:listPRs', `Found ${res.data.length} PRs`, { repo, state });
    return res.data;
  } catch (err) {
    logger.error('github:listPRs', `Failed to list PRs`, err);
    throw err;
  }
}

// ── GET FULL TREE ─────────────────────────────────────────────────────────────

/**
 * Get full recursive file tree for a repo.
 * Used by repoMap.js for caching.
 * Returns array of { path, sha, size }
 */
async function getTree(repo, branch = GITHUB.DEFAULT_BRANCH) {
  try {
    const res = await client().rest.git.getTree({
      owner:    GITHUB.OWNER,
      repo,
      tree_sha: branch,
      recursive: '1',
    });

    const tree = (res.data.tree || [])
      .filter((item) => item.type === 'blob')
      .map((item) => ({
        path: item.path,
        sha:  item.sha,
        size: item.size || 0,
      }));

    logger.debug('github:getTree', `Got ${tree.length} files`, { repo, branch });
    return tree;
  } catch (err) {
    logger.error('github:getTree', `Failed to get tree`, err);
    throw err;
  }
}

// ── ROLLBACK FILE ─────────────────────────────────────────────────────────────

/**
 * Restore a file from ai-sandbox branch to target branch.
 * Used by api/github.js rollback endpoint.
 * Returns write result.
 */
async function rollbackFile(repo, path, targetBranch = GITHUB.DEFAULT_BRANCH) {
  try {
    // Read from ai-sandbox
    const sandbox = await readFile(repo, path, GITHUB.SANDBOX_BRANCH);

    // Write back to target branch
    const result = await writeFile(
      repo,
      path,
      sandbox.content,
      `rollback: restored ${path} from ${GITHUB.SANDBOX_BRANCH}`,
      targetBranch,
    );

    logger.info('github:rollbackFile', `Rolled back ${path}`, {
      repo,
      from: GITHUB.SANDBOX_BRANCH,
      to:   targetBranch,
    });

    return result;
  } catch (err) {
    logger.error('github:rollbackFile', `Failed to rollback ${path}`, err);
    throw err;
  }
}

// ── BRANCH EXISTS ─────────────────────────────────────────────────────────────

/**
 * Check if a branch exists.
 * Returns boolean.
 */
async function branchExists(repo, branch) {
  try {
    await client().rest.repos.getBranch({
      owner: GITHUB.OWNER,
      repo,
      branch,
    });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  readFile,
  writeFile,
  deleteFile,
  listFiles,
  createBranch,
  createPR,
  mergePR,
  listPRs,
  getTree,
  rollbackFile,
  branchExists,
};
