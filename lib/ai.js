'use strict';

/**
 * @file ai.js
 * @location /backend/lib/ai.js
 *
 * Native tool calling per provider:
 *   Groq         → OpenAI-compatible tools array + tool_calls response field
 *   Mistral      → Mistral native function calling (same OpenAI format, different endpoint)
 *   Gemini/Gemma → XML tags <tool>{"tool":"x","args":{}}</tool> in text response
 *
 * complete() returns:
 *   { text, model, tokens_used, tool_calls: [{name, args}] }
 *
 * tool_calls is always an array (empty if no tools called).
 * For Groq/Mistral: extracted from response.choices[0].message.tool_calls
 * For Gemini/Gemma: parsed from <tool>...</tool> tags in response text
 * The caller (lite-agent/agent) just reads result.tool_calls — zero regex.
 */

const Groq                   = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger                 = require('./logger');
const {
  MODELS, ENDPOINTS, RATE_LIMITS,
  PROVIDER_STATUS, PROVIDER_COOLDOWN,
  AGENT, VISION, TOOL_CALLING,
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
  if (!state) { logger.warn('ai:markProvider', `Unknown provider: ${provider}`); return; }
  const cooldown = type === 'rate_limited' ? PROVIDER_COOLDOWN.RATE_LIMITED : PROVIDER_COOLDOWN.DOWN;
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

// ── XML TOOL CALL PARSER (for Gemini/Gemma) ────────────────────────────────────
// Parses <tool>{"tool":"name","args":{...}}</tool> tags from response text.
// Returns { cleanText, toolCalls }

function parseXmlToolCalls(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { cleanText: responseText || '', toolCalls: [] };
  }

  const toolCalls  = [];
  const xmlOpen    = TOOL_CALLING.XML_OPEN;
  const xmlClose   = TOOL_CALLING.XML_CLOSE;
  let   cleanText  = responseText;
  let   searchFrom = 0;

  while (true) {
    const openIdx  = cleanText.indexOf(xmlOpen, searchFrom);
    if (openIdx === -1) break;
    const closeIdx = cleanText.indexOf(xmlClose, openIdx);
    if (closeIdx === -1) break;

    const inner = cleanText.slice(openIdx + xmlOpen.length, closeIdx).trim();

    try {
      const parsed = JSON.parse(inner);
      const name   = parsed.tool || parsed.name;
      const args   = parsed.args || parsed.arguments || {};
      if (name) toolCalls.push({ name, args });
    } catch {
      logger.debug('ai:parseXmlToolCalls', 'Failed to parse XML tool call JSON', { inner: inner.slice(0, 100) });
    }

    // Remove the tag from cleanText
    cleanText  = cleanText.slice(0, openIdx) + cleanText.slice(closeIdx + xmlClose.length);
    searchFrom = openIdx;
  }

  return { cleanText: cleanText.trim(), toolCalls };
}

// ── TOOL SCHEMA CONVERTER ─────────────────────────────────────────────────────
// Converts OpenAI-compatible tool schema to Mistral format (same shape, confirming)
// and builds XML instruction block for Gemini/Gemma.

function buildXmlToolInstructions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const toolDescriptions = tools.map((t) => {
    const fn     = t.function || t;
    const name   = fn.name || t.name;
    const desc   = fn.description || '';
    const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : '{}';
    return `Tool: ${name}\nDescription: ${desc}\nParameters: ${params}`;
  }).join('\n\n');

  return `[TOOL CALLING — XML FORMAT]
When you need a tool, embed it in your response using XML tags:
${TOOL_CALLING.XML_OPEN}{"tool": "tool_name", "args": {"param": "value"}}${TOOL_CALLING.XML_CLOSE}
After the tool result is injected, continue your response normally.
Only use tools from the list below. Never invent tool names.

Available tools:
${toolDescriptions}`;
}

// ── NORMALIZERS ───────────────────────────────────────────────────────────────

function normalizeGroqResult(res, modelName) {
  const choice      = res.choices[0];
  const text        = choice?.message?.content || '';
  const rawCalls    = choice?.message?.tool_calls || [];
  const toolCalls   = rawCalls.map((tc) => ({
    name: tc.function?.name || tc.name,
    args: (() => {
      try { return JSON.parse(tc.function?.arguments || '{}'); }
      catch { return tc.function?.arguments || {}; }
    })(),
  })).filter((tc) => tc.name);

  return { text, model: modelName, tokens_used: res.usage?.total_tokens || 0, tool_calls: toolCalls };
}

