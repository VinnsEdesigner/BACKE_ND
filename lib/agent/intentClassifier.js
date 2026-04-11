/**
 * @file intentClassifier.js
 * @location /backend/lib/agent/intentClassifier.js
 *
 * @purpose
 * Classifies user message intent using keyword heuristics first,
 * with AI fallback for ambiguous cases. Returns a normalized intent
 * that maps directly into modelRouter.js and toolInjector.js.
 *
 * Classification pipeline:
 *   1. Keyword rules (fast, zero tokens, deterministic)
 *   2. Conversational continuity (if previous intent exists)
 *   3. AI fallback via complete() (only when keywords are ambiguous)
 *
 * All returned intents are canonical strings from INTENTS enum.
 * modelRouter.js and tools.js both depend on these exact strings.
 *
 * @exports
 *   classify(message, context)       → Promise<ClassifyResult>
 *   classifySync(message)            → ClassifyResult  (keyword-only, no AI)
 *   classifyByKeywords(message)      → { intent, confidence, matched }
 *   classifyByAI(message)            → Promise<{ intent, confidence, source }>
 *   normalizeIntent(raw)             → string (canonical intent or 'chat')
 *   buildResult(intent, conf, src)   → ClassifyResult
 *   INTENTS                          → canonical intent enum
 *   INTENT_ALIASES                   → variant → canonical map
 *   INTENT_META                      → intent → metadata map
 *
 * @imports
 *   ../logger             → child('intentClassifier')
 *   ../ai                 → complete() for AI fallback
 *   ../../utils/constants → MODELS (unused directly — ai.js handles selection)
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   none (ai.js handles provider keys)
 *
 * @dependency-level 3
 */

'use strict';

const logger     = require('../logger').child('intentClassifier');
const { complete } = require('../ai');

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL INTENTS
// These are the ONLY intent strings accepted by modelRouter.js and tools.js.
// Any classification must resolve to one of these exactly.
// ─────────────────────────────────────────────────────────────────────────────

