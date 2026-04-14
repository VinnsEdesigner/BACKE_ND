'use strict';

/**
 * lib/ai.js — AI provider abstraction with native tool calling + VERBOSE LOGGING
 *
 * Every provider call, fallback, rate limit, tool call, and error is logged
 * to stdout so it shows up in HF Spaces container logs.
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
  if (wait > 0) {
    logger.debug('ai:mistral', `Rate gap enforced — waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastMistralCall = Date.now();
}

async function codestralGap() {
  const wait = RATE_LIMITS.CODESTRAL_GAP_MS - (Date.now() - lastCodestralCall);
  if (wait > 0) {
    logger.debug('ai:codestral', `Rate gap enforced — waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
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
  logger.warn('ai', `Provider "${provider}" marked ${type} for ${cd / 1000}s`, {
    provider, type, cooldownSec: cd / 1000, recoversAt: new Date(state.downUntil).toISOString(),
  });
}

function markOk(p) {
  if (health[p]) {
    const wasDown = health[p].status !== PROVIDER_STATUS.OK;
    health[p].status = PROVIDER_STATUS.OK;
    health[p].downUntil = 0;
    if (wasDown) logger.info('ai', `Provider "${p}" recovered — status OK`, { provider: p });
  }
}

// ── SDK CLIENTS ────────────────────────────────────────────────────────────────
let _groq = null, _gemini = null;

function groqClient() {
  if (!_groq) {
    logger.debug('ai', 'Initializing Groq SDK client');
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

function geminiModel(name) {
  if (!_gemini) {
    logger.debug('ai', 'Initializing Google Generative AI client');
    _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _gemini.getGenerativeModel({ model: name });
}

// ── TOOL CALL NORMALIZERS ──────────────────────────────────────────────────────
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
    logger.warn('ai:gemini', `text() extraction failed for ${modelName}`, { model: modelName, error: e.message });
  }
  const tool_calls = parseGeminiToolCalls(text);
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
  logger.info('ai:groq', `Calling ${MODELS.GROQ_BRAIN}`, {
    model: MODELS.GROQ_BRAIN,
    msgCount: msgs.length,
    maxTokens,
    hasTools: toolSchemas?.length > 0,
    toolNames: toolSchemas?.map((t) => t.function?.name) || [],
  });

  const params = { model: MODELS.GROQ_BRAIN, messages: msgs, max_tokens: maxTokens, stream: false };
  if (toolSchemas?.length) { params.tools = toolSchemas; params.tool_choice = 'auto'; }

  const t0  = Date.now();
  const res = await groqClient().chat.completions.create(params);
  const dur = Date.now() - t0;

  const normalized = normalizeGroqResponse(res, MODELS.GROQ_BRAIN);
  markOk('groq');

  logger.info('ai:groq', `Response OK — ${normalized.tokens_used} tokens in ${dur}ms`, {
    model:      MODELS.GROQ_BRAIN,
    tokens:     normalized.tokens_used,
    durationMs: dur,
    toolCalls:  normalized.tool_calls.map((t) => t.name),
    textLen:    normalized.text.length,
  });

  return normalized;
}

async function callMistralChat(model, msgs, maxTokens, toolSchemas) {
  logger.info('ai:mistral', `Calling ${model}`, {
    model,
    msgCount: msgs.length,
    maxTokens,
    hasTools: toolSchemas?.length > 0,
    toolNames: toolSchemas?.map((t) => t.function?.name) || [],
  });

  await mistralGap();
  const body = { model, messages: msgs, max_tokens: maxTokens, stream: false };
  if (toolSchemas?.length) { body.tools = toolSchemas; body.tool_choice = 'auto'; }

  const t0  = Date.now();
  const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body:    JSON.stringify(body),
  });
  const dur  = Date.now() - t0;
  const data = await res.json();

  if (!res.ok) {
    logger.error('ai:mistral', `HTTP ${res.status} from ${model}`, {
      model, status: res.status, statusText: res.statusText,
      error: data.message || data.error || 'unknown',
      durationMs: dur,
    });
    throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  }

  const normalized = normalizeMistralResponse(data, model);
  markOk('mistral_chat');

  logger.info('ai:mistral', `Response OK — ${normalized.tokens_used} tokens in ${dur}ms`, {
    model,
    tokens:    normalized.tokens_used,
    durationMs: dur,
    toolCalls: normalized.tool_calls.map((t) => t.name),
    textLen:   normalized.text.length,
  });

  return normalized;
}

async function callGeminiText(providerKey, modelName, msgs, maxTokens, toolSchemas) {
  logger.info(`ai:${providerKey}`, `Calling ${modelName}`, {
    model: modelName, providerKey,
    msgCount: msgs.length, maxTokens,
    hasTools: toolSchemas?.length > 0,
  });

  let msgsToUse = msgs;
  if (toolSchemas?.length) {
    const xmlHint = buildGeminiToolInstruction(toolSchemas);
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
  const t0     = Date.now();
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  const dur    = Date.now() - t0;

  const normalized = normalizeGeminiResponse(result, modelName, providerKey);
  markOk(providerKey);

  logger.info(`ai:${providerKey}`, `Response OK — ${normalized.tokens_used} tokens in ${dur}ms`, {
    model: modelName, providerKey,
    tokens:    normalized.tokens_used,
    durationMs: dur,
    toolCalls: normalized.tool_calls.map((t) => t.name),
    textLen:   normalized.text.length,
  });

  return normalized;
}

async function callGeminiVisionUrl(providerKey, modelName, imageUrl, mimeType, question, maxTokens) {
  logger.info(`ai:vision`, `Vision URL call — ${modelName}`, {
    model: modelName, providerKey, mimeType,
    url: imageUrl.slice(0, 80), questionLen: question.length,
  });

  const model  = geminiModel(modelName);
  const t0     = Date.now();
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: question }, { fileData: { mimeType, fileUri: imageUrl } }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  const dur = Date.now() - t0;

  const normalized = normalizeGeminiResponse(result, modelName, providerKey);
  markOk(providerKey);

  logger.info(`ai:vision`, `Vision URL response OK — ${normalized.tokens_used} tokens in ${dur}ms`, {
    model: modelName, tokens: normalized.tokens_used, durationMs: dur,
  });

  return normalized;
}

async function callGeminiVisionBase64(providerKey, modelName, base64Data, mimeType, question, maxTokens) {
  const sizeKB = Math.round((base64Data.length * 3) / 4 / 1024);
  logger.info(`ai:vision`, `Vision base64 call — ${modelName}`, {
    model: modelName, providerKey, mimeType, sizeKB, questionLen: question.length,
  });

  const model  = geminiModel(modelName);
  const t0     = Date.now();
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: question }, { inlineData: { mimeType, data: base64Data } }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  const dur = Date.now() - t0;

  const normalized = normalizeGeminiResponse(result, modelName, providerKey);
  markOk(providerKey);

  logger.info(`ai:vision`, `Vision base64 response OK — ${normalized.tokens_used} tokens in ${dur}ms`, {
    model: modelName, tokens: normalized.tokens_used, durationMs: dur,
  });

  return normalized;
}

const VISION_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

// ── FiM ────────────────────────────────────────────────────────────────────────
async function fim(prefix, suffix, maxTokens = AGENT.CODESTRAL_MAX_TOKENS) {
  if (!isUp('codestral')) {
    logger.warn('ai:fim', 'Codestral unavailable — FiM skipped', { provider: 'codestral' });
    throw new Error('codestral_unavailable');
  }

  logger.info('ai:fim', `Calling Codestral FiM — ${MODELS.CODESTRAL_FIM}`, {
    model: MODELS.CODESTRAL_FIM, prefixLen: prefix.length, suffixLen: suffix.length, maxTokens,
  });

  await codestralGap();
  const t0  = Date.now();
  const res = await fetch(ENDPOINTS.CODESTRAL_FIM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CODESTRAL_API_KEY}` },
    body: JSON.stringify({ model: MODELS.CODESTRAL_FIM, prompt: prefix, suffix, max_tokens: maxTokens, stop: ['</s>'] }),
  });
  const data = await res.json();
  const dur  = Date.now() - t0;

  if (!res.ok) {
    logger.error('ai:fim', `Codestral FiM HTTP ${res.status}`, {
      status: res.status, error: data.message || 'unknown', durationMs: dur,
    });
    if (res.status === 429) markProvider('codestral', 'rate_limited');
    else markProvider('codestral', 'down');
    throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  }

  markOk('codestral');
  const tokens = data.usage?.total_tokens || 0;

  logger.info('ai:fim', `Codestral FiM OK — ${tokens} tokens in ${dur}ms`, {
    model: MODELS.CODESTRAL_FIM, tokens, durationMs: dur,
  });

  return {
    text: data.choices[0]?.message?.content || '',
    model: MODELS.CODESTRAL_FIM,
    tokens_used: tokens,
    tool_calls: [],
    provider_key: 'codestral',
  };
}

// ── COMPLETE (main waterfall) ──────────────────────────────────────────────────
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

  logger.debug('ai', `complete() called`, {
    msgCount: msgs.length, maxTokens, preferCode, hasTools,
    toolNames: toolSchemas?.map((t) => t.function?.name) || [],
  });

  const tryProvider = async (key, callFn, staleKey) => {
    if (!isUp(key)) {
      logger.debug('ai', `Skipping ${key} — currently down/rate-limited`, {
        provider: key, downUntil: health[key]?.downUntil ? new Date(health[key].downUntil).toISOString() : null,
      });
      return null;
    }
    try {
      const result = await callFn();
      const ck     = `${staleKey}:${result.text.slice(0, 80)}`;
      if (!result.tool_calls.length && _last.get(staleKey) === ck) {
        logger.warn('ai', `Stale response detected from ${key} — marking rate-limited`, { provider: key });
        markProvider(key, 'rate_limited');
        throw new Error('stale');
      }
      if (!result.tool_calls.length) _last.set(staleKey, ck);
      return result;
    } catch (err) {
      const s = err.status || err.statusCode;
      if (s === 429) markProvider(key, 'rate_limited');
      else if (err.message !== 'stale') markProvider(key, 'down');
      logger.warn('ai', `Provider ${key} failed — falling back`, {
        provider: key, error: err.message, status: s || null,
      });
      return null;
    }
  };

  // ── 1. Groq ────────────────────────────────────────────────────────────────
  if (!preferCode) {
    const r = await tryProvider('groq',
      () => callGroq(msgs, maxTokens, hasTools ? toolSchemas : []),
      'groq');
    if (r) return r;
  } else {
    logger.debug('ai', 'Groq skipped — preferCode=true');
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

  // ── 4-7. Gemini/Gemma ─────────────────────────────────────────────────────
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

  logger.error('ai', 'ALL PROVIDERS EXHAUSTED — complete() failed', {
    providers: Object.entries(health).map(([k, v]) => ({
      provider: k,
      status: v.status,
      downUntil: v.downUntil > 0 ? new Date(v.downUntil).toISOString() : null,
    })),
  });
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────
async function stream(options = {}, onChunk) {
  const { messages, maxTokens = AGENT.MAX_TOKENS, systemPrompt = null } = options;
  if (!messages?.length) throw new Error('ai.stream: messages required');
  if (typeof onChunk !== 'function') throw new Error('ai.stream: onChunk required');

  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  logger.info('ai:stream', `Stream requested`, { msgCount: msgs.length, maxTokens });

  if (isUp('groq')) {
    try {
      logger.info('ai:stream', `Streaming via Groq ${MODELS.GROQ_BRAIN}`);
      const s = await groqClient().chat.completions.create({ model: MODELS.GROQ_BRAIN, messages: msgs, max_tokens: maxTokens, stream: true });
      let text = '', tok = 0;
      for await (const chunk of s) {
        const d = chunk.choices[0]?.delta?.content || '';
        if (d) { text += d; onChunk(d); }
        if (chunk.usage) tok = chunk.usage.total_tokens;
      }
      markOk('groq');
      logger.info('ai:stream', `Stream complete — ${tok} tokens`);
      return { text, model: MODELS.GROQ_BRAIN, tokens_used: tok, tool_calls: [], provider_key: 'groq' };
    } catch (err) {
      const s = err.status || err.statusCode;
      if (s === 429) markProvider('groq', 'rate_limited'); else markProvider('groq', 'down');
      logger.warn('ai:stream', `Groq stream failed — falling back to complete()`, { error: err.message });
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
  if (!VISION.SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`ai.vision: unsupported mimeType "${mimeType}"`);
  if (!question?.trim()) throw new Error('ai.vision: question required');

  if (useBase64 && Math.ceil((base64Data.length * 3) / 4) > VISION.MAX_INLINE_BYTES) {
    throw new Error('ai.vision: image too large for inline');
  }

  logger.info('ai:vision', `Vision call started`, {
    mode: useUrl ? 'url' : 'base64', mimeType, maxTokens,
    urlPreview: useUrl ? imageUrl.slice(0, 80) : null,
  });

  for (const modelName of VISION.MODEL_CHAIN) {
    const pk = VISION_PROVIDER[modelName];
    if (!pk || !isUp(pk)) {
      logger.debug('ai:vision', `Skipping ${modelName} — provider ${pk} down`);
      continue;
    }
    try {
      const r = useUrl
        ? await callGeminiVisionUrl(pk, modelName, imageUrl, mimeType, question.trim(), maxTokens)
        : await callGeminiVisionBase64(pk, modelName, base64Data, mimeType, question.trim(), maxTokens);
      return r;
    } catch (err) {
      const isRateLimit = err.message?.includes('429');
      markProvider(pk, isRateLimit ? 'rate_limited' : 'down');
      logger.warn('ai:vision', `${modelName} failed — trying next`, {
        model: modelName, error: err.message,
      });
    }
  }

  logger.error('ai:vision', 'ALL VISION PROVIDERS EXHAUSTED');
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

module.exports = {
  complete, fim, stream, vision,
  currentModel, modelStatus,
  markProvider, mistralGap, codestralGap,
  parseGeminiToolCalls,
};
