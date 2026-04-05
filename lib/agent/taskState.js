'use strict';

const { Redis }  = require('@upstash/redis');
const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES, AGENT } = require('../../utils/constants');

// ── TASK STATE ────────────────────────────────────────────────────────────────
// Manages lifecycle of multi-step tasks.
// Supabase = persistent storage (survives server restart)
// Upstash Redis = fast TTL cache (1hr) for active tasks
// On HF Space restart: resumes from Redis, falls back to Supabase

let _redis = null;
function redis() {
  if (!_redis) _redis = new Redis({
    url:   process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });
  return _redis;
}

const REDIS_PREFIX = 'task:';

// ── HELPERS ───────────────────────────────────────────────────────────────────

function redisKey(taskId) {
  return `${REDIS_PREFIX}${taskId}`;
}

async function cacheTask(task) {
  try {
    await redis().set(redisKey(task.id), JSON.stringify(task), {
      ex: AGENT.TASK_TTL_SECONDS,
    });
  } catch (err) {
    logger.warn('taskState:cache', 'Redis cache write failed', err);
  }
}

async function getCached(taskId) {
  try {
    const raw = await redis().get(redisKey(taskId));
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) {
    logger.warn('taskState:getCached', 'Redis cache read failed', err);
    return null;
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────

/**
 * Create a new task.
 */
async function create(userId, intent, steps = []) {
  try {
    const rows = await query(TABLES.TASKS, 'insert', {
      data: {
        user_id:      userId,
        intent,
        steps:        JSON.stringify(steps),
        current_step: 0,
        status:       'pending',
        created_at:   new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      },
    });

    const task = rows?.[0];
    if (!task) throw new Error('Task insert returned no rows');

    await cacheTask(task);
    // task_checkpoints table available for future checkpoint saves (TABLES.TASK_CHECKPOINTS)
  logger.info('taskState:create', `Created task ${task.id}`, { userId, intent });
    return task;
  } catch (err) {
    logger.error('taskState:create', 'Failed to create task', err);
    throw err;
  }
}

/**
 * Advance task to next step.
 */
async function advance(taskId) {
  try {
    const task = await get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const steps       = Array.isArray(task.steps) ? task.steps : JSON.parse(task.steps || '[]');
    const nextStep    = (task.current_step || 0) + 1;
    const isDone      = nextStep >= steps.length;
    const newStatus   = isDone ? 'done' : 'running';

    const rows = await query(TABLES.TASKS, 'update', {
      data:    { current_step: nextStep, status: newStatus, updated_at: new Date().toISOString() },
      filters: { id: taskId },
    });

    const updated = rows?.[0];
    if (updated) await cacheTask(updated);
    logger.debug('taskState:advance', `Task ${taskId} → step ${nextStep}`, { isDone });
    return updated;
  } catch (err) {
    logger.error('taskState:advance', `Failed to advance task ${taskId}`, err);
    throw err;
  }
}

/**
 * Pause a task (awaiting user input).
 */
async function pause(taskId, reason = '') {
  try {
    const rows = await query(TABLES.TASKS, 'update', {
      data:    { status: 'paused', result_summary: reason, updated_at: new Date().toISOString() },
      filters: { id: taskId },
    });
    const updated = rows?.[0];
    if (updated) await cacheTask(updated);
    logger.debug('taskState:pause', `Task ${taskId} paused: ${reason}`);
    return updated;
  } catch (err) {
    logger.error('taskState:pause', `Failed to pause task ${taskId}`, err);
    throw err;
  }
}

/**
 * Mark task as complete.
 */
async function complete(taskId, result = '') {
  try {
    const rows = await query(TABLES.TASKS, 'update', {
      data:    { status: 'done', result_summary: result, updated_at: new Date().toISOString() },
      filters: { id: taskId },
    });
    const updated = rows?.[0];
    if (updated) await cacheTask(updated);
    logger.info('taskState:complete', `Task ${taskId} completed`);
    return updated;
  } catch (err) {
    logger.error('taskState:complete', `Failed to complete task ${taskId}`, err);
    throw err;
  }
}

/**
 * Mark task as failed.
 */
async function fail(taskId, error = '') {
  try {
    const rows = await query(TABLES.TASKS, 'update', {
      data:    { status: 'failed', result_summary: error, updated_at: new Date().toISOString() },
      filters: { id: taskId },
    });
    const updated = rows?.[0];
    if (updated) await cacheTask(updated);
    logger.warn('taskState:fail', `Task ${taskId} failed: ${error}`);
    return updated;
  } catch (err) {
    logger.error('taskState:fail', `Failed to mark task ${taskId} as failed`, err);
    throw err;
  }
}

/**
 * Get a task by ID. Checks Redis first, falls back to Supabase.
 */
async function get(taskId) {
  // Try Redis cache first
  const cached = await getCached(taskId);
  if (cached) return cached;

  // Fall back to Supabase
  try {
    const rows = await query(TABLES.TASKS, 'select', {
      filters: { id: taskId },
      limit:   1,
    });
    const task = rows?.[0] || null;
    if (task) await cacheTask(task);
    return task;
  } catch (err) {
    logger.error('taskState:get', `Failed to get task ${taskId}`, err);
    throw err;
  }
}

/**
 * List active tasks for a user.
 */
async function listActive(userId) {
  try {
    const rows = await query(TABLES.TASKS, 'select', {
      filters: { user_id: userId, status: 'running' },
      order:   { column: 'created_at', ascending: false },
      limit:   10,
    });
    return rows || [];
  } catch (err) {
    logger.error('taskState:listActive', 'Failed to list active tasks', err);
    return [];
  }
}

module.exports = { create, advance, pause, complete, fail, get, listActive };
