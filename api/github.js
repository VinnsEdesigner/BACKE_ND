'use strict';

const gh             = require('../lib/github');
const shadowBranch   = require('../lib/agent/shadowBranch');
const repoMap        = require('../lib/agent/repoMap');
const { emit }       = require('./broadcast');
const { query }      = require('../lib/supabase');
const logger         = require('../lib/logger');
const { HTTP, TABLES, SSE, GITHUB } = require('../utils/constants');

// ── DESTRUCTIVE OPS — require shadow backup first ─────────────────────────────

const DESTRUCTIVE = new Set(['write_file', 'delete_file']);

// ── MAIN HANDLER — POST /api/github ──────────────────────────────────────────
// Single endpoint, action-based routing.
// Body: { action, repo, ...actionArgs }

async function githubHandler(req, res) {
  const { userId }         = req.user;
  const { action, ...args } = req.body;

  if (!action || typeof action !== 'string') {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'action is required',
    });
  }

  const repo = args.repo;
  if (!repo || typeof repo !== 'string') {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'repo is required',
    });
  }

  logger.info('github:handler', `Action: ${action}`, { userId, repo });

  try {
    const result = await dispatch(action, args, userId);

    // Invalidate repo cache after writes
    if (DESTRUCTIVE.has(action)) {
      await repoMap.invalidate(userId, repo).catch((err) => {
        logger.warn('github:handler', 'Cache invalidation failed', err);
      });

      // SSE — push file tree update notification
      await emit(userId, {
        type:    SSE.EVENT_TYPES.PULSE,
        content: {
          event:  'repo_changed',
          action,
          repo,
          path:   args.path || null,
        },
      }).catch(() => {});
    }

    return res.status(HTTP.OK).json({
      ok:        true,
      action,
      repo,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const status = err.status || err.statusCode;

    if (status === 404) {
      return res.status(HTTP.NOT_FOUND).json({
        error:   'not_found',
        message: err.message || 'Resource not found',
      });
    }

    if (status === 403 || status === 401) {
      return res.status(HTTP.FORBIDDEN).json({
        error:   'forbidden',
        message: 'GitHub PAT lacks required permissions',
      });
    }

    logger.error('github:handler', `Action ${action} failed`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'github_action_failed',
      message: err.message || 'GitHub operation failed',
    });
  }
}

// ── ROLLBACK — POST /api/github/rollback ──────────────────────────────────────

async function rollbackHandler(req, res) {
  const { userId }          = req.user;
  const { repo, path, branch } = req.body;

  if (!repo || !path) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'repo and path are required',
    });
  }

  try {
    logger.info('github:rollback', `Rolling back ${path}`, { userId, repo });

    const result = await gh.rollbackFile(repo, path, branch || GITHUB.DEFAULT_BRANCH);

    // Invalidate cache
      // BUG16 FIX: pass branch so we only clear the affected branch cache
    await repoMap.invalidate(userId, repo, args.branch || GITHUB.DEFAULT_BRANCH).catch((err) => {
      logger.warn('github:handler', 'Cache invalidation failed', err);
    });

    // Log rollback in shadow_branches
    await query(TABLES.SHADOW_BRANCHES, 'insert', {
      data: {
        user_id:     userId,
        repo,
        branch_name: GITHUB.SANDBOX_BRANCH,
        file_path:   path,
        operation:   'rollback',
        created_at:  new Date().toISOString(),
      },
    }).catch((err) => {
      logger.warn('github:rollback', 'Failed to log rollback', err);
    });

    // SSE push
    await emit(userId, {
      type:    SSE.EVENT_TYPES.COMPLETE,
      content: {
        event:  'rollback_complete',
        repo,
        path,
        branch: branch || GITHUB.DEFAULT_BRANCH,
      },
    }).catch(() => {});

    logger.info('github:rollback', `Rollback complete: ${path}`, { userId, repo });

    return res.status(HTTP.OK).json({
      ok:        true,
      rolled_back: path,
      repo,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('github:rollback', `Rollback failed: ${path}`, err);

    // SSE — push failure
    await emit(userId, {
      type:    SSE.EVENT_TYPES.WARNING,
      content: {
        event:   'rollback_failed',
        repo,
        path,
        message: err.message,
      },
    }).catch(() => {});

    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'rollback_failed',
      message: err.message || 'Rollback failed',
    });
  }
}

// ── REPO TREE — GET /api/github/tree ─────────────────────────────────────────

async function treeHandler(req, res) {
  const { userId }           = req.user;
  const { repo, branch }     = req.query;

  if (!repo) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'repo is required',
    });
  }

  try {
    const tree = await repoMap.get(userId, repo, branch || GITHUB.DEFAULT_BRANCH);

    return res.status(HTTP.OK).json({
      ok:     true,
      repo,
      branch: branch || GITHUB.DEFAULT_BRANCH,
      tree,
      count:  tree.length,
    });
  } catch (err) {
    logger.error('github:tree', `Failed to get tree for ${repo}`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'tree_failed',
      message: err.message || 'Could not fetch file tree',
    });
  }
}

// ── ACTION DISPATCHER ─────────────────────────────────────────────────────────

async function dispatch(action, args, userId) {
  const { repo, branch } = args;

  switch (action) {

    case 'read_file': {
      if (!args.path) throw Object.assign(new Error('path required'), { status: 400 });
      return gh.readFile(repo, args.path, branch);
    }

    case 'write_file': {
      if (!args.path || !args.content || !args.message) {
        throw Object.assign(new Error('path, content, message required'), { status: 400 });
      }
      // Shadow backup first (LAW — destructive op)
      await shadowBranch.create(userId, repo, args.path, 'write');
      return gh.writeFile(repo, args.path, args.content, args.message, branch);
    }

    case 'delete_file': {
      if (!args.path || !args.message) {
        throw Object.assign(new Error('path, message required'), { status: 400 });
      }
      await shadowBranch.create(userId, repo, args.path, 'delete');
      return gh.deleteFile(repo, args.path, args.message, branch);
    }

    case 'list_files': {
      return gh.listFiles(repo, args.path || '', branch);
    }

    case 'create_branch': {
      if (!args.branch_name) throw Object.assign(new Error('branch_name required'), { status: 400 });
      return gh.createBranch(repo, args.branch_name, branch);
    }

    case 'create_pr': {
      if (!args.title || !args.head) {
        throw Object.assign(new Error('title, head required'), { status: 400 });
      }
      return gh.createPR(repo, args.title, args.head, branch, args.body || '');
    }

    case 'merge_pr': {
      if (!args.pull_number) throw Object.assign(new Error('pull_number required'), { status: 400 });
      return gh.mergePR(repo, args.pull_number, args.merge_message || '');
    }

    case 'list_prs': {
      return gh.listPRs(repo, args.state || 'open');
    }

    default:
      throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
  }
}

module.exports = { githubHandler, rollbackHandler, treeHandler };
