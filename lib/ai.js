/**
 * @file ai.js
 * @location /backend/lib/ai.js
 *
 * @purpose
 * Unified AI provider abstraction layer.
 * Handles text completion, streaming, FiM, and vision across all providers.
 * Implements waterfall fallback with per-provider health tracking.
 * Enforces Mistral 1 RPS gap (LAW 8) — two independent buckets.
 *
 * @exports
 *   complete(options)               → { text, model, tokens_used }
 *   fim(prefix, suffix, maxTokens)  → { text, model, tokens_used }
 *   stream(options, onChunk)        → { text, model, tokens_used }
 *   vision(imageSource, question, options) → { text, model, tokens_used }
 *   currentModel()                  → string | null
 *   modelStatus()                   → { [providerKey]: { status, available, downUntil } }
 *   markProvider(provider, type)    → void  (exported for visionHandler)
 *   mistralGap()                    → Promise<void>
 *   codestralGap()                  → Promise<void>
 *
 * @imports
 *   groq-sdk                  → Groq client
 *   @google/generative-ai     → GoogleGenerativeAI client
 *   ./logger                  → structured logger
 *   ../utils/constants        → MODELS, ENDPOINTS, RATE_LIMITS, PROVIDER_STATUS,
 *                               PROVIDER_COOLDOWN, AGENT, VISION
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   GROQ_API_KEY
 *   MISTRAL_API_KEY
 *   CODESTRAL_API_KEY
 *   GEMINI_API_KEY
 *
 * @dependency-level 2
 */

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
// Two INDEPENDENT 1 RPS buckets.
// api.mistral.ai    → devstral + mistral-large + leanstral share one bucket
// codestral.mistral.ai → codestral-latest has its own bucket
// Both can fire simultaneously — they are different endpoints.

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
// Tracks availability + cooldown per provider key.
// visionHandler.js imports markProvider to update vision-specific providers.

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

  state.status    = type === 'rate_limited'
    ? PROVIDER_STATUS.RATE_LIMITED
    : PROVIDER_STATUS.DOWN;
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
// Initialized on first use — avoids startup failures if keys are missing
// (env-check.js handles that separately).

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
// All providers normalize to: { text, model, tokens_used }

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
  await mistralGap(); // LAW 8 — always enforce before api.mistral.ai
  const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream:     false,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw Object.assign(
      new Error(data.message || res.statusText),
      { status: res.status }
    );
  }

  markOk('mistral_chat');
  return normalizeMistral(data, model);
}

/**
 * Calls a Gemini/Gemma model for text-only completion.
 * Converts messages array to flat prompt — Gemini doesn't use roles natively here.
 *
 * @param {string} providerKey  - health map key (gemini | gemini_lite | gemma_26b | gemma_31b)
 * @param {string} modelName    - exact model string from MODELS
 * @param {Array}  messages     - [{ role, content }]
 * @param {number} maxTokens
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
  return normalizeGemini(result, modelName);
}

// ── VISION CALLERS ─────────────────────────────────────────────────────────────
// Used internally by vision() — never by complete() or stream().
// Only Gemini/Gemma models support vision (LAW 12, LAW 21).

/**
 * Call a Gemini/Gemma vision model with an image URL.
 *
 * @param {string} providerKey
 * @param {string} modelName
 * @param {string} imageUrl
 * @param {string} mimeType
 * @param {string} question
 * @param {number} maxTokens
 */
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

/**
 * Call a Gemini/Gemma vision model with base64 inline image data.
 *
 * @param {string} providerKey
 * @param {string} modelName
 * @param {string} base64Data   - raw base64 string (no data URI prefix)
 * @param {string} mimeType
 * @param {string} question
 * @param {number} maxTokens
 */
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
// Maps vision model chain strings → health provider keys.

const VISION_MODEL_PROVIDER = {
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
  [MODELS.GEMINI_FLASH]:      'gemini',
};

// ── FiM — CODESTRAL FILL-IN-MIDDLE ────────────────────────────────────────────

/**
 * Fill-in-middle completion via Codestral.
 * Used exclusively for surgical_edit intent.
 * Independent RPS bucket from api.mistral.ai (LAW 8, LAW 12).
 *
 * @param {string} prefix     - code before the gap
 * @param {string} suffix     - code after the gap
 * @param {number} maxTokens
 * @returns {Promise<{ text, model, tokens_used }>}
 */
