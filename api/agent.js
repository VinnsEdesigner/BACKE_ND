'use strict';

const { complete, stream, currentModel, modelStatus } = require('../lib/ai');
const { search }           = require('../lib/searchRouter');
const { query }            = require('../lib/supabase');
const logger               = require('../lib/logger');
const tokenizer            = require('../lib/tokenizer');
const taskState            = require('../lib/agent/taskState');
const { classify }         = require('../lib/agent/intentClassifier');
const { inject: injectTools, names: toolNames } = require('../lib/agent/toolInjector');
const { plan }             = require('../lib/agent/reasoner');
const { run: runExecutor, register } = require('../lib/agent/executor');
const { shouldConfirm, buildCard, riskLevel } = require('../lib/agent/confirmationGate');
const broadcastEmitter     = require('../lib/agent/broadcastEmitter');
const { summarize, loadSummaries } = require('../lib/agent/memorySummarizer');
const { getRelevant }      = require('../lib/agent/sessionBridge');
const { explain }          = require('../lib/agent/diffExplainer');
const { build: buildPersonality } = require('../lib/personality/inject');
const gh                   = require('../lib/github');
const shadowBranch         = require('../lib/agent/shadowBranch');
const { HTTP, TABLES, SSE, AGENT, MODELS } = require('../utils/constants');

// ── REGISTER TOOL HANDLERS (wired here — executor.js calls these) ─────────────

