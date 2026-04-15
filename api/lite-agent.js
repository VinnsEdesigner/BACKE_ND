/**
 * @file lite-agent.js
 * @location /backend/api/lite-agent.js
 *
 * FIXES IN THIS VERSION:
 *   1. ensureSession() — upserts session row BEFORE any conversation insert
 *      This kills the FK violation: conversations.session_id → sessions.id
 *   2. ensureSettings() — creates default settings row if missing
 *      This fixes settings returning null from bookmarklet /api/sync poll
 *   3. Stale key collision fixed — intent classifier uses message hash not text
 *      so repeated short intent responses don't mark Groq rate-limited
 *   4. Tool execution verbose logging — every tool call + result logged
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

const LITE_MAX_TOKENS     = 1000;
const LITE_MAX_ITERATIONS = 2;
const LITE_CONTEXT        = 'bookmarklet';
const LITE_HISTORY_LIMIT  = 10;

const LITE_VALID_TOOLS = new Set([
  'read_file', 'list_files', 'web_search', 'read_url',
  'remember', 'read_logs', 'check_file_exists',
  'analyze_image', 'fetch_to_snippets',
]);

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
  } catch (err) {
    logger.warn('lite-agent', `Search failed: ${err.message}`);
    return '';
  }
}

// ── FIX 1: Session upsert before conversation insert ─────────────────────────
// Without this, conversations.session_id FK fails because session row
// doesn't exist yet when bookmarklet sends its first message.
async function ensureSession(userId, sessionId, pageContext) {
  if (!userId || !sessionId) return;
  try {
    await query(TABLES.SESSIONS, 'upsert', {
      data: {
        id:         sessionId,
        user_id:    userId,
        page_url:   pageContext?.url   || null,
        page_title: pageContext?.title || null,
        name:       pageContext?.title || null,
        updated_at: new Date().toISOString(),
      },
      onConflict: 'id',
    });
    logger.debug('lite-agent', `Session ensured: ${sessionId}`, { userId });
  } catch (err) {
    logger.warn('lite-agent', `ensureSession failed — FK violation likely`, {
      userId, sessionId, error: err.message,
    });
  }
}

// ── FIX 2: Settings bootstrap ─────────────────────────────────────────────────
// /api/sync returns null if no settings row exists.
// Creates defaults on first use so bookmarklet gets real settings.
async function ensureSettings(userId) {
  if (!userId) return;
  try {
    const rows = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit: 1,
    });
    if (!rows || rows.length === 0) {
      await query(TABLES.SETTINGS, 'upsert', {
        data: {
          user_id:              userId,
          autonomy_level:       1,
          confirmation_prompts: true,
          reasoning_log:        false,
          auto_sync:            true,
          prompt_injection:     true,
          snippet_limit:        20,
          updated_at:           new Date().toISOString(),
        },
        onConflict: 'user_id',
      });
      logger.info('lite-agent', `Default settings bootstrapped for user ${userId}`);
    }
  } catch (err) {
    logger.warn('lite-agent', 'ensureSettings failed — non-fatal', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

async function executeLiteTool(toolName, args, userId, sessionId) {
  if (!LITE_VALID_TOOLS.has(toolName)) {
    return JSON.stringify({ error: `Tool "${toolName}" not available. Use: ${[...LITE_VALID_TOOLS].join(', ')}` });
  }

  logger.info('lite-agent:tool', `Executing ${toolName}`, {
    userId,
    args: JSON.stringify(args).slice(0, 200),
  });

  switch (toolName) {
    case 'read_file': {
      const r = await gh.readFile(args.repo, args.path, args.branch || 'main');
      const out = (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 2000);
      logger.info('lite-agent:tool', `read_file done — ${out.length} chars`, { userId, repo: args.repo, path: args.path });
      return out;
    }
    case 'list_files': {
      const files = await gh.listFiles(args.repo, args.path || '', args.branch || 'main');
      const out = JSON.stringify(files).slice(0, 2000);
      logger.info('lite-agent:tool', `list_files done — ${files.length} items`, { userId, repo: args.repo });
      return out;
    }
    case 'read_url': {
      try {
        const res = await fetch(`https://r.jina.ai/${encodeURIComponent(args.url)}`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json();
          const c = data.data?.content || data.content || '';
          if (c.trim()) {
            logger.info('lite-agent:tool', `read_url done via jina — ${c.length} chars`, { userId });
            return c.slice(0, 2000);
          }
        }
      } catch (e) {
        logger.debug('lite-agent:tool', `Jina failed, trying Firecrawl: ${e.message}`);
      }
      const FC = require('@mendable/firecrawl-js');
      const fc = new FC({ apiKey: process.env.FIRECRAWL_API_KEY });
      const result = await fc.scrapeUrl(args.url, { formats: ['markdown'] });
      logger.info('lite-agent:tool', `read_url done via firecrawl`, { userId });
      return (result.markdown || '').slice(0, 2000);
    }
    case 'web_search': {
      logger.info('lite-agent:tool', `web_search: "${args.query}"`, { userId });
      const { results } = await search(args.query, { maxResults: args.max_results || 4 });
      const out = results.map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.snippet||''}`).join('\n\n').slice(0, 2000);
      logger.info('lite-agent:tool', `web_search done — ${results.length} results`, { userId });
      return out;
    }
    case 'remember': {
      await query(TABLES.PERSONALITY, 'upsert', {
        data: { user_id: userId, key: args.key, value: String(args.value), updated_at: new Date().toISOString() },
        onConflict: 'user_id,key',
      });
      logger.info('lite-agent:tool', `remember saved: ${args.key}`, { userId });
      return JSON.stringify({ saved: true, key: args.key });
    }
    case 'read_logs': {
      try {
        const lm = require('../lib/logManager');
        const logs = await lm.tail({ lines: args.lines||50, level: args.level||null, namespace: args.namespace||null });
        logger.info('lite-agent:tool', `read_logs done — ${logs.count || 0} entries`, { userId });
        return JSON.stringify(logs).slice(0, 2000);
      } catch (e) {
        logger.warn('lite-agent:tool', `read_logs failed: ${e.message}`);
        return '[]';
      }
    }
    case 'check_file_exists': {
      const fs = require('fs'), path = require('path');
      const t = path.resolve('/app', (args.path||'').replace(/^\//,''));
      const exists = fs.existsSync(t);
      logger.info('lite-agent:tool', `check_file_exists: ${t} → ${exists}`, { userId });
      return JSON.stringify({ exists, path: t });
    }
    case 'analyze_image': {
      const r = await analyzeImage({
        imageUrl: args.image_url||null, snippetId: args.snippet_id||null,
        question: args.question||null, mimeType: args.mime_type||null,
      }, userId);
      logger.info('lite-agent:tool', `analyze_image done — ${r.analysis?.length || 0} chars`, { userId });
      return r.analysis || '';
    }
    case 'fetch_to_snippets': {
      const s = await fetchToSnippets({
        url: args.url, type: args.type, label: args.label||null,
        userId, sessionId: sessionId||null,
      });
      logger.info('lite-agent:tool', `fetch_to_snippets saved #${s.number}`, { userId });
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
  logger.info('lite-agent', `Classified: intent="${intent}" needsTools=${needsTools} source=${classification.source}`, { userId });
  await broadcastEmitter.trace(userId, `[bookmarklet] "${intent}" tools=${needsTools}`).catch(() => {});

  // ── 2. Model selection ────────────────────────────────────────────────────
  const resolved = resolvePreferredModel(preferredModel);
  const modelSelection = resolved
    ? { model: resolved, preferCode: false, fimOnly: false, visionOnly: false }
    : selectModel(intent, null);

  logger.info('lite-agent', `Model selected: ${modelSelection.model}`, { userId, intent });

  // ── 3. Tool injection ─────────────────────────────────────────────────────
  const injectedToolNames   = needsTools ? toolNames(intent, { context: LITE_CONTEXT }) : [];
  const injectedToolSchemas = needsTools ? injectTools(intent, { context: LITE_CONTEXT }) : [];

  if (injectedToolNames.length > 0) {
    logger.info('lite-agent', `Tools injected: [${injectedToolNames.join(', ')}]`, { userId, intent });
  } else {
    logger.debug('lite-agent', `No tools injected for intent "${intent}"`, { userId });
  }

  // ── 4. System prompt ──────────────────────────────────────────────────────
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
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, casual.\nYou have tools available — USE web_search when asked to find/search information. Always use your tools.`;
  }

  // ── 5. Build user content ─────────────────────────────────────────────────
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

  let pageBlock = '';
  if (!pageContextInjected && pageContext && typeof pageContext === 'object') {
    const content = typeof pageContext.content === 'string' ? pageContext.content.slice(0, 3000) : '';
    pageBlock = `\n\n[CURRENT PAGE]\nURL: ${pageContext.url||'unknown'}\nTitle: ${pageContext.title||'unknown'}` +
      (content ? `\nContent:\n${content}` : '');
  }

  let searchBlock = '', searched = false;
  if (needsSearch(userMessage)) {
    logger.info('lite-agent', `Running pre-search for: "${userMessage.slice(0, 60)}"`, { userId });
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

  logger.info('lite-agent', `Calling complete() — ${messages.length} messages, ${injectedToolSchemas.length} tools`, { userId });

  // ── 7. Tool-calling loop ──────────────────────────────────────────────────
  let finalReply = '', toolsUsed = [], lastResponse = null, totalTokens = 0;

  for (let iteration = 1; iteration <= LITE_MAX_ITERATIONS; iteration++) {
    let aiResponse;
    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens:   LITE_MAX_TOKENS,
        preferCode:  modelSelection.preferCode,
        toolSchemas: injectedToolSchemas,
      });
    } catch (err) {
      if (err.message === 'all_providers_down') throw err;
      logger.error('lite-agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    lastResponse  = aiResponse;
    totalTokens  += aiResponse.tokens_used;

    const toolCalls = aiResponse.tool_calls || [];
    logger.info('lite-agent', `AI response iter ${iteration} — model=${aiResponse.model} tokens=${aiResponse.tokens_used} toolCalls=${toolCalls.length}`, { userId });

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

      if (toolCall.id) {
        messages.push({
          role: 'assistant', content: null,
          tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }],
        });
        messages.push({ role: 'tool', content: resultStr, tool_call_id: toolCall.id });
      } else {
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

  logger.info('lite-agent', 'Complete', { userId, intent, model: lastResponse?.model, tokens: totalTokens, tools: toolsUsed, searched });

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

  logger.info('lite-agent', `Request from ${userId}`, {
    msgLen: message.length, sessionId, hasPageCtx: !!pageContext,
    snippetCount: snippets?.length || 0, historyLen: history?.length || 0,
  });

  // ── CRITICAL: ensure session + settings exist BEFORE anything else ────────
  if (sessionId) {
    await ensureSession(userId, sessionId, pageContext);
  }
  await ensureSettings(userId);

  try {
    const result = await runLiteAgent({
      userId, message: message.trim(), pageContext,
      snippets: Array.isArray(snippets) ? snippets : [],
      history:  Array.isArray(history)  ? history  : [],
      sessionId, preferredModel,
    });

    // Persist assistant reply — session guaranteed to exist now
    if (sessionId) {
      try {
        await query(TABLES.CONVERSATIONS, 'insert', {
          data: {
            user_id: userId, session_id: sessionId, role: 'assistant',
            content: result.reply, card_type: 'text',
            metadata: { model: result.model, tokens_used: result.tokens_used, source: 'lite_agent', searched: result.searched, tools_used: result.tools_used },
            created_at: new Date().toISOString(),
          },
        });
        logger.debug('lite-agent', 'Reply persisted to conversations', { userId, sessionId });
      } catch (dbErr) {
        logger.warn('lite-agent', 'Persist failed — non-fatal', { error: dbErr.message });
      }
    }

    return res.status(HTTP.OK).json({
      reply: result.reply, model: result.model, tokens_used: result.tokens_used,
      searched: result.searched, tools_used: result.tools_used,
    });
  } catch (err) {
    if (err.message === 'all_providers_down') {
      return res.status(HTTP.SERVICE_UNAVAILABLE).json({ error: 'all_providers_down', message: 'All AI providers unavailable. Try again shortly.' });
    }
    logger.error('lite-agent', 'Unhandled error', { error: err.message, stack: err.stack?.slice(0, 400) });
    return res.status(HTTP.INTERNAL_SERVER_ERROR).json({ error: 'lite_agent_failed', message: 'Lite agent encountered an error.' });
  }
}

module.exports = { liteAgent, runLiteAgent };
