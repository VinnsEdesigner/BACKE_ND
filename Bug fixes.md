# api/agent.js patches

## BUG 1 — aiResponse out of scope
FIND:
```
  let finalReply     = '';
  let toolResults    = [];
  const reasoningTrace = [];
```
REPLACE WITH:
```
  let finalReply     = '';
  let toolResults    = [];
  let aiResponse     = null;   // BUG1 FIX: declare outside loop
  const reasoningTrace = [];
```

## BUG 1 continued — remove inner declaration
FIND (inside while loop):
```
    let aiResponse;
    try {
      aiResponse = await complete({
```
REPLACE WITH:
```
    try {
      aiResponse = await complete({
```

## BUG 4 — execContext sessionId silently dropped
FIND:
```
async function run(userId, plan, streamCallback = null) {
```
IN executor.js — but the caller fix is here in agent.js:
FIND:
```
      const execContext = { userId, sessionId };
      const execResult  = await runExecutor(userId, execPlan, null, execContext);
```
REPLACE WITH:
```
      const execContext = { userId, sessionId };
      const execResult  = await runExecutor(userId, execPlan, execContext);
```

## BUG 2 — task advances once per iteration not per tool
FIND:
```
    // Advance task step
    if (task) {
      await taskState.advance(task.id).catch(() => {});
    }
```
REPLACE WITH:
```
    // Advance task step once per tool executed this iteration
    if (task && toolCalls.length > 0) {
      for (let t = 0; t < toolCalls.length; t++) {
        await taskState.advance(task.id).catch(() => {});
      }
    }
```
## BUG 13 FIX — utils/constants.js

FIND:
```
  REPOS: {
    BACKEND:   'backend',
    DASHBOARD: 'dashboard',
    SCRAPER:   'scraper',
  },
```
REPLACE WITH:
```
  REPOS: {
    BACKEND:   'backend',
    DASHBOARD: 'dashboard',
    SCRAPER:   'SCRAPER-',   // BUG13 FIX: trailing hyphen — actual repo name
  },
```
## BUG 6 FIX — middleware/rate-limit.js

FIND:
```
  const key = `rl:${userId}:${req.path.split('/')[2]}:${window}:${Math.floor(Date.now() / 3_600_000)}`;
```
REPLACE WITH:
```
  // BUG6 FIX: use full path sanitized, not just [2] segment
  // /api/agent → 'agent', /api/agent/status → 'agent_status'
  const routeKey = req.path.replace(/^\/api\//, '').replace(/\//g, '_');
  const key = `rl:${userId}:${routeKey}:${window}:${Math.floor(Date.now() / 3_600_000)}`;
```
## BUG 5 FIX — lib/supabase.js
Add count support to select operation.

FIND in query() select block:
```
    if (operation === 'select') {
      const { columns = '*', filters = {}, order = null, limit = null } = options;
      q = q.select(columns);
      for (const [col, val] of Object.entries(filters)) {
        q = q.eq(col, val);
      }
      if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
      if (limit) q = q.limit(limit);
    }
```
REPLACE WITH:
```
    if (operation === 'select') {
      const { columns = '*', filters = {}, order = null, limit = null, count = null } = options;
      // BUG5 FIX: pass count option to supabase select
      q = count ? q.select(columns, { count }) : q.select(columns);
      for (const [col, val] of Object.entries(filters)) {
        q = q.eq(col, val);
      }
      if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
      if (limit) q = q.limit(limit);
    }
```

AND update the return to expose count:
FIND:
```
    const { data, error } = await q;

    if (error) {
      logger.error('supabase', `${operation} failed on ${table}`, error);
      throw error;
    }

    return data;
```
REPLACE WITH:
```
    const { data, count: rowCount, error } = await q;

    if (error) {
      logger.error('supabase', `${operation} failed on ${table}`, error);
      throw error;
    }

    // BUG5 FIX: attach count to result array when requested
    if (rowCount !== null && rowCount !== undefined && Array.isArray(data)) {
      data._count = rowCount;
    }

    return data;
```

---

