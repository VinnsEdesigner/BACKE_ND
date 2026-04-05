'use strict';

const { query }  = require('../lib/supabase');
const logger     = require('../lib/logger');
const { HTTP, TABLES } = require('../utils/constants');

// ── LIST SESSIONS — GET /api/session ─────────────────────────────────────────

async function listSessions(req, res) {
  const { userId } = req.user;
  const limit      = Math.min(parseInt(req.query.limit || '20', 10), 50);

  try {
    const rows = await query(TABLES.SESSIONS, 'select', {
      filters: { user_id: userId },
      order:   { column: 'created_at', ascending: false },
      limit,
    });

    return res.status(HTTP.OK).json({
      ok:       true,
      sessions: rows || [],
      count:    (rows || []).length,
    });
  } catch (err) {
    logger.error('session:list', 'Failed to list sessions', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'session_list_failed',
      message: 'Could not fetch sessions',
    });
  }
}

// ── GET SESSION — GET /api/session/:id ────────────────────────────────────────

async function getSession(req, res) {
  const { userId }    = req.user;
  const { id: sessionId } = req.params;

  if (!sessionId) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'Session ID required',
    });
  }

  try {
    const client = require('../lib/supabase').getClient();

    const { data: session, error: sessionErr } = await client
      .from(TABLES.SESSIONS)
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single();

    if (sessionErr || !session) {
      return res.status(HTTP.NOT_FOUND).json({
        error:   'not_found',
        message: 'Session not found',
      });
    }

    // Fetch snippets for this session
    const snippets = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId, session_id: sessionId },
      order:   { column: 'number', ascending: true },
    });

    return res.status(HTTP.OK).json({
      ok:       true,
      session,
      snippets: snippets || [],
    });
  } catch (err) {
    logger.error('session:get', `Failed to get session ${sessionId}`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'session_get_failed',
      message: 'Could not fetch session',
    });
  }
}

// ── CREATE SESSION — POST /api/session ───────────────────────────────────────

async function createSession(req, res) {
  const { userId }                       = req.user;
  const { id, page_url, page_title, name } = req.body;

  if (!id || typeof id !== 'string') {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'Session id is required',
    });
  }

  try {
    const rows = await query(TABLES.SESSIONS, 'upsert', {
      data: {
        id,
        user_id:    userId,
        page_url:   page_url   || null,
        page_title: page_title || null,
        name:       name       || null,
        created_at: new Date().toISOString(),
      },
      onConflict: 'id',
    });

    logger.info('session:create', `Session ${id} created/updated`, { userId });

    return res.status(HTTP.OK).json({
      ok:      true,
      session: rows?.[0] || { id },
    });
  } catch (err) {
    logger.error('session:create', `Failed to create session ${id}`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'session_create_failed',
      message: 'Could not create session',
    });
  }
}

// ── UPDATE SESSION NAME — PATCH /api/session/:id ──────────────────────────────

async function updateSession(req, res) {
  const { userId }    = req.user;
  const { id: sessionId } = req.params;
  const { name }      = req.body;

  if (!sessionId) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'Session ID required',
    });
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'name is required',
    });
  }

  try {
    const rows = await query(TABLES.SESSIONS, 'update', {
      data:    { name: name.trim(), updated_at: new Date().toISOString() },
      filters: { id: sessionId, user_id: userId },
    });

    if (!rows || rows.length === 0) {
      return res.status(HTTP.NOT_FOUND).json({
        error:   'not_found',
        message: 'Session not found',
      });
    }

    logger.info('session:update', `Session ${sessionId} renamed`, { userId, name });

    return res.status(HTTP.OK).json({
      ok:      true,
      session: rows[0],
    });
  } catch (err) {
    logger.error('session:update', `Failed to update session ${sessionId}`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'session_update_failed',
      message: 'Could not update session',
    });
  }
}

// ── DELETE SESSION — DELETE /api/session/:id ─────────────────────────────────

async function deleteSession(req, res) {
  const { userId }    = req.user;
  const { id: sessionId } = req.params;

  if (!sessionId) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'Session ID required',
    });
  }

  try {
    const sbClient = require('../lib/supabase').getClient();

    // Delete snippets first (FK safety)
    await sbClient
      .from(TABLES.SNIPPETS)
      .delete()
      .eq('session_id', sessionId)
      .eq('user_id', userId);

    // Delete session
    await sbClient
      .from(TABLES.SESSIONS)
      .delete()
      .eq('id', sessionId)
      .eq('user_id', userId);

    logger.info('session:delete', `Deleted session ${sessionId}`, { userId });

    return res.status(HTTP.OK).json({
      ok:        true,
      deleted:   sessionId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('session:delete', `Failed to delete session ${sessionId}`, err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'session_delete_failed',
      message: 'Could not delete session',
    });
  }
}

module.exports = {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
};
