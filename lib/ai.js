'use strict';

const Groq                  = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger                = require('./logger');
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
  if (!state) {
    logger.warn('ai:markProvider', `Unknown provider key: ${provider}`);
    return;
  }
  const cooldown = type === 'rate_limited'
    ? PROVIDER_COOLDOWN.RATE_LIMITED
    : PROVIDER_COOLDOWN.DOWN;
  state.status    = type === 'rate_limited' ? PROVIDER_STATUS.RATE_LIMITED : PROVIDER_STATUS.DOWN;
  state.downUntil = Date.now() + cooldown;
  logger.warn('ai', `Provider "${provider}" marked ${type} — cooldown ${cooldown / 1000}s`, {
    downUntil: new Date(state.downUntil).toISOString(),
  });
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
function normalizeGroq(res, modelName) {
  return {
    text:        res.choices[0]?.message?.content || '',
    model:       modelName,
    tokens_used: res.usage?.total_tokens || 0,
  };
}

function normalizeMistral(data, modelName) {
  return {
    text:        data.choices[0]?.message?.content || '',
    model:       modelName,
    tokens_used: data.usage?.total_tokens || 0,
  };
}

function normalizeGemini(result, modelName) {
  let text = '';
  try {
    text = result.response.text() || '';
  } catch (err) {
    logger.warn('ai:normalizeGemini', 'Failed to extract text from Gemini response', {
      model: modelName,
      error: err.message,
    });
  }
  return {
    text,
    model:       modelName,
    tokens_used: result.response.usageMetadata?.totalTokenCount || 0,
  };
}

// ── INDIVIDUAL PROVIDER CALLERS ────────────────────────────────────────────────
async function callGroq(messages, maxTokens) {
  const res = await groqClient().chat.completions.create({
    model:      MODELS.GROQ_BRAIN,
    messages,
    max_tokens: maxTokens,
    stream:     false,
  });
  markOk('groq');
  return normalizeGroq(res, MODELS.GROQ_BRAIN);
}

async function callMistralChat(model, messages, maxTokens) {
  await mistralGap();
  const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.message || res.statusText), { status: res.status });
  }
  markOk('mistral_chat');
  return normalizeMistral(data, model);
}

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
  return normalizeGemini(result, modelName);
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
  return normalizeGemini(result, modelName);
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
  return normalizeGemini(result, modelName);
}

// ── VISION PROVIDER KEY MAP ────────────────────────────────────────────────────
const VISION_MODEL_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

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
    };
  } catch (err) {
    logger.error('ai:fim', 'Codestral FiM failed', { error: err.message, status: err.status });
    throw err;
  }
}

