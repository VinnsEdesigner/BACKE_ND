/**
 * @file intentClassifier.js
 * @location /backend/lib/agent/intentClassifier.js
 *
 * @purpose
 * Classifies user intent from message text using keyword heuristics first,
 * then falls back to a lightweight AI classification if ambiguous.
 * Returns a normalized intent that maps directly to modelRouter.js and tools.js.
 *
 * @exports
 *   classify(message, context)    → { intent, confidence, suggestedTone, needsTools, isMultiStep, preferCode }
 *   classifyWithAI(message, context) → same shape, but uses AI fallback
 *   INTENTS                       → canonical intent enum
 *   INTENT_ALIASES                → maps legacy/variant names to canonical
 *   normalizeIntent(raw)          → converts any alias to canonical
 *
 * @imports
 *   ../logger       → child('intentClassifier')
 *   ../ai           → complete() for AI fallback
 *   ../../utils/constants → MODELS
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   none
 *
 * @dependency-level 3
 */

'use strict';

const logger = require('../logger').child('intentClassifier');
const { complete } = require('../ai');
const { MODELS } = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL INTENTS
// These are the ONLY intent strings that modelRouter.js and tools.js accept.
// All classification must resolve to one of these.
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
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT ALIASES
// Maps legacy names, variants, and loose matches to canonical intents.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_ALIASES = {
  // Canonical (maps to self)
  chat:          INTENTS.CHAT,
  reasoning:     INTENTS.REASONING,
  code_write:    INTENTS.CODE_WRITE,
  surgical_edit: INTENTS.SURGICAL_EDIT,
  code_review:   INTENTS.CODE_REVIEW,
  research:      INTENTS.RESEARCH,
  git_ops:       INTENTS.GIT_OPS,
  deploy:        INTENTS.DEPLOY,
  search:        INTENTS.SEARCH,

  // Legacy / variant names
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
  analyze:       INTENTS.CODE_REVIEW,
  analyse:       INTENTS.CODE_REVIEW,
  find:          INTENTS.SEARCH,
  lookup:        INTENTS.SEARCH,
  google:        INTENTS.SEARCH,
  merge:         INTENTS.GIT_OPS,
  pr:            INTENTS.GIT_OPS,
  branch:        INTENTS.GIT_OPS,
  push:          INTENTS.DEPLOY,
  release:       INTENTS.DEPLOY,
  publish:       INTENTS.DEPLOY,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT METADATA
