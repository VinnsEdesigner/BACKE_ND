/**
 * @file lite-agent.js
 * @location /backend/api/lite-agent.js
 *
 * @purpose
 * Thin HTTP wrapper around the unified agent brain for bookmarklet context.
 * Same brain as api/agent.js — same intent classifier, same model router,
 * same system prompt (with readOnly: true), same memory.
 * Differences from full agent:
 *   → context: 'bookmarklet' → toolInjector enforces read-only tools only
 *   → max 2 tool iterations (cheap, fast)
 *   → max 1000 response tokens
 *   → no confirmation gates (read-only ops don't need approval)
 *   → no task records (no multi-step task persistence)
 *   → page DOM context injected as additional context
 *   → no streaming
 *
 * runLiteAgent() is exported for direct call by scraper-agent.js
 * (avoids HTTP round-trip for auto-prompt feature).
 *
 * @exports
 *   liteAgent(req, res)    → POST /api/lite-agent (HTTP handler)
 *   runLiteAgent(params)   → Promise<LiteAgentResult> (direct call)
 *
 * @imports
 *   ../lib/ai                        → complete
 *   ../lib/searchRouter              → search
 *   ../lib/supabase                  → query
 *   ../lib/logger                    → structured logger
 *   ../lib/agent/intentClassifier    → classify (async)
 *   ../lib/agent/toolInjector        → inject, names
 *   ../lib/agent/modelRouter         → selectModel
 *   ../lib/agent/broadcastEmitter    → trace (non-fatal)
 *   ../lib/agent/visionHandler       → analyzeImage
 *   ../lib/agent/fetchToSnippets     → fetchToSnippets
 *   ../lib/personality/systemPrompt  → buildSystemPrompt
 *   ../lib/github                    → readFile, listFiles
 *   ../utils/constants               → HTTP, TABLES, AGENT, SCRAPER
 *
 * @tables
 *   conversations → INSERT (assistant reply)
 *   personality   → UPSERT (remember tool)
 *
 * @sse-events
 *   trace → thinking stream (non-fatal, bookmarklet may not receive SSE)
 *
 * @env-vars
 *   none directly — all handled by imported modules
 *
 * @dependency-level 8
 */

'use strict';

const { complete }           = require('../lib/ai');
const { search }             = require('../lib/searchRouter');
const { query }              = require('../lib/supabase');
const logger                 = require('../lib/logger');
const { classify }           = require('../lib/agent/intentClassifier');
const { inject: injectTools, names: toolNames } = require('../lib/agent/toolInjector');
const { selectModel }        = require('../lib/agent/modelRouter');
const broadcastEmitter       = require('../lib/agent/broadcastEmitter');
const { analyzeImage }       = require('../lib/agent/visionHandler');
const { fetchToSnippets }    = require('../lib/agent/fetchToSnippets');
const { buildSystemPrompt }  = require('../lib/personality/systemPrompt');
const gh                     = require('../lib/github');
const { HTTP, TABLES, AGENT, SCRAPER } = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LITE_MAX_TOKENS      = 1000;
const LITE_MAX_ITERATIONS  = 2;
const LITE_CONTEXT         = 'bookmarklet';
const LITE_HISTORY_LIMIT   = 10;   // max turns from client history

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH HEURISTIC
// Checks if message likely needs a web search before calling AI.
// Saves tokens when search is unnecessary.
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_KEYWORDS = new Set([
  'search', 'find', 'look up', 'what is', 'who is', 'latest',
  'recent', 'news', 'docs', 'documentation', 'how to', 'tutorial',
  'example', 'compare', 'vs', 'difference between', 'price', 'release',
]);

/**
 * Check if the message likely needs a web search.
 *
 * @param {string} message
 * @returns {boolean}
 */