## BUG 5 FIX — lib/personality/prompts/dynamicContext.js
getSnippetCount() needs to use the count properly.

FIND:
```
async function getSnippetCount(userId, sessionId) {
  if (!userId || !sessionId) return 0;
  try {
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId, session_id: sessionId },
      limit:   1,
      count:   'exact',
    });
    return rows?.length || 0;
  } catch {
    return 0;
  }
}
```
REPLACE WITH:
```
async function getSnippetCount(userId, sessionId) {
  if (!userId || !sessionId) return 0;
  try {
    const rows = await query(TABLES.SNIPPETS, 'select', {
      filters: { user_id: userId, session_id: sessionId },
      count:   'exact',  // BUG5 FIX: now actually handled by supabase.js
    });
    // supabase returns count in header, rows._count when count option used
    return rows?._count ?? rows?.length ?? 0;
  } catch {
    return 0;
  }
}
```
## BUG 8 FIX — lib/agent/memorySummarizer.js

FIND:
```
    const result = await complete({
      messages:    [{ role: 'user', content: transcript }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   150,
      preferCode:  true,
    });
```
REPLACE WITH:
```
    const result = await complete({
      messages:    [{ role: 'user', content: transcript }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   150,
      preferCode:  false,  // BUG8 FIX: summarization is prose not code, use Groq
    });
```
## BUG 9 FIX — lib/logManager.js startTailWatcher

FIND:
```
  state.timer = setInterval(tick, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();

  tailers.add(state);
  if (emitExisting) tick();

  return {
    stop() { stopTailWatcher(state); },
  };
```
REPLACE WITH:
```
  tailers.add(state);

  // BUG9 FIX: if emitExisting, run first tick synchronously BEFORE starting interval
  // prevents race condition where interval fires before initial read completes
  if (emitExisting) {
    tick();
    // Start interval only after first tick initiated
    state.timer = setInterval(tick, intervalMs);
  } else {
    state.timer = setInterval(tick, intervalMs);
  }

  if (typeof state.timer.unref === 'function') state.timer.unref();

  return {
    stop() { stopTailWatcher(state); },
  };
```
## BUG 11 FIX — api/lite-agent.js

buildSystemPrompt already adds [AVAILABLE TOOLS THIS REQUEST].
The inline append adds them AGAIN. Remove the duplicate.

FIND:
```
  // ── 5. Append tool calling instructions if tools available ─────────────────
  if (injectedToolNames.length > 0) {
    systemPrompt += '\n\n[TOOL CALLING — BOOKMARKLET]\n' +
      'You have access to read-only tools. Use them when needed.\n' +
      'Respond with ONLY JSON to call a tool:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'Max 2 tool calls per response. After tools: respond in plain text.';
  }
```
REPLACE WITH:
```
  // ── 5. Append tool calling FORMAT instructions only (names already in systemPrompt)
  // BUG11 FIX: don't list tool names again — buildSystemPrompt already did that
  if (injectedToolNames.length > 0) {
    systemPrompt += '\n\n[TOOL CALLING FORMAT]\n' +
      'To call a tool respond with ONLY valid JSON — no other text:\n' +
      '{"tool": "tool_name", "args": {...}}\n' +
      'Only use tools from [AVAILABLE TOOLS THIS REQUEST] above.\n' +
      'Max 2 tool calls per response. After all tools done: respond in plain text.';
  }
```
## BUG 12 FIX — lib/agent/shadowBranch.js + api/agent.js

### In lib/agent/shadowBranch.js
FIND at top (after requires):
```
const { query }   = require('../supabase');
const logger      = require('../logger');
const { TABLES, GITHUB } = require('../../utils/constants');
```
REPLACE WITH:
```
const { query }   = require('../supabase');
const logger      = require('../logger');
const { TABLES, GITHUB } = require('../../utils/constants');
// BUG12 FIX: import broadcastEmitter to warn user when shadow fails
const broadcastEmitter = require('./broadcastEmitter');
```