async function fim(prefix, suffix, maxTokens = AGENT.CODESTRAL_MAX_TOKENS) {
  if (!isUp('codestral')) {
    throw new Error('codestral_unavailable');
  }

  if (typeof prefix !== 'string' || typeof suffix !== 'string') {
    throw new Error('fim: prefix and suffix must be strings');
  }

  try {
    await codestralGap(); // LAW 8 — independent Codestral bucket

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
      const err = Object.assign(
        new Error(data.message || res.statusText),
        { status: res.status }
      );
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
// Order: groq → devstral → mistral-large → gemini-lite → gemma-26b → gemma-31b → gemini-2.5-flash
// Groq is skipped if preferCode=true (devstral is better for code writing).

/**
 * Complete a chat interaction using the provider waterfall.
 *
 * @param {Object} options
 * @param {Array}   options.messages      - [{ role, content }]
 * @param {number}  [options.maxTokens]   - max response tokens
 * @param {boolean} [options.preferCode]  - skip Groq, start with devstral
 * @param {string}  [options.systemPrompt]- prepended as system message
 * @returns {Promise<{ text, model, tokens_used }>}
 */
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

  // ── 1. Groq llama-3.3-70b — primary brain (skip if preferCode) ────────────
  if (!preferCode && isUp('groq')) {
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
  }

  // ── 2. Devstral — primary code model ──────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying devstral-medium-2507');
      const result = await callMistralChat(MODELS.MISTRAL_CODE, msgs, maxTokens);
      logger.info('ai:complete', 'Devstral succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.status === 429) markProvider('mistral_chat', 'rate_limited');
      else                    markProvider('mistral_chat', 'down');
      logger.warn('ai:complete', 'Devstral failed — trying next', { error: err.message });
    }
  }

  // ── 3. Mistral-large — fallback brain ─────────────────────────────────────
  if (isUp('mistral_chat')) {
    try {
      logger.debug('ai:complete', 'Trying mistral-large-2512');
      const result = await callMistralChat(MODELS.MISTRAL_LARGE, msgs, maxTokens);
      logger.info('ai:complete', 'Mistral-large succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.status === 429) markProvider('mistral_chat', 'rate_limited');
      else                    markProvider('mistral_chat', 'down');
      logger.warn('ai:complete', 'Mistral-large failed — trying next', { error: err.message });
    }
  }

  // ── 4. Gemini flash-lite — 500 RPD fast fallback ──────────────────────────
  if (isUp('gemini_lite')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-3.1-flash-lite-preview');
      const result = await callGeminiText('gemini_lite', MODELS.GEMINI_FLASH_LITE, msgs, maxTokens);
      logger.info('ai:complete', 'Gemini flash-lite succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message?.includes('429') || err.status === 429) markProvider('gemini_lite', 'rate_limited');
      else                                                     markProvider('gemini_lite', 'down');
      logger.warn('ai:complete', 'Gemini flash-lite failed — trying next', { error: err.message });
    }
  }

  // ── 5. Gemma 26B MoE — 1.5K RPD ──────────────────────────────────────────
  if (isUp('gemma_26b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-26b-a4b-it');
      const result = await callGeminiText('gemma_26b', MODELS.GEMMA_4_26B, msgs, maxTokens);
      logger.info('ai:complete', 'Gemma-26b succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message?.includes('429') || err.status === 429) markProvider('gemma_26b', 'rate_limited');
      else                                                     markProvider('gemma_26b', 'down');
      logger.warn('ai:complete', 'Gemma-26b failed — trying next', { error: err.message });
    }
  }

  // ── 6. Gemma 31B dense — 1.5K RPD ────────────────────────────────────────
  if (isUp('gemma_31b')) {
    try {
      logger.debug('ai:complete', 'Trying gemma-4-31b-it');
      const result = await callGeminiText('gemma_31b', MODELS.GEMMA_4_31B, msgs, maxTokens);
      logger.info('ai:complete', 'Gemma-31b succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message?.includes('429') || err.status === 429) markProvider('gemma_31b', 'rate_limited');
      else                                                     markProvider('gemma_31b', 'down');
      logger.warn('ai:complete', 'Gemma-31b failed — trying next', { error: err.message });
    }
  }

  // ── 7. Gemini 2.5-flash — ABSOLUTE LAST RESORT (20 RPD) ──────────────────
  if (isUp('gemini')) {
    try {
      logger.debug('ai:complete', 'Trying gemini-2.5-flash [LAST RESORT — 20 RPD]');
      const result = await callGeminiText('gemini', MODELS.GEMINI_FLASH, msgs, maxTokens);
      logger.info('ai:complete', 'Gemini-2.5-flash succeeded', { tokens: result.tokens_used });
      return result;
    } catch (err) {
      if (err.message?.includes('429') || err.status === 429) markProvider('gemini', 'rate_limited');
      else                                                     markProvider('gemini', 'down');
      logger.warn('ai:complete', 'Gemini-2.5-flash failed', { error: err.message });
    }
  }

  logger.error('ai:complete', 'All providers exhausted');
  throw new Error('all_providers_down');
}

// ── STREAMING ──────────────────────────────────────────────────────────────────
// Groq supports native streaming. All other providers fall back to complete()
// with the full text emitted as a single chunk.

/**
 * Stream a completion. Calls onChunk(delta) for each text chunk.
 *
 * @param {Object}   options     - same as complete()
 * @param {Function} onChunk     - (delta: string) => void
 * @returns {Promise<{ text, model, tokens_used }>}
 */
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

  // LOOP DETECTION: track last response per provider to detect stale repeats
  const _lastResponses = complete._lastResponses || (complete._lastResponses = new Map());

  // ── Groq native streaming ─────────────────────────────────────────────────
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
      logger.warn('ai:stream', 'Groq stream failed — falling back to complete()', {
        error: err.message,
      });
    }
  }

  // ── Fallback: complete() + emit full text as single chunk ─────────────────
  logger.debug('ai:stream', 'Groq unavailable — falling back to complete() for streaming');
  const result = await complete(options);
  onChunk(result.text);
  return result;
}

