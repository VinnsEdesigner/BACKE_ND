'use strict';

const { complete }   = require('../lib/ai');
const { search }     = require('../lib/searchRouter');
const { query }      = require('../lib/supabase');
const logger         = require('../lib/logger');
const { HTTP, TABLES, AGENT } = require('../utils/constants');

// Read-only tools lite-agent can call. Writes are NEVER allowed here.
const LITE_ALLOWED_TOOLS = new Set([
  'read_file', 'list_files', 'read_url', 'remember',
]);

async function runLiteTool(toolName, args, userId) {
  if (!LITE_ALLOWED_TOOLS.has(toolName)) {
    return { error: `${toolName} not allowed in lite-agent — use full agent` };
  }
  const gh = require('../lib/github');
  const { query } = require('../lib/supabase');
  const { TABLES } = require('../utils/constants');

  if (toolName === 'read_file') {
    return gh.readFile(args.repo, args.path, args.branch || 'main');
  }
  if (toolName === 'list_files') {
    return gh.listFiles(args.repo, args.path || '', args.branch || 'main');
  }
  if (toolName === 'read_url') {
    const res = await fetch(`https://r.jina.ai/${args.url}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jina ${res.status}`);
    const data = await res.json();
    return data.data?.content || '';
  }
  if (toolName === 'remember') {
    await query(TABLES.PERSONALITY, 'upsert', {
      data: { user_id: userId, key: args.key, value: String(args.value),
              updated_at: new Date().toISOString() },
      onConflict: 'user_id,key',
    });
    return { saved: true };
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

const LITE_SYSTEM_PROMPT = `You are a focused agent for vinns, be helpful and reply as gen-Z - have humor - use emojis whre needed. don't respond in corporate tone. you are vinns assistant buddy - he is your creator and you run in his system. your nickname is NEXY.
You have access to the current page content and can search the web.
Keep responses concise and actionable — the user is reading on mobile.
Do not perform file operations, GitHub actions, or multi-step plans.
If a task requires those, say: "This needs the full agent — send from Dashboard."
 respond in text but inser emoji's where required and if you're asked to code drop it professionally don't hesitate. No markdown headers. Short paragraphs.`;

// ── SEARCH INTENT HEURISTIC ───────────────────────────────────────────────────

async function needsSearch(userMessage) {
  const keywords = [
    'search', 'find', 'look up', 'what is', 'who is', 'latest', 'recent',
    'news', 'docs', 'documentation', 'how to', 'tutorial', 'example',
    'compare', 'vs', 'difference between', 'price', 'release',
  ];
  const lower = userMessage.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ── SEARCH RUNNER ─────────────────────────────────────────────────────────────

async function runSearch(queryStr) {
  try {
    const { results, provider } = await search(queryStr, { maxResults: 4 });
    logger.debug('lite-agent', `Search via ${provider}: ${results.length} results`);
    return results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
      .join('\n\n');
  } catch (err) {
    logger.warn('lite-agent', 'Search failed', { error: err.message });
    return null;
  }
}

// ── CORE RUNNER ───────────────────────────────────────────────────────────────
// Exported so scraper-agent.js can call directly (no HTTP round-trip)

async function runLiteAgent({ userId, message, pageContext, snippets = [] }) {
  if (!message) throw new Error('message required');

  // Page DOM context block
  const pageBlock = pageContext
    ? `\n\n[PAGE CONTEXT]\nURL: ${pageContext.url || 'unknown'}\nTitle: ${pageContext.title || 'unknown'}\nContent:\n${(pageContext.content || '').slice(0, 3000)}`
    : '';

  // Staged snippets block
  const snippetBlock = snippets.length > 0
    ? `\n\n[STAGED SNIPPETS]\n${snippets.map((s, i) => `#${i + 1} [${s.type}]: ${s.text}`).join('\n')}`
    : '';

  // Optional web search
  let searchBlock = '';
  if (await needsSearch(message)) {
    logger.debug('lite-agent', 'Search triggered', { msg: message.slice(0, 60) });
    const results = await runSearch(message);
    if (results) searchBlock = `\n\n[WEB SEARCH RESULTS]\n${results}`;
  }

  const userContent = `${message}${pageBlock}${snippetBlock}${searchBlock}`;
  const messages    = [{ role: 'user', content: userContent }];

  const result = await complete({
    messages,
    systemPrompt: LITE_SYSTEM_PROMPT,
    maxTokens:    1000,
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

async function liteAgent(req, res) {
  const { userId }                       = req.user;
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
      message:     message.trim(),
      pageContext,
      snippets:    snippets || [],
    });

    // Persist to conversations — only columns that exist in schema
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id:    userId,
          role:       'assistant',
          content:    result.reply,
          card_type:  'text',
          metadata:   {
            model:       result.model,
            tokens_used: result.tokens_used,
            source:      'lite_agent',
            searched:    result.searched,
          },
          created_at: new Date().toISOString(),
        },
      });
    } catch (dbErr) {
      // Non-fatal — response already ready
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
