/**
 * @file agent.js
 * @location /backend/api/agent.js
 *
 * TOOL CALLING: Now uses native tool_calls from ai.complete().
 * No more parseToolCalls() regex. toolSchemas passed to complete().
 * result.tool_calls[] is always a structured array.
 *
 * When feeding tool results back to the model:
 *   - If tool_call.id exists (Groq/Mistral): use proper tool role message
 *   - If no id (Gemini XML): use user message with result text
 *
 * assistant message content is set to null when tool_calls present
 * (required by Mistral API — content must be null when calling tools)
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

// ── REGISTER TOOL HANDLERS ─────────────────────────────────────────────────────

register('read_file',   (args) => gh.readFile(args.repo, args.path, args.branch || 'main'));

register('write_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'write').catch(() => {});
  return gh.writeFile(args.repo, args.path, args.content, args.message, args.branch || 'main');
});

register('delete_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'delete').catch(() => {});
  return gh.deleteFile(args.repo, args.path, args.message, args.branch || 'main');
});

register('list_files',       (args) => gh.listFiles(args.repo, args.path || '', args.branch || 'main'));
register('create_branch',    (args) => gh.createBranch(args.repo, args.branch_name, args.from_branch || 'main'));
register('create_pr',        (args) => gh.createPR(args.repo, args.title, args.head, args.base || 'main', args.body || ''));
register('merge_pr',         (args) => gh.mergePR(args.repo, args.pull_number, args.merge_message || ''));

register('web_search', async (args) => {
  const { results } = await search(args.query, { maxResults: args.max_results || 5 });
  return results;
});

register('read_url', async (args) => {
  try {
    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(args.url)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const content = data.data?.content || data.content || '';
      if (content.trim()) return content;
    }
  } catch {}
  const FirecrawlApp = require('@mendable/firecrawl-js');
  const firecrawl    = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const result       = await firecrawl.scrapeUrl(args.url, { formats: ['markdown'] });
  return result.markdown || '';
});

register('remember', async (args, ctx) => {
  await query(TABLES.PERSONALITY, 'upsert', {
    data: { user_id: ctx.userId, key: args.key, value: String(args.value), updated_at: new Date().toISOString() },
    onConflict: 'user_id,key',
  });
  return { saved: true, key: args.key };
});

register('run_command', async (args) => {
  const { validateStructured, buildExecOptions } = require('../utils/commandSafety');
  validateStructured(args.executable, args.args || []);
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const opts = buildExecOptions(args.cwd || '/app');
  const { stdout, stderr } = await promisify(execFile)(args.executable, args.args || [], opts);
  return { stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) };
});

register('read_logs', async (args) => {
  const logManager = require('../lib/logManager');
  return logManager.tail({ lines: args.lines || 100, level: args.level || null, namespace: args.namespace || null });
});

register('check_file_exists', async (args) => {
  const fs   = require('fs');
  const path = require('path');
  const target = path.resolve('/app', args.path.replace(/^\//, ''));
  return { exists: fs.existsSync(target), path: target };
});

register('analyze_image', async (args, ctx) => {
  return analyzeImage({ imageUrl: args.image_url || null, snippetId: args.snippet_id || null, question: args.question || null, mimeType: args.mime_type || null }, ctx.userId);
});

register('fetch_to_snippets', async (args, ctx) => {
  return fetchToSnippets({ url: args.url, type: args.type, label: args.label || null, userId: ctx.userId, sessionId: ctx.sessionId || null });
});

// ── HELPERS ────────────────────────────────────────────────────────────────────

async function getActiveModel(userId) {
  try {
    const rows = await query(TABLES.ACTIVE_MODEL, 'select', { filters: { user_id: userId }, limit: 1 });
    return rows?.[0]?.model || currentModel();
  } catch { return currentModel(); }
}

async function setActiveModel(userId, model) {
  try {
    await query(TABLES.ACTIVE_MODEL, 'upsert', {
      data: { user_id: userId, model, updated_at: new Date().toISOString() },
      onConflict: 'user_id',
    });
  } catch (err) { logger.warn('agent:setActiveModel', 'Failed', { error: err.message }); }
}

async function persistMessage(userId, sessionId, role, content, cardType = 'text', metadata = {}) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id: userId, session_id: sessionId || null, role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        card_type: cardType, metadata: metadata || {},
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) { logger.warn('agent:persistMessage', 'Failed', { error: err.message, role }); }
}

async function persistReasoning(userId, taskId, trace, model) {
  try {
    await query(TABLES.REASONING_LOG, 'insert', {
      data: { user_id: userId, task_id: taskId || null, trace: JSON.stringify(trace), model, created_at: new Date().toISOString() },
    });
  } catch (err) { logger.warn('agent:persistReasoning', 'Failed', { error: err.message }); }
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
    history      = [],
    context: reqContext = 'dashboard',
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({ error: 'bad_request', message: 'message is required' });
  }

  const userMessage      = message.trim();
  const executionContext = ['dashboard', 'bookmarklet', 'api'].includes(reqContext) ? reqContext : 'dashboard';

  logger.info('agent', 'Request received', { userId, sessionId, forceMode, context: executionContext, msgLen: userMessage.length });

  await persistMessage(userId, sessionId, 'user', userMessage);

  // ── Intent classification ──────────────────────────────────────────────────
  let classification;
  try {
    classification = await classify(userMessage, { source: executionContext });
  } catch {
    classification = { intent: 'chat', confidence: 0.5, source: 'fallback', suggestedTone: 'chat', preferCode: false, needsTools: false, isMultiStep: false };
  }

  const { intent, needsTools, isMultiStep, preferCode } = classification;
  await broadcastEmitter.trace(userId, `classifier → "${intent}" (${classification.source})`).catch(() => {});

  // ── Model selection ────────────────────────────────────────────────────────
  const modelSelection = selectModel(intent, modelStatus());
  await broadcastEmitter.trace(userId, `model → ${modelSelection.model}${modelSelection.fallback ? ' (fallback)' : ''}`).catch(() => {});

  // ── Tool injection ─────────────────────────────────────────────────────────
  const shouldInjectTools = needsTools || forceMode;
  const injectedToolSchemas = shouldInjectTools
    ? injectTools(intent, { context: executionContext, forceMode })
    : [];
  const injectedToolNames = shouldInjectTools
    ? toolNames(intent, { context: executionContext, forceMode })
    : [];

  if (injectedToolNames.length > 0) {
    await broadcastEmitter.trace(userId, `tools → ${injectedToolNames.join(', ')}`).catch(() => {});
  }

  // ── System prompt ──────────────────────────────────────────────────────────
  let systemPrompt;
  try {
    const result = await buildSystemPrompt(userId, {
      intent, repo, branch, sessionId,
      readOnly: executionContext === 'bookmarklet',
      tools: injectedToolNames,
    });
    systemPrompt = result.prompt;
  } catch (err) {
    logger.warn('agent', 'buildSystemPrompt failed — fallback', { error: err.message });
    systemPrompt = `You are Nexy, Vinns' AI engineering collaborator. Be helpful, precise, and direct.`;
  }

  // ── Relevant snippets ──────────────────────────────────────────────────────
  try {
    const snippets = await getRelevant(userId, userMessage, 3);
    if (snippets.length > 0) {
      const block = snippets.map((s) => `#${s.number} [${s.type}]: ${(s.content || '').slice(0, 500)}`).join('\n');
      systemPrompt += `\n\n[RELEVANT SNIPPETS FROM SCRAPER]\n${block}`;
    }
  } catch {}

  // ── Messages ───────────────────────────────────────────────────────────────
  const historyMessages = Array.isArray(history)
    ? history.filter((m) => m && m.role && m.content).slice(-10)
        .map((m) => ({ role: ['user','assistant','system'].includes(m.role) ? m.role : 'user', content: String(m.content).slice(0, 2000) }))
    : [];

  let messages = [...historyMessages, { role: 'user', content: userMessage }];
  messages = tokenizer.trimToFit(messages, AGENT.MAX_TOKENS - 1500);

  // ── Task record ────────────────────────────────────────────────────────────
  let task = null;
  if (isMultiStep) {
    try { task = await taskState.create(userId, intent, []); } catch {}
  }

  await setActiveModel(userId, modelSelection.model);

  // ── TOOL-CALLING LOOP — NATIVE tool_calls ──────────────────────────────────
  const MAX_ITERATIONS = AGENT.MAX_RETRIES;
  let iteration        = 0;
  let finalReply       = '';
  let toolResults      = [];
  let aiResponse       = null;
  const reasoningTrace = [];

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    await broadcastEmitter.trace(userId, `thinking... (${iteration}/${MAX_ITERATIONS})`).catch(() => {});

    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens:   AGENT.MAX_TOKENS,
        preferCode:  modelSelection.preferCode,
        toolSchemas: injectedToolSchemas, // ← NATIVE tool calling — passed to Groq/Mistral directly
      });
    } catch (err) {
      if (err.message === 'all_providers_down') {
        await broadcastEmitter.warning(userId, { event: 'all_providers_down', message: 'All AI providers unavailable' }).catch(() => {});
        return res.status(HTTP.SERVICE_UNAVAILABLE).json({ error: 'all_providers_down', message: 'All AI providers are currently unavailable. Try again shortly.' });
      }
      logger.error('agent', 'AI completion failed', { error: err.message, iteration });
      throw err;
    }

    await setActiveModel(userId, aiResponse.model);
    reasoningTrace.push({ iteration, model: aiResponse.model, tokens: aiResponse.tokens_used, output: aiResponse.text.slice(0, 200) });

    // Native tool_calls — structured array, no regex
    const toolCalls = aiResponse.tool_calls || [];

    if (toolCalls.length === 0) {
      // No tool calls → this is the final text reply
      finalReply = aiResponse.text;
      break;
    }

    // Execute each tool call
    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId, `calling tool: ${toolCall.name}`).catch(() => {});

      // Confirmation gate
      let needsConfirm = false;
      try { needsConfirm = await shouldConfirm(userId, toolCall.name); } catch {}

      if (needsConfirm) {
        const card = buildCard({
          action: toolCall.name,
          description: `Run ${toolCall.name} on ${toolCall.args?.path || toolCall.args?.repo || 'target'}`,
          details: toolCall.args, risk: riskLevel(toolCall.name),
        });
        if (task) await taskState.pause(task.id, `awaiting confirmation: ${toolCall.name}`).catch(() => {});
        await persistMessage(userId, sessionId, 'assistant', JSON.stringify(card), 'confirm_card', { tool: toolCall.name, taskId: task?.id || null });
        return res.status(HTTP.OK).json({
          reply: null, confirmation: card, taskId: task?.id || null,
          model: aiResponse.model, tokens_used: aiResponse.tokens_used, intent, sessionId,
        });
      }

      // Execute via executor
      const execPlan    = { steps: [{ tool: toolCall.name, description: `Execute ${toolCall.name}`, args: toolCall.args }] };
      const execContext = { userId, sessionId };
      const execResult  = await runExecutor(userId, execPlan, execContext);

      if (!execResult.success) {
        const errMsg = execResult.failedStep?.error || 'Tool execution failed';
        await broadcastEmitter.warning(userId, { event: 'tool_failed', tool: toolCall.name, message: errMsg }).catch(() => {});

        // Feed error back — use correct format based on provider
        if (toolCall.id) {
          // Groq/Mistral: assistant had tool_calls, content should be null
          messages.push({
            role: 'assistant', content: null,
            tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }],
          });
          messages.push({ role: 'tool', content: `Error: ${errMsg}`, tool_call_id: toolCall.id });
        } else {
          // Gemini: user message with result
          messages.push({ role: 'assistant', content: aiResponse.text });
          messages.push({ role: 'user', content: `Tool ${toolCall.name} failed: ${errMsg}. Handle this and continue.` });
        }
      } else {
        const result = execResult.results?.[0]?.result;
        toolResults.push({ tool: toolCall.name, result });

        if (toolCall.name === 'write_file' && result) {
          try {
            const diff = await explain(
              `+++ ${toolCall.args?.path}\n${(toolCall.args?.content || '').slice(0, 1000)}`,
              { filePath: toolCall.args?.path, repo: toolCall.args?.repo, intent }
            );
            await broadcastEmitter.finding(userId, { event: 'file_written', path: toolCall.args?.path, repo: toolCall.args?.repo, explanation: diff }).catch(() => {});
          } catch {}
        }

        const resultStr = typeof result === 'string'
          ? result.slice(0, 2000)
          : JSON.stringify(result || {}).slice(0, 2000);

        // Feed result back — correct format per provider
        if (toolCall.id) {
          // Groq/Mistral native: assistant content MUST be null when tool_calls present
          messages.push({
            role: 'assistant', content: null,
            tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }],
          });
          messages.push({ role: 'tool', content: resultStr, tool_call_id: toolCall.id });
        } else {
          // Gemini XML: user message with result
          messages.push({ role: 'assistant', content: aiResponse.text });
          messages.push({ role: 'user', content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue with the task.` });
        }

        await broadcastEmitter.trace(userId, `✅ ${toolCall.name} done`).catch(() => {});
      }
    }

    // Advance task per tool executed
    if (task && toolCalls.length > 0) {
      for (let t = 0; t < toolCalls.length; t++) {
        await taskState.advance(task.id).catch(() => {});
      }
    }
  }

  // ── Loop exhausted ─────────────────────────────────────────────────────────
  if (!finalReply) {
    finalReply = toolResults.length > 0
      ? `Completed ${toolResults.length} tool operation(s). Check the Repos tab for changes.`
      : 'Task completed.';
  }

  if (task) await taskState.complete(task.id, finalReply.slice(0, 200)).catch(() => {});

  const totalTokens = reasoningTrace.reduce((acc, r) => acc + r.tokens, 0);

  await persistMessage(userId, sessionId, 'assistant', finalReply, 'text', {
    model: aiResponse?.model, tokens_used: totalTokens, intent, tools_used: toolResults.map((t) => t.tool),
  });

  if (reasoningLog && reasoningTrace.length > 0) {
    await persistReasoning(userId, task?.id || null, reasoningTrace, aiResponse?.model || 'unknown');
  }

  if (toolResults.length > 0) {
    await broadcastEmitter.complete(userId, { event: 'agent_complete', tools_used: toolResults.map((t) => t.tool), message: finalReply.slice(0, 200) }).catch(() => {});
  }

  await broadcastEmitter.trace(userId, `done ✅`).catch(() => {});

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

// ── MODEL SWITCH ───────────────────────────────────────────────────────────────

async function switchModel(req, res) {
  const { userId } = req.user;
  const { model }  = req.body;

  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({ error: 'bad_request', message: 'model is required' });
  }

  const validModels = Object.values(MODELS);
  if (!validModels.includes(model.trim())) {
    return res.status(HTTP.BAD_REQUEST).json({ error: 'invalid_model', message: `Unknown model: "${model}"` });
  }

  await setActiveModel(userId, model.trim());
  await broadcastEmitter.trace(userId, `model switched → ${model}`).catch(() => {});
  await broadcastEmitter.pulse(userId, { event: 'model_switched', model: model.trim() }).catch(() => {});

  return res.status(HTTP.OK).json({ ok: true, model: model.trim(), timestamp: new Date().toISOString() });
}

// ── AGENT STATUS ───────────────────────────────────────────────────────────────

async function agentStatus(req, res) {
  const { userId } = req.user;
  const [activeModel, statuses] = await Promise.all([getActiveModel(userId), Promise.resolve(modelStatus())]);
  return res.status(HTTP.OK).json({ ok: true, active_model: activeModel, providers: statuses, timestamp: new Date().toISOString() });
}

module.exports = { agent, switchModel, agentStatus };
