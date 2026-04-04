'use strict';

// ── AI MODELS ────────────────────────────────────────────────────────────────

const MODELS = {
  // Primary brain — Groq
  GROQ_BRAIN: 'llama-3.3-70b-versatile',

  // Mistral chat models — api.mistral.ai (shared 1 RPS bucket)
  MISTRAL_CODE:    'devstral-medium-2507',
  MISTRAL_LARGE:   'mistral-large-2512',
  MISTRAL_LEAN:    'labs-leanstral-2603',
  MISTRAL_OCR:     'mistral-ocr-2505',

  // Codestral FiM — codestral.mistral.ai (independent 1 RPS bucket)
  CODESTRAL_FIM:   'codestral-latest',

  // Gemini models — same API key
  GEMINI_FLASH:      'gemini-2.5-flash',              // heavy tasks only — 20 RPD, use sparingly!
  GEMINI_FLASH_LITE: 'gemini-3.1-flash-lite-preview', // primary Gemini fallback — 500 RPD ✅

  // Gemma models — via Gemini API key (Google AI Studio)
  // Free tier: 15 RPM, unlimited TPM, 1.5K RPD 🔥
  GEMMA_4_26B: 'gemma-4-26b-it',  // last resort — unlimited TPM
  GEMMA_4_31B: 'gemma-4-31b-it',  // last resort — unlimited TPM
};

// ── API ENDPOINTS ─────────────────────────────────────────────────────────────

const ENDPOINTS = {
  GROQ:            'https://api.groq.com/openai/v1',
  MISTRAL_CHAT:    'https://api.mistral.ai/v1/chat/completions',
  MISTRAL_OCR:     'https://api.mistral.ai/v1/ocr',
  CODESTRAL_FIM:   'https://codestral.mistral.ai/v1/fim/completions',
  TAVILY:          'https://api.tavily.com/search',
  SERPER:          'https://google.serper.dev/search',
};

// ── RATE LIMITS ───────────────────────────────────────────────────────────────

const RATE_LIMITS = {
  // Per user per hour
  AGENT:          30,
  LITE_AGENT:     60,
  SCRAPER_AGENT:  100,
  GITHUB:         60,
  SEARCH:         20,

  // Mistral token budget (shared across ALL mistral APIs)
  MISTRAL_MONTHLY_TOKENS:  1_000_000_000,   // 1B
  MISTRAL_WARN_THRESHOLD:  800_000_000,     // warn at 800M (80%)

  // Mistral RPS gap (ms) — separate per API endpoint
  MISTRAL_GAP_MS:          1000,
  CODESTRAL_GAP_MS:        1000,
};

// ── PROVIDER STATUS ───────────────────────────────────────────────────────────

const PROVIDER_STATUS = {
  OK:           'ok',
  RATE_LIMITED: 'rate_limited',
  DOWN:         'down',
  UNKNOWN:      'unknown',
};

// How long to mark a provider as unavailable after failure (ms)
const PROVIDER_COOLDOWN = {
  RATE_LIMITED: 60_000,   // 60s after 429
  DOWN:         120_000,  // 120s after 5xx
};

// ── AGENT ─────────────────────────────────────────────────────────────────────

const AGENT = {
  MAX_TOKENS:           6000,
  CODESTRAL_MAX_TOKENS: 2000,
  CONTEXT_WARN_PCT:     0.80,   // summarise at 80% context usage
  MAX_RETRIES:          5,
  TASK_TTL_SECONDS:     3600,   // 1hr Redis TTL for task state
  SHADOW_BRANCH_TTL_HRS: 48,
  MEMORY_SUMMARIES:     5,      // load last 5 episodic summaries on start
  DEBOUNCE_SETTINGS_MS: 1500,   // settings delta sync debounce
  DIFF_PAGE_LINES:      50,     // paginate diffs after 50 lines
};

// ── SSE ───────────────────────────────────────────────────────────────────────

const SSE = {
  HEARTBEAT_INTERVAL_MS: 15_000,  // 15s ping/pong
  BROADCAST_TTL_HRS:     24,      // broadcast_queue auto-clear
  EVENT_TYPES: {
    TRACE:     'trace',       // thinking stream entries
    FINDING:   'finding',     // agent discovered something
    WARNING:   'warning',     // needs attention
    COMPLETE:  'complete',    // background task done
    PULSE:     'pulse',       // system status update
    HEARTBEAT: 'heartbeat',   // keep-alive ping
  },
};

// ── SCRAPER ───────────────────────────────────────────────────────────────────

const SCRAPER = {
  MAX_SNIPPET_LENGTH:    2000,
  MAX_SNIPPETS_COUNT:    20,
  SCROLL_AFTER:          3,      // fixed height + scroll after 3 items
  POLL_INTERVAL_MS:      15_000, // bookmarklet polls /api/sync every 15s
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
    BACKEND:    'backend',
    DASHBOARD:  'dashboard',
    SCRAPER:    'scraper',
  },
  SANDBOX_BRANCH: 'ai-sandbox',
  DEFAULT_BRANCH: 'main',
  REPO_CACHE_TTL: 300_000,  // 5 min cache for file trees
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
