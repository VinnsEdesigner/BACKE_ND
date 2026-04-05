'use strict';

const { Octokit } = require('octokit');
const { query }   = require('../supabase');
const logger      = require('../logger');
const { TABLES, GITHUB } = require('../../utils/constants');

// ── REPO MAP ──────────────────────────────────────────────────────────────────
// Maintains cached file trees for GitHub repos.
// Cache: Supabase repo_cache table, TTL 5 minutes.
// Avoids calling GitHub API on every agent step.

let _octokit = null;
function octokit() {
  if (!_octokit) _octokit = new Octokit({ auth: process.env.GITHUB_PAT });
  return _octokit;
}

const CACHE_TTL_MS = GITHUB.REPO_CACHE_TTL; // 5 min

/**
 * Get file tree for a repo. Returns cached version if fresh.
 */
async function get(userId, repo, branch = GITHUB.DEFAULT_BRANCH) {
  // Check cache
  try {
    const rows = await query(TABLES.REPO_CACHE, 'select', {
      filters: { user_id: userId, repo, branch },
      limit:   1,
    });

    const cached = rows?.[0];
    if (cached) {
      const age = Date.now() - new Date(cached.cached_at).getTime();
      if (age < CACHE_TTL_MS) {
        logger.debug('repoMap:get', `Cache hit for ${repo}@${branch}`, { age: `${Math.round(age/1000)}s` });
        return typeof cached.tree === 'string' ? JSON.parse(cached.tree) : cached.tree;
      }
    }
  } catch (err) {
    logger.warn('repoMap:get', 'Cache read failed — fetching fresh', err);
  }

  // Fetch fresh from GitHub
  return await fetchAndCache(userId, repo, branch);
}

/**
 * Invalidate cache for a repo (called after file write).
 */
async function invalidate(userId, repo) {
  try {
    const client = require('../supabase').getClient();
    await client
      .from(TABLES.REPO_CACHE)
      .delete()
      .eq('user_id', userId)
      .eq('repo', repo);
    logger.debug('repoMap:invalidate', `Cache cleared for ${repo}`, { userId });
  } catch (err) {
    logger.warn('repoMap:invalidate', 'Failed to invalidate cache', err);
  }
}

/**
 * Find a specific file path in the repo tree.
 * Returns full path or null.
 */
async function findFile(userId, repo, filename, branch = GITHUB.DEFAULT_BRANCH) {
  const tree = await get(userId, repo, branch);
  if (!tree || !Array.isArray(tree)) return null;

  const match = tree.find((f) =>
    f.path === filename ||
    f.path.endsWith(`/${filename}`) ||
    f.path.endsWith(`\\${filename}`)
  );

  return match?.path || null;
}

// ── INTERNALS ─────────────────────────────────────────────────────────────────

async function fetchAndCache(userId, repo, branch) {
  try {
    logger.debug('repoMap:fetch', `Fetching tree for ${repo}@${branch}`);

    const response = await octokit().rest.git.getTree({
      owner:     GITHUB.OWNER,
      repo,
      tree_sha:  branch,
      recursive: '1',
    });

    const tree = (response.data.tree || [])
      .filter((item) => item.type === 'blob')
      .map((item) => ({ path: item.path, sha: item.sha, size: item.size }));

    // Upsert cache
    await query(TABLES.REPO_CACHE, 'upsert', {
      data: {
        user_id:   userId,
        repo,
        branch,
        tree:      JSON.stringify(tree),
        cached_at: new Date().toISOString(),
      },
      onConflict: 'user_id,repo,branch',
    });

    logger.info('repoMap:fetch', `Cached ${tree.length} files for ${repo}@${branch}`);
    return tree;
  } catch (err) {
    logger.error('repoMap:fetch', `Failed to fetch tree for ${repo}@${branch}`, err);
    throw err;
  }
}

module.exports = { get, invalidate, findFile };
