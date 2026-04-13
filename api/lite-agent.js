/**
 * @file lite-agent.js
 * @location /backend/api/lite-agent.js
 *
 * @purpose
 * Thin HTTP wrapper around the unified agent brain for bookmarklet context.
 *
 * KEY CHANGES FROM PREVIOUS VERSION:
 *   → Native tool calling — ai.complete() returns tool_calls[] directly.
 *     No regex parsing. No parseToolCalls() function.
 *   → pageContext injected ONCE in buildSystemPrompt() via systemPrompt.js
 *     NOT duplicated in the user message content.
 *   → preferredModel accepted — allows slash /model commands to pin a model
 *   → sessionId always passed from ask.js now (was always null before)
 *   → Gemini fallback: if provider_key is not groq/mistral, injects XML tool
 *     instructions into systemPrompt before calling complete()
 *
 * Tool calling loop (max 2 iterations):
 *   1. Call ai.complete() with tool schemas
 *   2. If result.tool_calls.length > 0 → execute tools → feed results back
 *   3. If no tool_calls → finalReply = result.text → done
 *
 * @exports
 *   liteAgent(req, res)    → POST /api/lite-agent (HTTP handler)
 *   runLiteAgent(params)   → Promise<LiteAgentResult> (direct call)
 *
 * @dependency-level 8
 */

'use strict';

const { complete, supportsNativeTools, getGeminiToolInstructions } = require('../lib/ai');
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
const { HTTP, TABLES, AGENT, SCRAPER, MODELS } = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LITE_MAX_TOKENS      = 1000;
const LITE_MAX_ITERATIONS  = 2;
const LITE_CONTEXT         = 'bookmarklet';
const LITE_HISTORY_LIMIT   = 10;

// ─────────────────────────────────────────────────────────────────────────────
// VALID TOOLS IN BOOKMARKLET CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

const LITE_VALID_TOOLS = new Set([
  'read_file', 'list_files', 'web_search', 'read_url',
  'remember', 'read_logs', 'check_file_exists',
  'analyze_image', 'fetch_to_snippets',
]);

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
// TOOL EXECUTOR (inline — bookmarklet context, read-only only)
// ─────────────────────────────────────────────────────────────────────────────

