'use strict';

/**
 * lib/ai.js — AI provider abstraction with native tool calling
 *
 * TOOL CALLING STRATEGY:
 *   Groq + Mistral → native tool_calls (pass tools[] array, read tool_calls[] back)
 *   Gemini/Gemma   → XML tag fallback (inject instructions into last user msg, parse tags)
 *
 * Callers NEVER see the difference. They always:
 *   1. Pass toolSchemas to complete()
 *   2. Read result.tool_calls[] — always an array, empty = no call needed
 *
 * No regex. No parseToolCalls(). Tool_calls come back structured from the model.
 */

const Groq                   = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger                 = require('./logger');
const {
  MODELS, ENDPOINTS, RATE_LIMITS,
  PROVIDER_STATUS, PROVIDER_COOLDOWN, AGENT, VISION,
} = require('../utils/constants');

// ── MISTRAL GAP ENFORCERS (LAW 8) ─────────────────────────────────────────────
let lastMistralCall   = 0;
let lastCodestralCall = 0;

async function mistralGap() {
  const wait = RATE_LIMITS.MISTRAL_GAP_MS - (Date.now() - lastMistralCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastMistralCall = Date.now();
}

async function codestralGap() {
  const wait = RATE_LIMITS.CODESTRAL_GAP_MS - (Date.now() - lastCodestralCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCodestralCall = Date.now();
}

// ── PROVIDER HEALTH ────────────────────────────────────────────────────────────
const health = {
  groq:         { status: PROVIDER_STATUS.OK, downUntil: 0 },
  mistral_chat: { status: PROVIDER_STATUS.OK, downUntil: 0 },
  codestral:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemini:       { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemini_lite:  { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemma_26b:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemma_31b:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
};

function isUp(p) {
  return health[p] ? Date.now() > health[p].downUntil : false;
}

function markProvider(provider, type) {
  const state = health[provider];
  if (!state) return;
  const cd = type === 'rate_limited' ? PROVIDER_COOLDOWN.RATE_LIMITED : PROVIDER_COOLDOWN.DOWN;
  state.status    = type === 'rate_limited' ? PROVIDER_STATUS.RATE_LIMITED : PROVIDER_STATUS.DOWN;
  state.downUntil = Date.now() + cd;
  logger.warn('ai', `"${provider}" marked ${type} for ${cd / 1000}s`);
}

function markOk(p) {
  if (health[p]) { health[p].status = PROVIDER_STATUS.OK; health[p].downUntil = 0; }
}

// ── SDK CLIENTS ────────────────────────────────────────────────────────────────
let _groq = null, _gemini = null;

function groqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

function geminiModel(name) {
  if (!_gemini) _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _gemini.getGenerativeModel({ model: name });
}

// ── TOOL CALL NORMALIZERS ──────────────────────────────────────────────────────

/**
 * Normalize native tool_calls from Groq/Mistral OpenAI format.
 * tc.function.arguments is a JSON STRING — must be parsed.
 */
function normalizeNativeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || !rawToolCalls.length) return [];
  return rawToolCalls.map((tc) => {
    let args = {};
    try {
      args = typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : (tc.function?.arguments || {});
    } catch { args = {}; }
    return { name: tc.function?.name || '', args, id: tc.id || null };
  }).filter((tc) => tc.name);
}

/**
 * Parse XML tool tags from Gemini text.
 * <tool>{"tool":"name","args":{...}}</tool>
 */
function parseGeminiToolCalls(text) {
  if (!text) return [];
  const calls = [], re = /<tool>([\s\S]*?)<\/tool>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const p = JSON.parse(m[1].trim());
      const name = p.tool || p.name || '';
      if (name) calls.push({ name, args: p.args || p.arguments || {}, id: null });
    } catch {}
  }
  return calls;
}

/**
 * Build XML tool instruction to inject into Gemini's last user message.
 * Never goes in the system prompt — only in user message content.
 */
