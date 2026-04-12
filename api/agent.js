/**
 * @file agent.js
 * @location /backend/api/agent.js
 *
 * @purpose
 * Full agent HTTP handler. Manages the complete request lifecycle:
 * intent classification → model selection → system prompt assembly →
 * tool injection → AI completion loop → tool execution → persistence.
 *
 * Unified agent brain — same core logic serves both dashboard
 * (context: 'dashboard') and bookmarklet (context: 'bookmarklet')
 * via the context flag passed to toolInjector and buildSystemPrompt.
 *
 * Tool-calling loop:
 *   Max AGENT.MAX_RETRIES iterations per request.
 *   Each iteration: AI responds → parse tool call → execute →
 *   feed result back → repeat until no tool call or max iterations.
 *
 * @exports
 *   agent(req, res)        → POST /api/agent
 *   switchModel(req, res)  → PATCH /api/active-model
 *   agentStatus(req, res)  → GET /api/agent/status
 *
 * @imports
 *   ../lib/ai                        → complete, stream, currentModel, modelStatus
 *   ../lib/searchRouter              → search
 *   ../lib/supabase                  → query
 *   ../lib/logger                    → structured logger
 *   ../lib/tokenizer                 → trimToFit
 *   ../lib/agent/taskState           → create/advance/pause/complete/fail
 *   ../lib/agent/intentClassifier    → classify (async)
 *   ../lib/agent/toolInjector        → inject, names
 *   ../lib/agent/modelRouter         → selectModel
 *   ../lib/agent/executor            → run, register
 *   ../lib/agent/confirmationGate    → shouldConfirm, buildCard, riskLevel
 *   ../lib/agent/broadcastEmitter    → trace, finding, warning, complete
 *   ../lib/agent/memorySummarizer    → loadSummaries
 *   ../lib/agent/sessionBridge       → getRelevant
 *   ../lib/agent/diffExplainer       → explain
 *   ../lib/agent/visionHandler       → analyzeImage, analyzeBase64
 *   ../lib/agent/fetchToSnippets     → fetchToSnippets
 *   ../lib/agent/shadowBranch        → create, rollback
 *   ../lib/personality/systemPrompt  → buildSystemPrompt
 *   ../lib/github                    → readFile, writeFile, etc.
 *   ../utils/constants               → HTTP, TABLES, SSE, AGENT, MODELS
 *
 * @tables
 *   conversations  → INSERT (user + assistant messages)
 *   active_model   → SELECT + UPSERT
 *   reasoning_log  → INSERT (if enabled)
 *   personality    → UPSERT (via remember tool)
 *   snippets       → INSERT (via fetch_to_snippets tool)
 *   tasks          → CREATE/ADVANCE/PAUSE/COMPLETE
 *
 * @sse-events
 *   trace    → thinking stream updates
 *   finding  → tool results, file writes
 *   warning  → provider failures, tool errors
 *   complete → agent task done
 *
 * @env-vars
 *   FIRECRAWL_API_KEY (via read_url tool)
 *   GITHUB_PAT        (via github lib)
 *   GROQ_API_KEY      (via ai lib)
 *   MISTRAL_API_KEY   (via ai lib)
 *   GEMINI_API_KEY    (via ai lib)
 *
 * @dependency-level 8
 */

'use strict';

const { complete, stream, currentModel, modelStatus } = require('../lib/ai');
const { search }             = require('../lib/searchRouter');
const { query }              = require('../lib/supabase');
const logger                 = require('../lib/logger');
const tokenizer              = require('../lib/tokenizer');
const taskState              = require('../lib/agent/taskState');
const { classify }           = require('../lib/agent/intentClassifier');
const { inject: injectTools, names: toolNames } = require('../lib/agent/toolInjector');
const { selectModel }        = require('../lib/agent/modelRouter');
const { run: runExecutor, register } = require('../lib/agent/executor');
const { shouldConfirm, buildCard, riskLevel } = require('../lib/agent/confirmationGate');
const broadcastEmitter       = require('../lib/agent/broadcastEmitter');
const { loadSummaries }      = require('../lib/agent/memorySummarizer');
const { getRelevant }        = require('../lib/agent/sessionBridge');
const { explain }            = require('../lib/agent/diffExplainer');
const { analyzeImage, analyzeBase64 } = require('../lib/agent/visionHandler');
const { fetchToSnippets }    = require('../lib/agent/fetchToSnippets');
const shadowBranch           = require('../lib/agent/shadowBranch');
const { buildSystemPrompt }  = require('../lib/personality/systemPrompt');
const gh                     = require('../lib/github');
const { HTTP, TABLES, SSE, AGENT, MODELS } = require('../utils/constants');

