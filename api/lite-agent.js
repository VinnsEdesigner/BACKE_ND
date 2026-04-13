/**
 * @file lite-agent.js
 * @location /backend/api/lite-agent.js
 *
 * BUGS FIXED IN THIS REWRITE:
 *
 * BUG 1 — parseToolCalls exits on text preamble
 *   OLD: if (!clean.startsWith('{')) return [] → killed ALL real tool calls
 *        Devstral/Mistral ALWAYS prepend a sentence before JSON
 *   FIX: deleted. We now read result.tool_calls from ai.complete() directly.
 *        ai.js extracts tool_calls natively per provider (no regex).
 *
 * BUG 2 — Page context injected into system prompt
 *   OLD: buildSystemPrompt received pageContext → formatPageContext in system
 *        prompt → model treated DOM as part of its identity (~750 token waste)
 *   FIX: page context appended to USER message content only (Layer 4).
 *        systemPrompt.js never receives pageContext.
 *
 * BUG 3 — sessionId never forwarded to runLiteAgent
 *   OLD: options = {} always → sessionId: null on every backend request
 *   FIX: sessionId passed through properly.
 *
 * BUG 4 — contextCompressor never called
 *   OLD: raw history slice, no compression
 *   FIX: loadCompressedContext wired for history + memory.
 *
 * BUG 5 — tools_used badge never populated
 *   OLD: result.tools_used never read
 *   FIX: result.tool_calls from ai.complete() → tools_used tracked correctly.
 */

'use strict';

const { complete }              = require('../lib/ai');
const { search }                = require('../lib/searchRouter');
const { query }                 = require('../lib/supabase');
const logger                    = require('../lib/logger');
const { classify }              = require('../lib/agent/intentClassifier');
const { inject: injectTools, names: toolNames } = require('../lib/agent/toolInjector');
const { selectModel }           = require('../lib/agent/modelRouter');
const broadcastEmitter          = require('../lib/agent/broadcastEmitter');
const { analyzeImage }          = require('../lib/agent/visionHandler');
const { fetchToSnippets }       = require('../lib/agent/fetchToSnippets');
const { buildSystemPrompt }     = require('../lib/personality/systemPrompt');
const { loadCompressedContext } = require('../lib/agent/contextCompressor');
const gh                        = require('../lib/github');
const {
  HTTP, TABLES, AGENT, SCRAPER, MEMORY,
} = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LITE_MAX_TOKENS     = 1000;
const LITE_MAX_ITERATIONS = 2;
const LITE_CONTEXT        = 'bookmarklet';

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH HEURISTIC
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_KEYWORDS = new Set([
  'search', 'find', 'look up', 'what is', 'who is', 'latest',
  'recent', 'news', 'docs', 'documentation', 'how to', 'tutorial',
  'example', 'compare', 'vs', 'difference between', 'price', 'release',
]);

