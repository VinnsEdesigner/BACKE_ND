'use strict';

const Groq                   = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger                 = require('./logger');
const {
  MODELS,
  ENDPOINTS,
  RATE_LIMITS,
  PROVIDER_STATUS,
  PROVIDER_COOLDOWN,
  AGENT,
  VISION,
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

// ── PROVIDER HEALTH STATE ──────────────────────────────────────────────────────
const health = {
  groq:         { status: PROVIDER_STATUS.OK, downUntil: 0 },
  mistral_chat: { status: PROVIDER_STATUS.OK, downUntil: 0 },
  codestral:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemini:       { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemini_lite:  { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemma_26b:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
  gemma_31b:    { status: PROVIDER_STATUS.OK, downUntil: 0 },
};

function isUp(provider) {
  const state = health[provider];
  if (!state) return false;
  return Date.now() > state.downUntil;
}

function markProvider(provider, type) {
  const state = health[provider];
  if (!state) { logger.warn('ai:markProvider', `Unknown provider key: ${provider}`); return; }
  const cooldown = type === 'rate_limited'
    ? PROVIDER_COOLDOWN.RATE_LIMITED
    : PROVIDER_COOLDOWN.DOWN;
  state.status    = type === 'rate_limited' ? PROVIDER_STATUS.RATE_LIMITED : PROVIDER_STATUS.DOWN;
  state.downUntil = Date.now() + cooldown;
  logger.warn('ai', `Provider "${provider}" marked ${type} — cooldown ${cooldown / 1000}s`);
}

function markOk(provider) {
  const state = health[provider];
  if (!state) return;
  state.status    = PROVIDER_STATUS.OK;
  state.downUntil = 0;
}

// ── SDK CLIENTS (lazy init) ────────────────────────────────────────────────────
let _groq   = null;
let _gemini = null;

function groqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

function geminiClient() {
  if (!_gemini) _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _gemini;
}

function geminiModel(modelName) {
  return geminiClient().getGenerativeModel({ model: modelName });
}

// ── SCHEMA NORMALIZERS ─────────────────────────────────────────────────────────

/**
 * Normalize a Groq/OpenAI response.
 * Handles both text replies and native tool_calls.
 */
function normalizeGroqResponse(res, modelName) {
  const choice     = res.choices[0];
  const message    = choice?.message || {};
  const text       = message.content || '';
  const toolCalls  = message.tool_calls || [];

  return {
    text,
    model:       modelName,
    tokens_used: res.usage?.total_tokens || 0,
    // Native tool calls — already structured, no parsing needed
    tool_calls: toolCalls.map((tc) => ({
      name: tc.function?.name || tc.name || '',
      args: (() => {
        try {
          return typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || tc.args || {});
        } catch {
          return {};
        }
      })(),
      id: tc.id || null,
    })).filter((tc) => tc.name),
  };
}

/**
 * Normalize a Mistral response.
 * Mistral is OpenAI-compatible — same tool_calls shape as Groq.
 */
function normalizeMistralResponse(data, modelName) {
  const choice    = data.choices?.[0];
  const message   = choice?.message || {};
  const text      = message.content || '';
  const toolCalls = message.tool_calls || [];

  return {
    text,
    model:       modelName,
    tokens_used: data.usage?.total_tokens || 0,
    tool_calls: toolCalls.map((tc) => ({
      name: tc.function?.name || '',
      args: (() => {
        try {
          return typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || {});
        } catch {
          return {};
        }
      })(),
      id: tc.id || null,
    })).filter((tc) => tc.name),
  };
}

/**
 * Normalize a Gemini response.
 * Gemini does NOT support native tool_calls in the way Groq/Mistral do.
 * Tool calls are embedded in text using XML tags: <tool>{"tool":"x","args":{}}</tool>
 * We parse those here.
 */
function normalizeGeminiResponse(result, modelName) {
  let text = '';
  try {
    text = result.response.text() || '';
  } catch (err) {
    logger.warn('ai:normalizeGemini', 'Failed to extract text from Gemini response', {
      model: modelName, error: err.message,
    });
  }

  // Parse XML tool tags for Gemini
  const toolCalls = parseGeminiToolCalls(text);

  // Strip tool call XML from text response so only the human reply is shown
  const cleanText = toolCalls.length > 0
    ? text.replace(/<tool>[\s\S]*?<\/tool>/g, '').trim()
    : text;

  return {
    text:        cleanText,
    model:       modelName,
    tokens_used: result.response.usageMetadata?.totalTokenCount || 0,
    tool_calls:  toolCalls,
  };
}

/**
 * Parse XML tool call tags from Gemini text output.
 * Format: <tool>{"tool": "tool_name", "args": {...}}</tool>
 * This is only used for Gemini — Groq and Mistral use native tool_calls.
 *
 * @param {string} text
 * @returns {Array<{name: string, args: Object}>}
 */
function parseGeminiToolCalls(text) {
  if (!text || typeof text !== 'string') return [];

  const calls  = [];
  const regex  = /<tool>([\s\S]*?)<\/tool>/g;
  let   match;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const name   = parsed.tool || parsed.name || '';
      const args   = parsed.args || parsed.arguments || {};
      if (name) calls.push({ name, args, id: null });
    } catch {
      // Malformed tool tag — skip
    }
  }

  return calls;
}

