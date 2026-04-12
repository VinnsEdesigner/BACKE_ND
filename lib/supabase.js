'use strict';

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

let _client = null;

function getClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    logger.error('supabase', 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    throw new Error('Supabase env vars not set');
  }

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  logger.info('supabase', 'Client initialised', { url });
  return _client;
}

// Convenience wrapper — always use this, never raw client
async function query(table, operation, options = {}) {
  const client = getClient();
  try {
    let q = client.from(table);

if (operation === 'select') {
      const { columns = '*', filters = {}, order = null, limit = null, count = null } = options;
      // BUG5 FIX: pass count option to supabase select
      q = count ? q.select(columns, { count }) : q.select(columns);
      for (const [col, val] of Object.entries(filters)) {
        q = q.eq(col, val);
      }
      if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
      if (limit) q = q.limit(limit);
    }

    if (operation === 'insert') {
      q = q.insert(options.data).select();
    }

    if (operation === 'update') {
      q = q.update(options.data);
      for (const [col, val] of Object.entries(options.filters || {})) {
        q = q.eq(col, val);
      }
      q = q.select();
    }

    if (operation === 'upsert') {
      q = q.upsert(options.data, { onConflict: options.onConflict }).select();
    }

    if (operation === 'delete') {
      q = q.delete();
      for (const [col, val] of Object.entries(options.filters || {})) {
        q = q.eq(col, val);
      }
    }

    const { data, count: rowCount, error } = await q;

    if (error) {
      logger.error('supabase', `${operation} failed on ${table}`, error);
      throw error;
    }

    // BUG5 FIX: attach count to result array when requested
    if (rowCount !== null && rowCount !== undefined && Array.isArray(data)) {
      data._count = rowCount;
    }
  return data;

    return data;
  } catch (err) {
    logger.error('supabase', `query error on ${table}`, err);
    throw err;
  }
}

module.exports = { getClient, query };
