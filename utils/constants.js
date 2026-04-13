/**
 * @file constants.js
 * @location /backend/utils/constants.js
 */

'use strict';

// ── AI MODELS ────────────────────────────────────────────────────────────────

const MODELS = {
  GROQ_BRAIN:        'llama-3.3-70b-versatile',
  MISTRAL_CODE:      'devstral-medium-2507',
  MISTRAL_LARGE:     'mistral-large-2512',
  MISTRAL_LEAN:      'labs-leanstral-2603',
  MISTRAL_OCR:       'mistral-ocr-2505',
  CODESTRAL_FIM:     'codestral-latest',
  GEMINI_FLASH:      'gemini-2.5-flash',
  GEMINI_FLASH_LITE: 'gemini-3.1-flash-lite-preview',
  GEMMA_4_26B:       'gemma-4-26b-a4b-it',
  GEMMA_4_31B:       'gemma-4-31b-it',
};

// ── VISION ────────────────────────────────────────────────────────────────────

const VISION = {
  MODEL_CHAIN: [
    'gemini-3.1-flash-lite-preview',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'gemini-2.5-flash',
  ],
  SUPPORTED_MIME_TYPES: new Set([
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/gif', 'image/bmp', 'image/svg+xml',
  ]),
  MAX_INLINE_BYTES:    4 * 1024 * 1024,
  MAX_URL_LENGTH:      2048,
  MAX_TOKENS:          1500,
  SCREENSHOT_QUALITY:  0.75,
  SCREENSHOT_MAX_DIM:  1280,
};

// ── SNIPPET TYPES ─────────────────────────────────────────────────────────────

const SNIPPET_TYPES = {
  CODE:     'code',
  RESEARCH: 'research',
  IMAGE:    'image',
  FILE:     'file',
};

// ── API ENDPOINTS ─────────────────────────────────────────────────────────────

const ENDPOINTS = {
  GROQ:          'https://api.groq.com/openai/v1',
  MISTRAL_CHAT:  'https://api.mistral.ai/v1/chat/completions',
  MISTRAL_OCR:   'https://api.mistral.ai/v1/ocr',
  CODESTRAL_FIM: 'https://codestral.mistral.ai/v1/fim/completions',
  TAVILY:        'https://api.tavily.com/search',
  SERPER:        'https://google.serper.dev/search',
};

// ── RATE LIMITS ───────────────────────────────────────────────────────────────

const RATE_LIMITS = {
  AGENT:                    30,
  LITE_AGENT:               60,
  SCRAPER_AGENT:            100,
  GITHUB:                   60,
  SEARCH:                   20,
  VISION:                   40,
  MISTRAL_MONTHLY_TOKENS:   1_000_000_000,
  MISTRAL_WARN_THRESHOLD:   800_000_000,
  MISTRAL_GAP_MS:           1000,
  CODESTRAL_GAP_MS:         1000,
};

// ── PROVIDER STATUS ───────────────────────────────────────────────────────────

const PROVIDER_STATUS = {
  OK:           'ok',
  RATE_LIMITED: 'rate_limited',
  DOWN:         'down',
  UNKNOWN:      'unknown',
};

const PROVIDER_COOLDOWN = {
  RATE_LIMITED: 60_000,
  DOWN:         120_000,
};

// ── AGENT ─────────────────────────────────────────────────────────────────────

const AGENT = {
  MAX_TOKENS:            6000,
  CODESTRAL_MAX_TOKENS:  2000,
  VISION_MAX_TOKENS:     1500,
  CONTEXT_WARN_PCT:      0.80,
  MAX_RETRIES:           5,
  TASK_TTL_SECONDS:      3600,
  SHADOW_BRANCH_TTL_HRS: 48,
  MEMORY_SUMMARIES:      5,
  DEBOUNCE_SETTINGS_MS:  1500,
  DIFF_PAGE_LINES:       50,
};

// ── SSE ───────────────────────────────────────────────────────────────────────

const SSE = {
  HEARTBEAT_INTERVAL_MS: 15_000,
  BROADCAST_TTL_HRS:     24,
  EVENT_TYPES: {
    TRACE:     'trace',
    FINDING:   'finding',
    WARNING:   'warning',
    COMPLETE:  'complete',
    PULSE:     'pulse',
    HEARTBEAT: 'heartbeat',
  },
};

// ── SCRAPER ───────────────────────────────────────────────────────────────────

const SCRAPER = {
  MAX_SNIPPET_LENGTH:  2000,
  MAX_SNIPPETS_COUNT:  20,
  SCROLL_AFTER:        3,
  POLL_INTERVAL_MS:    15_000,
  SCREENSHOT_QUALITY:  0.75,
  SCREENSHOT_MAX_DIM:  1280,
  MAX_TEXT_FILE_BYTES: 500_000,
  SUPPORTED_TEXT_EXTS: new Set([
    'js','ts','jsx','tsx','json','md','txt',
    'py','css','html','yaml','yml','sh','env',
    'sql','rs','go','rb','java','c','cpp','h',
  ]),
};

// ── SUPABASE TABLES ───────────────────────────────────────────────────────────

const TABLES = {
  SESSIONS:          'sessions',
  SNIPPETS:          'snippets',
  PERSONALITY:       'personality',
  CONVERSATIONS:     'conversations',
  REPO_MAPPINGS:     'repo_mappings',
  DEPLOYMENTS:       'deployments',
  ACTIVE_MODEL:      'active_model',
  TASKS:             'tasks',
  REPO_CACHE:        'repo_cache',
  REASONING_LOG:     'reasoning_log',
  RATE_USAGE:        'rate_usage',
  CONTEXT_SUMMARIES: 'context_summaries',
  TASK_CHECKPOINTS:  'task_checkpoints',
  LOGS:              'logs',
  USERS:             'users',
  BROADCAST_QUEUE:   'broadcast_queue',
  SHADOW_BRANCHES:   'shadow_branches',
  SETTINGS:          'settings',
};