// preferCode tells modelRouter to prefer code-specialized models.
// needsTools tells toolInjector to inject tools.
// isMultiStep signals multi-turn task handling.
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
};

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD RULES
// Ordered by specificity — first match wins.
// Each rule maps to a canonical intent.
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_RULES = [
  // ── Surgical edit (specific phrases) ─────────────────────────────────────
  {
    pattern: /\b(patch|fix line|edit line|change line|surgically|just change|update line|modify line)\b/i,
    intent:  INTENTS.SURGICAL_EDIT,
  },
  {
    pattern: /\b(fix|update|edit|modify|change|refactor|rename)\s+(the|this|that|a)?\s*(function|method|variable|class|import|line|code)\b/i,
    intent:  INTENTS.SURGICAL_EDIT,
  },

  // ── Code write (new files, new code) ─────────────────────────────────────
  {
    pattern: /\b(write|create|add|generate|build|implement)\s+(a|an|the|new)?\s*(file|function|class|component|module|route|endpoint|api|service|helper|util)\b/i,
    intent:  INTENTS.CODE_WRITE,
  },
  {
    pattern: /\b(scaffold|boilerplate|template|stub|skeleton)\b/i,
    intent:  INTENTS.CODE_WRITE,
  },

  // ── Code review ──────────────────────────────────────────────────────────
  {
    pattern: /\b(review|check|audit|inspect|look at|analyze|analyse|examine)\s+(the|this|my)?\s*(code|file|function|pr|pull request|commit|diff)\b/i,
    intent:  INTENTS.CODE_REVIEW,
  },

  // ── Git operations ───────────────────────────────────────────────────────
  {
    pattern: /\b(merge|pull request|PR|open PR|create PR|close PR)\b/i,
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

  // ── Deploy ───────────────────────────────────────────────────────────────
  {
    pattern: /\b(deploy|push to|release|publish|ship|go live)\b/i,
    intent:  INTENTS.DEPLOY,
  },

  // ── Research (deep synthesis) ────────────────────────────────────────────
  {
    pattern: /\b(research|investigate|deep dive|explore|compare|contrast|pros and cons|best practices)\b/i,
    intent:  INTENTS.RESEARCH,
  },
  {
    pattern: /\b(what are the options|what's the best way|how should I|recommend)\b/i,
    intent:  INTENTS.RESEARCH,
  },

  // ── Search (quick lookup) ────────────────────────────────────────────────
  {
    pattern: /\b(search|find|look up|google|what is|who is|latest|news|docs|documentation)\b/i,
    intent:  INTENTS.SEARCH,
  },

  // ── Reasoning (complex logic, debugging, multi-step) ─────────────────────
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
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize any intent string (including legacy names) to a canonical intent.
 * Returns INTENTS.CHAT if not recognized.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeIntent(raw) {
  if (!raw || typeof raw !== 'string') return INTENTS.CHAT;

  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return INTENT_ALIASES[cleaned] || INTENTS.CHAT;
}

/**
 * Build classification result object.
 *
 * @param {string} intent
 * @param {number} confidence
 * @param {string} source
 * @returns {object}
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
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify intent using keyword rules only.
 * Fast, zero tokens, deterministic.
 *
 * @param {string} message
 * @returns {{ intent: string, confidence: number, matched: boolean }}
 */
function classifyByKeywords(message) {
  if (!message || typeof message !== 'string') {
    return { intent: INTENTS.CHAT, confidence: 1.0, matched: false };
  }

  const text = message.trim();

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) {
      logger.debug(`Keyword match: ${rule.intent}`, {
        pattern: rule.pattern.source.slice(0, 50),
      });
      return { intent: rule.intent, confidence: 0.88, matched: true };
    }
  }

  return { intent: INTENTS.CHAT, confidence: 0.5, matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

const AI_CLASSIFIER_PROMPT = `You are an intent classifier for a coding assistant.

Given a user message, classify it into exactly one of these intents:
- chat: casual conversation, greetings, thanks, unrelated questions
- reasoning: debugging, complex logic, multi-step analysis, "why" questions
- code_write: creating new files, functions, components, modules
- surgical_edit: fixing, updating, modifying existing code (small changes)
- code_review: reviewing, auditing, analyzing code quality
- research: deep exploration, comparisons, best practices, recommendations
- git_ops: branches, PRs, merges, commits, rebasing
- deploy: deploying, releasing, publishing, shipping
- search: quick lookups, finding docs, news, simple "what is" questions

Respond with ONLY the intent name, nothing else.`;

/**
 * Classify intent using a fast AI model.
 * Used only when keyword matching has low confidence.
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
      messages: [{ role: 'user', content: message.slice(0, 500) }],
      systemPrompt: AI_CLASSIFIER_PROMPT,
      maxTokens: 20,
      preferCode: false,
    });

    const raw = (result.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const intent = normalizeIntent(raw);

    logger.debug(`AI classified: ${intent}`, { raw, model: result.model });

    return { intent, confidence: 0.82, source: 'ai' };
  } catch (err) {
    logger.warn('AI classification failed — defaulting to chat', { error: err.message });
    return { intent: INTENTS.CHAT, confidence: 0.5, source: 'ai_error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassifyContext
 * @property {string} [source] - 'bookmarklet' | 'dashboard' | 'api'
 * @property {string} [sessionId]
 * @property {string} [previousIntent]
 * @property {boolean} [forceAI] - skip keywords, use AI directly
 */

/**
 * Classify user intent from message text.
 * Uses keyword heuristics first, falls back to AI if ambiguous.
 *
 * @param {string} message
 * @param {ClassifyContext} context
 * @returns {Promise<{
 *   intent: string,
 *   confidence: number,
 *   source: string,
 *   suggestedTone: string,
 *   preferCode: boolean,
 *   needsTools: boolean,
 *   isMultiStep: boolean,
 * }>}
 */
async function classify(message, context = {}) {
  const { forceAI = false, previousIntent = null } = context;

  // Force AI classification if requested
  if (forceAI) {
    const aiResult = await classifyByAI(message);
    return buildResult(aiResult.intent, aiResult.confidence, aiResult.source);
  }

  // Try keyword classification first
  const keywordResult = classifyByKeywords(message);

  // If keywords matched with good confidence, use that
  if (keywordResult.matched && keywordResult.confidence >= 0.75) {
    return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword');
  }

  // If previous intent exists and keywords didn't match strongly,
  // consider continuing the same intent (conversational continuity)
  if (previousIntent && !keywordResult.matched) {
    const normalized = normalizeIntent(previousIntent);
    if (normalized !== INTENTS.CHAT) {
      logger.debug(`Continuing previous intent: ${normalized}`);
      return buildResult(normalized, 0.7, 'continuation');
    }
  }

  // Fall back to AI classification for ambiguous cases
  if (!keywordResult.matched || keywordResult.confidence < 0.6) {
    const aiResult = await classifyByAI(message);
    if (aiResult.confidence > keywordResult.confidence) {
      return buildResult(aiResult.intent, aiResult.confidence, aiResult.source);
    }
  }

  // Default to keyword result (even if low confidence)
  return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword_fallback');
}

/**
 * Synchronous keyword-only classification.
 * Use when you can't await (rare).
 *
 * @param {string} message
 * @returns {object}
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
