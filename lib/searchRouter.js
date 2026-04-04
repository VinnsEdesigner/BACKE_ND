'use strict';

const logger = require('./logger');
const { ENDPOINTS, RATE_LIMITS } = require('../utils/constants');

// ── PROVIDER STATE ────────────────────────────────────────────────────────────
// Simple in-memory cooldown tracking (resets on server restart — acceptable)

const providerState = {
  tavily: { downUntil: 0 },
  serper: { downUntil: 0 },
};

function isAvailable(provider) {
  return Date.now() > providerState[provider].downUntil;
}

function markDown(provider, ms = 60_000) {
  providerState[provider].downUntil = Date.now() + ms;
  logger.warn('searchRouter', `${provider} marked down for ${ms / 1000}s`);
}

// ── TAVILY ────────────────────────────────────────────────────────────────────

async function searchTavily(query, maxResults = 5) {
  const res = await fetch(ENDPOINTS.TAVILY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily ${res.status}: ${err}`);
  }

  const data = await res.json();

  // Normalise to common shape
  return (data.results || []).map((r) => ({
    title:   r.title   || '',
    url:     r.url     || '',
    snippet: r.content || '',
    source:  'tavily',
  }));
}

// ── SERPER ────────────────────────────────────────────────────────────────────

async function searchSerper(query, maxResults = 5) {
  const res = await fetch(ENDPOINTS.SERPER, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Serper ${res.status}: ${err}`);
  }

  const data = await res.json();

  // Normalise to common shape
  return (data.organic || []).slice(0, maxResults).map((r) => ({
    title:   r.title   || '',
    url:     r.link    || '',
    snippet: r.snippet || '',
    source:  'serper',
  }));
}

// ── JINA READER (no-key fallback) ─────────────────────────────────────────────

async function fetchJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jina ${res.status}`);
  const data = await res.json();
  return data.data?.content || '';
}

// ── MAIN ROUTER ───────────────────────────────────────────────────────────────

/**
 * search(query, options)
 *
 * options:
 *   maxResults {number}  — default 5
 *   fetchContent {boolean} — fetch full page via Jina for top result (default false)
 *
 * Returns: { results: Array<{title, url, snippet, source}>, provider: string }
 * Throws only if ALL providers fail.
 */
async function search(query, options = {}) {
  const { maxResults = 5, fetchContent = false } = options;

  let results = null;
  let usedProvider = null;

  // 1. Try Tavily first
  if (isAvailable('tavily')) {
    try {
      logger.debug('searchRouter', 'Trying Tavily', { query });
      results = await searchTavily(query, maxResults);
      usedProvider = 'tavily';
      logger.info('searchRouter', `Tavily returned ${results.length} results`);
    } catch (err) {
      logger.warn('searchRouter', 'Tavily failed', { error: err.message });
      if (err.message.includes('429') || err.message.includes('402')) {
        markDown('tavily', 60_000);
      } else {
        markDown('tavily', 30_000);
      }
    }
  } else {
    logger.debug('searchRouter', 'Tavily skipped (cooling down)');
  }

  // 2. Fallback to Serper
  if (!results && isAvailable('serper')) {
    try {
      logger.debug('searchRouter', 'Trying Serper', { query });
      results = await searchSerper(query, maxResults);
      usedProvider = 'serper';
      logger.info('searchRouter', `Serper returned ${results.length} results`);
    } catch (err) {
      logger.warn('searchRouter', 'Serper failed', { error: err.message });
      if (err.message.includes('429')) {
        markDown('serper', 60_000);
      } else {
        markDown('serper', 30_000);
      }
    }
  } else if (!results) {
    logger.debug('searchRouter', 'Serper skipped (cooling down)');
  }

  // 3. All providers down
  if (!results) {
    logger.error('searchRouter', 'All search providers unavailable', { query });
    throw new Error('all_search_providers_down');
  }

  // 4. Optionally fetch full content for top result via Jina
  if (fetchContent && results.length > 0) {
    try {
      logger.debug('searchRouter', 'Fetching full content via Jina', { url: results[0].url });
      results[0].fullContent = await fetchJina(results[0].url);
    } catch (err) {
      logger.warn('searchRouter', 'Jina fetch failed — snippet only', { error: err.message });
      // Non-fatal — results still returned without fullContent
    }
  }

  return { results, provider: usedProvider };
}

// ── PROVIDER STATUS (for health checks) ──────────────────────────────────────

function getSearchStatus() {
  return {
    tavily: isAvailable('tavily') ? 'ok' : 'cooling_down',
    serper: isAvailable('serper') ? 'ok' : 'cooling_down',
  };
}

module.exports = { search, getSearchStatus };