// ── REGISTER TOOL HANDLERS ────────────────────────────────────────────────────
// All tool handlers wired here — executor.js dispatches by name.
// Shadow backup BEFORE any destructive GitHub operation (LAW 16).

register('read_file', (args) =>
  gh.readFile(args.repo, args.path, args.branch || 'main')
);

register('write_file', async (args, ctx) => {
  // BUG12 FIX: shadowBranch.create now emits SSE warning internally on failure
  // so we just fire-and-forget here — the user will see the warning in Terminal
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'write').catch(() => {});
  return gh.writeFile(
    args.repo,
    args.path,
    args.content,
    args.message,
    args.branch || 'main'
  );
});

register('delete_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'delete').catch(() => {});
  return gh.deleteFile(args.repo, args.path, args.message, args.branch || 'main');
});

register('list_files', (args) =>
  gh.listFiles(args.repo, args.path || '', args.branch || 'main')
);

register('create_branch', (args) =>
  gh.createBranch(args.repo, args.branch_name, args.from_branch || 'main')
);

register('create_pr', (args) =>
  gh.createPR(args.repo, args.title, args.head, args.base || 'main', args.body || '')
);

register('merge_pr', (args) =>
  gh.mergePR(args.repo, args.pull_number, args.merge_message || '')
);

register('web_search', async (args) => {
  const { results } = await search(args.query, {
    maxResults: args.max_results || 5,
  });
  return results;
});