// ── PROVIDER CALLERS ───────────────────────────────────────────────────────────

/**
 * Call Groq with optional native tool schemas.
 * When tools are provided, Groq returns tool_calls in the response — no regex.
 */
async function callGroq(messages, maxTokens, toolSchemas = []) {
  const params = {
    model:      MODELS.GROQ_BRAIN,
    messages,
    max_tokens: maxTokens,
    stream:     false,
  };

  // Native tool calling — Groq supports OpenAI-compatible tools
  if (toolSchemas && toolSchemas.length > 0) {
    params.tools       = toolSchemas;
    params.tool_choice = 'auto';
  }

  const res = await groqClient().chat.completions.create(params);
  markOk('groq');
  return normalizeGroqResponse(res, MODELS.GROQ_BRAIN);
}

/**
 * Call Mistral with optional native tool schemas.
 * Mistral is OpenAI-compatible — same tool_calls API as Groq.
 */
async function callMistralChat(model, messages, maxTokens, toolSchemas = []) {
  await mistralGap();

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    stream:     false,
  };

  if (toolSchemas && toolSchemas.length > 0) {
    body.tools       = toolSchemas;
    body.tool_choice = 'auto';
  }

  const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  }
  markOk('mistral_chat');
  return normalizeMistralResponse(data, model);
}

/**
 * Call Gemini for text.
 * Gemini does NOT support native tool_calls in OpenAI format.
 * Tools are injected as XML tag instructions in the system prompt by the caller.
 * We parse the XML tags out of the response here.
 */
async function callGeminiText(providerKey, modelName, messages, maxTokens) {
  const prompt = messages
    .map((m) => {
      if (m.role === 'system') return m.content;
      return `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`;
    })
    .join('\n');

  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName);
}

// ── VISION CALLERS ─────────────────────────────────────────────────────────────