function needsSearch(message) {
  if (!message || typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  for (const kw of SEARCH_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Run a web search and format results as a context block.
 * Returns empty string on failure — non-fatal.
 *
 * @param {string} queryStr
 * @returns {Promise<string>}
 */
async function runSearch(queryStr) {
  try {
    const { results, provider } = await search(queryStr, { maxResults: 4 });
    if (!results || results.length === 0) return '';

    logger.debug('lite-agent', `Search via ${provider}: ${results.length} results`);

    return results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`)
      .join('\n\n');
  } catch (err) {
    logger.warn('lite-agent', 'Search failed — non-fatal', { error: err.message });
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR (INLINE — bookmarklet context)
// Lite agent handles tools inline without executor.js.
// Only READ_ONLY_TOOLS are available in bookmarklet context.
// toolInjector enforces this — but we double-check here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single tool call inline.
 * Returns result string or throws on failure.
 *
 * @param {string} toolName
 * @param {Object} args
 * @param {string} userId
 * @param {string|null} sessionId
 * @returns {Promise<string>}
 */
// VALID tools in bookmarklet context — single source of truth
const LITE_VALID_TOOLS = new Set([
  'read_file', 'list_files', 'web_search', 'read_url',
  'remember', 'read_logs', 'check_file_exists',
  'analyze_image', 'fetch_to_snippets',
]);

async function executeLiteTool(toolName, args, userId, sessionId) {
  // TOOL VALIDATION FIX: reject invented tool names before they reach the switch
  if (!LITE_VALID_TOOLS.has(toolName)) {
    logger.warn('lite-agent:executeLiteTool', `Invalid tool "${toolName}" — not in allowed list`);
    return JSON.stringify({
      error: `Tool "${toolName}" does not exist. Available tools: ${[...LITE_VALID_TOOLS].join(', ')}`,
    });
  }

  switch (toolName) {

    case 'read_file': {
      const content = await gh.readFile(
        args.repo,
        args.path,
        args.branch || 'main'
      );
      return typeof content === 'string'
        ? content.slice(0, 2000)
        : JSON.stringify(content).slice(0, 2000);
    }

    case 'list_files': {
      const files = await gh.listFiles(
        args.repo,
        args.path || '',
        args.branch || 'main'
      );
      return JSON.stringify(files).slice(0, 2000);
    }

    case 'read_url': {
      // Jina first (free, no key)
      try {
        const res = await fetch(`https://r.jina.ai/${encodeURIComponent(args.url)}`, {
          headers: { Accept: 'application/json' },
          signal:  AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data    = await res.json();
          const content = data.data?.content || data.content || '';
          if (content.trim()) return content.slice(0, 2000);
        }
      } catch {
        // fall through to Firecrawl
      }
      // Firecrawl fallback
      const FirecrawlApp = require('@mendable/firecrawl-js');
      const firecrawl    = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
      const result       = await firecrawl.scrapeUrl(args.url, { formats: ['markdown'] });
      return (result.markdown || '').slice(0, 2000);
    }

    case 'web_search': {
      const { results } = await search(args.query, {
        maxResults: args.max_results || 4,
      });
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`)
        .join('\n\n')
        .slice(0, 2000);
    }

    case 'remember': {
      await query(TABLES.PERSONALITY, 'upsert', {
        data: {
          user_id:    userId,
          key:        args.key,
          value:      String(args.value),
          updated_at: new Date().toISOString(),
        },
        onConflict: 'user_id,key',
      });
      return JSON.stringify({ saved: true, key: args.key });
    }

    case 'read_logs': {
      try {
        const logManager = require('../lib/logManager');
        const logs = await logManager.tail({
          lines:     args.lines || 50,
          level:     args.level || null,
          namespace: args.namespace || null,
        });
        return JSON.stringify(logs).slice(0, 2000);
      } catch {
        return '[]';
      }
    }

    case 'check_file_exists': {
      const fs   = require('fs');
      const path = require('path');
      const target = path.resolve('/app', (args.path || '').replace(/^\//, ''));
      return JSON.stringify({ exists: fs.existsSync(target), path: target });
    }

    case 'analyze_image': {
      const result = await analyzeImage(
        {
          imageUrl:  args.image_url  || null,
          snippetId: args.snippet_id || null,
          question:  args.question   || null,
          mimeType:  args.mime_type  || null,
        },
        userId
      );
      return result.analysis || '';
    }

    case 'fetch_to_snippets': {
      const saved = await fetchToSnippets({
        url:       args.url,
        type:      args.type,
        label:     args.label || null,
        userId,
        sessionId: sessionId || null,
      });
      return JSON.stringify({
        saved:  true,
        number: saved.number,
        type:   saved.type,
      });
    }

    default:
      // Tool not in read-only set — should not reach here
      // toolInjector prevents injection but extra safety guard
      logger.warn('lite-agent:executeLiteTool', `Tool "${toolName}" not available in bookmarklet context`);
      return JSON.stringify({
        error: `${toolName} is not available in bookmarklet context — use the dashboard agent`,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL CALL PARSER
// Same logic as agent.js — inlined to avoid cross-api imports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse tool calls from AI response text.
 *
 * @param {string} responseText
 * @returns {Array<{ name: string, args: Object }>}
 */
function parseToolCalls(responseText) {
  if (!responseText || typeof responseText !== 'string') return [];

  const clean = responseText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  if (!clean.startsWith('{') && !clean.startsWith('[')) return [];

  try {
    const parsed = JSON.parse(clean);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if ((parsed.tool || parsed.name) && parsed.args !== undefined) {
        return [{ name: parsed.tool || parsed.name, args: parsed.args || {} }];
      }
    }

    if (Array.isArray(parsed)) {
      return parsed
        .filter((t) => t && (t.tool || t.name))
        .map((t) => ({ name: t.tool || t.name, args: t.args || {} }));
    }
  } catch {
    // Plain text — no tool calls
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RUNNER
// Exported for direct call by scraper-agent.js.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LiteAgentParams
 * @property {string}   userId
 * @property {string}   message
 * @property {Object}   [pageContext]  - { url, title, content }
 * @property {Array}    [snippets]     - [{ type, text }] from scraper
 * @property {Array}    [history]      - [{ role, content }] last N turns
 * @property {string}   [sessionId]
 */

/**
 * @typedef {Object} LiteAgentResult
 * @property {string}  reply
 * @property {string}  model
 * @property {number}  tokens_used
 * @property {boolean} searched
 * @property {string[]} tools_used
 */

/**
 * Run the lite agent for a bookmarklet request.
 * Same brain as full agent — constrained by bookmarklet context.
 *
 * @param {LiteAgentParams} params
 * @returns {Promise<LiteAgentResult>}
 */
async function runLiteAgent({
  userId,
  message,
  pageContext = null,
  snippets    = [],
  history     = [],
  sessionId   = null,
}) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new Error('runLiteAgent: message is required');
  }
  if (!userId) {
    throw new Error('runLiteAgent: userId is required');
  }

  const userMessage = message.trim();

  // ── 1. Classify intent ─────────────────────────────────────────────────────
  let classification;
  try {
    classification = await classify(userMessage, {
      source: LITE_CONTEXT,
    });
  } catch (err) {
    logger.warn('lite-agent', 'Classification failed — defaulting to chat', {
      error: err.message,
    });
    classification = {
      intent:        'chat',
      confidence:    0.5,
      source:        'fallback',
      suggestedTone: 'chat',
      preferCode:    false,
      needsTools:    false,
      isMultiStep:   false,
    };
  }

  const { intent, needsTools, preferCode } = classification;

  await broadcastEmitter.trace(userId,
    `[bookmarklet] classifier → "${intent}"`
  ).catch(() => {});

  // ── 2. Select model ────────────────────────────────────────────────────────
  const modelSelection = selectModel(intent, null);

  // ── 3. Inject tools (bookmarklet context — read-only enforced) ─────────────
  const injectedToolNames = needsTools
    ? toolNames(intent, { context: LITE_CONTEXT, forceMode: false })
    : [];

  // ── 4. Build system prompt (readOnly: true) ────────────────────────────────
  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(userId, {
      intent,
      sessionId,
      readOnly:    true,
      pageContext,
      tools:       injectedToolNames,
    });
  } catch (err) {
    logger.warn('lite-agent', 'buildSystemPrompt failed — using minimal fallback', {
      error: err.message,
    });
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, casual.`;
  }

  // ── 5. Append tool calling FORMAT instructions only (names already in systemPrompt)
  // BUG11 FIX: don't list tool names again — buildSystemPrompt already did that
  if (injectedToolNames.length > 0) {
    systemPrompt += '\n\n[TOOL CALLING FORMAT]\n' +
      'To call a tool respond with ONLY valid JSON — no other text:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'Only use tools from [AVAILABLE TOOLS THIS REQUEST] above.\n' +
      'Max 2 tool calls per response. After all tools done: respond in plain text.';
  }

  // ── 6. Build context blocks ────────────────────────────────────────────────

  // Page DOM context
  let pageBlock = '';
  if (pageContext && typeof pageContext === 'object') {
    const url     = pageContext.url   || 'unknown';
    const title   = pageContext.title || 'unknown';
    const content = typeof pageContext.content === 'string'
      ? pageContext.content.slice(0, 3000)
      : '';
    pageBlock = `\n\n[CURRENT PAGE]\nURL: ${url}\nTitle: ${title}` +
      (content ? `\nContent:\n${content}` : '');
  }

  // Staged snippets context
  let snippetBlock = '';
  if (Array.isArray(snippets) && snippets.length > 0) {
    const validSnippets = snippets
      .filter((s) => s && s.type && (s.text || s.content))
      .slice(0, SCRAPER.MAX_SNIPPETS_COUNT);

    if (validSnippets.length > 0) {
      const hasImageSnippets = validSnippets.some((s) => s.type === 'image');
      snippetBlock = `\n\n[STAGED SNIPPETS]\n` +
        validSnippets
          .map((s, i) => `#${i + 1} [${s.type}]: ${(s.text || s.content || '').slice(0, 300)}`)
          .join('\n');

      if (hasImageSnippets) {
        snippetBlock += '\n[Vision capability available — image snippets staged]';
      }
    }
  }

  // Optional web search
  let searchBlock  = '';
  let searched     = false;
  if (needsSearch(userMessage)) {
    const results = await runSearch(userMessage);
    if (results) {
      searchBlock = `\n\n[WEB SEARCH RESULTS]\n${results}`;
      searched    = true;
    }
  }

  // ── 7. Build messages array ────────────────────────────────────────────────
  const historyMessages = Array.isArray(history)
    ? history
        .filter((m) => m && m.role && m.content)
        .slice(-LITE_HISTORY_LIMIT)
        .map((m) => ({
          role:    ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
          content: String(m.content).slice(0, 1000),
        }))
    : [];

  // Append context blocks to user message
  const userContent = `${userMessage}${pageBlock}${snippetBlock}${searchBlock}`;

  const messages = [
    ...historyMessages,
    { role: 'user', content: userContent },
  ];

  // ── 8. Tool-calling loop (max 2 iterations) ────────────────────────────────
  let finalReply  = '';
  let toolsUsed   = [];
  let lastResponse = null;
  let totalTokens  = 0;

  for (let iteration = 1; iteration <= LITE_MAX_ITERATIONS; iteration++) {
    let aiResponse;
    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens:  LITE_MAX_TOKENS,
        preferCode: modelSelection.preferCode,
      });
    } catch (err) {
      if (err.message === 'all_providers_down') {
        throw err; // bubble up — HTTP handler returns 503
      }
      logger.error('lite-agent', 'AI completion failed', {
        error: err.message,
        iteration,
      });
      throw err;
    }

    lastResponse  = aiResponse;
    totalTokens  += aiResponse.tokens_used;

    const toolCalls = parseToolCalls(aiResponse.text);

    // No tool calls → final reply
    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    // Execute tool calls inline
    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId,
        `[bookmarklet] tool: ${toolCall.name}`
      ).catch(() => {});

      let resultStr = '';
      try {
        resultStr = await executeLiteTool(
          toolCall.name,
          toolCall.args,
          userId,
          sessionId
        );
        toolsUsed.push(toolCall.name);
      } catch (err) {
        logger.warn('lite-agent', `Tool "${toolCall.name}" failed`, {
          error: err.message,
        });
        resultStr = JSON.stringify({ error: err.message });
      }

      // Feed result back
      messages.push({ role: 'assistant', content: aiResponse.text });
      messages.push({
        role:    'user',
        content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue.`,
      });
    }

    // Last iteration — if still getting tool calls, use last response as reply
    if (iteration === LITE_MAX_ITERATIONS) {
      finalReply = aiResponse.text;
    }
  }

  // Ensure we always have a reply
  if (!finalReply && lastResponse) {
    finalReply = lastResponse.text;
  }
  if (!finalReply) {
    finalReply = 'Done.';
  }

  logger.info('lite-agent', 'Completed', {
    userId,
    intent,
    model:      lastResponse?.model,
    tokens:     totalTokens,
    tools:      toolsUsed,
    searched,
  });

  return {
    reply:       finalReply,
    model:       lastResponse?.model || 'unknown',
    tokens_used: totalTokens,
    searched,
    tools_used:  toolsUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/lite-agent
 * Thin HTTP wrapper around runLiteAgent().
 *
 * @param {Object} req
 * @param {Object} res
 */
async function liteAgent(req, res) {
  const { userId } = req.user;
  const {
    message,
    pageContext = null,
    snippets    = [],
    history     = [],
    sessionId   = null,
  } = req.body;

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
      snippets:    Array.isArray(snippets) ? snippets : [],
      history:     Array.isArray(history)  ? history  : [],
      sessionId,
    });

    // Persist assistant reply — non-fatal
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id:    userId,
          session_id: sessionId || null,
          role:       'assistant',
          content:    result.reply,           // LAW 11 — always 'content'
          card_type:  'text',
          metadata:   {
            model:       result.model,
            tokens_used: result.tokens_used,
            source:      'lite_agent',
            searched:    result.searched,
            tools_used:  result.tools_used,
            intent:      'bookmarklet',
          },
          created_at: new Date().toISOString(),
        },
      });
    } catch (dbErr) {
      logger.warn('lite-agent', 'Failed to persist conversation — non-fatal', {
        error: dbErr.message,
      });
    }

    return res.status(HTTP.OK).json({
      reply:       result.reply,
      model:       result.model,
      tokens_used: result.tokens_used,
      searched:    result.searched,
      tools_used:  result.tools_used,
    });
  } catch (err) {
    if (err.message === 'all_providers_down') {
      return res.status(HTTP.SERVICE_UNAVAILABLE).json({
        error:   'all_providers_down',
        message: 'All AI providers are currently unavailable. Try again shortly.',
      });
    }

    logger.error('lite-agent', 'Unhandled error', { error: err.message });
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error:   'lite_agent_failed',
      message: 'Lite agent encountered an error.',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { liteAgent, runLiteAgent };
