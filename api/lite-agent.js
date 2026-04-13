/**
 * @file lite-agent.js
 * @location /backend/api/lite-agent.js
 *
 * TOOL CALLING FIX:
 *   → Never pre-appends Gemini XML instructions (ai.js handles that internally)
 *   → complete() receives toolSchemas, returns tool_calls[] structured
 *   → When feeding Groq/Mistral tool results back: assistant content = null (required)
 *   → When feeding Gemini results back: user message format
 *   → pageContext injected once in buildSystemPrompt, NOT duplicated in user message
 */

'use strict';

const { complete }        = require('../lib/ai');
const { search }          = require('../lib/searchRouter');
const { query }           = require('../lib/supabase');
const logger              = require('../lib/logger');
const { classify }        = require('../lib/agent/intentClassifier');
const { inject: injectTools, names: toolNames } = require('../lib/agent/toolInjector');
const { selectModel }     = require('../lib/agent/modelRouter');
const broadcastEmitter    = require('../lib/agent/broadcastEmitter');
const { analyzeImage }    = require('../lib/agent/visionHandler');
const { fetchToSnippets } = require('../lib/agent/fetchToSnippets');
const { buildSystemPrompt } = require('../lib/personality/systemPrompt');
const gh                  = require('../lib/github');
const { HTTP, TABLES, AGENT, SCRAPER, MODELS } = require('../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LITE_MAX_TOKENS     = 1000;
const LITE_MAX_ITERATIONS = 2;
const LITE_CONTEXT        = 'bookmarklet';
const LITE_HISTORY_LIMIT  = 10;

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

function needsSearch(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  for (const kw of SEARCH_KEYWORDS) if (lower.includes(kw)) return true;
  return false;
}

async function runSearch(q) {
  try {
    const { results } = await search(q, { maxResults: 4 });
    if (!results?.length) return '';
    return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet || ''}`).join('\n\n');
  } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR (inline, bookmarklet read-only context)
// ─────────────────────────────────────────────────────────────────────────────

async function executeLiteTool(toolName, args, userId, sessionId) {
  if (!LITE_VALID_TOOLS.has(toolName)) {
    return JSON.stringify({ error: `Tool "${toolName}" not available. Use: ${[...LITE_VALID_TOOLS].join(', ')}` });
  }

  switch (toolName) {
    case 'read_file': {
      const r = await gh.readFile(args.repo, args.path, args.branch || 'main');
      return (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 2000);
    }
    case 'list_files': {
      return JSON.stringify(await gh.listFiles(args.repo, args.path || '', args.branch || 'main')).slice(0, 2000);
    }
    case 'read_url': {
      try {
        const res = await fetch(`https://r.jina.ai/${encodeURIComponent(args.url)}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json();
          const c = data.data?.content || data.content || '';
          if (c.trim()) return c.slice(0, 2000);
        }
      } catch {}
      const FC = require('@mendable/firecrawl-js');
      const fc = new FC({ apiKey: process.env.FIRECRAWL_API_KEY });
      return ((await fc.scrapeUrl(args.url, { formats: ['markdown'] })).markdown || '').slice(0, 2000);
    }
    case 'web_search': {
      const { results } = await search(args.query, { maxResults: args.max_results || 4 });
      return results.map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.snippet||''}`).join('\n\n').slice(0, 2000);
    }
    case 'remember': {
      await query(TABLES.PERSONALITY, 'upsert', {
        data: { user_id: userId, key: args.key, value: String(args.value), updated_at: new Date().toISOString() },
        onConflict: 'user_id,key',
      });
      return JSON.stringify({ saved: true, key: args.key });
    }
    case 'read_logs': {
      try {
        const lm = require('../lib/logManager');
        return JSON.stringify(await lm.tail({ lines: args.lines||50, level: args.level||null, namespace: args.namespace||null })).slice(0, 2000);
      } catch { return '[]'; }
    }
    case 'check_file_exists': {
      const fs = require('fs'), path = require('path');
      const t  = path.resolve('/app', (args.path||'').replace(/^\//,''));
      return JSON.stringify({ exists: fs.existsSync(t), path: t });
    }
    case 'analyze_image': {
      const r = await analyzeImage({ imageUrl: args.image_url||null, snippetId: args.snippet_id||null, question: args.question||null, mimeType: args.mime_type||null }, userId);
      return r.analysis || '';
    }
    case 'fetch_to_snippets': {
      const s = await fetchToSnippets({ url: args.url, type: args.type, label: args.label||null, userId, sessionId: sessionId||null });
      return JSON.stringify({ saved: true, number: s.number, type: s.type });
    }
    default:
      return JSON.stringify({ error: `${toolName} not available in bookmarklet context` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODEL ALIAS RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_ALIASES = {
  groq: MODELS.GROQ_BRAIN, llama: MODELS.GROQ_BRAIN,
  devstral: MODELS.MISTRAL_CODE, mistral: MODELS.MISTRAL_LARGE,
  'mistral-large': MODELS.MISTRAL_LARGE,
  gemini: MODELS.GEMINI_FLASH, 'gemini-lite': MODELS.GEMINI_FLASH_LITE,
  'gemma-26': MODELS.GEMMA_4_26B, 'gemma-31': MODELS.GEMMA_4_31B,
};

function resolvePreferredModel(pm) {
  if (!pm) return null;
  const lower = pm.toLowerCase().trim();
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  if (Object.values(MODELS).includes(pm)) return pm;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function runLiteAgent({ userId, message, pageContext = null, snippets = [], history = [], sessionId = null, preferredModel = null }) {
  if (!message?.trim()) throw new Error('runLiteAgent: message required');
  if (!userId)          throw new Error('runLiteAgent: userId required');

  const userMessage = message.trim();

  // ── 1. Classify ───────────────────────────────────────────────────────────
  let classification;
  try {
    classification = await classify(userMessage, { source: LITE_CONTEXT });
  } catch {
    classification = { intent: 'chat', confidence: 0.5, source: 'fallback', preferCode: false, needsTools: false };
  }

  const { intent, needsTools, preferCode } = classification;
  await broadcastEmitter.trace(userId, `[bookmarklet] "${intent}"`).catch(() => {});

  // ── 2. Model selection ────────────────────────────────────────────────────
  const resolved = resolvePreferredModel(preferredModel);
  const modelSelection = resolved
    ? { model: resolved, preferCode: false, fimOnly: false, visionOnly: false }
    : selectModel(intent, null);

  // ── 3. Tool injection ─────────────────────────────────────────────────────
  const injectedToolNames   = needsTools ? toolNames(intent, { context: LITE_CONTEXT }) : [];
  const injectedToolSchemas = needsTools ? injectTools(intent, { context: LITE_CONTEXT }) : [];

  // ── 4. System prompt ──────────────────────────────────────────────────────
  // buildSystemPrompt injects pageContext ONCE for bookmarklet context
  // Returns pageContextInjected=true so we don't duplicate in user message
  let systemPrompt = '';
  let pageContextInjected = false;

  try {
    const result = await buildSystemPrompt(userId, {
      intent, sessionId, readOnly: true, pageContext, tools: injectedToolNames,
    });
    systemPrompt        = result.prompt;
    pageContextInjected = result.pageContextInjected;
  } catch (err) {
    logger.warn('lite-agent', 'buildSystemPrompt failed — fallback', { error: err.message });
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, casual.`;
  }

  // ── 5. Build user content ─────────────────────────────────────────────────
  // Snippets always appended to user message
  let snippetBlock = '';
  if (Array.isArray(snippets) && snippets.length > 0) {
    const valid = snippets.filter((s) => s && s.type && (s.text || s.content)).slice(0, SCRAPER.MAX_SNIPPETS_COUNT);
    if (valid.length > 0) {
      const hasImages = valid.some((s) => s.type === 'image');
      snippetBlock = '\n\n[STAGED SNIPPETS]\n' +
        valid.map((s, i) => `#${i+1} [${s.type}]: ${(s.text||s.content||'').slice(0, 300)}`).join('\n');
      if (hasImages) snippetBlock += '\n[Vision capability active — image snippets staged]';
    }
  }

  // Page context in user message ONLY if not already in system prompt
  let pageBlock = '';
  if (!pageContextInjected && pageContext && typeof pageContext === 'object') {
    const content = typeof pageContext.content === 'string' ? pageContext.content.slice(0, 3000) : '';
    pageBlock = `\n\n[CURRENT PAGE]\nURL: ${pageContext.url||'unknown'}\nTitle: ${pageContext.title||'unknown'}` +
      (content ? `\nContent:\n${content}` : '');
  }

  // Optional search
  let searchBlock = '', searched = false;
  if (needsSearch(userMessage)) {
    const r = await runSearch(userMessage);
    if (r) { searchBlock = `\n\n[WEB SEARCH RESULTS]\n${r}`; searched = true; }
  }

  // ── 6. Messages ───────────────────────────────────────────────────────────
  const historyMessages = Array.isArray(history)
    ? history
        .filter((m) => m && m.role && m.content)
        .slice(-LITE_HISTORY_LIMIT)
        .map((m) => ({ role: ['user','assistant','system'].includes(m.role) ? m.role : 'user', content: String(m.content).slice(0, 1000) }))
    : [];

  const userContent = `${userMessage}${pageBlock}${snippetBlock}${searchBlock}`;
  const messages    = [...historyMessages, { role: 'user', content: userContent }];

  // ── 7. NATIVE tool-calling loop ───────────────────────────────────────────
  let finalReply = '', toolsUsed = [], lastResponse = null, totalTokens = 0;

  for (let iteration = 1; iteration <= LITE_MAX_ITERATIONS; iteration++) {
    let aiResponse;
    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens:   LITE_MAX_TOKENS,
        preferCode:  modelSelection.preferCode,
        toolSchemas: injectedToolSchemas,  // ← passed to Groq/Mistral natively, Gemini gets XML internally
      });
    } catch (err) {
      if (err.message === 'all_providers_down') throw err;
      logger.error('lite-agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    lastResponse  = aiResponse;
    totalTokens  += aiResponse.tokens_used;

    // tool_calls comes from native (Groq/Mistral) or XML parsing (Gemini)
    // Either way it's always a structured array — no regex here
    const toolCalls = aiResponse.tool_calls || [];

    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId, `[bookmarklet] 🔧 ${toolCall.name}`).catch(() => {});

      let resultStr = '';
      try {
        resultStr = await executeLiteTool(toolCall.name, toolCall.args, userId, sessionId);
        toolsUsed.push(toolCall.name);
        await broadcastEmitter.trace(userId, `[bookmarklet] ✅ ${toolCall.name} done`).catch(() => {});
      } catch (err) {
        logger.warn('lite-agent', `Tool "${toolCall.name}" failed`, { error: err.message });
        resultStr = JSON.stringify({ error: err.message });
      }

      // Feed result back using correct format per provider
      if (toolCall.id) {
        // Groq/Mistral native tool_calls:
        // assistant content MUST be null when tool_calls is present (Mistral API requirement)
        messages.push({
          role: 'assistant', content: null,
          tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }],
        });
        messages.push({ role: 'tool', content: resultStr, tool_call_id: toolCall.id });
      } else {
        // Gemini XML: simple user message with result
        messages.push({ role: 'assistant', content: aiResponse.text || '' });
        messages.push({ role: 'user', content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue.` });
      }
    }

    if (iteration === LITE_MAX_ITERATIONS && !finalReply) {
      finalReply = aiResponse.text || '';
    }
  }

  if (!finalReply && lastResponse) finalReply = lastResponse.text;
  if (!finalReply) finalReply = 'Done.';

  logger.info('lite-agent', 'Completed', { userId, intent, model: lastResponse?.model, tokens: totalTokens, tools: toolsUsed });

  return { reply: finalReply, model: lastResponse?.model || 'unknown', tokens_used: totalTokens, searched, tools_used: toolsUsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function liteAgent(req, res) {
  const { userId } = req.user;
  const { message, pageContext = null, snippets = [], history = [], sessionId = null, preferredModel = null } = req.body;

  if (!message?.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({ error: 'bad_request', message: 'message is required' });
  }

  try {
    const result = await runLiteAgent({
      userId, message: message.trim(), pageContext,
      snippets: Array.isArray(snippets) ? snippets : [],
      history:  Array.isArray(history)  ? history  : [],
      sessionId, preferredModel,
    });

    // Persist assistant reply
    try {
      await query(TABLES.CONVERSATIONS, 'insert', {
        data: {
          user_id: userId, session_id: sessionId || null, role: 'assistant',
          content: result.reply, card_type: 'text',
          metadata: { model: result.model, tokens_used: result.tokens_used, source: 'lite_agent', searched: result.searched, tools_used: result.tools_used },
          created_at: new Date().toISOString(),
        },
      });
    } catch (dbErr) {
      logger.warn('lite-agent', 'Persist failed — non-fatal', { error: dbErr.message });
    }

    return res.status(HTTP.OK).json({
      reply: result.reply, model: result.model, tokens_used: result.tokens_used,
      searched: result.searched, tools_used: result.tools_used,
    });
  } catch (err) {
    if (err.message === 'all_providers_down') {
      return res.status(HTTP.SERVICE_UNAVAILABLE).json({ error: 'all_providers_down', message: 'All AI providers unavailable. Try again shortly.' });
    }
    logger.error('lite-agent', 'Unhandled error', { error: err.message });
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({ error: 'lite_agent_failed', message: 'Lite agent encountered an error.' });
  }
}

module.exports = { liteAgent, runLiteAgent };