function buildGeminiToolInstruction(toolSchemas) {
  if (!toolSchemas?.length) return '';
  const list = toolSchemas
    .map((t) => `- ${t.function.name}: ${t.function.description || ''}`)
    .join('\n');
  return `\n\n[AVAILABLE TOOLS]\n${list}\n\nWhen you need a tool, include EXACTLY:\n<tool>{"tool": "tool_name", "args": {"key": "value"}}</tool>\nAfter the tool result is returned to you, continue your response using it.`;
}

// ── RESPONSE NORMALIZERS ───────────────────────────────────────────────────────

function normalizeGroqResponse(res, modelName) {
  const msg = res.choices[0]?.message || {};
  return {
    text:         msg.content || '',
    model:        modelName,
    tokens_used:  res.usage?.total_tokens || 0,
    tool_calls:   normalizeNativeToolCalls(msg.tool_calls || []),
    provider_key: 'groq',
  };
}

function normalizeMistralResponse(data, modelName) {
  const msg = data.choices?.[0]?.message || {};
  return {
    text:         msg.content || '',
    model:        modelName,
    tokens_used:  data.usage?.total_tokens || 0,
    tool_calls:   normalizeNativeToolCalls(msg.tool_calls || []),
    provider_key: 'mistral_chat',
  };
}

function normalizeGeminiResponse(result, modelName, providerKey) {
  let text = '';
  try { text = result.response.text() || ''; } catch (e) {
    logger.warn('ai:gemini', 'text() failed', { model: modelName, error: e.message });
  }
  const tool_calls = parseGeminiToolCalls(text);
  // Strip tool tags from displayed text
  const cleanText  = tool_calls.length ? text.replace(/<tool>[\s\S]*?<\/tool>/g, '').trim() : text;
  return {
    text:         cleanText,
    model:        modelName,
    tokens_used:  result.response.usageMetadata?.totalTokenCount || 0,
    tool_calls,
    provider_key: providerKey,
  };
}

// ── PROVIDER CALLERS ───────────────────────────────────────────────────────────

async function callGroq(msgs, maxTokens, toolSchemas) {
  const params = { model: MODELS.GROQ_BRAIN, messages: msgs, max_tokens: maxTokens, stream: false };
  if (toolSchemas?.length) { params.tools = toolSchemas; params.tool_choice = 'auto'; }
  const res = await groqClient().chat.completions.create(params);
  markOk('groq');
  return normalizeGroqResponse(res, MODELS.GROQ_BRAIN);
}

async function callMistralChat(model, msgs, maxTokens, toolSchemas) {
  await mistralGap();
  const body = { model, messages: msgs, max_tokens: maxTokens, stream: false };
  if (toolSchemas?.length) { body.tools = toolSchemas; body.tool_choice = 'auto'; }
  const res  = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  markOk('mistral_chat');
  return normalizeMistralResponse(data, model);
}

/**
 * Call Gemini text. Injects XML tool instructions into last user msg if tools active.
 */
async function callGeminiText(providerKey, modelName, msgs, maxTokens, toolSchemas) {
  let msgsToUse = msgs;

  if (toolSchemas?.length) {
    const xmlHint = buildGeminiToolInstruction(toolSchemas);
    // Inject into the last user message (not system prompt)
    msgsToUse = msgs.map((m, i) =>
      (i === msgs.length - 1 && m.role === 'user')
        ? { ...m, content: m.content + xmlHint }
        : m
    );
  }

  const prompt = msgsToUse
    .map((m) => m.role === 'system' ? m.content : `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`)
    .join('\n');

  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName, providerKey);
}

async function callGeminiVisionUrl(providerKey, modelName, imageUrl, mimeType, question, maxTokens) {
  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: question }, { fileData: { mimeType, fileUri: imageUrl } }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName, providerKey);
}

async function callGeminiVisionBase64(providerKey, modelName, base64Data, mimeType, question, maxTokens) {
  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: question }, { inlineData: { mimeType, data: base64Data } }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName, providerKey);
}

const VISION_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

