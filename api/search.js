'use strict';

const { search: routerSearch, getSearchStatus } = require('../lib/searchRouter');
const logger = require('../lib/logger');
const { HTTP } = require('../utils/constants');

// ── POST /api/search ──────────────────────────────────────────────────────────
// Direct search endpoint for dashboard.
// Agent uses searchRouter directly — this is for manual dashboard searches.
//
// Body: { query, maxResults?, fetchContent? }

async function search(req, res) {
  const { userId } = req.user;
  const { query, maxResults = 5, fetchContent = false } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'query is required',
    });
  }

  const clampedMax = Math.min(Math.max(1, maxResults), 10); // 1-10 max

  logger.info('search', `Query: "${query.slice(0, 60)}"`, { userId, maxResults: clampedMax });

  try {
    const { results, provider } = await routerSearch(query.trim(), {
      maxResults:   clampedMax,
      fetchContent: Boolean(fetchContent),
    });

    logger.info('search', `Returned ${results.length} results via ${provider}`, { userId });

    return res.status(HTTP.OK).json({
      ok:        true,
      query:     query.trim(),
      provider,
      results,
      count:     results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.message === 'all_search_providers_down') {
      return res.status(HTTP.SERVICE_UNAVAILABLE).json({
        error:   'all_search_providers_down',
        message: 'All search providers are currently unavailable. Try again shortly.',
        status:  getSearchStatus(),
      });
    }

    logger.error('search', 'Search failed', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'search_failed',
      message: 'Search encountered an error',
    });
  }
}

// ── GET /api/search/status ────────────────────────────────────────────────────

async function searchStatus(req, res) {
  return res.status(HTTP.OK).json({
    ok:        true,
    providers: getSearchStatus(),
    timestamp: new Date().toISOString(),
  });
}

module.exports = { search, searchStatus };