function normalizeMistralResult(data, modelName) {
  const choice    = data.choices[0];
  const text      = choice?.message?.content || '';
  const rawCalls  = choice?.message?.tool_calls || [];
  const toolCalls = rawCalls.map((tc) => ({
    name: tc.function?.name || tc.name,
    args: (() => {
      try { return JSON.parse(tc.function?.arguments || '{}'); }
      catch { return tc.function?.arguments || {}; }
    })(),
  })).filter((tc) => tc.name);

  return { text, model: modelName, tokens_used: data.usage?.total_tokens || 0, tool_calls: toolCalls };
}

function normalizeGeminiResult(result, modelName) {
  let rawText = '';
  try { rawText = result.response.text() || ''; }
  catch (err) { logger.warn('ai:normalizeGemini', 'Failed to extract text', { model: modelName, error: err.message }); }

  const { cleanText, toolCalls } = parseXmlToolCalls(rawText);

  return {
    text:        cleanText,
    model:       modelName,
    tokens_used: result.response.usageMetadata?.totalTokenCount || 0,
    tool_calls:  toolCalls,
  };
}

// ── INDIVIDUAL PROVIDER CALLERS ────────────────────────────────────────────────

async function callGroq(messages, maxTokens, tools) {
  const params = {
    model:      MODELS.GROQ_BRAIN,
    messages,
    max_tokens: maxTokens,
    stream:     false,
  };

  // Native OpenAI tool calling
  if (Array.isArray(tools) && tools.length > 0) {
    params.tools       = tools;
    params.tool_choice = 'auto';
  }

  const res = await groqClient().chat.completions.create(params);
  markOk('groq');
  return normalizeGroqResult(res, MODELS.GROQ_BRAIN);
}

async function callMistralChat(model, messages, maxTokens, tools) {
  await mistralGap();

  const body = { model, messages, max_tokens: maxTokens, stream: false };

  // Native Mistral function calling (same OpenAI format)
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools       = tools;
    body.tool_choice = 'auto';
  }

  const res  = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  markOk('mistral_chat');
  return normalizeMistralResult(data, model);
}