const INTENTS = {
  CHAT:          'chat',
  REASONING:     'reasoning',
  CODE_WRITE:    'code_write',
  SURGICAL_EDIT: 'surgical_edit',
  CODE_REVIEW:   'code_review',
  RESEARCH:      'research',
  GIT_OPS:       'git_ops',
  DEPLOY:        'deploy',
  SEARCH:        'search',
  VISION:        'vision',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT ALIASES
// Maps legacy names, variants, and loose matches → canonical intents.
// normalizeIntent() uses this map exclusively.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_ALIASES = {
  // Canonical self-maps
  chat:          INTENTS.CHAT,
  reasoning:     INTENTS.REASONING,
  code_write:    INTENTS.CODE_WRITE,
  surgical_edit: INTENTS.SURGICAL_EDIT,
  code_review:   INTENTS.CODE_REVIEW,
  research:      INTENTS.RESEARCH,
  git_ops:       INTENTS.GIT_OPS,
  deploy:        INTENTS.DEPLOY,
  search:        INTENTS.SEARCH,
  vision:        INTENTS.VISION,

  // Code variants
  code_edit:     INTENTS.SURGICAL_EDIT,
  file_ops:      INTENTS.CODE_WRITE,
  debug:         INTENTS.REASONING,
  explain:       INTENTS.CHAT,
  multi_step:    INTENTS.REASONING,
  write:         INTENTS.CODE_WRITE,
  edit:          INTENTS.SURGICAL_EDIT,
  fix:           INTENTS.SURGICAL_EDIT,
  refactor:      INTENTS.SURGICAL_EDIT,
  review:        INTENTS.CODE_REVIEW,
  analyse:       INTENTS.CODE_REVIEW,

  // Git/deploy variants
  merge:         INTENTS.GIT_OPS,
  pr:            INTENTS.GIT_OPS,
  branch:        INTENTS.GIT_OPS,
  push:          INTENTS.DEPLOY,
  release:       INTENTS.DEPLOY,
  publish:       INTENTS.DEPLOY,

  // Search variants
  find:          INTENTS.SEARCH,
  lookup:        INTENTS.SEARCH,
  google:        INTENTS.SEARCH,

  // Vision variants — must not collide with code_review 'analyze' alias
  image:         INTENTS.VISION,
  ocr:           INTENTS.VISION,
  screenshot:    INTENTS.VISION,
  analyze_image: INTENTS.VISION,
  vision_task:   INTENTS.VISION,
  describe_image:INTENTS.VISION,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT METADATA
// Controls model selection, tool injection, and tone per intent.
// All fields consumed by modelRouter.js, toolInjector.js, and agent.js.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_META = {
  [INTENTS.CHAT]: {
    preferCode:  false,
    needsTools:  false,
    isMultiStep: false,
    tone:        'chat',
  },
  [INTENTS.REASONING]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: true,
    tone:        'analytical',
  },
  [INTENTS.CODE_WRITE]: {
    preferCode:  true,
    needsTools:  true,
    isMultiStep: false,
    tone:        'code',
  },
  [INTENTS.SURGICAL_EDIT]: {
    preferCode:  true,
    needsTools:  true,
    isMultiStep: false,
    tone:        'code',
  },
  [INTENTS.CODE_REVIEW]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'review',
  },
  [INTENTS.RESEARCH]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'analytical',
  },
  [INTENTS.GIT_OPS]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'code',
  },
  [INTENTS.DEPLOY]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'code',
  },
  [INTENTS.SEARCH]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'chat',
  },
  // Vision: uses Gemini/Gemma chain (enforced by visionHandler, not modelRouter)
  // preferCode: false — vision models are not code models
  // needsTools: true — analyze_image tool is required
  // isMultiStep: false — single vision analysis call
  // tone: 'explain' — describing visual content
  [INTENTS.VISION]: {
    preferCode:  false,
    needsTools:  true,
    isMultiStep: false,
    tone:        'explain',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD RULES
// Ordered by specificity — first match wins.
// More specific patterns must come before broader ones to avoid collisions.
// Vision patterns come before code_review to prevent "analyze image"
// from matching the code_review "analyze" alias.
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_RULES = [

  // ── Vision (MUST be before code_review — "analyze image" collision risk) ──
  {
    pattern: /\b(analyze image|analyse image|describe (this |the |my )?image|what('s| is) in (this |the )?image|look at (this |the )?image|read (this |the )?image|what does (this |the )?image show|screenshot analysis|ocr|extract text from image|image to text)\b/i,
    intent:  INTENTS.VISION,
  },
  {
    // Catches "analyze this screenshot", "describe screenshot", etc.
    pattern: /\b(screenshot|image|photo|picture|thumbnail)\b.{0,40}\b(analyze|analyse|describe|explain|read|extract|what|show|tell me)\b/i,
    intent:  INTENTS.VISION,
  },
  {
    // Catches "what is this image", "tell me about this photo"
    pattern: /\b(what|tell me|explain).{0,20}\b(image|screenshot|photo|picture|thumbnail)\b/i,
    intent:  INTENTS.VISION,
  },

  // ── Surgical edit ─────────────────────────────────────────────────────────
  {
    pattern: /\b(patch|fix line|edit line|change line|surgically|just change|update line|modify line)\b/i,
    intent:  INTENTS.SURGICAL_EDIT,
  },
  {
    pattern: /\b(fix|update|edit|modify|change|refactor|rename)\s+(the|this|that|a)?\s*(function|method|variable|class|import|line|code)\b/i,
    intent:  INTENTS.SURGICAL_EDIT,
  },

  // ── Code write ────────────────────────────────────────────────────────────
  {
    pattern: /\b(write|create|add|generate|build|implement)\s+(a|an|the|new)?\s*(file|function|class|component|module|route|endpoint|api|service|helper|util|hook|middleware)\b/i,
    intent:  INTENTS.CODE_WRITE,
  },
  {
    pattern: /\b(scaffold|boilerplate|template|stub|skeleton)\b/i,
    intent:  INTENTS.CODE_WRITE,
  },

  // ── Code review ───────────────────────────────────────────────────────────
  {
    // "analyze" here is scoped to code — NOT images (vision rules above are more specific)
    pattern: /\b(review|check|audit|inspect|look at|analyze|analyse|examine)\s+(the|this|my)?\s*(code|file|function|pr|pull request|commit|diff)\b/i,
    intent:  INTENTS.CODE_REVIEW,
  },

  // ── Git operations ────────────────────────────────────────────────────────
  {
    pattern: /\b(merge|pull request|open PR|create PR|close PR)\b/i,
    intent:  INTENTS.GIT_OPS,
  },
  {
    pattern: /\b(create branch|new branch|checkout|switch branch|delete branch)\b/i,
    intent:  INTENTS.GIT_OPS,
  },
  {
    pattern: /\b(rebase|cherry-pick|squash|amend commit)\b/i,
    intent:  INTENTS.GIT_OPS,
  },

  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    pattern: /\b(deploy|push to|release|publish|ship|go live)\b/i,
    intent:  INTENTS.DEPLOY,
  },

  // ── Research ──────────────────────────────────────────────────────────────
  {
    pattern: /\b(research|investigate|deep dive|explore|compare|contrast|pros and cons|best practices)\b/i,
    intent:  INTENTS.RESEARCH,
  },
  {
    pattern: /\b(what are the options|what('s| is) the best way|how should I|recommend)\b/i,
    intent:  INTENTS.RESEARCH,
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    pattern: /\b(search|find|look up|google|what is|who is|latest|news|docs|documentation)\b/i,
    intent:  INTENTS.SEARCH,
  },

  // ── Reasoning ─────────────────────────────────────────────────────────────
  {
    pattern: /\b(debug|error|bug|crash|fail|broken|not working|exception|stack trace|why does|why is)\b/i,
    intent:  INTENTS.REASONING,
  },
  {
    pattern: /\b(figure out|work through|step by step|think through|reason about|analyze this|complex)\b/i,
    intent:  INTENTS.REASONING,
  },
  {
    pattern: /\b(then|after that|next|finally|step \d|first.*then|plan)\b/i,
    intent:  INTENTS.REASONING,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// AI CLASSIFIER PROMPT
// Must include all canonical intents including vision.
// Response must be a single intent word — max 20 tokens.
// ─────────────────────────────────────────────────────────────────────────────

const AI_CLASSIFIER_PROMPT = `You are an intent classifier for a coding assistant.

Given a user message, classify it into exactly one of these intents:
- chat: casual conversation, greetings, thanks, unrelated questions
- reasoning: debugging, complex logic, multi-step analysis, "why" questions
- code_write: creating new files, functions, components, modules
- surgical_edit: fixing, updating, modifying existing code (small targeted changes)
- code_review: reviewing, auditing, analyzing code quality
- research: deep exploration, comparisons, best practices, recommendations
- git_ops: branches, pull requests, merges, commits, rebasing
- deploy: deploying, releasing, publishing, shipping
- search: quick lookups, finding docs, news, simple "what is" questions
- vision: analyzing images, describing screenshots, OCR, image content questions

Respond with ONLY the intent name — one word, nothing else.`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize any intent string (including aliases) to a canonical INTENTS value.
 * Returns INTENTS.CHAT if unrecognized — never throws.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeIntent(raw) {
  if (!raw || typeof raw !== 'string') return INTENTS.CHAT;
  const cleaned = raw.trim().toLowerCase().replace(/[\s\-]+/g, '_');
  return INTENT_ALIASES[cleaned] || INTENTS.CHAT;
}

/**
 * Build a full classification result object.
 * Pulls metadata from INTENT_META — falls back to chat meta if intent unknown.
 *
 * @param {string} intent     - canonical intent string
 * @param {number} confidence - 0.0 to 1.0
 * @param {string} source     - 'keyword' | 'ai' | 'continuation' | 'keyword_fallback' | etc.
 * @returns {ClassifyResult}
 */
function buildResult(intent, confidence, source) {
  const meta = INTENT_META[intent] || INTENT_META[INTENTS.CHAT];

  return {
    intent,
    confidence,
    source,
    suggestedTone: meta.tone,
    preferCode:    meta.preferCode,
    needsTools:    meta.needsTools,
    isMultiStep:   meta.isMultiStep,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD CLASSIFIER
// Deterministic, zero tokens, zero network.
// First matching rule wins — order in KEYWORD_RULES is significant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify intent using keyword rules only.
 *
 * @param {string} message
 * @returns {{ intent: string, confidence: number, matched: boolean }}
 */
function classifyByKeywords(message) {
  if (!message || typeof message !== 'string') {
    return { intent: INTENTS.CHAT, confidence: 1.0, matched: false };
  }

  const text = message.trim();
  if (text.length === 0) {
    return { intent: INTENTS.CHAT, confidence: 1.0, matched: false };
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) {
      logger.debug('classifyByKeywords', `Matched intent "${rule.intent}"`, {
        pattern: rule.pattern.source.slice(0, 60),
        message: text.slice(0, 80),
      });
      return { intent: rule.intent, confidence: 0.88, matched: true };
    }
  }

  return { intent: INTENTS.CHAT, confidence: 0.5, matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CLASSIFIER
// Used only when keyword matching is ambiguous (confidence < threshold).
// Consumes tokens — kept minimal (max 20 tokens response).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify intent using a fast AI model call.
 * Truncates message to 500 chars to keep token cost minimal.
 *
 * @param {string} message
 * @returns {Promise<{ intent: string, confidence: number, source: string }>}
 */
async function classifyByAI(message) {
  if (!message || typeof message !== 'string' || message.trim().length < 3) {
    return { intent: INTENTS.CHAT, confidence: 1.0, source: 'ai_skip' };
  }

  try {
    const result = await complete({
      messages:     [{ role: 'user', content: message.slice(0, 500) }],
      systemPrompt: AI_CLASSIFIER_PROMPT,
      maxTokens:    20,
      preferCode:   false,
    });

    // Strip everything except lowercase letters and underscores
    const raw    = (result.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const intent = normalizeIntent(raw);

    logger.debug('classifyByAI', `AI classified "${intent}"`, {
      raw,
      model:   result.model,
      message: message.slice(0, 80),
    });

    return { intent, confidence: 0.82, source: 'ai' };
  } catch (err) {
    // Non-fatal — fall through to keyword result
    logger.warn('classifyByAI', 'AI classification failed — defaulting to chat', {
      error: err.message,
    });
    return { intent: INTENTS.CHAT, confidence: 0.5, source: 'ai_error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassifyContext
 * @property {'bookmarklet'|'dashboard'|'api'} [source]      - execution context
 * @property {string}  [sessionId]                           - current session ID
 * @property {string}  [previousIntent]                      - last classified intent
 * @property {boolean} [forceAI=false]                       - skip keywords, use AI directly
 */

/**
 * @typedef {Object} ClassifyResult
 * @property {string}  intent        - canonical intent string
 * @property {number}  confidence    - 0.0 to 1.0
 * @property {string}  source        - classification method used
 * @property {string}  suggestedTone - tone mode for personality
 * @property {boolean} preferCode    - whether to prefer code models
 * @property {boolean} needsTools    - whether to inject tools
 * @property {boolean} isMultiStep   - whether to create a task record
 */

/**
 * Classify user intent from message text.
 *
 * Pipeline:
 *   1. forceAI → skip keywords, use AI directly
 *   2. Keyword rules → high confidence match returns immediately
 *   3. Conversational continuity → continue previous intent if keywords didn't match
 *   4. AI fallback → for ambiguous messages
 *   5. Keyword fallback → return keyword result even if low confidence
 *
 * @param {string}         message
 * @param {ClassifyContext} context
 * @returns {Promise<ClassifyResult>}
 */
async function classify(message, context = {}) {
  const {
    forceAI        = false,
    previousIntent = null,
  } = context;

  // ── Force AI path ──────────────────────────────────────────────────────────
  if (forceAI) {
    const aiResult = await classifyByAI(message);
    return buildResult(aiResult.intent, aiResult.confidence, aiResult.source);
  }

  // ── Keyword classification ─────────────────────────────────────────────────
  const keywordResult = classifyByKeywords(message);

  // High confidence keyword match — return immediately, no AI call
  if (keywordResult.matched && keywordResult.confidence >= 0.75) {
    logger.debug('classify', `Keyword match → "${keywordResult.intent}" (${keywordResult.confidence})`);
    return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword');
  }

  // ── Conversational continuity ──────────────────────────────────────────────
  // If no keyword match and we have a previous intent, continue it.
  // Only applies to non-chat intents — chat doesn't carry over.
  if (!keywordResult.matched && previousIntent) {
    const normalized = normalizeIntent(previousIntent);
    if (normalized !== INTENTS.CHAT) {
      logger.debug('classify', `Continuing previous intent "${normalized}"`);
      return buildResult(normalized, 0.70, 'continuation');
    }
  }

  // ── AI fallback ────────────────────────────────────────────────────────────
  // Only invoke when keyword confidence is below threshold
  if (!keywordResult.matched || keywordResult.confidence < 0.60) {
    const aiResult = await classifyByAI(message);
    if (aiResult.confidence > keywordResult.confidence) {
      logger.debug('classify', `AI override → "${aiResult.intent}" (${aiResult.confidence})`);
      return buildResult(aiResult.intent, aiResult.confidence, aiResult.source);
    }
  }

  // ── Keyword fallback ───────────────────────────────────────────────────────
  // Return keyword result even at low confidence — better than nothing
  return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword_fallback');
}

/**
 * Synchronous keyword-only classification.
 * Use only when async is not available — no AI fallback.
 *
 * @param {string} message
 * @returns {ClassifyResult}
 */
function classifySync(message) {
  const keywordResult = classifyByKeywords(message);
  return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword_sync');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  classify,
  classifySync,
  classifyByKeywords,
  classifyByAI,
  normalizeIntent,
  buildResult,
  INTENTS,
  INTENT_ALIASES,
  INTENT_META,
};