register('read_file',    (args) => gh.readFile(args.repo, args.path, args.branch));
register('write_file',   (args, ctx) => gh.writeFile(args.repo, args.path, args.content, args.message, args.branch));
register('delete_file',  (args, ctx) => gh.deleteFile(args.repo, args.path, args.message, args.branch));
register('list_files',   (args) => gh.listFiles(args.repo, args.path || '', args.branch));
register('create_branch',(args) => gh.createBranch(args.repo, args.branch_name, args.from_branch));
register('create_pr',    (args) => gh.createPR(args.repo, args.title, args.head, args.base, args.body));
register('merge_pr',     (args) => gh.mergePR(args.repo, args.pull_number, args.merge_message));
register('web_search',   async (args) => {
  const { results } = await search(args.query, { maxResults: args.max_results || 5 });
  return results;
});
register('read_url',     async (args) => {
  // Jina first — free forever
  try {
    const res = await fetch(`https://r.jina.ai/${args.url}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      return data.data?.content || '';
    }
  } catch {
    // fall through to Firecrawl
  }

  // Firecrawl fallback — free tier (expires eventually)
  const FirecrawlApp = require('@mendable/firecrawl-js');
  const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
  const result = await firecrawl.scrapeUrl(args.url, { formats: ['markdown'] });
  return result.markdown || '';
});
register('remember',     async (args, ctx) => {
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

// ── ACTIVE MODEL HELPERS ──────────────────────────────────────────────────────

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
    logger.warn('agent:setActiveModel', 'Failed to persist active model', err);
  }
}

// ── PERSIST CONVERSATION ──────────────────────────────────────────────────────

async function persistMessage(userId, sessionId, role, content) {
  try {
    await query(TABLES.CONVERSATIONS, 'insert', {
      data: {
        user_id:    userId,
        session_id: sessionId || null,
        role,
        content:    typeof content === 'string' ? content : JSON.stringify(content),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Non-fatal — never block agent on DB write failure
    logger.warn('agent:persistMessage', 'Failed to persist message', err);
  }
}

// ── PERSIST REASONING LOG (only if reasoning_log setting ON) ──────────────────

async function persistReasoning(userId, taskId, trace) {
  try {
    await query(TABLES.REASONING_LOG, 'insert', {
      data: {
        user_id:    userId,
        task_id:    taskId || null,
        trace:      JSON.stringify(trace),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('agent:persistReasoning', 'Failed to persist reasoning log', err);
  }
}

// ── TOOL CALL PARSER ──────────────────────────────────────────────────────────
// Parses tool calls from AI response regardless of provider format.
// Normalises to: [{ name, args }]

function parseToolCalls(responseText) {
  // Try JSON tool-calling pattern first (our primary pattern per CONTEXT.md)
  // AI is prompted to respond with JSON tool calls when tools are injected
  try {
    const clean = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Single tool call: { tool, args } or { name, args } or { function, arguments }
    if (parsed.tool && parsed.args) {
      return [{ name: parsed.tool, args: parsed.args }];
    }
    if (parsed.name && parsed.args) {
      return [{ name: parsed.name, args: parsed.args }];
    }
    // Array of tool calls
    if (Array.isArray(parsed)) {
      return parsed
        .filter((t) => t.tool || t.name)
        .map((t) => ({ name: t.tool || t.name, args: t.args || t.arguments || {} }));
    }
    // Steps array (from reasoner plan format)
    if (parsed.steps && Array.isArray(parsed.steps)) {
      return parsed.steps.map((s) => ({ name: s.tool, args: s.args || {} }));
    }
  } catch {
    // Not JSON — plain text response, no tool calls
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
    stream: useStream = false,
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'message is required',
    });
  }

  const userMessage = message.trim();
  logger.info('agent', 'Request received', { userId, sessionId, forceMode });

  // ── 1. Persist user message ───────────────────────────────────────────────
  await persistMessage(userId, sessionId, 'user', userMessage);

  // ── 2. Classify intent ────────────────────────────────────────────────────
  const classification = classify(userMessage);
  const { intent, suggestedTone, needsTools, isMultiStep } = classification;

  await broadcastEmitter.trace(userId, `classifier → "${intent}"`);
  logger.info('agent', `Intent: ${intent}`, { userId, needsTools, isMultiStep });

  // ── 3. Load episodic memory (last 5 summaries) ────────────────────────────
  const memorySummary = await loadSummaries(userId);

  // ── 4. Load relevant scraper snippets ─────────────────────────────────────
  const relevantSnippets = await getRelevant(userId, userMessage, 3);

  // ── 5. Build personality system prompt ────────────────────────────────────
  const personalityBlock = await buildPersonality(userId, {
    toneMode:    suggestedTone,
    requestMeta: { repo, branch },
  });

  // ── 6. Build system prompt ────────────────────────────────────────────────
  const systemParts = [personalityBlock];
  if (memorySummary)         systemParts.push(memorySummary);
  if (relevantSnippets.length > 0) {
    const snippetBlock = relevantSnippets
      .map((s) => `#${s.number} [${s.type}]: ${s.content?.slice(0, 500)}`)
      .join('\n');
    systemParts.push(`[RELEVANT SNIPPETS FROM SCRAPER]\n${snippetBlock}`);
  }
  if (needsTools || forceMode) {
    systemParts.push(
      '[TOOL CALLING]\nWhen you need to use a tool, respond with ONLY valid JSON in this format:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'For multiple tools in sequence, respond with one tool at a time.\n' +
      'After all tools complete, provide your final plain text response.'
    );
  }

  const systemPrompt = systemParts.join('\n\n');

  // ── 7. Inject tools if needed ─────────────────────────────────────────────
  const tools = (needsTools || forceMode) ? injectTools(intent, forceMode) : [];
  if (tools.length > 0) {
    await broadcastEmitter.trace(userId,
      `injecting tools: ${toolNames(intent, forceMode).join(', ')}`
    );
  }

  // ── 8. Build messages array ───────────────────────────────────────────────
  let messages = [{ role: 'user', content: userMessage }];

  // Trim to fit token budget
  const trimmed = tokenizer.trimToFit(messages, AGENT.MAX_TOKENS - 1000); // reserve 1k for response
  if (trimmed.length < messages.length) {
    await broadcastEmitter.trace(userId, `context trimmed to fit token budget`);
  }
  messages = trimmed;

  // ── 9. Create task record for multi-step ──────────────────────────────────
  let task = null;
  if (isMultiStep) {
    try {
      task = await taskState.create(userId, intent, []);
      await broadcastEmitter.trace(userId, `task created: ${task.id}`);
    } catch (err) {
      logger.warn('agent', 'Failed to create task record', err);
    }
  }

  // ── 10. Get active model ──────────────────────────────────────────────────
  const activeModel = await getActiveModel(userId);
  await broadcastEmitter.trace(userId, `model: ${activeModel}`);

  // ── 11. TOOL-CALLING LOOP ─────────────────────────────────────────────────
  // Max 5 iterations to prevent infinite loops
  const MAX_ITERATIONS = 5;
  let   iteration      = 0;
  let   finalReply     = '';
  let   toolResults    = [];
  const reasoningTrace = [];

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    await broadcastEmitter.trace(userId, `thinking... (iteration ${iteration})`);

    // Call AI
    let aiResponse;
    try {
      aiResponse = await complete({
        messages,
        systemPrompt,
        maxTokens: AGENT.MAX_TOKENS,
      });
    } catch (err) {
      if (err.message === 'all_providers_down') {
        await broadcastEmitter.warning(userId, {
          event:   'all_providers_down',
          message: 'All AI providers are currently unavailable',
        });
        return res.status(HTTP.SERVICE_UNAVAILABLE).json({
          error:   'all_providers_down',
          message: 'All AI providers are currently unavailable. Try again shortly.',
        });
      }
      throw err;
    }

    // Track model used
    await setActiveModel(userId, aiResponse.model);
    reasoningTrace.push({
      iteration,
      model:  aiResponse.model,
      tokens: aiResponse.tokens_used,
      output: aiResponse.text.slice(0, 200),
    });

    // Parse tool calls from response
    const toolCalls = parseToolCalls(aiResponse.text);

    // No tool calls → this is the final reply
    if (toolCalls.length === 0) {
      finalReply = aiResponse.text;
      break;
    }

    // ── Execute tool calls ─────────────────────────────────────────────────
    for (const toolCall of toolCalls) {
      await broadcastEmitter.trace(userId, `calling tool: ${toolCall.name}`);

      // Confirmation gate — check if this action needs user approval
      const needsConfirm = await shouldConfirm(userId, toolCall.name);
      if (needsConfirm) {
        const card = buildCard({
          action:      toolCall.name,
          description: `Run ${toolCall.name} on ${toolCall.args?.path || toolCall.args?.repo || ''}`,
          details:     toolCall.args,
          risk:        riskLevel(toolCall.name),
        });

        // Pause task awaiting confirmation
        if (task) await taskState.pause(task.id, `awaiting confirmation: ${toolCall.name}`);

        // Persist assistant message with confirmation card
        await persistMessage(userId, sessionId, 'assistant', JSON.stringify(card));

        return res.status(HTTP.OK).json({
          reply:        null,
          confirmation: card,
          taskId:       task?.id || null,
          model:        aiResponse.model,
          tokens_used:  aiResponse.tokens_used,
        });
      }

      // Execute the tool via executor plan wrapper
      const execPlan = {
        steps: [{ tool: toolCall.name, description: `Execute ${toolCall.name}`, args: toolCall.args }],
      };

      const execResult = await runExecutor(userId, execPlan, null);

      if (!execResult.success) {
        await broadcastEmitter.warning(userId, {
          event:   'tool_failed',
          tool:    toolCall.name,
          message: execResult.failedStep?.error || 'Tool execution failed',
        });
        // Inject failure into messages so AI can recover
        messages.push({ role: 'assistant', content: aiResponse.text });
        messages.push({
          role:    'user',
          content: `Tool ${toolCall.name} failed: ${execResult.failedStep?.error}. Please handle this error.`,
        });
      } else {
        const result = execResult.results[0]?.result;
        toolResults.push({ tool: toolCall.name, result });

        // For write_file — explain the diff
        if (toolCall.name === 'write_file' && result) {
          const diffExplanation = await explain(
            `+++ ${toolCall.args?.path}\n${toolCall.args?.content?.slice(0, 1000)}`,
            { filePath: toolCall.args?.path, repo: toolCall.args?.repo, intent }
          );
          await broadcastEmitter.finding(userId, {
            event:       'file_written',
            path:        toolCall.args?.path,
            repo:        toolCall.args?.repo,
            explanation: diffExplanation,
          });
        }

        // Feed tool result back to AI for next iteration
        const resultStr = typeof result === 'string'
          ? result.slice(0, 2000)
          : JSON.stringify(result).slice(0, 2000);

        messages.push({ role: 'assistant', content: aiResponse.text });
        messages.push({
          role:    'user',
          content: `Tool ${toolCall.name} result:\n${resultStr}\n\nContinue with the task.`,
        });

        await broadcastEmitter.trace(userId, `✅ ${toolCall.name} done`);
      }
    }

    // Advance task step
    if (task) {
      try { await taskState.advance(task.id); } catch {}
    }
  }

  // ── 12. If loop exhausted without final reply ──────────────────────────────
  if (!finalReply) {
    finalReply = toolResults.length > 0
      ? `Completed ${toolResults.length} tool operation(s). Check the Repos tab for changes.`
      : 'Task completed.';
  }

  // ── 13. Complete task ─────────────────────────────────────────────────────
  if (task) {
    await taskState.complete(task.id, finalReply.slice(0, 200)).catch(() => {});
  }

  // ── 14. Persist assistant reply ───────────────────────────────────────────
  await persistMessage(userId, sessionId, 'assistant', finalReply);

  // ── 15. Persist reasoning log (if enabled) ────────────────────────────────
  if (reasoningLog && reasoningTrace.length > 0) {
    await persistReasoning(userId, task?.id, reasoningTrace);
  }

  // ── 16. Broadcast complete ────────────────────────────────────────────────
  if (toolResults.length > 0) {
    await broadcastEmitter.complete(userId, {
      event:      'agent_complete',
      tools_used: toolResults.map((t) => t.tool),
      message:    finalReply.slice(0, 200),
    });
  }

  // ── 17. SSE thinking stream — model status ────────────────────────────────
  await broadcastEmitter.trace(userId, `done ✅`);

  logger.info('agent', 'Request complete', {
    userId,
    intent,
    iterations: iteration,
    tools:      toolResults.length,
  });

  return res.status(HTTP.OK).json({
    reply:       finalReply,
    intent,
    model:       await getActiveModel(userId),
    tokens_used: reasoningTrace.reduce((acc, r) => acc + r.tokens, 0),
    tools_used:  toolResults.map((t) => t.tool),
    taskId:      task?.id || null,
    sessionId,
  });
}

// ── MODEL SWITCH — PATCH /api/active-model ────────────────────────────────────

async function switchModel(req, res) {
  const { userId } = req.user;
  const { model }  = req.body;

  if (!model || typeof model !== 'string') {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'bad_request',
      message: 'model is required',
    });
  }

  // Validate model string against known models (MODELS already imported at top)
  const validModels = Object.values(MODELS);
  if (!validModels.includes(model)) {
    return res.status(HTTP.BAD_REQUEST).json({
      error:   'invalid_model',
      message: `Unknown model: ${model}. Use one of: ${validModels.join(', ')}`,
    });
  }

  await setActiveModel(userId, model);
  await broadcastEmitter.trace(userId, `model switched → ${model}`);

  logger.info('agent:switchModel', `Model switched to ${model}`, { userId });

  return res.status(HTTP.OK).json({
    ok:        true,
    model,
    timestamp: new Date().toISOString(),
  });
}

// ── MODEL STATUS — GET /api/agent/status ──────────────────────────────────────

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

module.exports = { agent, switchModel, agentStatus };