// ── TEXT COMPLETION WATERFALL ──────────────────────────────────────────────────
async function complete(options = {}) {
  const {
    messages,
    maxTokens    = AGENT.MAX_TOKENS,
    preferCode   = false,
    systemPrompt = null,
  } = options;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('ai.complete: messages array is required and must not be empty');
  }

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  // LOOP DETECTION: track last response per provider to detect stale repeats
  const _lastResponses = complete._lastResponses || (complete._lastResponses = new Map());

  // ── 1. Groq (skip if preferCode) ──────────────────────────────────────────
  if (!preferCode && isUp('groq')) {
    try {
      logger.debug('ai:complete', 'Trying Groq llama-3.3-70b');
      const result = await callGroq(msgs, maxTokens);
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
  }

  // ── 2. Devstral ───────────────────────────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying devstral-medium-2507');
      const result = await callMistralChat(MODELS.MISTRAL_CODE, msgs, maxTokens);
      const lastKey = `devstral:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('devstral') === lastKey) {
        logger.warn('ai:complete', 'Devstral returning identical response — treating as stale');
        markProvider('mistral_chat', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('devstral', lastKey);
      logger.info('ai:complete', 'Devstral succeeded', { tokens: result.tokens_used });
      return result;
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
      const result = await callMistralChat(MODELS.MISTRAL_LARGE, msgs, maxTokens);
      const lastKey = `mistral_large:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('mistral_large') === lastKey) {
        logger.warn('ai:complete', 'Mistral-large returning identical response — treating as stale');
        markProvider('mistral_chat', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('mistral_large', lastKey);
      logger.info('ai:complete', 'Mistral-large succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('mistral_chat', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('mistral_chat', 'down');
      logger.warn('ai:complete', 'Mistral-large failed — trying next', { error: err.message });
    }
  }

  // ── 4. Gemini flash-lite ──────────────────────────────────────────────────
  if (isUp('gemini_lite')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-3.1-flash-lite-preview');
      const result = await callGeminiText('gemini_lite', MODELS.GEMINI_FLASH_LITE, msgs, maxTokens);
      const lastKey = `gemini_lite:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('gemini_lite') === lastKey) {
        logger.warn('ai:complete', 'Gemini flash-lite returning identical response — treating as stale');
        markProvider('gemini_lite', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('gemini_lite', lastKey);
      logger.info('ai:complete', 'Gemini flash-lite succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429) markProvider('gemini_lite', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('gemini_lite', 'down');
      logger.warn('ai:complete', 'Gemini flash-lite failed — trying next', { error: err.message });
    }
  }

  // ── 5. Gemma 26B ──────────────────────────────────────────────────────────
  if (isUp('gemma_26b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-26b-a4b-it');
      const result = await callGeminiText('gemma_26b', MODELS.GEMMA_4_26B, msgs, maxTokens);
      const lastKey = `gemma_26b:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('gemma_26b') === lastKey) {
        logger.warn('ai:complete', 'Gemma-26b returning identical response — treating as stale');
        markProvider('gemma_26b', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('gemma_26b', lastKey);
      logger.info('ai:complete', 'Gemma-26b succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429) markProvider('gemma_26b', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('gemma_26b', 'down');
      logger.warn('ai:complete', 'Gemma-26b failed — trying next', { error: err.message });
    }
  }

  // ── 6. Gemma 31B ──────────────────────────────────────────────────────────
  if (isUp('gemma_31b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-31b-it');
      const result = await callGeminiText('gemma_31b', MODELS.GEMMA_4_31B, msgs, maxTokens);
      const lastKey = `gemma_31b:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('gemma_31b') === lastKey) {
        logger.warn('ai:complete', 'Gemma-31b returning identical response — treating as stale');
        markProvider('gemma_31b', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('gemma_31b', lastKey);
      logger.info('ai:complete', 'Gemma-31b succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429) markProvider('gemma_31b', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('gemma_31b', 'down');
      logger.warn('ai:complete', 'Gemma-31b failed — trying next', { error: err.message });
    }
  }

  // ── 7. Gemini 2.5-flash — LAST RESORT ─────────────────────────────────────
  if (isUp('gemini')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-2.5-flash [LAST RESORT — 20 RPD]');
      const result = await callGeminiText('gemini', MODELS.GEMINI_FLASH, msgs, maxTokens);
      const lastKey = `gemini:${result.text.slice(0, 100)}`;
      if (_lastResponses.get('gemini') === lastKey) {
        logger.warn('ai:complete', 'Gemini returning identical response — treating as stale');
        markProvider('gemini', 'rate_limited');
        throw new Error('stale_response');
      }
      _lastResponses.set('gemini', lastKey);
      logger.info('ai:complete', 'Gemini-2.5-flash succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      const is429 = err.message?.includes('429') || err.status === 429;
      if (is429) markProvider('gemini', 'rate_limited');
      else if (err.message !== 'stale_response') markProvider('gemini', 'down');
      logger.warn('ai:complete', 'Gemini-2.5-flash failed', { error: err.message });
    }
  }

  logger.error('ai:complete', 'All providers exhausted');
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────
async function stream(options = {}, onChunk) {
  const {
    messages,
    maxTokens    = AGENT.MAX_TOKENS,
    systemPrompt = null,
  } = options;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('ai.stream: messages array is required and must not be empty');
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
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
        if (chunk.usage) tokensUsed = chunk.usage.total_tokens;
      }
      markOk('groq');
      return { text: fullText, model: MODELS.GROQ_BRAIN, tokens_used: tokensUsed };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (status === 429) markProvider('groq', 'rate_limited');
      else                markProvider('groq', 'down');
      logger.warn('ai:stream', 'Groq stream failed — falling back to complete()', { error: err.message });
    }
  }

  logger.debug('ai:stream', 'Groq unavailable — falling back to complete() for streaming');
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
      throw new Error(`ai.vision: inline image exceeds ${VISION.MAX_INLINE_BYTES / 1024 / 1024}MB limit — pass as imageUrl instead`);
    }
  }

  for (const modelName of VISION.MODEL_CHAIN) {
    const providerKey = VISION_MODEL_PROVIDER[modelName];
    if (!providerKey) {
      logger.warn('ai:vision', `No provider key for vision model "${modelName}" — skipping`);
      continue;
    }
    if (!isUp(providerKey)) {
      logger.debug('ai:vision', `Provider "${providerKey}" is down — skipping ${modelName}`);
      continue;
    }
    try {
      logger.debug('ai:vision', `Trying ${modelName} for vision`, { mode: useUrl ? 'url' : 'base64', mimeType });
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
};
