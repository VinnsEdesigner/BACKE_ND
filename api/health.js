'use strict';

const { getClient } = require('../lib/supabase');
const logger = require('../lib/logger');
const { HTTP } = require('../utils/constants');

// Check if env var exists (never expose value)
function keyStatus(envVar) {
  return process.env[envVar] ? 'ok' : 'missing';
}

async function checkSupabase() {
  try {
    const client = getClient();
    // Lightweight ping — select nothing, just checks connection
    const { error } = await client.from('users').select('count').limit(1);
    if (error) throw error;
    return 'ok';
  } catch (err) {
    logger.warn('health', 'Supabase check failed', { error: err.message });
    return 'error';
  }
}

async function health(req, res) {
  const [supabaseStatus] = await Promise.all([checkSupabase()]);

  const payload = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      supabase: supabaseStatus,
    },
    // Read-only key presence — never expose actual values
    api_keys: {
      groq:       keyStatus('GROQ_API_KEY'),
      mistral:    keyStatus('MISTRAL_API_KEY'),
      codestral:  keyStatus('CODESTRAL_API_KEY'),
      gemini:     keyStatus('GEMINI_API_KEY'),
      tavily:     keyStatus('TAVILY_API_KEY'),
      serper:     keyStatus('SERPER_API_KEY'),
      firecrawl:  keyStatus('FIRECRAWL_API_KEY'),
      github_pat: keyStatus('GITHUB_PAT'),
      upstash:    keyStatus('UPSTASH_REDIS_URL'),
    },
  };

  // Overall status degrades if any service is down
  if (supabaseStatus !== 'ok') {
    payload.status = 'degraded';
  }

  const statusCode = payload.status === 'ok' ? HTTP.OK : HTTP.SERVICE_UNAVAILABLE;
  logger.info('health', `Health check → ${payload.status}`);

  return res.status(statusCode).json(payload);
}

module.exports = health;