// ── FiM ────────────────────────────────────────────────────────────────────────
async function fim(prefix, suffix, maxTokens = AGENT.CODESTRAL_MAX_TOKENS) {
  if (!isUp('codestral')) throw new Error('codestral_unavailable');
  await codestralGap();
  const res = await fetch(ENDPOINTS.CODESTRAL_FIM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CODESTRAL_API_KEY}` },
    body: JSON.stringify({ model: MODELS.CODESTRAL_FIM, prompt: prefix, suffix, max_tokens: maxTokens, stop: ['</s>'] }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) markProvider('codestral', 'rate_limited');
    else markProvider('codestral', 'down');
    throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  }
  markOk('codestral');
  return { text: data.choices[0]?.message?.content || '', model: MODELS.CODESTRAL_FIM, tokens_used: data.usage?.total_tokens || 0, tool_calls: [], provider_key: 'codestral' };
}

// ── COMPLETE (main waterfall) ──────────────────────────────────────────────────

/**
 * @param {Object}  options
 * @param {Array}   options.messages
 * @param {number}  [options.maxTokens]
 * @param {boolean} [options.preferCode]    skip Groq → prefer Mistral code models
 * @param {string}  [options.systemPrompt]
 * @param {Array}   [options.toolSchemas]   OpenAI-compatible tool schemas
 *
 * @returns {Promise<{text, model, tokens_used, tool_calls[], provider_key}>}
 *   tool_calls is ALWAYS an array. Empty = text reply. Populated = tool needed.
 */
async function complete(options = {}) {
  const {
    messages,
    maxTokens    = AGENT.MAX_TOKENS,
    preferCode   = false,
    systemPrompt = null,
    toolSchemas  = [],
  } = options;

  if (!messages?.length) throw new Error('ai.complete: messages required');

  const msgs     = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  const hasTools = Boolean(toolSchemas?.length);
  const _last    = complete._last || (complete._last = new Map());

  const tryProvider = async (key, callFn, staleKey) => {
    if (!isUp(key)) return null;
    try {
      const result = await callFn();
      const ck     = `${staleKey}:${result.text.slice(0, 80)}`;
      // Only stale-check when there are no tool calls (text-only response)
      if (!result.tool_calls.length && _last.get(staleKey) === ck) {
        markProvider(key, 'rate_limited'); throw new Error('stale');
      }
      if (!result.tool_calls.length) _last.set(staleKey, ck);
      logger.info('ai:complete', `${key} OK`, { tc: result.tool_calls.length, tok: result.tokens_used });
      return result;
    } catch (err) {
      const s = err.status || err.statusCode;
      if (s === 429) markProvider(key, 'rate_limited');
      else if (err.message !== 'stale') markProvider(key, 'down');
      logger.warn('ai:complete', `${key} failed: ${err.message}`);
      return null;
    }
  };

  // ── 1. Groq ────────────────────────────────────────────────────────────────
  if (!preferCode) {
    const r = await tryProvider('groq',
      () => callGroq(msgs, maxTokens, hasTools ? toolSchemas : []),
      'groq');
    if (r) return r;
  }

  // ── 2. Devstral ───────────────────────────────────────────────────────────
  {
    const r = await tryProvider('mistral_chat',
      () => callMistralChat(MODELS.MISTRAL_CODE, msgs, maxTokens, hasTools ? toolSchemas : []),
      'devstral');
    if (r) return r;
  }

  // ── 3. Mistral-large ──────────────────────────────────────────────────────
  {
    const r = await tryProvider('mistral_chat',
      () => callMistralChat(MODELS.MISTRAL_LARGE, msgs, maxTokens, hasTools ? toolSchemas : []),
      'mistral_large');
    if (r) return r;
  }

  // ── 4-7. Gemini/Gemma (XML tool fallback) ─────────────────────────────────
  const geminiChain = [
    { key: 'gemini_lite', model: MODELS.GEMINI_FLASH_LITE },
    { key: 'gemma_26b',   model: MODELS.GEMMA_4_26B },
    { key: 'gemma_31b',   model: MODELS.GEMMA_4_31B },
    { key: 'gemini',      model: MODELS.GEMINI_FLASH },
  ];

  for (const { key, model } of geminiChain) {
    const r = await tryProvider(key,
      () => callGeminiText(key, model, msgs, maxTokens, hasTools ? toolSchemas : []),
      key);
    if (r) return r;
  }

  logger.error('ai:complete', 'All providers exhausted');
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────
async function stream(options = {}, onChunk) {
  const { messages, maxTokens = AGENT.MAX_TOKENS, systemPrompt = null } = options;
  if (!messages?.length) throw new Error('ai.stream: messages required');
  if (typeof onChunk !== 'function') throw new Error('ai.stream: onChunk required');

  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;

  if (isUp('groq')) {
    try {
      const s = await groqClient().chat.completions.create({ model: MODELS.GROQ_BRAIN, messages: msgs, max_tokens: maxTokens, stream: true });
      let text = '', tok = 0;
      for await (const chunk of s) {
        const d = chunk.choices[0]?.delta?.content || '';
        if (d) { text += d; onChunk(d); }
        if (chunk.usage) tok = chunk.usage.total_tokens;
      }
      markOk('groq');
      return { text, model: MODELS.GROQ_BRAIN, tokens_used: tok, tool_calls: [], provider_key: 'groq' };
    } catch (err) {
      const s = err.status || err.statusCode;
      if (s === 429) markProvider('groq', 'rate_limited'); else markProvider('groq', 'down');
    }
  }

  const result = await complete(options);
  onChunk(result.text);
  return result;
}

// ── VISION ─────────────────────────────────────────────────────────────────────
async function vision(imageSource, question, options = {}) {
  const { maxTokens = VISION.MAX_TOKENS } = options;
  const { imageUrl, base64Data, mimeType } = imageSource || {};
  const useUrl    = Boolean(imageUrl);
  const useBase64 = Boolean(base64Data);

  if (!useUrl && !useBase64) throw new Error('ai.vision: imageUrl or base64Data required');
  if (!mimeType) throw new Error('ai.vision: mimeType required');
  if (!VISION.SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`ai.vision: unsupported mimeType`);
  if (!question?.trim()) throw new Error('ai.vision: question required');

  if (useBase64 && Math.ceil((base64Data.length * 3) / 4) > VISION.MAX_INLINE_BYTES) {
    throw new Error('ai.vision: image too large for inline');
  }

  for (const modelName of VISION.MODEL_CHAIN) {
    const pk = VISION_PROVIDER[modelName];
    if (!pk || !isUp(pk)) continue;
    try {
      const r = useUrl
        ? await callGeminiVisionUrl(pk, modelName, imageUrl, mimeType, question.trim(), maxTokens)
        : await callGeminiVisionBase64(pk, modelName, base64Data, mimeType, question.trim(), maxTokens);
      logger.info('ai:vision', `OK via ${modelName}`, { tok: r.tokens_used });
      return r;
    } catch (err) {
      markProvider(pk, err.message?.includes('429') ? 'rate_limited' : 'down');
    }
  }
  throw new Error('vision_unavailable');
}

// ── STATUS ─────────────────────────────────────────────────────────────────────
function currentModel() {
  if (isUp('groq'))         return MODELS.GROQ_BRAIN;
  if (isUp('mistral_chat')) return MODELS.MISTRAL_CODE;
  if (isUp('gemini_lite'))  return MODELS.GEMINI_FLASH_LITE;
  if (isUp('gemma_26b'))    return MODELS.GEMMA_4_26B;
  if (isUp('gemma_31b'))    return MODELS.GEMMA_4_31B;
  if (isUp('gemini'))       return MODELS.GEMINI_FLASH;
  return null;
}

function modelStatus() {
  return Object.fromEntries(
    Object.entries(health).map(([p, s]) => [p, {
      status: s.status, available: isUp(p),
      downUntil: s.downUntil > 0 ? new Date(s.downUntil).toISOString() : null,
    }])
  );
}

module.exports = { complete, fim, stream, vision, currentModel, modelStatus, markProvider, mistralGap, codestralGap, parseGeminiToolCalls };