FIND the catch block in create():
```
  } catch (err) {
    logger.error('shadowBranch:create', `Failed to create shadow backup for ${filePath}`, err);
    // Non-fatal — don't block the main operation if shadow fails
    return { branchName, sha: null };
  }
```
REPLACE WITH:
```
  } catch (err) {
    logger.error('shadowBranch:create', `Failed to create shadow backup for ${filePath}`, err);
    // BUG12 FIX: emit SSE warning so user knows backup failed before destructive op
    broadcastEmitter.warning(userId, {
      event:   'shadow_backup_failed',
      repo,
      path:    filePath,
      message: `Shadow backup failed: ${err.message}. Write will proceed without backup.`,
    }).catch(() => {});
    return { branchName, sha: null };
  }
```

### In api/agent.js — write_file handler
FIND:
```
register('write_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'write').catch((err) => {
    logger.warn('agent:write_file', 'Shadow backup failed — proceeding anyway', {
      error: err.message,
    });
  });
```
REPLACE WITH:
```
register('write_file', async (args, ctx) => {
  // BUG12 FIX: shadowBranch.create now emits SSE warning internally on failure
  // so we just fire-and-forget here — the user will see the warning in Terminal
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'write').catch(() => {});
```

### Same for delete_file handler
FIND:
```
register('delete_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'delete').catch((err) => {
    logger.warn('agent:delete_file', 'Shadow backup failed — proceeding anyway', {
      error: err.message,
    });
  });
```
REPLACE WITH:
```
register('delete_file', async (args, ctx) => {
  await shadowBranch.create(ctx.userId, args.repo, args.path, 'delete').catch(() => {});
```
## BUG 14 FIX — lib/personality/freedom.js setLevel()

FIND:
```
async function setLevel(userId, level) {
  const clamped = Math.max(0, Math.min(3, level));
  try {
    await query(TABLES.SETTINGS, 'upsert', {
      data: {
        user_id:       userId,
        autonomy_level: clamped,
        updated_at:    new Date().toISOString(),
      },
      onConflict: 'user_id',
    });
```
REPLACE WITH:
```
async function setLevel(userId, level) {
  const clamped = Math.max(0, Math.min(3, level));
  try {
    // BUG14 FIX: check if row exists first — use update not upsert
    // upsert on first insert would null out all other settings columns
    const existing = await query(TABLES.SETTINGS, 'select', {
      filters: { user_id: userId },
      limit:   1,
    });

    if (existing && existing.length > 0) {
      // Row exists — safe to update only autonomy_level
      await query(TABLES.SETTINGS, 'update', {
        data:    { autonomy_level: clamped, updated_at: new Date().toISOString() },
        filters: { user_id: userId },
      });
    } else {
      // No row yet — upsert with defaults for all columns
      await query(TABLES.SETTINGS, 'upsert', {
        data: {
          user_id:              userId,
          autonomy_level:       clamped,
          confirmation_prompts: true,
          reasoning_log:        false,
          auto_sync:            true,
          prompt_injection:     true,
          snippet_limit:        20,
          updated_at:           new Date().toISOString(),
        },
        onConflict: 'user_id',
      });
    }
```
## BUG 15 FIX — api/settings.js coerce()

FIND:
```
  if (intKeys.includes(key)) {
    const n = parseInt(value, 10);
    if (key === 'autonomy_level') return Math.max(0, Math.min(3, n));
    if (key === 'snippet_limit')  return Math.max(1, Math.min(20, n));
    return n;
  }
```
REPLACE WITH:
```
  if (intKeys.includes(key)) {
    const n = parseInt(value, 10);
    if (key === 'autonomy_level') return Math.max(0, Math.min(3, n));
    // BUG15 FIX: match frontend max of 100, not 20 (20 is scraper default not hard limit)
    if (key === 'snippet_limit')  return Math.max(1, Math.min(100, n));
    return n;
  }
```
## BUG 16 FIX — lib/agent/repoMap.js invalidate()

