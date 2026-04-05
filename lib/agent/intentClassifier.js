'use strict';

const logger = require('../logger');

// ── INTENT CLASSIFIER ─────────────────────────────────────────────────────────
// First thing called on every /api/agent request.
// Heuristic-first (fast, zero tokens) → AI fallback only if ambiguous.
// Sets tone mode and tool injection strategy for the request.

const INTENTS = {
  CHAT:        'chat',
  CODE_WRITE:  'code_write',
  CODE_EDIT:   'code_edit',
  CODE_REVIEW: 'code_review',
  FILE_OPS:    'file_ops',
  GIT_OPS:     'git_ops',
  SEARCH:      'search',
  DEPLOY:      'deploy',
  DEBUG:       'debug',
  EXPLAIN:     'explain',
  MULTI_STEP:  'multi_step',
};

// Keyword → intent mapping (ordered by specificity)
const RULES = [
  { pattern: /\b(merge|pull request|PR|open PR|create PR)\b/i,           intent: INTENTS.GIT_OPS,     tone: 'code' },
  { pattern: /\b(create branch|new branch|checkout)\b/i,                  intent: INTENTS.GIT_OPS,     tone: 'code' },
  { pattern: /\b(delete|remove)\s+(file|folder|dir)\b/i,                  intent: INTENTS.FILE_OPS,    tone: 'code' },
  { pattern: /\b(write|create|add|generate)\s+(file|function|class|component|module|route|endpoint|api)\b/i, intent: INTENTS.CODE_WRITE, tone: 'code' },
  { pattern: /\b(fix|update|edit|modify|change|refactor|rename|move)\b/i, intent: INTENTS.CODE_EDIT,   tone: 'code' },
  { pattern: /\b(review|check|audit|look at|analyze|analyse)\b/i,         intent: INTENTS.CODE_REVIEW, tone: 'review' },
  { pattern: /\b(debug|error|bug|crash|fail|broken|not working|exception|stack trace)\b/i, intent: INTENTS.DEBUG, tone: 'debug' },
  { pattern: /\b(explain|what is|how does|why does|what does|describe)\b/i, intent: INTENTS.EXPLAIN,   tone: 'explain' },
  { pattern: /\b(search|find|look up|google|what's new|latest)\b/i,       intent: INTENTS.SEARCH,      tone: 'chat' },
  { pattern: /\b(deploy|push to|release|publish)\b/i,                     intent: INTENTS.DEPLOY,      tone: 'code' },
  { pattern: /\b(then|after that|next|finally|also|and then|step \d)\b/i, intent: INTENTS.MULTI_STEP,  tone: 'code' },
];

// Intents that require tool injection
const NEEDS_TOOLS = new Set([
  INTENTS.CODE_WRITE,
  INTENTS.CODE_EDIT,
  INTENTS.CODE_REVIEW,
  INTENTS.FILE_OPS,
  INTENTS.GIT_OPS,
  INTENTS.SEARCH,
  INTENTS.DEPLOY,
  INTENTS.DEBUG,
  INTENTS.MULTI_STEP,
]);

// Intents that are multi-step
const IS_MULTI_STEP = new Set([INTENTS.MULTI_STEP]);

/**
 * Classify user intent from message text.
 *
 * Returns:
 * {
 *   intent:       string,
 *   confidence:   number,  // 0-1
 *   suggestedTone: string,
 *   needsTools:   boolean,
 *   isMultiStep:  boolean,
 * }
 */
function classify(message, context = {}) {
  if (!message || typeof message !== 'string') {
    return {
      intent:        INTENTS.CHAT,
      confidence:    1,
      suggestedTone: 'chat',
      needsTools:    false,
      isMultiStep:   false,
    };
  }

  const text = message.trim();

  // Check rules in order — first match wins
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      const intent = rule.intent;
      logger.debug('intentClassifier', `Matched intent: ${intent}`, {
        pattern: rule.pattern.toString().slice(0, 40),
      });
      return {
        intent,
        confidence:    0.85,
        suggestedTone: rule.tone,
        needsTools:    NEEDS_TOOLS.has(intent),
        isMultiStep:   IS_MULTI_STEP.has(intent),
      };
    }
  }

  // Default to chat
  logger.debug('intentClassifier', 'No rule matched → chat');
  return {
    intent:        INTENTS.CHAT,
    confidence:    0.6,
    suggestedTone: 'chat',
    needsTools:    false,
    isMultiStep:   false,
  };
}

module.exports = { classify, INTENTS };