// ── GITHUB ────────────────────────────────────────────────────────────────────

const GITHUB = {
  OWNER:          'VinnsEdesigner',
  REPOS: {
    BACKEND:   'backend',
    DASHBOARD: 'dashboard',
    SCRAPER:   'SCRAPER-',
  },
  SANDBOX_BRANCH: 'ai-sandbox',
  DEFAULT_BRANCH: 'main',
  REPO_CACHE_TTL: 300_000,
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

const HTTP = {
  OK:                    200,
  CREATED:               201,
  BAD_REQUEST:           400,
  UNAUTHORIZED:          401,
  FORBIDDEN:             403,
  NOT_FOUND:             404,
  TOO_MANY_REQUESTS:     429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE:   503,
};

// ── JWT ───────────────────────────────────────────────────────────────────────

const JWT = {
  EXPIRES_IN: '7d',
  ALGORITHM:  'HS256',
};

// ── JIT INSTRUCTION FILES ─────────────────────────────────────────────────────
// These files live in the backend repo and are fetched by Nexy on-demand
// based on intent. Nexy is told about them in the system prompt but only
// fetches them when the current task requires that knowledge.
//
// Provider: GitHub raw content via gh.readFile()
// Repo: GITHUB.REPOS.BACKEND
// Branch: main
//
// Intent → which files to pre-fetch before responding:
//   code_write / surgical_edit → file-map.md + build-laws.md
//   git_ops / deploy           → build-laws.md
//   reasoning / code_review    → build-laws.md
//   research / search / chat   → none (no JIT fetch)
//   vision                     → none

const INSTRUCTION_FILES = {
  // Maps intent → array of file paths to pre-fetch from backend repo
  INTENT_MAP: {
    code_write:    ['instructions/file-map.md', 'instructions/build-laws.md'],
    surgical_edit: ['instructions/file-map.md', 'instructions/build-laws.md'],
    git_ops:       ['instructions/build-laws.md'],
    deploy:        ['instructions/build-laws.md'],
    reasoning:     ['instructions/build-laws.md'],
    code_review:   ['instructions/file-map.md'],
    research:      [],
    search:        [],
    chat:          [],
    vision:        [],
  },

  // Navigator block injected into every system prompt
  // Tells Nexy the files exist and have been pre-fetched (or where to find them)
  NAVIGATOR_PROMPT: `[INSTRUCTION FILES — JIT KNOWLEDGE]
You have access to detailed system knowledge files. When relevant context has been
pre-fetched for this request, it appears below tagged [JIT: filename].
If you need information not pre-fetched, use read_file tool on repo "backend":
  instructions/file-map.md     → complete backend file map + dependency levels
  instructions/build-laws.md   → all 25 BUILD_LAWS + quick reference
  instructions/db-schema.md    → all 18 Supabase tables with exact column names
Do NOT fetch these files for chat/search/vision tasks — unnecessary token waste.`,
};

// ── TOOL CALLING PROVIDERS ────────────────────────────────────────────────────
// Controls which tool-calling strategy is used per provider.
// 'native_openai'  → Groq — OpenAI-compatible tools array + tool_calls response
// 'native_mistral' → Mistral — Mistral function calling format
// 'xml_tags'       → Gemini/Gemma — XML <tool>...</tool> tags in text (no native support)

const TOOL_CALLING = {
  STRATEGY: {
    groq:         'native_openai',
    mistral_chat: 'native_mistral',
    codestral:    'none',           // FiM only — no tool calling
    gemini:       'xml_tags',
    gemini_lite:  'xml_tags',
    gemma_26b:    'xml_tags',
    gemma_31b:    'xml_tags',
  },
  // XML tag format for Gemini/Gemma
  XML_OPEN:  '<tool>',
  XML_CLOSE: '</tool>',
};

// ── MEMORY LAYERS ─────────────────────────────────────────────────────────────
// Defines the layered memory architecture.
// Layer 1: Identity (static, always ~200 tokens)
// Layer 2: Relationship + last 2 session summaries (dynamic, always ~300 tokens)
// Layer 3: JIT instruction files (dynamic, per-intent, 0-800 tokens)
// Layer 4: Page context (bookmarklet only, in USER message not system)
// Layer 5: Conversation history via contextCompressor (session-scoped)

const MEMORY = {
  LAYER_1_ALWAYS: true,           // identity always injected
  LAYER_2_SUMMARIES: 2,           // bookmarklet: 2 summaries max (not 5)
  LAYER_2_SUMMARIES_FULL: 5,      // dashboard: full 5 summaries
  LAYER_3_JIT: true,              // fetch instruction files per intent
  LAYER_4_PAGE_IN_USER_MSG: true, // page context goes in user message, not system
  LAYER_5_HISTORY_LIMIT: 10,      // max turns from client history
  SYSTEM_PROMPT_TOKEN_TARGET: 700, // target for bookmarklet system prompt
  SYSTEM_PROMPT_TOKEN_WARN:  1200, // warn if above this
};

module.exports = {
  MODELS,
  VISION,
  SNIPPET_TYPES,
  ENDPOINTS,
  RATE_LIMITS,
  PROVIDER_STATUS,
  PROVIDER_COOLDOWN,
  AGENT,
  SSE,
  SCRAPER,
  TABLES,
  GITHUB,
  HTTP,
  JWT,
  INSTRUCTION_FILES,
  TOOL_CALLING,
  MEMORY,
};