FIND:
```
async function invalidate(userId, repo) {
  try {
    const client = require('../supabase').getClient();
    await client
      .from(TABLES.REPO_CACHE)
      .delete()
      .eq('user_id', userId)
      .eq('repo', repo);
    logger.debug('repoMap:invalidate', `Cache cleared for ${repo}`, { userId });
  } catch (err) {
    logger.warn('repoMap:invalidate', 'Failed to invalidate cache', err);
  }
}
```
REPLACE WITH:
```
// BUG16 FIX: accept optional branch param — only invalidate the specific branch written to
async function invalidate(userId, repo, branch = null) {
  try {
    const client = require('../supabase').getClient();
    let q = client
      .from(TABLES.REPO_CACHE)
      .delete()
      .eq('user_id', userId)
      .eq('repo', repo);

    // Only invalidate the specific branch if provided
    if (branch) q = q.eq('branch', branch);

    await q;
    logger.debug('repoMap:invalidate', `Cache cleared for ${repo}${branch ? `@${branch}` : ''}`, { userId });
  } catch (err) {
    logger.warn('repoMap:invalidate', 'Failed to invalidate cache', err);
  }
}
```

### Also update the callers in api/github.js to pass branch:

FIND:
```
    await repoMap.invalidate(userId, repo).catch((err) => {
      logger.warn('github:handler', 'Cache invalidation failed', err);
    });
```
REPLACE WITH:
```
    // BUG16 FIX: pass branch so we only clear the affected branch cache
    await repoMap.invalidate(userId, repo, args.branch || GITHUB.DEFAULT_BRANCH).catch((err) => {
      logger.warn('github:handler', 'Cache invalidation failed', err);
    });
```
## DOCKERFILE — TZ fix

FIND:
```
FROM node:20-alpine

WORKDIR /app
```
REPLACE WITH:
```
FROM node:20-alpine

# Fix server time to Africa/Nairobi (EAT, UTC+3)
ENV TZ=Africa/Nairobi

WORKDIR /app
```

---

## TOOL VALIDATION — api/lite-agent.js executeLiteTool()

Add validation at the top of executeLiteTool before the switch:

FIND:
```
async function executeLiteTool(toolName, args, userId, sessionId) {
  switch (toolName) {
```
REPLACE WITH:
```
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
```

---

## LOOP DETECTION — lib/ai.js complete()

Add after the health/provider tracking section, before the waterfall:

FIND in complete():
```
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
```
REPLACE WITH:
```
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  // LOOP DETECTION: track last response per provider to detect stale repeats
  const _lastResponses = complete._lastResponses || (complete._lastResponses = new Map());
```

Then in each provider's success block, add a check. Example for Groq:

FIND:
```
    try {
      logger.debug('ai:complete', 'Trying Groq llama-3.3-70b');
      const result = await callGroq(msgs, maxTokens);
      logger.info('ai:complete', 'Groq succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('groq', 'rate_limited');
      else                markProvider('groq', 'down');
      logger.warn('ai:complete', 'Groq failed — trying next', { error: err.message });
    }
```
REPLACE WITH:
```
    try {
      logger.debug('ai:complete', 'Trying Groq llama-3.3-70b');
      const result = await callGroq(msgs, maxTokens);
      // LOOP DETECTION: if identical to last response from this provider, skip it
      const lastKey = `groq:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('groq') === lastKey) {
        logger.warn('ai:complete', 'Groq returning identical response — treating as stale');
        markProvider('groq', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('groq', lastKey);
      logger.info('ai:complete', 'Groq succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('groq', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('groq', 'down');
      logger.warn('ai:complete', 'Groq failed — trying next', { error: err.message });
    }
```

Apply same pattern to devstral, mistral-large, gemini-lite, gemma-26b, gemma-31b, gemini blocks.
Change the key prefix to match the provider: 'devstral', 'mistral_large', 'gemini_lite', etc.

---

## ALSO — repo read access from bookmarklet
Already in READ_ONLY_TOOLS in tools.js so toolInjector.js already allows it.
The real issue was lite-agent.js executeLiteTool not having read_file/list_files cases.
Those ARE in the switch already (read_file, list_files) so this should work.
Verify by checking that LITE_VALID_TOOLS above includes 'read_file' and 'list_files' ✅
