/**
 * @file constants.js
 * @location /backend/utils/constants.js
 *
 * Changes from previous version:
 *   → Added VISION constants (models, mime types, limits)
 *   → Added SNIPPET_TYPES with new image/file types
 *   → Everything else unchanged
 */

'use strict';

// ── AI MODELS ────────────────────────────────────────────────────────────────

const MODELS = {
  // Primary brain — Groq
  GROQ_BRAIN: 'llama-3.3-70b-versatile',

  // Mistral chat models — api.mistral.ai (shared 1 RPS bucket)
  MISTRAL_CODE:  'devstral-medium-2507',
  MISTRAL_LARGE: 'mistral-large-2512',
  MISTRAL_LEAN:  'labs-leanstral-2603',
  MISTRAL_OCR:   'mistral-ocr-2505',

  // Codestral FiM — codestral.mistral.ai (independent 1 RPS bucket)
  CODESTRAL_FIM: 'codestral-latest',

  // Gemini models — same API key
  // ⚠️  gemini-2.5-flash: 20 RPD — use sparingly, last resort for vision
  GEMINI_FLASH:      'gemini-2.5-flash',
  // gemini-3.1-flash-lite: 500 RPD — primary Gemini fallback + primary vision
  GEMINI_FLASH_LITE: 'gemini-3.1-flash-lite-preview',

  // Gemma models — via Gemini API key (Google AI Studio)
  // Free tier: 15 RPM, 1.5K RPD — preferred for high-volume vision
  GEMMA_4_26B: 'gemma-4-26b-a4b-it',
  GEMMA_4_31B: 'gemma-4-31b-it',
};

// ── VISION MODELS ─────────────────────────────────────────────────────────────
// All Gemini/Gemma models support vision.
// Ordered by preferred usage (quota-aware):
//   primary:   gemini-3.1-flash-lite (500 RPD — preserve gemini-2.5-flash)
//   fallback1: gemma-4-26b (1.5K RPD, fast MoE)
//   fallback2: gemma-4-31b (1.5K RPD, dense)
//   last:      gemini-2.5-flash (20 RPD — best quality, use sparingly)

const VISION = {
  // Ordered model chain for vision tasks
  MODEL_CHAIN: [
    'gemini-3.1-flash-lite-preview',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'gemini-2.5-flash',
  ],

  // Supported image MIME types
  SUPPORTED_MIME_TYPES: new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/svg+xml',
  ]),

  // Max image size for inline base64 (bytes)
  // Larger images must be passed as URL
  MAX_INLINE_BYTES: 4 * 1024 * 1024,   // 4MB

  // Max image URL length
  MAX_URL_LENGTH: 2048,

  // Max vision response tokens
  MAX_TOKENS: 1500,

  // Screenshot compression quality (0-1)
  SCREENSHOT_QUALITY: 0.75,

  // Screenshot max dimension (px) — longer side scaled down to this
  SCREENSHOT_MAX_DIM: 1280,
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
  // Per user per hour
  AGENT:         30,
  LITE_AGENT:    60,
  SCRAPER_AGENT: 100,
  GITHUB:        60,
  SEARCH:        20,
  VISION:        40,   // vision endpoint — separate bucket

  // Mistral token budget (shared across ALL mistral APIs)
  MISTRAL_MONTHLY_TOKENS: 1_000_000_000,
  MISTRAL_WARN_THRESHOLD: 800_000_000,

  // Mistral RPS gap (ms) — separate per API endpoint
  MISTRAL_GAP_MS:    1000,
  CODESTRAL_GAP_MS:  1000,
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
  MAX_SNIPPET_LENGTH:    2000,
  MAX_SNIPPETS_COUNT:    20,
  SCROLL_AFTER:          3,
  POLL_INTERVAL_MS:      15_000,

  // Screenshot settings (mirrors VISION constants for scraper build access)
  SCREENSHOT_QUALITY:    0.75,
  SCREENSHOT_MAX_DIM:    1280,

  // File capture settings
  MAX_TEXT_FILE_BYTES:   500_000,    // 500KB max for text file content fetch
  SUPPORTED_TEXT_EXTS:   new Set([
    'js', 'ts', 'jsx', 'tsx', 'json', 'md', 'txt',
    'py', 'css', 'html', 'yaml', 'yml', 'sh', 'env',
    'sql', 'rs', 'go', 'rb', 'java', 'c', 'cpp', 'h',
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
    BACKEND:   'BACKE_ND',
    DASHBOARD: 'DASHBOARD',
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

// ── EXPORTS ───────────────────────────────────────────────────────────────────

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
};