function needsSearch(message) {
  if (!message || typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  for (const kw of SEARCH_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

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
// PAGE CONTEXT FORMATTER (Layer 4 — goes into USER message, not system prompt)
// This is intentionally NOT in systemPrompt.js.
// Page DOM in system prompt = model treats it as identity = bad.
// Page DOM in user message = model treats it as context = correct.
// ─────────────────────────────────────────────────────────────────────────────

function formatPageContext(pageContext) {
  if (!pageContext || typeof pageContext !== 'object') return '';

  const url     = pageContext.url   || 'unknown';
  const title   = pageContext.title || 'unknown';
  const content = typeof pageContext.content === 'string'
    ? pageContext.content.slice(0, 3000)
    : '';

  if (!content && url === 'unknown') return '';

  return [
    '\n\n[CURRENT PAGE — CONTEXT FOR THIS REQUEST]',
    `URL: ${url}`,
    `Title: ${title}`,
    content ? `Content:\n${content}` : '',
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR (inline — bookmarklet context, read-only only)
// ─────────────────────────────────────────────────────────────────────────────

const LITE_VALID_TOOLS = new Set([
  'read_file', 'list_files', 'web_search', 'read_url',
  'remember', 'read_logs', 'check_file_exists',
  'analyze_image', 'fetch_to_snippets',
]);

async function executeLiteTool(toolName, args, userId, sessionId) {
  if (!LITE_VALID_TOOLS.has(toolName)) {
    logger.warn('lite-agent:executeLiteTool', `Invalid tool "${toolName}"`);
    return JSON.stringify({
      error: `Tool "${toolName}" is not available in bookmarklet context. Available: ${[...LITE_VALID_TOOLS].join(', ')}`,
    });
  }

  switch (toolName) {
    case 'read_file': {
      const content = await gh.readFile(args.repo, args.path, args.branch || 'main');
      return typeof content === 'string'
        ? content.slice(0, 2000)
        : JSON.stringify(content).slice(0, 2000);
    }

    case 'list_files': {
      const files = await gh.listFiles(args.repo, args.path || '', args.branch || 'main');
      return JSON.stringify(files).slice(0, 2000);
    }

    case 'read_url': {
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
      } catch { /* fall through to firecrawl */ }
      const FirecrawlApp = require('@mendable/firecrawl-js');
      const firecrawl    = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
      const result       = await firecrawl.scrapeUrl(args.url, { formats: ['markdown'] });
      return (result.markdown || '').slice(0, 2000);
    }

    case 'web_search': {
      const { results } = await search(args.query, { maxResults: args.max_results || 4 });
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
        const logs = await logManager.tail({ lines: args.lines || 50, level: args.level || null });
        return JSON.stringify(logs).slice(0, 2000);
      } catch { return '[]'; }
    }

    case 'check_file_exists': {
      const fs   = require('fs');
      const path = require('path');
      const target = path.resolve('/app', (args.path || '').replace(/^\//, ''));
      return JSON.stringify({ exists: fs.existsSync(target), path: target });
    }

    case 'analyze_image': {
      const result = await analyzeImage({
        imageUrl:  args.image_url  || null,
        snippetId: args.snippet_id || null,
        question:  args.question   || null,
        mimeType:  args.mime_type  || null,
      }, userId);
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
      return JSON.stringify({ saved: true, number: saved.number, type: saved.type });
    }

    default:
      return JSON.stringify({ error: `${toolName} not available in bookmarklet context` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LiteAgentParams
 * @property {string}   userId
 * @property {string}   message
 * @property {Object}   [pageContext]   - { url, title, content } — goes into USER message
 * @property {Array}    [snippets]      - [{ type, text }] staged snippets
 * @property {Array}    [history]       - [{ role, content }] prior turns
 * @property {string}   [sessionId]
 * @property {string}   [preferredModel] - slash command model override
 */

/**
 * Run the lite agent for a bookmarklet request.
 *
 * @param {LiteAgentParams} params
 * @returns {Promise<{ reply, model, tokens_used, searched, tools_used }>}
 */
async function runLiteAgent({
  userId,
  message,
  pageContext   = null,
  snippets      = [],
  history       = [],
  sessionId     = null,
  preferredModel = null,
}) {
  if (!message?.trim()) throw new Error('runLiteAgent: message is required');
  if (!userId)          throw new Error('runLiteAgent: userId is required');

  const userMessage = message.trim();

  // ── 1. Classify intent ─────────────────────────────────────────────────────
  let classification;
  try {
    classification = await classify(userMessage, { source: LITE_CONTEXT });
  } catch (err) {
    logger.warn('lite-agent', 'Classification failed — defaulting to chat', { error: err.message });
    classification = { intent: 'chat', confidence: 0.5, source: 'fallback', needsTools: false, preferCode: false };
  }

  const { intent, needsTools, preferCode } = classification;

  await broadcastEmitter.trace(userId, `[bookmarklet] classifier → "${intent}"`).catch(() => {});

  // ── 2. Select model ────────────────────────────────────────────────────────
  const modelSelection = selectModel(intent, null, preferredModel);

  // ── 3. Inject tools (bookmarklet = read-only enforced) ─────────────────────
  const injectedTools     = needsTools
    ? injectTools(intent, { context: LITE_CONTEXT, forceMode: false })
    : [];
  const injectedToolNames = needsTools
    ? toolNames(intent, { context: LITE_CONTEXT, forceMode: false })
    : [];

  // ── 4. Build system prompt (NO pageContext here — goes in user message) ─────
  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(userId, {
      intent,
      sessionId,
      readOnly: true,
      tools:    injectedToolNames,
      // NOTE: no pageContext param — intentional (LAW: page context in user msg)
    });
  } catch (err) {
    logger.warn('lite-agent', 'buildSystemPrompt failed — minimal fallback', { error: err.message });
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, casual.`;
  }

  // Append tool calling FORMAT instructions (not schemas — already in system prompt)
  if (injectedToolNames.length > 0) {
    systemPrompt += '\n\n[TOOL CALLING FORMAT]\n' +
      'To call a tool respond with ONLY valid JSON — no other text:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'Only use tools from [AVAILABLE TOOLS THIS REQUEST] above.\n' +
      'Max 2 tool calls per response. After all tools done: respond in plain text.';
  }

  // ── 5. Load compressed history (Layer 5 — contextCompressor) ──────────────
  // This replaces the raw history slice. Compressor handles token budget.
  let compressedMessages = [];
  try {
    const compressed = await loadCompressedContext({
      userId,
      sessionId,
      keepRecentMessages: MEMORY.LAYER_5_HISTORY_LIMIT,
      promptBudgetTokens: AGENT.MAX_TOKENS,
      preferCode,
    });
    // Use compressed messages as our history base
    compressedMessages = compressed.messages || [];
  } catch (err) {
    logger.warn('lite-agent', 'contextCompressor failed — using raw history', { error: err.message });
    // Fallback to raw history slice
    compressedMessages = Array.isArray(history)
      ? history
          .filter((m) => m && m.role && m.content)
          .slice(-MEMORY.LAYER_5_HISTORY_LIMIT)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1000) }))
      : [];
  }

  // ── 6. Build context blocks (Layer 4 — page context into USER message) ──────
  // Page DOM goes here, NOT in system prompt
  const pageContextStr = formatPageContext(pageContext);

  // Staged snippets context
  let snippetBlock = '';
  if (Array.isArray(snippets) && snippets.length > 0) {
    const validSnippets = snippets
      .filter((s) => s && s.type && (s.text || s.content))
      .slice(0, SCRAPER.MAX_SNIPPETS_COUNT);
    if (validSnippets.length > 0) {
      snippetBlock = `\n\n[STAGED SNIPPETS]\n` +
        validSnippets
          .map((s, i) => `#${i + 1} [${s.type}]: ${(s.text || s.content || '').slice(0, 300)}`)
          .join('\n');
    }
  }

  // Optional web search
  let searchBlock = '';
  let searched    = false;
  if (needsSearch(userMessage)) {
    const results = await runSearch(userMessage);
    if (results) { searchBlock = `\n\n[WEB SEARCH RESULTS]\n${results}`; searched = true; }
  }

  // User message = actual message + page context + snippets + search
  // Page context is appended here so model reads it as "what the user is looking at"
  const userContent = `${userMessage}${pageContextStr}${snippetBlock}${searchBlock}`;

  const messages = [
    ...compressedMessages,
    { role: 'user', content: userContent },
  ];

  // ── 7. Tool-calling loop (max 2 iterations) ────────────────────────────────
  let finalReply   = '';
  let toolsUsed    = [];
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
        tools:      injectedTools,   // pass tool schemas to ai.complete()
      });
    } catch (err) {
      if (err.message === 'all_providers_down') throw err;
      logger.error('lite-agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    lastResponse  = aiResponse;
    totalTokens  += aiResponse.tokens_used;

    // READ tool_calls from ai.complete() result — no regex, no parseToolCalls()
    // ai.js extracts these natively per provider (Groq/Mistral → tool_calls field,
    // Gemini/Gemma → parsed from <tool>...</tool> XML tags in response text)
    const toolCalls = aiResponse.tool_calls || [];

    // No tool calls → final reply
    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    // Execute tool calls inline
    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId, `[bookmarklet] tool: ${toolCall.name}`).catch(() => {});

      let resultStr = '';
      try {
        resultStr = await executeLiteTool(toolCall.name, toolCall.args, userId, sessionId);
        toolsUsed.push(toolCall.name);
      } catch (err) {
        logger.warn('lite-agent', `Tool "${toolCall.name}" failed`, { error: err.message });
        resultStr = JSON.stringify({ error: err.message });
      }

      messages.push({ role: 'assistant', content: aiResponse.text });
      messages.push({
        role:    'user',
        content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue.`,
      });
    }

    if (iteration === LITE_MAX_ITERATIONS) {
      finalReply = aiResponse.text;
    }
  }

  if (!finalReply && lastResponse) finalReply = lastResponse.text;
  if (!finalReply) finalReply = 'Done.';

  logger.info('lite-agent', 'Completed', {
    userId, intent,
    model:   lastResponse?.model,
    tokens:  totalTokens,
    tools:   toolsUsed,
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
// HTTP HANDLER — POST /api/lite-agent
// ─────────────────────────────────────────────────────────────────────────────

async function liteAgent(req, res) {
  const { userId } = req.user;
  const {
    message,
    pageContext    = null,
    snippets       = [],
    history        = [],
    sessionId      = null,
    preferredModel = null,
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({ error: 'bad_request', message: 'message is required' });
  }

  try {
    const result = await runLiteAgent({
      userId,
      message:       message.trim(),
      pageContext,
      snippets:      Array.isArray(snippets) ? snippets : [],
      history:       Array.isArray(history)  ? history  : [],
      sessionId:     sessionId ? String(sessionId) : null,
      preferredModel,
    });

    // Persist assistant reply — non-fatal
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id:    userId,
          session_id: sessionId || null,
          role:       'assistant',
          content:    result.reply,    // LAW 11 — always 'content'
          card_type:  'text',
          metadata: {
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
      logger.warn('lite-agent', 'Failed to persist conversation — non-fatal', { error: dbErr.message });
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

module.exports = { liteAgent, runLiteAgent };
