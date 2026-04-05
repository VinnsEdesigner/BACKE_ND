'use strict';

const { query }  = require('../supabase');
const logger     = require('../logger');
const { TABLES } = require('../../utils/constants');

// ── SESSION BRIDGE ────────────────────────────────────────────────────────────
// Links scraper sessions to agent context.
// When agent runs, pulls relevant scraper snippets as context.
// Keyword matching — no AI call needed for relevance scoring.

/**
 * Get snippets relevant to the current task description.
 * Returns top N most relevant snippets from recent sessions.
 *
 * @param {string} userId
 * @param {string} taskDescription - the user's current request
 * @param {number} maxSnippets     - max snippets to return (default: 3)
 */
async function getRelevant(userId, taskDescription, maxSnippets = 3) {
  try {
    // Fetch recent snippets (last 20)
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId },
      order:   { column: 'created_at', ascending: false },
      limit:   20,
    });

    if (!rows || rows.length === 0) return [];

    // Extract keywords from task description
    const keywords = extractKeywords(taskDescription);
    if (keywords.length === 0) return rows.slice(0, maxSnippets);

    // Score each snippet by keyword match
    const scored = rows.map((snippet) => {
      const text  = (snippet.content || '').toLowerCase();
      const score = keywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
      return { ...snippet, _score: score };
    });

    // Sort by score desc, then by recency
    scored.sort((a, b) => b._score - a._score || 0);

    const relevant = scored.slice(0, maxSnippets);
    logger.debug('sessionBridge:getRelevant', `Found ${relevant.length} relevant snippets`, {
      userId,
      keywords: keywords.slice(0, 5),
    });

    return relevant.map(({ _score, ...s }) => s);
  } catch (err) {
    logger.error('sessionBridge:getRelevant', 'Failed to fetch snippets', err);
    return [];
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];

  // Stop words to ignore
  const STOP = new Set([
    'the','a','an','is','it','in','on','at','to','for','of','and','or',
    'with','this','that','be','as','by','from','but','not','are','was',
    'do','can','my','i','you','we','they','he','she','file','code',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 10); // max 10 keywords
}

module.exports = { getRelevant };
