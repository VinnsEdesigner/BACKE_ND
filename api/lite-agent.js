'use strict';

const { complete } = require('../lib/ai');
const { search }   = require('../lib/searchRouter');
const { query }    = require('../lib/supabase');
const logger       = require('../lib/logger');
const { HTTP, TABLES, AGENT } = require('../utils/constants');

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────────
// Stripped-down — no GitHub tools, no file ops, no complex chains.
// Fast + cheap. Focused on what's on the page RIGHT NOW.

const LITE_SYSTEM_PROMPT = `You are a focused web research assistant injected into the user's browser.
You have access to the current page content and can search the web.
Keep responses concise and actionable — the user is reading on mobile.
Do not perform file operations, GitHub actions, or multi-step plans.
If a task requires those, say: "This needs the full agent — send from Dashboard."
Always respond in plain text. No markdown headers. Short paragraphs.`;

// ── INTENT CLASSIFIER (cheap — decides if search is needed) ───────────────────

async function needsSearch(userMessage) {
  // Heuristic-first — avoids a full AI call for obvious cases
  const searchKeywords = [
    'search', 'find', 'look up', 'what is', 'who is', 'latest', 'recent',
    'news', 'docs', 'documentation', 'how to', 'tutorial', 'example',
    'compare', 'vs', 'difference between', 'price', 'release',
  ];
  const lower = userMessage.toLowerCase();
  return searchKeywords.some((kw) => lower.includes(kw));
}

// ── TOOL: WEB SEARCH ──────────────────────────────────────────────────────────

async function runSearch(query_str) {
  try {
    const { results, provider } = await search(query_str, { maxResults: 4 });
    logger.debug('lite-agent', `Search via ${provider}: ${results.length} results`);
    // Format results into a compact string for context injection
    return results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
      .join('\n\n');
  } catch (err) {
    logger.warn('lite-agent', 'Search failed', { error: err.message });
    return null;
  }
}

// ── CORE LITE AGENT RUNNER ────────────────────────────────────────────────────
// Exported so scraper-agent.js can call it directly (no HTTP round-trip)

async function runLiteAgent({ userId, message, pageContext, snippets = [] }) {
  if (!message) throw new Error('message required');

  // Build context block from page DOM
  const pageBlock = pageContext
    ? `\n\n[PAGE CONTEXT]\nURL: ${pageContext.url || 'unknown'}\nTitle: ${pageContext.title || 'unknown'}\nContent:\n${(pageContext.content || '').slice(0, 3000)}`
    : '';

  // Build snippets block (staged selections)
  const snippetBlock = snippets.length > 0
    ? `\n\n[STAGED SNIPPETS]\n${snippets.map((s, i) => `#${i + 1} [${s.type}]: ${s.text}`).join('\n')}`
    : '';

  // Decide if we need a web search
  let searchBlock = '';
  if (await needsSearch(message)) {
    logger.debug('lite-agent', 'Search triggered for message', { message: message.slice(0, 60) });
    const searchResults = await runSearch(message);
    if (searchResults) {
      searchBlock = `\n\n[WEB SEARCH RESULTS]\n${searchResults}`;
    }
  }

  const userContent = `${message}${pageBlock}${snippetBlock}${searchBlock}`;

  const messages = [{ role: 'user', content: userContent }];

  // Run through AI waterfall
  const result = await complete({
    messages,
    systemPrompt: LITE_SYSTEM_PROMPT,
    maxTokens:    1000, // lite = cheap, keep short
  });

  logger.info('lite-agent', 'Completed', {
    userId,
    model:  result.model,
    tokens: result.tokens_used,
  });

  return {
    reply:       result.text,
    model:       result.model,
    tokens_used: result.tokens_used,
    searched:    searchBlock.length > 0,
  };
}

// ── HTTP HANDLER ──────────────────────────────────────────────────────────────
// POST /api/lite-agent
// Body: { message, pageContext?, snippets? }

async function liteAgent(req, res) {
  const { userId } = req.user;
  const { message, pageContext, snippets } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'message is required',
    });
  }

  try {
    const result = await runLiteAgent({
      userId,
      message: message.trim(),
      pageContext,
      snippets: snippets || [],
    });

    // Persist conversation to Supabase (non-fatal if fails)
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id:     userId,
          source:      'lite_agent',
          role:        'assistant',
          content:     result.reply,
          model_used:  result.model,
          tokens_used: result.tokens_used,
          created_at:  new Date().toISOString(),
        },
      });
    } catch (dbErr) {
      logger.warn('lite-agent', 'Failed to persist conversation', dbErr);
    }

    return res.status(HTTP.OK).json({
      reply:       result.reply,
      model:       result.model,
      tokens_used: result.tokens_used,
      searched:    result.searched,
    });
  } catch (err) {
    if (err.message === 'all_providers_down') {
      return res.status(HTTP.SERVICE_UNAVAILABLE).json({
        error:   'all_providers_down',
        message: 'All AI providers are currently unavailable. Try again shortly.',
      });
    }
    logger.error('lite-agent', 'Unhandled error', err);
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'lite_agent_failed',
      message: 'Lite agent encountered an error',
    });
  }
}

module.exports = { liteAgent, runLiteAgent };