async function callGeminiVisionUrl(providerKey, modelName, imageUrl, mimeType, question, maxTokens) {
  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{
      role:  'user',
      parts: [
        { text: question },
        { fileData: { mimeType, fileUri: imageUrl } },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName);
}

async function callGeminiVisionBase64(providerKey, modelName, base64Data, mimeType, question, maxTokens) {
  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents: [{
      role:  'user',
      parts: [
        { text: question },
        { inlineData: { mimeType, data: base64Data } },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResponse(result, modelName);
}

// ── GEMINI XML TOOL INSTRUCTIONS ───────────────────────────────────────────────
// Appended to system prompt by callers when using Gemini with tools.
// This is the ONLY place tool calling format is specified for Gemini.

const GEMINI_TOOL_INSTRUCTIONS = `
[TOOL CALLING — GEMINI MODE]
When you need to use a tool, embed the call in your response using XML tags:
<tool>{"tool": "tool_name", "args": {"key": "value"}}</tool>
After the tool result is injected back, continue your response.
Only call tools from the [AVAILABLE TOOLS THIS REQUEST] list.
Never print raw JSON outside of <tool> tags.
`.trim();

/**
 * Returns the XML tool instruction string for Gemini.
 * Callers append this to the system prompt when Gemini is selected AND tools are active.
 */
function getGeminiToolInstructions() {
  return GEMINI_TOOL_INSTRUCTIONS;
}

// ── VISION PROVIDER KEY MAP ────────────────────────────────────────────────────
const VISION_MODEL_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

// Which models support native tool_calls (OpenAI-compatible)
const NATIVE_TOOL_PROVIDERS = new Set(['groq', 'mistral_chat']);

/**
 * Check if a model/provider supports native tool calling.
 * Used by callers to decide whether to inject Gemini XML instructions.
 *
 * @param {string} providerKey
 * @returns {boolean}
 */
function supportsNativeTools(providerKey) {
  return NATIVE_TOOL_PROVIDERS.has(providerKey);
}

// ── FiM — CODESTRAL FILL-IN-MIDDLE ────────────────────────────────────────────
async function fim(prefix, suffix, maxTokens = AGENT.CODESTRAL_MAX_TOKENS) {
  if (!isUp('codestral')) throw new Error('codestral_unavailable');
  if (typeof prefix !== 'string' || typeof suffix !== 'string') {
    throw new Error('fim: prefix and suffix must be strings');
  }
  try {
    await codestralGap();
    const res = await fetch(ENDPOINTS.CODESTRAL_FIM, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${process.env.CODESTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model:      MODELS.CODESTRAL_FIM,
        prompt:     prefix,
        suffix,
        max_tokens: maxTokens,
        stop:       ['</s>'],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = Object.assign(new Error(data.message || res.statusText), { status: res.status });
      if (res.status === 429) markProvider('codestral', 'rate_limited');
      else                    markProvider('codestral', 'down');
      throw err;
    }
    markOk('codestral');
    return {
      text:        data.choices[0]?.message?.content || '',
      model:       MODELS.CODESTRAL_FIM,
      tokens_used: data.usage?.total_tokens || 0,
      tool_calls:  [],
    };
  } catch (err) {
    logger.error('ai:fim', 'Codestral FiM failed', { error: err.message });
    throw err;
  }
}

// ── TEXT COMPLETION WATERFALL ──────────────────────────────────────────────────
/**
 * Complete a request with tool calling support.
 *
 * @param {Object}  options
 * @param {Array}   options.messages
 * @param {number}  options.maxTokens
 * @param {boolean} options.preferCode
 * @param {string}  options.systemPrompt
 * @param {Array}   options.toolSchemas  - OpenAI-compatible tool schema array
 *                                        Passed natively to Groq/Mistral.
 *                                        For Gemini: caller should append getGeminiToolInstructions()
 *                                        to systemPrompt before calling complete().
 * @returns {Promise<{text, model, tokens_used, tool_calls, provider_key}>}
 */
async function complete(options = {}) {
  const {
    messages,
    maxTokens    = AGENT.MAX_TOKENS,
    preferCode   = false,
    systemPrompt = null,
    toolSchemas  = [],   // OpenAI-compatible tool schemas for native calling
  } = options;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('ai.complete: messages array is required and must not be empty');
  }

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const hasTools = Array.isArray(toolSchemas) && toolSchemas.length > 0;

  // Stale response detector
  const _lastResponses = complete._lastResponses || (complete._lastResponses = new Map());

  // ── 1. Groq (skip if preferCode) ──────────────────────────────────────────
  if (!preferCode && isUp('groq')) {
    try {
      logger.debug('ai:complete', 'Trying Groq llama-3.3-70b');
      // Pass tool schemas directly — Groq supports native tool_calls
      const result = await callGroq(msgs, maxTokens, hasTools ? toolSchemas : []);
      const lastKey = `groq:${result.text.slice(0, 100)}`;
      if (!result.tool_calls.length && _lastResponses.get('groq') === lastKey) {
        logger.warn('ai:complete', 'Groq returning identical response — stale');
        markProvider('groq', 'rate_limited');
        throw new Error('stale_response');
      }
      if (!result.tool_calls.length) _lastResponses.set('groq', lastKey);
      logger.info('ai:complete', 'Groq succeeded', { tokens: result.tokens_used, tool_calls: result.tool_calls.length });
      return { ...result, provider_key: 'groq' };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('groq', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('groq', 'down');
      logger.warn('ai:complete', 'Groq failed — trying next', { error: err.message });
    }
  }

  // ── 2. Devstral ───────────────────────────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying devstral-medium-2507');
      const result = await callMistralChat(MODELS.MISTRAL_CODE, msgs, maxTokens, hasTools ? toolSchemas : []);
      const lastKey = `devstral:${result.text.slice(0, 100)}`;
      if (!result.tool_calls.length && _lastResponses.get('devstral') === lastKey) {
        logger.warn('ai:complete', 'Devstral stale');
        markProvider('mistral_chat', 'rate_limited');
        throw new Error('stale_response');
      }
      if (!result.tool_calls.length) _lastResponses.set('devstral', lastKey);
      logger.info('ai:complete', 'Devstral succeeded', { tokens: result.tokens_used, tool_calls: result.tool_calls.length });
      return { ...result, provider_key: 'mistral_chat' };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('mistral_chat', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('mistral_chat', 'down');
      logger.warn('ai:complete', 'Devstral failed — trying next', { error: err.message });
    }
  }

  // ── 3. Mistral-large ──────────────────────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying mistral-large-2512');
      const result = await callMistralChat(MODELS.MISTRAL_LARGE, msgs, maxTokens, hasTools ? toolSchemas : []);
      const lastKey = `mistral_large:${result.text.slice(0, 100)}`;
      if (!result.tool_calls.length && _lastResponses.get('mistral_large') === lastKey) {
        logger.warn('ai:complete', 'Mistral-large stale');
        markProvider('mistral_chat', 'rate_limited');
        throw new Error('stale_response');
      }
      if (!result.tool_calls.length) _lastResponses.set('mistral_large', lastKey);
      logger.info('ai:complete', 'Mistral-large succeeded', { tokens: result.tokens_used });
      return { ...result, provider_key: 'mistral_chat' };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('mistral_chat', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('mistral_chat', 'down');
      logger.warn('ai:complete', 'Mistral-large failed — trying next', { error: err.message });
    }
  }

  // ── 4-7. Gemini/Gemma fallbacks ───────────────────────────────────────────
  // Note: Gemini does NOT support native tool_calls.
  // Callers that reach this point with tools active should have already
  // appended getGeminiToolInstructions() to their systemPrompt.
  // The XML tags are parsed in normalizeGeminiResponse().

  const geminiChain = [
    { key: 'gemini_lite', model: MODELS.GEMINI_FLASH_LITE },
    { key: 'gemma_26b',   model: MODELS.GEMMA_4_26B },
    { key: 'gemma_31b',   model: MODELS.GEMMA_4_31B },
    { key: 'gemini',      model: MODELS.GEMINI_FLASH },
  ];

  for (const { key, model } of geminiChain) {
    if (!isUp(key)) continue;
    try {
      logger.debug('ai:complete', `Trying ${model}`);
      const result    = await callGeminiText(key, model, msgs, maxTokens);
      const lastKey   = `${key}:${result.text.slice(0, 100)}`;
      if (!result.tool_calls.length && _lastResponses.get(key) === lastKey) {
        logger.warn('ai:complete', `${model} stale`);
        markProvider(key, 'rate_limited');
        throw new Error('stale_response');
      }
      if (!result.tool_calls.length) _lastResponses.set(key, lastKey);
      logger.info('ai:complete', `${model} succeeded`, { tokens: result.tokens_used, tool_calls: result.tool_calls.length });
      return { ...result, provider_key: key };
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429) markProvider(key, 'rate_limited');
      else if (err.message !== 'stale_response') markProvider(key, 'down');
      logger.warn('ai:complete', `${model} failed — trying next`, { error: err.message });
    }
  }

  logger.error('ai:complete', 'All providers exhausted');
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────
async function stream(options = {}, onChunk) {
  const { messages, maxTokens = AGENT.MAX_TOKENS, systemPrompt = null } = options;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('ai.stream: messages array is required');
  }
  if (typeof onChunk !== 'function') {
    throw new Error('ai.stream: onChunk callback is required');
  }

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  if (isUp('groq')) {
    try {
      logger.debug('ai:stream', 'Streaming via Groq');
      const groqStream = await groqClient().chat.completions.create({
        model:      MODELS.GROQ_BRAIN,
        messages:   msgs,
        max_tokens: maxTokens,
        stream:     true,
      });
      let fullText   = '';
      let tokensUsed = 0;
      for await (const chunk of groqStream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) { fullText += delta; onChunk(delta); }
        if (chunk.usage) tokensUsed = chunk.usage.total_tokens;
      }
      markOk('groq');
      return { text: fullText, model: MODELS.GROQ_BRAIN, tokens_used: tokensUsed, tool_calls: [], provider_key: 'groq' };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('groq', 'rate_limited');
      else                markProvider('groq', 'down');
      logger.warn('ai:stream', 'Groq stream failed — fallback to complete()', { error: err.message });
    }
  }

  logger.debug('ai:stream', 'Groq unavailable — falling back to complete()');
  const result = await complete(options);
  onChunk(result.text);
  return result;
}

// ── VISION WATERFALL ───────────────────────────────────────────────────────────
async function vision(imageSource, question, options = {}) {
  const { maxTokens = VISION.MAX_TOKENS } = options;

  if (!imageSource || typeof imageSource !== 'object') {
    throw new Error('ai.vision: imageSource object is required');
  }

  const { imageUrl, base64Data, mimeType } = imageSource;
  const useUrl    = Boolean(imageUrl && typeof imageUrl === 'string');
  const useBase64 = Boolean(base64Data && typeof base64Data === 'string');

  if (!useUrl && !useBase64) throw new Error('ai.vision: imageUrl or base64Data is required');
  if (!mimeType || typeof mimeType !== 'string') throw new Error('ai.vision: mimeType is required');
  if (!VISION.SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`ai.vision: unsupported mimeType "${mimeType}"`);
  if (!question || typeof question !== 'string' || !question.trim()) throw new Error('ai.vision: question is required');

  if (useBase64) {
    const byteSize = Math.ceil((base64Data.length * 3) / 4);
    if (byteSize > VISION.MAX_INLINE_BYTES) {
      throw new Error(`ai.vision: inline image exceeds ${VISION.MAX_INLINE_BYTES / 1024 / 1024}MB limit`);
    }
  }

  for (const modelName of VISION.MODEL_CHAIN) {
    const providerKey = VISION_MODEL_PROVIDER[modelName];
    if (!providerKey) continue;
    if (!isUp(providerKey)) continue;
    try {
      logger.debug('ai:vision', `Trying ${modelName}`, { mode: useUrl ? 'url' : 'base64', mimeType });
      const result = useUrl
        ? await callGeminiVisionUrl(providerKey, modelName, imageUrl, mimeType, question.trim(), maxTokens)
        : await callGeminiVisionBase64(providerKey, modelName, base64Data, mimeType, question.trim(), maxTokens);
      logger.info('ai:vision', `Vision succeeded via ${modelName}`, { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      markProvider(providerKey, is429 ? 'rate_limited' : 'down');
      logger.warn('ai:vision', `${modelName} failed — trying next`, { error: err.message });
    }
  }

  logger.error('ai:vision', 'All vision providers exhausted');
  throw new Error('vision_unavailable');
}

// ── PUBLIC STATUS HELPERS ──────────────────────────────────────────────────────
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
    Object.entries(health).map(([provider, state]) => [
      provider,
      {
        status:    state.status,
        available: isUp(provider),
        downUntil: state.downUntil > 0 ? new Date(state.downUntil).toISOString() : null,
      },
    ])
  );
}

module.exports = {
  complete,
  fim,
  stream,
  vision,
  currentModel,
  modelStatus,
  markProvider,
  mistralGap,
  codestralGap,
  supportsNativeTools,
  getGeminiToolInstructions,
  parseGeminiToolCalls,
};
