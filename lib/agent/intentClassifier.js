/**
 * @file intentClassifier.js
 * @location /backend/lib/agent/intentClassifier.js
 *
 * CHANGES FROM PREVIOUS VERSION:
 *   New keyword rules added for patterns that were being misclassified as 'chat':
 *   - "check my repos / look at the files / what's in backend" → git_ops
 *   - "check the logs / show me the server logs / read logs" → reasoning
 *   - "switch to coding model / use groq / change model" → chat (redirect to /model)
 *   - "can you see / do you see / look at the snippets" → research
 *
 * These were causing the agent to hallucinate instead of calling real tools
 * because chat intent has needsTools:false → no tool schemas injected.
 */

'use strict';

const logger     = require('../logger').child('intentClassifier');
const { complete } = require('../ai');

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL INTENTS
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
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_ALIASES = {
  chat: INTENTS.CHAT, reasoning: INTENTS.REASONING,
  code_write: INTENTS.CODE_WRITE, surgical_edit: INTENTS.SURGICAL_EDIT,
  code_review: INTENTS.CODE_REVIEW, research: INTENTS.RESEARCH,
  git_ops: INTENTS.GIT_OPS, deploy: INTENTS.DEPLOY,
  search: INTENTS.SEARCH, vision: INTENTS.VISION,
  code_edit: INTENTS.SURGICAL_EDIT, file_ops: INTENTS.CODE_WRITE,
  debug: INTENTS.REASONING, explain: INTENTS.CHAT,
  multi_step: INTENTS.REASONING, write: INTENTS.CODE_WRITE,
  edit: INTENTS.SURGICAL_EDIT, fix: INTENTS.SURGICAL_EDIT,
  refactor: INTENTS.SURGICAL_EDIT, review: INTENTS.CODE_REVIEW,
  analyse: INTENTS.CODE_REVIEW, merge: INTENTS.GIT_OPS,
  pr: INTENTS.GIT_OPS, branch: INTENTS.GIT_OPS,
  push: INTENTS.DEPLOY, release: INTENTS.DEPLOY, publish: INTENTS.DEPLOY,
  find: INTENTS.SEARCH, lookup: INTENTS.SEARCH, google: INTENTS.SEARCH,
  image: INTENTS.VISION, ocr: INTENTS.VISION, screenshot: INTENTS.VISION,
  analyze_image: INTENTS.VISION, vision_task: INTENTS.VISION,
  describe_image: INTENTS.VISION,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT METADATA
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_META = {
  [INTENTS.CHAT]:          { preferCode: false, needsTools: false, isMultiStep: false, tone: 'chat' },
  [INTENTS.REASONING]:     { preferCode: false, needsTools: true,  isMultiStep: true,  tone: 'analytical' },
  [INTENTS.CODE_WRITE]:    { preferCode: true,  needsTools: true,  isMultiStep: false, tone: 'code' },
  [INTENTS.SURGICAL_EDIT]: { preferCode: true,  needsTools: true,  isMultiStep: false, tone: 'code' },
  [INTENTS.CODE_REVIEW]:   { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'review' },
  [INTENTS.RESEARCH]:      { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'analytical' },
  [INTENTS.GIT_OPS]:       { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'code' },
  [INTENTS.DEPLOY]:        { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'code' },
  [INTENTS.SEARCH]:        { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'chat' },
  [INTENTS.VISION]:        { preferCode: false, needsTools: true,  isMultiStep: false, tone: 'explain' },
};

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD RULES
// Order matters — first match wins. More specific before broader.
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_RULES = [

  // ── Vision (MUST be before code_review — "analyze image" collision risk) ──
  {
    pattern: /\b(analyze image|analyse image|describe (this |the |my )?image|what('s| is) in (this |the )?image|look at (this |the )?image|read (this |the )?image|what does (this |the )?image show|screenshot analysis|ocr|extract text from image|image to text)\b/i,
    intent:  INTENTS.VISION,
  },
  {
    pattern: /\b(screenshot|image|photo|picture|thumbnail)\b.{0,40}\b(analyze|analyse|describe|explain|read|extract|what|show|tell me)\b/i,
    intent:  INTENTS.VISION,
  },
  {
    pattern: /\b(what|tell me|explain).{0,20}\b(image|screenshot|photo|picture|thumbnail)\b/i,
    intent:  INTENTS.VISION,
  },

  // ── Repo/file browsing — NEW: was being misclassified as chat ─────────────
  // "check my repos", "look at the backend", "what's in the dashboard repo"
  // "can you see my repos", "how many repos", "list the files"
  {
    pattern: /\b(check|look at|show|list|view|see|browse|what(?:'s?| is) in|how many|open|read)\b.{0,35}\b(repo|repos|repository|repositories|dashboard|backend|scraper|codebase)\b/i,
    intent:  INTENTS.GIT_OPS,
  },
  {
    // "can you access the repo", "try to read the files", "access my repository"
    pattern: /\b(access|can you (see|read|access|check)|try (calling|reading|accessing))\b.{0,30}\b(repo|repository|files?|codebase|backend|dashboard|scraper)\b/i,
    intent:  INTENTS.GIT_OPS,
  },

  // ── Server logs — NEW: "check logs", "read the server logs" ──────────────
  // These need read_logs tool which lives under reasoning intent
  {
    pattern: /\b(check|read|show|view|see|tail|get)\b.{0,20}\b(server\s*)?(logs?|error logs?|app logs?|recent logs?)\b/i,
    intent:  INTENTS.REASONING,
  },
  {
    pattern: /\b(what('?s| is) (in|on|the)\s+logs?|logs? (check|tail|view)|server (status|health|errors?))\b/i,
    intent:  INTENTS.REASONING,
  },

  // ── Read specific files — "can you read/check this file" ─────────────────
  {
    pattern: /\b(read|check|show|view|open|get)\b.{0,25}\b(file|\.js|\.ts|\.py|\.json|\.md|\.css|\.html|\.yml|\.yaml)\b/i,
    intent:  INTENTS.CODE_REVIEW,
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
  // "can you see the snippets", "look at the research folder", "show me the snippets"
  {
    pattern: /\b(see|look at|show|check|view)\b.{0,20}\b(snippet|snippets|research folder|captures?|staged)\b/i,
    intent:  INTENTS.RESEARCH,
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    // 'what is X' requires X to be 4+ chars to avoid matching "what is up" as search
    pattern: /\b(search|find|look up|google|latest|news|docs|documentation)\b|\b(what is|who is)\s+\w{4,}/i,
    intent:  INTENTS.SEARCH,
  },

  // ── Reasoning / Debug ─────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────

const AI_CLASSIFIER_PROMPT = `You are an intent classifier for a coding assistant.

Given a user message, classify it into exactly one of these intents:
- chat: casual conversation, greetings, thanks, unrelated questions, identity questions
- reasoning: debugging, complex logic, multi-step analysis, checking logs, "why" questions
- code_write: creating new files, functions, components, modules
- surgical_edit: fixing, updating, modifying existing code (small targeted changes)
- code_review: reviewing, auditing, analyzing code quality, reading/checking files
- research: deep exploration, comparisons, best practices, checking snippets/captures
- git_ops: branches, pull requests, merges, commits, rebasing, checking repos/files in repos
- deploy: deploying, releasing, publishing, shipping
- search: quick lookups, finding docs, news, simple "what is" questions
- vision: analyzing images, describing screenshots, OCR, image content questions

IMPORTANT: 
- "check my repos", "what's in the backend", "look at my files" → git_ops
- "check the logs", "show me server logs" → reasoning
- "can you see the snippets" → research
- "switch to groq model" → chat (user should use /model command)

Respond with ONLY the intent name — one word, nothing else.`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeIntent(raw) {
  if (!raw || typeof raw !== 'string') return INTENTS.CHAT;
  const cleaned = raw.trim().toLowerCase().replace(/[\s\-]+/g, '_');
  return INTENT_ALIASES[cleaned] || INTENTS.CHAT;
}

function buildResult(intent, confidence, source) {
  const meta = INTENT_META[intent] || INTENT_META[INTENTS.CHAT];
  return {
    intent, confidence, source,
    suggestedTone: meta.tone,
    preferCode:    meta.preferCode,
    needsTools:    meta.needsTools,
    isMultiStep:   meta.isMultiStep,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

function classifyByKeywords(message) {
  if (!message || typeof message !== 'string') {
    return { intent: INTENTS.CHAT, confidence: 1.0, matched: false };
  }

  const text = message.trim();
  if (!text) return { intent: INTENTS.CHAT, confidence: 1.0, matched: false };

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
// ─────────────────────────────────────────────────────────────────────────────

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

    const raw    = (result.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    const intent = normalizeIntent(raw);

    logger.debug('classifyByAI', `AI classified "${intent}"`, { raw, model: result.model, message: message.slice(0, 80) });

    return { intent, confidence: 0.82, source: 'ai' };
  } catch (err) {
    logger.warn('classifyByAI', 'AI classification failed — defaulting to chat', { error: err.message });
    return { intent: INTENTS.CHAT, confidence: 0.5, source: 'ai_error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

async function classify(message, context = {}) {
  const { forceAI = false, previousIntent = null } = context;

  if (forceAI) {
    const r = await classifyByAI(message);
    return buildResult(r.intent, r.confidence, r.source);
  }

  const keywordResult = classifyByKeywords(message);

  if (keywordResult.matched && keywordResult.confidence >= 0.75) {
    logger.debug('classify', `Keyword match → "${keywordResult.intent}" (${keywordResult.confidence})`);
    return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword');
  }

  if (!keywordResult.matched && previousIntent) {
    const normalized = normalizeIntent(previousIntent);
    if (normalized !== INTENTS.CHAT) {
      logger.debug('classify', `Continuing previous intent "${normalized}"`);
      return buildResult(normalized, 0.70, 'continuation');
    }
  }

  if (!keywordResult.matched || keywordResult.confidence < 0.60) {
    const aiResult = await classifyByAI(message);
    if (aiResult.confidence > keywordResult.confidence) {
      logger.debug('classify', `AI override → "${aiResult.intent}" (${aiResult.confidence})`);
      return buildResult(aiResult.intent, aiResult.confidence, aiResult.source);
    }
  }

  return buildResult(keywordResult.intent, keywordResult.confidence, 'keyword_fallback');
}

function classifySync(message) {
  const r = classifyByKeywords(message);
  return buildResult(r.intent, r.confidence, 'keyword_sync');
}

module.exports = {
  classify, classifySync, classifyByKeywords, classifyByAI,
  normalizeIntent, buildResult, INTENTS, INTENT_ALIASES, INTENT_META,
};