async function callGeminiText(providerKey, modelName, messages, maxTokens, tools) {
  // For Gemini/Gemma: inject XML tool instructions into system prompt if tools provided
  let msgsWithTools = messages;
  if (Array.isArray(tools) && tools.length > 0) {
    const xmlInstructions = buildXmlToolInstructions(tools);
    // Prepend to system message or first message
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    msgsWithTools   = [...messages];
    if (systemIdx >= 0) {
      msgsWithTools[systemIdx] = {
        ...msgsWithTools[systemIdx],
        content: msgsWithTools[systemIdx].content + '\n\n' + xmlInstructions,
      };
    } else {
      msgsWithTools = [{ role: 'system', content: xmlInstructions }, ...msgsWithTools];
    }
  }

  const prompt = msgsWithTools
    .map((m) => {
      if (m.role === 'system') return m.content;
      return `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content}`;
    })
    .join('\n');

  const model  = geminiModel(modelName);
  const result = await model.generateContent({
    contents:         [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  markOk(providerKey);
  return normalizeGeminiResult(result, modelName);
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
  return normalizeGeminiResult(result, modelName);
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
  return normalizeGeminiResult(result, modelName);
}

// ── VISION PROVIDER KEY MAP ────────────────────────────────────────────────────
const VISION_MODEL_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

// ── FiM ───────────────────────────────────────────────────────────────────────

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
// tools parameter: OpenAI-compatible tool schema array (optional)
// Returns: { text, model, tokens_used, tool_calls: [{name, args}] }

async function complete(options = {}) {
  const {
    messages,
    maxTokens    = AGENT.MAX_TOKENS,
    preferCode   = false,
    systemPrompt = null,
    tools        = [],        // ← OpenAI-compatible tool schema array
  } = options;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('ai.complete: messages array is required and must not be empty');
  }

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  // Stale response detection
  const _last = complete._last || (complete._last = new Map());

  // ── 1. Groq (skip if preferCode) ──────────────────────────────────────────
  if (!preferCode && isUp('groq')) {
    try {
      logger.debug('ai:complete', 'Trying Groq llama-3.3-70b');
      const result  = await callGroq(msgs, maxTokens, tools);
      const lastKey = `groq:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('groq') === lastKey) {
        logger.warn('ai:complete', 'Groq stale response'); markProvider('groq', 'rate_limited'); throw new Error('stale');
      }
      _last.set('groq', lastKey);
      logger.info('ai:complete', 'Groq ok', { tokens: result.tokens_used, tools: result.tool_calls.length });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const s = err.status || err.statusCode; if (s === 429) markProvider('groq', 'rate_limited'); else markProvider('groq', 'down'); }
      logger.warn('ai:complete', 'Groq failed', { error: err.message });
    }
  }

  // ── 2. Devstral ───────────────────────────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying devstral-medium-2507');
      const result  = await callMistralChat(MODELS.MISTRAL_CODE, msgs, maxTokens, tools);
      const lastKey = `devstral:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('devstral') === lastKey) {
        markProvider('mistral_chat', 'rate_limited'); throw new Error('stale');
      }
      _last.set('devstral', lastKey);
      logger.info('ai:complete', 'Devstral ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const s = err.status || err.statusCode; if (s === 429) markProvider('mistral_chat', 'rate_limited'); else markProvider('mistral_chat', 'down'); }
      logger.warn('ai:complete', 'Devstral failed', { error: err.message });
    }
  }

  // ── 3. Mistral-large ──────────────────────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying mistral-large-2512');
      const result  = await callMistralChat(MODELS.MISTRAL_LARGE, msgs, maxTokens, tools);
      const lastKey = `large:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('large') === lastKey) {
        markProvider('mistral_chat', 'rate_limited'); throw new Error('stale');
      }
      _last.set('large', lastKey);
      logger.info('ai:complete', 'Mistral-large ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const s = err.status || err.statusCode; if (s === 429) markProvider('mistral_chat', 'rate_limited'); else markProvider('mistral_chat', 'down'); }
      logger.warn('ai:complete', 'Mistral-large failed', { error: err.message });
    }
  }

  // ── 4. Gemini flash-lite ──────────────────────────────────────────────────
  if (isUp('gemini_lite')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-3.1-flash-lite-preview');
      const result  = await callGeminiText('gemini_lite', MODELS.GEMINI_FLASH_LITE, msgs, maxTokens, tools);
      const lastKey = `glite:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('glite') === lastKey) {
        markProvider('gemini_lite', 'rate_limited'); throw new Error('stale');
      }
      _last.set('glite', lastKey);
      logger.info('ai:complete', 'Gemini flash-lite ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const is429 = err.message?.includes('429') || err.status === 429; if (is429) markProvider('gemini_lite', 'rate_limited'); else markProvider('gemini_lite', 'down'); }
      logger.warn('ai:complete', 'Gemini flash-lite failed', { error: err.message });
    }
  }

  // ── 5. Gemma 26B ──────────────────────────────────────────────────────────
  if (isUp('gemma_26b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-26b-a4b-it');
      const result  = await callGeminiText('gemma_26b', MODELS.GEMMA_4_26B, msgs, maxTokens, tools);
      const lastKey = `g26b:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('g26b') === lastKey) {
        markProvider('gemma_26b', 'rate_limited'); throw new Error('stale');
      }
      _last.set('g26b', lastKey);
      logger.info('ai:complete', 'Gemma-26b ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const is429 = err.message?.includes('429') || err.status === 429; if (is429) markProvider('gemma_26b', 'rate_limited'); else markProvider('gemma_26b', 'down'); }
      logger.warn('ai:complete', 'Gemma-26b failed', { error: err.message });
    }
  }

  // ── 6. Gemma 31B ──────────────────────────────────────────────────────────
  if (isUp('gemma_31b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-31b-it');
      const result  = await callGeminiText('gemma_31b', MODELS.GEMMA_4_31B, msgs, maxTokens, tools);
      const lastKey = `g31b:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('g31b') === lastKey) {
        markProvider('gemma_31b', 'rate_limited'); throw new Error('stale');
      }
      _last.set('g31b', lastKey);
      logger.info('ai:complete', 'Gemma-31b ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const is429 = err.message?.includes('429') || err.status === 429; if (is429) markProvider('gemma_31b', 'rate_limited'); else markProvider('gemma_31b', 'down'); }
      logger.warn('ai:complete', 'Gemma-31b failed', { error: err.message });
    }
  }

  // ── 7. Gemini 2.5-flash — LAST RESORT ─────────────────────────────────────
  if (isUp('gemini')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-2.5-flash [LAST RESORT]');
      const result  = await callGeminiText('gemini', MODELS.GEMINI_FLASH, msgs, maxTokens, tools);
      const lastKey = `gflash:${result.text.slice(0, 80)}`;
      if (result.tool_calls.length === 0 && _last.get('gflash') === lastKey) {
        markProvider('gemini', 'rate_limited'); throw new Error('stale');
      }
      _last.set('gflash', lastKey);
      logger.info('ai:complete', 'Gemini-2.5-flash ok', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message !== 'stale') { const is429 = err.message?.includes('429') || err.status === 429; if (is429) markProvider('gemini', 'rate_limited'); else markProvider('gemini', 'down'); }
      logger.warn('ai:complete', 'Gemini-2.5-flash failed', { error: err.message });
    }
  }

  logger.error('ai:complete', 'All providers exhausted');
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────