// ── VISION WATERFALL ───────────────────────────────────────────────────────────
// Vision uses ONLY Gemini/Gemma models (LAW 21).
// Chain order from VISION.MODEL_CHAIN: flash-lite → gemma-26b → gemma-31b → gemini-2.5-flash
// Accepts either imageUrl (string) OR base64Data+mimeType (inline).
// Images > 4MB (VISION.MAX_INLINE_BYTES) must be passed as URL (LAW 22).

/**
 * Analyze an image using the vision model chain.
 *
 * @param {Object} imageSource
 * @param {string} [imageSource.imageUrl]   - public image URL
 * @param {string} [imageSource.base64Data] - raw base64 (no data URI prefix)
 * @param {string} [imageSource.mimeType]   - MIME type (required for both modes)
 * @param {string} question                 - what to ask about the image
 * @param {Object} [options]
 * @param {number} [options.maxTokens]      - max response tokens
 * @returns {Promise<{ text, model, tokens_used }>}
 */
async function vision(imageSource, question, options = {}) {
  const { maxTokens = VISION.MAX_TOKENS } = options;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!imageSource || typeof imageSource !== 'object') {
    throw new Error('ai.vision: imageSource object is required');
  }

  const { imageUrl, base64Data, mimeType } = imageSource;
  const useUrl    = Boolean(imageUrl && typeof imageUrl === 'string');
  const useBase64 = Boolean(base64Data && typeof base64Data === 'string');

  if (!useUrl && !useBase64) {
    throw new Error('ai.vision: imageUrl or base64Data is required');
  }
  if (!mimeType || typeof mimeType !== 'string') {
    throw new Error('ai.vision: mimeType is required');
  }
  if (!VISION.SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`ai.vision: unsupported mimeType "${mimeType}"`);
  }
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new Error('ai.vision: question is required');
  }

  // Enforce 4MB inline limit — if base64Data exceeds limit, caller must use URL
  if (useBase64) {
    const byteSize = Math.ceil((base64Data.length * 3) / 4);
    if (byteSize > VISION.MAX_INLINE_BYTES) {
      throw new Error(
        `ai.vision: inline image exceeds ${VISION.MAX_INLINE_BYTES / 1024 / 1024}MB limit — pass as imageUrl instead`
      );
    }
  }

  // ── Vision model waterfall ─────────────────────────────────────────────────
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
      logger.debug('ai:vision', `Trying ${modelName} for vision`, {
        mode:     useUrl ? 'url' : 'base64',
        mimeType,
      });

      let result;

      if (useUrl) {
        result = await callGeminiVisionUrl(
          providerKey, modelName, imageUrl, mimeType, question.trim(), maxTokens
        );
      } else {
        result = await callGeminiVisionBase64(
          providerKey, modelName, base64Data, mimeType, question.trim(), maxTokens
        );
      }

      logger.info('ai:vision', `Vision succeeded via ${modelName}`, {
        tokens: result.tokens_used,
      });

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

/**
 * Returns the string name of the first available text-completion model.
 * Used by agent.js to surface which model is currently active.
 *
 * @returns {string | null}
 */
function currentModel() {
  if (isUp('groq'))         return MODELS.GROQ_BRAIN;
  if (isUp('mistral_chat')) return MODELS.MISTRAL_CODE;
  if (isUp('gemini_lite'))  return MODELS.GEMINI_FLASH_LITE;
  if (isUp('gemma_26b'))    return MODELS.GEMMA_4_26B;
  if (isUp('gemma_31b'))    return MODELS.GEMMA_4_31B;
  if (isUp('gemini'))       return MODELS.GEMINI_FLASH;
  return null;
}

/**
 * Returns the full health snapshot for all providers.
 * Consumed by api/health.js and api/agent.js (status endpoint).
 *
 * @returns {{ [providerKey]: { status, available, downUntil } }}
 */
function modelStatus() {
  return Object.fromEntries(
    Object.entries(health).map(([provider, state]) => [
      provider,
      {
        status:    state.status,
        available: isUp(provider),
        downUntil: state.downUntil > 0
          ? new Date(state.downUntil).toISOString()
          : null,
      },
    ])
  );
}

// ── EXPORTS ────────────────────────────────────────────────────────────────────

module.exports = {
  complete,
  fim,
  stream,
  vision,
  currentModel,
  modelStatus,
  markProvider,   // exported for visionHandler.js
  mistralGap,     // exported for any direct mistral callers
  codestralGap,   // exported for any direct codestral callers
};