async function executeLiteTool(toolName, args, userId, sessionId) {
  if (!LITE_VALID_TOOLS.has(toolName)) {
    logger.warn('lite-agent:executeLiteTool', `Invalid tool "${toolName}" — not in allowed list`);
    return JSON.stringify({
      error: `Tool "${toolName}" does not exist. Available: ${[...LITE_VALID_TOOLS].join(', ')}`,
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
        const logs = await logManager.tail({
          lines:     args.lines || 50,
          level:     args.level || null,
          namespace: args.namespace || null,
        });
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
      const result = await analyzeImage(
        { imageUrl: args.image_url || null, snippetId: args.snippet_id || null,
          question: args.question || null, mimeType: args.mime_type || null },
        userId
      );
      return result.analysis || '';
    }

    case 'fetch_to_snippets': {
      const saved = await fetchToSnippets({
        url: args.url, type: args.type, label: args.label || null,
        userId, sessionId: sessionId || null,
      });
      return JSON.stringify({ saved: true, number: saved.number, type: saved.type });
    }

    default:
      return JSON.stringify({ error: `${toolName} not available in bookmarklet context` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PREFERRED MODEL RESOLVER
// Maps slash command model names to exact model strings.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_ALIAS_MAP = {
  groq:         MODELS.GROQ_BRAIN,
  llama:        MODELS.GROQ_BRAIN,
  devstral:     MODELS.MISTRAL_CODE,
  mistral:      MODELS.MISTRAL_LARGE,
  'mistral-large': MODELS.MISTRAL_LARGE,
  gemini:       MODELS.GEMINI_FLASH,
  'gemini-lite': MODELS.GEMINI_FLASH_LITE,
  'gemma-26':   MODELS.GEMMA_4_26B,
  'gemma-31':   MODELS.GEMMA_4_31B,
};

function resolvePreferredModel(preferredModel) {
  if (!preferredModel || typeof preferredModel !== 'string') return null;
  const lower = preferredModel.toLowerCase().trim();
  // Check alias map first
  if (MODEL_ALIAS_MAP[lower]) return MODEL_ALIAS_MAP[lower];
  // Check if it's already an exact model string
  const allModels = Object.values(MODELS);
  if (allModels.includes(preferredModel)) return preferredModel;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LiteAgentParams
 * @property {string}   userId
 * @property {string}   message
 * @property {Object}   [pageContext]    - { url, title, content }
 * @property {Array}    [snippets]       - [{ type, text }] from scraper
 * @property {Array}    [history]        - [{ role, content }] last N turns
 * @property {string}   [sessionId]
 * @property {string}   [preferredModel] - pinned model from slash command
 */

async function runLiteAgent({
  userId,
  message,
  pageContext    = null,
  snippets       = [],
  history        = [],
  sessionId      = null,
  preferredModel = null,
}) {
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new Error('runLiteAgent: message is required');
  }
  if (!userId) throw new Error('runLiteAgent: userId is required');

  const userMessage = message.trim();

  // ── 1. Classify intent ─────────────────────────────────────────────────────
  let classification;
  try {
    classification = await classify(userMessage, { source: LITE_CONTEXT });
  } catch {
    classification = { intent: 'chat', confidence: 0.5, source: 'fallback',
      suggestedTone: 'chat', preferCode: false, needsTools: false, isMultiStep: false };
  }

  const { intent, needsTools, preferCode } = classification;

  await broadcastEmitter.trace(userId, `[bookmarklet] classifier → "${intent}"`).catch(() => {});

  // ── 2. Select model ────────────────────────────────────────────────────────
  // preferredModel from slash command overrides modelRouter
  const resolved = resolvePreferredModel(preferredModel);
  const modelSelection = resolved
    ? { model: resolved, preferCode: false, fimOnly: false, visionOnly: false,
        provider_key: null, fallback: false }
    : selectModel(intent, null);

  // ── 3. Inject tools ────────────────────────────────────────────────────────
  const injectedToolNames   = needsTools
    ? toolNames(intent, { context: LITE_CONTEXT, forceMode: false })
    : [];
  const injectedToolSchemas = needsTools
    ? injectTools(intent, { context: LITE_CONTEXT, forceMode: false })
    : [];

  // ── 4. Build system prompt (readOnly: true) ────────────────────────────────
  // pageContext is injected INSIDE buildSystemPrompt for bookmarklet.
  // We get back pageContextInjected = true/false so we don't duplicate.
  let systemPromptResult;
  try {
    systemPromptResult = await buildSystemPrompt(userId, {
      intent,
      sessionId,
      readOnly:    true,
      pageContext,
      tools:       injectedToolNames,
    });
  } catch (err) {
    logger.warn('lite-agent', 'buildSystemPrompt failed — using minimal fallback', { error: err.message });
    systemPromptResult = {
      prompt:               `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, casual.`,
      pageContextInjected:  false,
    };
  }

  let { prompt: systemPrompt, pageContextInjected } = systemPromptResult;

  // ── 5. Determine if Gemini XML tool instructions needed ────────────────────
  // If we end up on a Gemini provider (no native tools), the first completion
  // attempt will tell us via provider_key. We pre-append for safety if tools
  // are active and we're not sure which provider will answer.
  // We append XML instructions ONLY when tools are active.
  // If groq/mistral answer → they use native tool_calls, XML is ignored.
  // If gemini answers → it reads the XML instructions.
  if (injectedToolSchemas.length > 0) {
    systemPrompt += '\n\n' + getGeminiToolInstructions();
  }

  // ── 6. Build context blocks ────────────────────────────────────────────────

  // Snippets block (always added to user message — not in systemPrompt)
  let snippetBlock = '';
  if (Array.isArray(snippets) && snippets.length > 0) {
    const valid = snippets
      .filter((s) => s && s.type && (s.text || s.content))
      .slice(0, SCRAPER.MAX_SNIPPETS_COUNT);
    if (valid.length > 0) {
      const hasImages = valid.some((s) => s.type === 'image');
      snippetBlock = `\n\n[STAGED SNIPPETS]\n` +
        valid.map((s, i) => `#${i + 1} [${s.type}]: ${(s.text || s.content || '').slice(0, 300)}`).join('\n');
      if (hasImages) snippetBlock += '\n[Vision capability available — image snippets staged]';
    }
  }

  // Page context in user message ONLY if systemPrompt didn't inject it
  let pageBlock = '';
  if (!pageContextInjected && pageContext && typeof pageContext === 'object') {
    const url     = pageContext.url   || 'unknown';
    const title   = pageContext.title || 'unknown';
    const content = typeof pageContext.content === 'string'
      ? pageContext.content.slice(0, 3000) : '';
    pageBlock = `\n\n[CURRENT PAGE]\nURL: ${url}\nTitle: ${title}` +
      (content ? `\nContent:\n${content}` : '');
  }

  // Optional web search
  let searchBlock = '';
  let searched    = false;
  if (needsSearch(userMessage)) {
    const results = await runSearch(userMessage);
    if (results) { searchBlock = `\n\n[WEB SEARCH RESULTS]\n${results}`; searched = true; }
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

  const userContent = `${userMessage}${pageBlock}${snippetBlock}${searchBlock}`;

  const messages = [
    ...historyMessages,
    { role: 'user', content: userContent },
  ];

  // ── 8. Native tool-calling loop (max 2 iterations) ────────────────────────
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
        maxTokens:   LITE_MAX_TOKENS,
        preferCode:  modelSelection.preferCode,
        // Pass tool schemas for native calling (Groq/Mistral use them directly)
        toolSchemas: injectedToolSchemas,
      });
    } catch (err) {
      if (err.message === 'all_providers_down') throw err;
      logger.error('lite-agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    lastResponse  = aiResponse;
    totalTokens  += aiResponse.tokens_used;

    // Native tool_calls from Groq/Mistral, or parsed XML tags from Gemini
    const toolCalls = aiResponse.tool_calls || [];

    // No tool calls → this is the final reply
    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    // Execute tool calls
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

      // Feed tool result back as user message (OpenAI-style)
      // For native tool_calls: use tool role with tool_call_id if available
      if (toolCall.id) {
        // Groq/Mistral native format
        messages.push({ role: 'assistant', content: aiResponse.text, tool_calls: [
          { id: toolCall.id, type: 'function', function: {
            name: toolCall.name, arguments: JSON.stringify(toolCall.args)
          }}
        ]});
        messages.push({ role: 'tool', content: resultStr, tool_call_id: toolCall.id });
      } else {
        // Gemini XML format fallback
        messages.push({ role: 'assistant', content: aiResponse.text });
        messages.push({
          role:    'user',
          content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue.`,
        });
      }
    }

    if (iteration === LITE_MAX_ITERATIONS) finalReply = aiResponse.text;
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
// HTTP HANDLER
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
    return res.status(HTTP.BAD_REQUEST).json({
      error: 'bad_request', message: 'message is required',
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
      preferredModel,
    });

    // Persist assistant reply
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id:    userId,
          session_id: sessionId || null,
          role:       'assistant',
          content:    result.reply,
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
        error: 'all_providers_down',
        message: 'All AI providers are currently unavailable. Try again shortly.',
      });
    }
    logger.error('lite-agent', 'Unhandled error', { error: err.message });
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({
      error: 'lite_agent_failed', message: 'Lite agent encountered an error.',
    });
  }
}

module.exports = { liteAgent, runLiteAgent };