async function stream(options = {}, onChunk) {
  const { messages, maxTokens = AGENT.MAX_TOKENS, systemPrompt = null } = options;
  if (!messages || !Array.isArray(messages) || messages.length === 0) throw new Error('ai.stream: messages required');
  if (typeof onChunk !== 'function') throw new Error('ai.stream: onChunk required');

  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;

  if (isUp('groq')) {
    try {
      const groqStream = await groqClient().chat.completions.create({
        model: MODELS.GROQ_BRAIN, messages: msgs, max_tokens: maxTokens, stream: true,
      });
      let fullText = ''; let tokensUsed = 0;
      for await (const chunk of groqStream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) { fullText += delta; onChunk(delta); }
        if (chunk.usage) tokensUsed = chunk.usage.total_tokens;
      }
      markOk('groq');
      return { text: fullText, model: MODELS.GROQ_BRAIN, tokens_used: tokensUsed, tool_calls: [] };
    } catch (err) {
      const s = err.status || err.statusCode;
      if (s === 429) markProvider('groq', 'rate_limited'); else markProvider('groq', 'down');
    }
  }

  const result = await complete(options);
  onChunk(result.text);
  return result;
}

// ── VISION WATERFALL ───────────────────────────────────────────────────────────

async function vision(imageSource, question, options = {}) {
  const { maxTokens = VISION.MAX_TOKENS } = options;
  if (!imageSource || typeof imageSource !== 'object') throw new Error('ai.vision: imageSource required');

  const { imageUrl, base64Data, mimeType } = imageSource;
  const useUrl    = Boolean(imageUrl && typeof imageUrl === 'string');
  const useBase64 = Boolean(base64Data && typeof base64Data === 'string');

  if (!useUrl && !useBase64) throw new Error('ai.vision: imageUrl or base64Data required');
  if (!mimeType) throw new Error('ai.vision: mimeType required');
  if (!VISION.SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error(`ai.vision: unsupported mimeType "${mimeType}"`);
  if (!question?.trim()) throw new Error('ai.vision: question required');

  if (useBase64) {
    const byteSize = Math.ceil((base64Data.length * 3) / 4);
    if (byteSize > VISION.MAX_INLINE_BYTES) throw new Error(`ai.vision: inline image exceeds ${VISION.MAX_INLINE_BYTES / 1024 / 1024}MB`);
  }

  for (const modelName of VISION.MODEL_CHAIN) {
    const providerKey = VISION_MODEL_PROVIDER[modelName];
    if (!providerKey || !isUp(providerKey)) continue;
    try {
      const result = useUrl
        ? await callGeminiVisionUrl(providerKey, modelName, imageUrl, mimeType, question.trim(), maxTokens)
        : await callGeminiVisionBase64(providerKey, modelName, base64Data, mimeType, question.trim(), maxTokens);
      logger.info('ai:vision', `Vision ok via ${modelName}`);
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      markProvider(providerKey, is429 ? 'rate_limited' : 'down');
    }
  }

  throw new Error('vision_unavailable');
}

// ── PUBLIC STATUS ──────────────────────────────────────────────────────────────

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
      { status: state.status, available: isUp(provider), downUntil: state.downUntil > 0 ? new Date(state.downUntil).toISOString() : null },
    ])
  );
}

module.exports = {
  complete, fim, stream, vision,
  currentModel, modelStatus,
  markProvider, mistralGap, codestralGap,
  parseXmlToolCalls, buildXmlToolInstructions,
};