register('read_url', async (args) => {
  // Jina first (free, no key)
  try {
    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(args.url)}`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const content = data.data?.content || data.content || '';
      if (content.trim()) return content;
    }
  } catch {
    // fall through to Firecrawl
  }

  // Firecrawl fallback
  const FirecrawlApp = require('@mendable/firecrawl-js');
  const firecrawl    = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const result       = await firecrawl.scrapeUrl(args.url, { formats: ['markdown'] });
  return result.markdown || '';
});

register('remember', async (args, ctx) => {
  await query(TABLES.PERSONALITY, 'upsert', {
    data: {
      user_id:    ctx.userId,
      key:        args.key,
      value:      String(args.value),
      updated_at: new Date().toISOString(),
    },
    onConflict: 'user_id,key',
  });
  return { saved: true, key: args.key };
});

register('run_command', async (args) => {
  const { validateStructured, buildExecOptions } = require('../utils/commandSafety');
  validateStructured(args.executable, args.args || []);
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const opts = buildExecOptions(args.cwd || '/app');
  const { stdout, stderr } = await execFileAsync(
    args.executable,
    args.args || [],
    opts
  );
  return { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) };
});

register('read_logs', async (args) => {
  const logManager = require('../lib/logManager');
  return logManager.tail({
    lines:     args.lines || 100,
    level:     args.level || null,
    namespace: args.namespace || null,
  });
});

register('check_file_exists', async (args) => {
  const fs   = require('fs');
  const path = require('path');
  const target = path.resolve('/app', args.path.replace(/^\//, ''));
  return { exists: fs.existsSync(target), path: target };
});

// Vision tools (LAW 23 — execute via executor.js)
register('analyze_image', async (args, ctx) => {
  return analyzeImage(
    {
      imageUrl:  args.image_url  || null,
      snippetId: args.snippet_id || null,
      question:  args.question   || null,
      mimeType:  args.mime_type  || null,
    },
    ctx.userId
  );
});

register('fetch_to_snippets', async (args, ctx) => {
  return fetchToSnippets({
    url:       args.url,
    type:      args.type,
    label:     args.label || null,
    userId:    ctx.userId,
    sessionId: ctx.sessionId || null,
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Get active model for user — falls back to currentModel() from ai.js.
 *
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function getActiveModel(userId) {
  try {
    const rows = await query(TABLES.ACTIVE_MODEL, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });
    return rows?.[0]?.model || currentModel();
  } catch {
    return currentModel();
  }
}

/**
 * Persist active model selection to Supabase.
 * Non-fatal — never blocks agent on DB write failure.
 *
 * @param {string} userId
 * @param {string} model
 */
async function setActiveModel(userId, model) {
  try {
    await query(TABLES.ACTIVE_MODEL, 'upsert', {
      data: {
        user_id:    userId,
        model,
        updated_at: new Date().toISOString(),
      },
      onConflict: 'user_id',
    });
  } catch (err) {
    logger.warn('agent:setActiveModel', 'Failed to persist active model', {
      error: err.message,
    });
  }
}

/**
 * Persist a conversation message to Supabase.
 * Non-fatal — never blocks agent on DB write failure.
 *
 * @param {string} userId
 * @param {string|null} sessionId
 * @param {'user'|'assistant'|'system'} role
 * @param {string|Object} content
 * @param {string} [cardType='text']
 * @param {Object} [metadata={}]
 */
async function persistMessage(userId, sessionId, role, content, cardType = 'text', metadata = {}) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id:    userId,
        session_id: sessionId || null,
        role,
        content:    typeof content === 'string' ? content : JSON.stringify(content),
        card_type:  cardType,
        metadata:   metadata || {},
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('agent:persistMessage', 'Failed to persist message', {
      error: err.message,
      role,
    });
  }
}

/**
 * Persist reasoning trace to reasoning_log table.
 * Only called if reasoningLog flag is enabled in request.
 * Non-fatal.
 *
 * @param {string}      userId
 * @param {string|null} taskId
 * @param {Array}       trace
 * @param {string}      model
 */
async function persistReasoning(userId, taskId, trace, model) {
  try {
    await query(TABLES.REASONING_LOG, 'insert', {
      data: {
        user_id:    userId,
        task_id:    taskId || null,
        trace:      JSON.stringify(trace),
        model,
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('agent:persistReasoning', 'Failed to persist reasoning log', {
      error: err.message,
    });
  }
}

/**
 * Parse tool calls from AI response text.
 * Supports: single JSON object, array of objects, steps array.
 * Returns empty array if response is plain text (final reply).
 *
 * @param {string} responseText
 * @returns {Array<{ name: string, args: Object }>}
 */
function parseToolCalls(responseText) {
  if (!responseText || typeof responseText !== 'string') return [];

  // Strip markdown code fences
  const clean = responseText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Must start with { or [ to be JSON
  if (!clean.startsWith('{') && !clean.startsWith('[')) return [];

  try {
    const parsed = JSON.parse(clean);

    // Single tool call: { tool, args } or { name, args }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if ((parsed.tool || parsed.name) && parsed.args !== undefined) {
        return [{
          name: parsed.tool || parsed.name,
          args: parsed.args || {},
        }];
      }
      // Steps array format from reasoner
      if (Array.isArray(parsed.steps)) {
        return parsed.steps
          .filter((s) => s && (s.tool || s.name))
          .map((s) => ({ name: s.tool || s.name, args: s.args || {} }));
      }
    }

    // Array of tool calls
    if (Array.isArray(parsed)) {
      return parsed
        .filter((t) => t && (t.tool || t.name))
        .map((t) => ({
          name: t.tool || t.name,
          args: t.args || t.arguments || {},
        }));
    }
  } catch {
    // Not JSON — plain text final reply
  }

  return [];
}

// ── MAIN HANDLER — POST /api/agent ────────────────────────────────────────────

async function agent(req, res) {
  const { userId } = req.user;
  const {
    message,
    sessionId    = null,
    repo         = null,
    branch       = 'main',
    forceMode    = false,
    reasoningLog = false,
    history      = [],     // conversation history from client (mini-agent / dashboard)
    context: reqContext = 'dashboard', // execution context
  } = req.body;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'message is required',
    });
  }

  const userMessage       = message.trim();
  const executionContext  = ['dashboard', 'bookmarklet', 'api'].includes(reqContext)
    ? reqContext
    : 'dashboard';

  logger.info('agent', 'Request received', {
    userId,
    sessionId,
    forceMode,
    context: executionContext,
    msgLen:  userMessage.length,
  });

  // ── 1. Persist user message ────────────────────────────────────────────────
  await persistMessage(userId, sessionId, 'user', userMessage);

  // ── 2. Classify intent (async — was missing await in original) ────────────
  let classification;
  try {
    classification = await classify(userMessage, {
      source:         executionContext,
      previousIntent: null,  // could load from session in future
    });
  } catch (err) {
    logger.warn('agent', 'Intent classification failed — defaulting to chat', {
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

  const { intent, suggestedTone, needsTools, isMultiStep, preferCode } = classification;

  await broadcastEmitter.trace(userId, `classifier → "${intent}" (${classification.source})`).catch(() => {});

  logger.info('agent', `Intent: ${intent}`, {
    userId,
    confidence: classification.confidence,
    needsTools,
    isMultiStep,
  });

  // ── 3. Select model via modelRouter ───────────────────────────────────────
  const currentStatuses = modelStatus();
  const modelSelection  = selectModel(intent, currentStatuses);

  await broadcastEmitter.trace(userId,
    `model → ${modelSelection.model}${modelSelection.fallback ? ' (fallback)' : ''}`
  ).catch(() => {});

  // ── 4. Inject tools ────────────────────────────────────────────────────────
  const injectedTools = (needsTools || forceMode)
    ? injectTools(intent, { context: executionContext, forceMode })
    : [];

  const injectedToolNames = (needsTools || forceMode)
    ? toolNames(intent, { context: executionContext, forceMode })
    : [];

  if (injectedToolNames.length > 0) {
    await broadcastEmitter.trace(userId,
      `tools → ${injectedToolNames.join(', ')}`
    ).catch(() => {});
  }

  // ── 5. Build system prompt via systemPrompt.js (LAW 15) ───────────────────
  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(userId, {
      intent,
      repo,
      branch,
      sessionId,
      readOnly:    executionContext === 'bookmarklet',
      tools:       injectedToolNames,
    });
  } catch (err) {
    logger.warn('agent', 'buildSystemPrompt failed — using minimal fallback', {
      error: err.message,
    });
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, and direct.`;
  }

  // ── 6. Append tool calling instructions if tools injected ─────────────────
  if (injectedTools.length > 0) {
    systemPrompt += '\n\n[TOOL CALLING]\n' +
      'When you need to use a tool, respond with ONLY valid JSON — no other text:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'For multiple tools: one tool call per response, wait for result, then continue.\n' +
      'When all tools are done: respond with your final plain text answer.';
  }

  // ── 7. Load relevant scraper snippets ─────────────────────────────────────
  let relevantSnippets = [];
  try {
    relevantSnippets = await getRelevant(userId, userMessage, 3);
  } catch (err) {
    logger.warn('agent', 'Failed to load relevant snippets', { error: err.message });
  }

  if (relevantSnippets.length > 0) {
    const snippetBlock = relevantSnippets
      .map((s) => `#${s.number} [${s.type}]: ${(s.content || '').slice(0, 500)}`)
      .join('\n');
    systemPrompt += `\n\n[RELEVANT SNIPPETS FROM SCRAPER]\n${snippetBlock}`;
  }

  // ── 8. Build messages array ────────────────────────────────────────────────
  // Incorporate client-provided history (from dashboard or mini-agent)
  const historyMessages = Array.isArray(history)
    ? history
        .filter((m) => m && m.role && m.content)
        .slice(-10)  // max 10 turns of history
        .map((m) => ({
          role:    ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
          content: String(m.content).slice(0, 2000),
        }))
    : [];

  let messages = [
    ...historyMessages,
    { role: 'user', content: userMessage },
  ];

  // Trim to fit token budget — reserve 1500 tokens for response + tools
  messages = tokenizer.trimToFit(messages, AGENT.MAX_TOKENS - 1500);

  if (messages.length < historyMessages.length + 1) {
    await broadcastEmitter.trace(userId, 'context trimmed to fit token budget').catch(() => {});
  }

  // ── 9. Create task record for multi-step ops ───────────────────────────────
  let task = null;
  if (isMultiStep) {
    try {
      task = await taskState.create(userId, intent, []);
      await broadcastEmitter.trace(userId, `task created: ${task.id}`).catch(() => {});
    } catch (err) {
      logger.warn('agent', 'Failed to create task record', { error: err.message });
    }
  }

  // ── 10. Persist active model ───────────────────────────────────────────────
  await setActiveModel(userId, modelSelection.model);

  // ── 11. Handle visionOnly intent ──────────────────────────────────────────
  // Vision requests are dispatched to visionHandler directly.
  // The AI loop still runs — visionHandler is called via the
  // analyze_image tool which the AI will invoke.
  // visionOnly flag is used for SSE trace context only.
  if (modelSelection.visionOnly) {
    await broadcastEmitter.trace(userId, `vision intent → Gemini/Gemma chain`).catch(() => {});
  }

   // ── 12. TOOL-CALLING LOOP ──────────────────────────────────────────────────


  // ── 12. TOOL-CALLING LOOP ─────────────────────────────────────────────────────
// This replaces the entire loop section in api/agent.js
// Fixes: BUG1 (aiResponse scope), BUG2 (task advance per tool), BUG4 (execContext)

  const MAX_ITERATIONS = AGENT.MAX_RETRIES;
  let iteration      = 0;
  let finalReply     = '';
  let toolResults    = [];
  let aiResponse     = null;   // BUG1 FIX: declare outside loop
  const reasoningTrace = [];

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    await broadcastEmitter.trace(userId, `thinking... (iteration ${iteration}/${MAX_ITERATIONS})`).catch(() => {});

    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens:  AGENT.MAX_TOKENS,
        preferCode: modelSelection.preferCode,
      });
    } catch (err) {
      if (err.message === 'all_providers_down') {
        await broadcastEmitter.warning(userId, {
          event:   'all_providers_down',
          message: 'All AI providers are currently unavailable',
        }).catch(() => {});
        return res.status(HTTP.SERVICE_UNAVAILABLE).json({
          error:   'all_providers_down',
          message: 'All AI providers are currently unavailable. Try again shortly.',
        });
      }
      logger.error('agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    await setActiveModel(userId, aiResponse.model);
    reasoningTrace.push({
      iteration,
      model:  aiResponse.model,
      tokens: aiResponse.tokens_used,
      output: aiResponse.text.slice(0, 200),
    });

    const toolCalls = parseToolCalls(aiResponse.text);

    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId, `calling tool: ${toolCall.name}`).catch(() => {});

      let needsConfirm = false;
      try {
        needsConfirm = await shouldConfirm(userId, toolCall.name);
      } catch (err) {
        logger.warn('agent', 'Confirmation gate check failed', { error: err.message });
      }

      if (needsConfirm) {
        const card = buildCard({
          action:      toolCall.name,
          description: `Run ${toolCall.name} on ${toolCall.args?.path || toolCall.args?.repo || 'target'}`,
          details:     toolCall.args,
          risk:        riskLevel(toolCall.name),
        });
        if (task) await taskState.pause(task.id, `awaiting confirmation: ${toolCall.name}`).catch(() => {});
        await persistMessage(userId, sessionId, 'assistant', JSON.stringify(card), 'confirm_card', {
          tool:   toolCall.name,
          taskId: task?.id || null,
        });
        return res.status(HTTP.OK).json({
          reply:        null,
          confirmation: card,
          taskId:       task?.id || null,
          model:        aiResponse.model,
          tokens_used:  aiResponse.tokens_used,
          intent,
          sessionId,
        });
      }

      const execPlan = {
        steps: [{
          tool:        toolCall.name,
          description: `Execute ${toolCall.name}`,
          args:        toolCall.args,
        }],
      };

      // BUG4 FIX: pass execContext so sessionId reaches tool handlers
      const execContext = { userId, sessionId };
      const execResult  = await runExecutor(userId, execPlan, execContext);

      if (!execResult.success) {
        const errMsg = execResult.failedStep?.error || 'Tool execution failed';
        await broadcastEmitter.warning(userId, {
          event:   'tool_failed',
          tool:    toolCall.name,
          message: errMsg,
        }).catch(() => {});
        messages.push({ role: 'assistant', content: aiResponse.text });
        messages.push({
          role:    'user',
          content: `Tool ${toolCall.name} failed: ${errMsg}. Please handle this error and continue.`,
        });
      } else {
        const result = execResult.results?.[0]?.result;
        toolResults.push({ tool: toolCall.name, result });

        if (toolCall.name === 'write_file' && result) {
          try {
            const diffExplanation = await explain(
              `+++ ${toolCall.args?.path}\n${(toolCall.args?.content || '').slice(0, 1000)}`,
              { filePath: toolCall.args?.path, repo: toolCall.args?.repo, intent }
            );
            await broadcastEmitter.finding(userId, {
              event:       'file_written',
              path:        toolCall.args?.path,
              repo:        toolCall.args?.repo,
              explanation: diffExplanation,
            }).catch(() => {});
          } catch (err) {
            logger.warn('agent', 'Diff explanation failed — non-fatal', { error: err.message });
          }
        }

        const resultStr = typeof result === 'string'
          ? result.slice(0, 2000)
          : JSON.stringify(result || {}).slice(0, 2000);

        messages.push({ role: 'assistant', content: aiResponse.text });
        messages.push({
          role:    'user',
          content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue with the task.`,
        });
        await broadcastEmitter.trace(userId, `✅ ${toolCall.name} done`).catch(() => {});
      }
    }

    // BUG2 FIX: advance task once per tool executed this iteration, not once per iteration
    if (task && toolCalls.length > 0) {
      for (let t = 0; t < toolCalls.length; t++) {
        await taskState.advance(task.id).catch(() => {});
      }
    }
  }
// END OF WHILE LOOP

  // ── 13. Loop exhausted without final reply ─────────────────────────────────
  if (!finalReply) {
    finalReply = toolResults.length > 0
      ? `Completed ${toolResults.length} tool operation(s). Check the Repos tab for changes.`
      : 'Task completed.';
  }

  // ── 14. Complete task ──────────────────────────────────────────────────────
  if (task) {
    await taskState.complete(task.id, finalReply.slice(0, 200)).catch(() => {});
  }

  // ── 15. Persist assistant reply ────────────────────────────────────────────
  await persistMessage(userId, sessionId, 'assistant', finalReply, 'text', {
    model:       aiResponse?.model,
    tokens_used: reasoningTrace.reduce((acc, r) => acc + r.tokens, 0),
    intent,
    tools_used:  toolResults.map((t) => t.tool),
  });

  // ── 16. Persist reasoning trace (if enabled) ───────────────────────────────
  if (reasoningLog && reasoningTrace.length > 0) {
    await persistReasoning(
      userId,
      task?.id || null,
      reasoningTrace,
      aiResponse?.model || 'unknown'
    );
  }

  // ── 17. Broadcast complete ─────────────────────────────────────────────────
  if (toolResults.length > 0) {
    await broadcastEmitter.complete(userId, {
      event:      'agent_complete',
      tools_used: toolResults.map((t) => t.tool),
      message:    finalReply.slice(0, 200),
    }).catch(() => {});
  }

  await broadcastEmitter.trace(userId, `done ✅`).catch(() => {});

  const totalTokens = reasoningTrace.reduce((acc, r) => acc + r.tokens, 0);

  logger.info('agent', 'Request complete', {
    userId,
    intent,
    iterations:  iteration,
    tools:       toolResults.length,
    totalTokens,
    model:       aiResponse?.model,
  });

  return res.status(HTTP.OK).json({
    reply:       finalReply,
    intent,
    model:       aiResponse?.model || modelSelection.model,
    tokens_used: totalTokens,
    tools_used:  toolResults.map((t) => t.tool),
    taskId:      task?.id || null,
    sessionId,
  });
}

// ── MODEL SWITCH — PATCH /api/active-model ─────────────────────────────────────

async function switchModel(req, res) {
  const { userId } = req.user;
  const { model }  = req.body;

  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'model is required',
    });
  }

  const validModels = Object.values(MODELS);
  if (!validModels.includes(model.trim())) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'invalid_model',
      message: `Unknown model: "${model}". Valid models: ${validModels.join(', ')}`,
    });
  }

  await setActiveModel(userId, model.trim());

  await broadcastEmitter.trace(userId, `model switched → ${model}`).catch(() => {});
  await broadcastEmitter.pulse(userId, {
    event: 'model_switched',
    model: model.trim(),
  }).catch(() => {});

  logger.info('agent:switchModel', `Model switched to ${model}`, { userId });

  return res.status(HTTP.OK).json({
    ok:        true,
    model:     model.trim(),
    timestamp: new Date().toISOString(),
  });
}

// ── AGENT STATUS — GET /api/agent/status ──────────────────────────────────────

async function agentStatus(req, res) {
  const { userId } = req.user;

  const [activeModel, statuses] = await Promise.all([
    getActiveModel(userId),
    Promise.resolve(modelStatus()),
  ]);

  return res.status(HTTP.OK).json({
    ok:           true,
    active_model: activeModel,
    providers:    statuses,
    timestamp:    new Date().toISOString(),
  });
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = { agent, switchModel, agentStatus };
