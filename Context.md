# CONTEXT.md — Nexus AI Control System v4.0
> Last updated: 2026-04-10 | Architecture: Vision Redesign + Dashboard First Build
> Author: Vinns (Nyeri, Kenya) | Mobile-only dev (Android Chrome + github.dev)
> Attach this file at the start of every new session to restore full context.

---

## 0. QUICK STATUS

```
BACKEND   ✅ COMPLETE  — All phases built, vision constants added, schema migrated
SCRAPER   ✅ COMPLETE  — Modular src/, VENOM HUD, bookmarklet built and deployed
DASHBOARD ❌ NOT BUILT — This is the active build target
```

**Active / Ongoing Changes (backend — not yet wired):**
- `lib/personality/systemPrompt.js` [NEW] — replaces hardcoded LITE_SYSTEM_PROMPT + systemParts assembly
- `lib/agent/visionHandler.js` [NEW] — Gemini/Gemma vision call chain
- `lib/agent/fetchToSnippets.js` [NEW] — agent tool: fetch URL/image/file → Supabase snippet
- `api/vision.js` [NEW] — POST /api/vision endpoint

---

## 1. SYSTEM OVERVIEW

```
┌─────────────────────────────────────────────────────────────┐
│  [SCRAPER]   ──sync──▶  [BACKEND]  ◀──SSE──▶  [DASHBOARD]  │
│  bookmarklet             HF Spaces              GitHub Pages │
│  VENOM HUD               Express.js             Vanilla JS   │
│  (any page)              + Supabase                          │
│                               ▲                             │
│                               │ Octokit PAT                 │
│                               ▼                             │
│                        [GitHub API]                         │
└─────────────────────────────────────────────────────────────┘
```

**Backend** = HF Spaces Express.js. No cold starts. No timeouts. 2vCPU/16GB.
**Scraper** = VENOM bookmarklet (spider emoji branding). Injected into any page.
**Dashboard** = GitHub Pages SPA. Pure vanilla JS, React philosophy, HuggingFace aesthetic.

---

## 2. REPO DETAILS

| Repo | Host | URL | Status |
|------|------|-----|--------|
| VinnsEdesigner/backend | HF Spaces (Docker) | `vinnsedesigner-vinns-ai-backend.hf.space` | ✅ Built |
| VinnsEdesigner/SCRAPER- | GitHub Pages | `vinnsedesigner.github.io/SCRAPER-/build/scraper.js` | ✅ Built |
| VinnsEdesigner/dashboard | GitHub Pages | `vinnsedesigner.github.io/dashboard` | ❌ Not built |

**HF Space name:** `VinnsEdesigner/vinns-ai-backend`
**GitHub username:** `VinnsEdesigner`
**Backend URL:** `https://vinnsedesigner-vinns-ai-backend.hf.space`

---

## 3. BACKEND — COMPLETE FILE MAP

### 3.1 Entry + Config
```
server.js                       — Express entry, all route mounts, middleware chain
Dockerfile                      — HF Spaces Docker (node:20-alpine, user: node, port 7860)
package.json                    — deps: groq-sdk, @google/generative-ai, @mendable/firecrawl-js,
                                         @supabase/supabase-js, @upstash/redis, octokit,
                                         cors, dotenv, express, jsonwebtoken
.github/workflows/sync-to-hf.yml — push main → sync to HF Spaces (force push)
.gitignore                      — .env, node_modules, dist, build, *.log
```

### 3.2 /api — Route Handlers
```
api/auth.js           — POST /api/auth/login (PIN→JWT)
                         POST /api/auth/refresh
                         GET  /api/auth/verify
api/agent.js          — POST /api/agent (full agent loop, tool dispatch, multi-step tasks)
                         PATCH /api/active-model
                         GET   /api/agent/status
api/lite-agent.js     — POST /api/lite-agent (bookmarklet stripped agent, max 1000 tokens)
                         Exports: liteAgent (HTTP handler) + runLiteAgent (direct call)
api/scraper-agent.js  — POST /api/scraper-agent
                         (snippet capture + SSE push + optional lite-agent auto-run)
api/vision.js         — POST /api/vision [NEW] image analysis via Gemini vision chain
api/broadcast.js      — GET /api/broadcast (SSE stream)
                         connections Map, replay from broadcast_queue on reconnect
api/github.js         — POST /api/github (action-based: read/write/delete/list/branch/PR/merge)
                         POST /api/github/rollback
                         GET  /api/github/tree
api/session.js        — GET/POST/PATCH/DELETE /api/session
api/search.js         — POST /api/search, GET /api/search/status
api/settings.js       — GET /api/settings, PATCH /api/settings (delta only, SSE push on change)
api/sync.js           — GET /api/sync (bookmarklet 15s poll → returns settings diff)
api/health.js         — GET /api/health (Supabase ping + API key presence, never exposes values)
api/warmup.js         — GET /api/warmup (uptime counter, UptimeRobot target)
api/test-models.js    — GET /api/test-models (parallel test all 9 models, returns pass/fail)
```

### 3.3 /lib — Core Logic
```
lib/ai.js             — AI provider abstraction
                         complete(options) → { text, model, tokens_used }
                         fim(prefix, suffix) → codestral FiM
                         stream(options, cb) → streaming via callback
                         currentModel(), modelStatus()
                         mistralGap(), codestralGap() — 1 RPS enforcers (LAW 8)
                         Unified schema normalizer across all providers

lib/supabase.js       — singleton client + query() wrapper
                         operations: select, insert, update, upsert, delete

lib/tools.js          — ALL tool schemas (OpenAI-compatible function format)
                         INTENT_TOOLS map (intent → tool names array)
                         READ_ONLY_TOOLS set (safe for bookmarklet context)
                         Exports: schema(), schemaForContext(), allSchema(), readOnlySchema()
                         namesForIntent(), namesForContext(), allNames(), readOnlyNames()
                         Tools defined:
                           read_file, write_file, delete_file, list_files
                           create_branch, create_pr, merge_pr
                           web_search, read_url, remember
                           run_command, read_logs, check_file_exists
                           analyze_image [NEW], fetch_to_snippets [NEW]

lib/tokenizer.js      — count(), countMessages(), budget(), trimToFit()
                         ~4 chars/token heuristic (no API calls)

lib/logger.js         — wraps logManager, console output + fire-and-forget file log
                         child(namespace) factory, parseCallArgs for flexible signatures

lib/logManager.js     — structured JSON file logger (/app/logs/app.log)
                         rotation at 10MB, pub/sub subscribe(), tail watcher, redaction

lib/searchRouter.js   — Tavily → Serper waterfall
                         in-memory cooldowns, Jina fetchContent for URL reading

lib/contextManager.js — get(), append(), summariseOld(), clear()
                         conversation context window management

lib/github.js         — Octokit PAT client (lazy init)
                         readFile, writeFile, deleteFile, listFiles
                         createBranch, createPR, mergePR, listPRs
                         getTree, rollbackFile, branchExists

lib/prompt.js         — build(userId, options) + buildLite(pageContext)
                         NOTE: being superseded by lib/personality/systemPrompt.js [NEW]
```

### 3.4 /lib/agent — Agent Subsystems
```
lib/agent/intentClassifier.js   — keyword rules first → AI fallback if ambiguous
                                   classify(message, context), classifySync(message)
                                   INTENTS enum, INTENT_ALIASES, INTENT_META
                                   Canonical intents: chat, reasoning, code_write,
                                   surgical_edit, code_review, research, git_ops, deploy, search

lib/agent/modelRouter.js        — selectModel(intent, modelStatus) → best available model
                                   INTENT_MODEL_MAP, MODEL_PROVIDER_KEY, LAST_RESORT_CHAIN

lib/agent/toolInjector.js       — inject(intent, options), names(intent, options)
                                   Context-aware: bookmarklet gets read-only only
                                   Force mode: bypasses intent filter

lib/agent/reasoner.js           — plan(userId, intent, context) → JSON execution plan
                                   Max 8 steps, includes rationale + risk_level

lib/agent/executor.js           — run(userId, plan, streamCb) → step-by-step execution
                                   register(toolName, handler) — wired in api/agent.js
                                   Uses retryHandler per step

lib/agent/confirmationGate.js   — shouldConfirm(userId, action), buildCard(plan)
                                   riskLevel(action) → 'low'|'medium'|'high'

lib/agent/broadcastEmitter.js   — trace(), finding(), warning(), complete(), pulse()
                                   Wraps api/broadcast.emit(), non-fatal

lib/agent/memorySummarizer.js   — summarize(userId, messages, sessionName)
                                   loadSummaries(userId, limit) → formatted memory block

lib/agent/sessionBridge.js      — getRelevant(userId, taskDescription, max)
                                   keyword-scored snippet retrieval (no AI call)

lib/agent/shadowBranch.js       — create(userId, repo, filePath, operation)
                                   rollback(repo, filePath) → restores from ai-sandbox

lib/agent/taskState.js          — create/advance/pause/complete/fail/get/listActive
                                   Redis (1hr TTL) + Supabase persistence

lib/agent/retryHandler.js       — run(fn, options) — exponential backoff [0, 1s, 3s, 8s]

lib/agent/validator.js          — check(toolName, result) → { valid, reason }
                                   Per-tool validation rules

lib/agent/repoMap.js            — get/invalidate/findFile
                                   Repo file tree cache (5min TTL in repo_cache table)

lib/agent/contextCompressor.js  — loadCompressedContext(options), compressContext(input)
                                   Loads conversations + summaries + personality from DB
                                   Compresses into token-budget-aware prompt bundle

lib/agent/diffExplainer.js      — explain(diff, context) → plain English bullets

lib/agent/selfDiagnose.js       — analyzeEntries(), scanRecentLogs(), createLiveMonitor()
                                   toBroadcastCard(finding)
                                   Detectors: rate_limit, provider_down, build_failure,
                                   memory_pressure, sse_failure, database_issue,
                                   git_issue, filesystem_issue, auth_issue, error_burst

lib/agent/visionHandler.js      [NEW] Gemini vision chain
                                   analyzeImage(imageUrl, question, userId)
                                   analyzeBase64(base64, mimeType, question, userId)
                                   Vision chain: gemini-3.1-flash-lite → gemma-4-26b
                                               → gemma-4-31b → gemini-2.5-flash

lib/agent/fetchToSnippets.js    [NEW] Agent tool implementation
                                   fetchToSnippets(url, type, label, userId, sessionId)
                                   Fetches URL content → saves to Supabase snippets
                                   Handles: images (URL→metadata), files, research URLs
```

### 3.5 /lib/personality — Personality Modules
```
lib/personality/base.js         — IDENTITY constant: name=Nexus, role, traits, forbidden list
lib/personality/tone.js         — TONE_MODES: chat, code, explain, review, debug
lib/personality/memory.js       — get/save/forget/summarise (personality table)
lib/personality/code-style.js   — get/update/toInstruction (indent, quotes, semicolons, etc.)
lib/personality/libraries.js    — get/update/toInstruction (preferred libs per domain)
lib/personality/context.js      — build(userId, requestMeta) → current context block
lib/personality/decisions.js    — in-memory decision log (resets on restart)
lib/personality/flags.js        — maps settings columns → feature flags
lib/personality/freedom.js      — getLevel/setLevel/shouldAsk (autonomy 0-3)
lib/personality/learning.js     — process(userId, interaction) — event-driven adaptation
lib/personality/patterns.js     — detect/get/save — recurring request patterns
lib/personality/inject.js       — build(userId, options) — assembles all modules → prompt block

lib/personality/systemPrompt.js [NEW] SINGLE SOURCE OF TRUTH for all system prompts
                                   buildSystemPrompt(userId, agentContext)
                                     → loads personality + memory + model health + tools
                                     → returns complete self-aware system prompt
                                   buildLiteSystemPrompt(userId, pageContext)
                                     → stripped version for bookmarklet
                                     → includes page context + vision capability flag
                                   Replaces:
                                     LITE_SYSTEM_PROMPT const in api/lite-agent.js
                                     systemParts assembly in api/agent.js
                                     personalityBlock in api/agent.js
```

### 3.6 /middleware
```
middleware/cors.js           — allows github.io + localhost:3000/5500 + injected pages (origin: true)
middleware/verify-token.js   — JWT verify, DEV_TOKEN env bypass (remove before full production)
middleware/rate-limit.js     — Upstash Redis per-user/hr limits, fails OPEN on Redis error
middleware/requestLogger.js  — logs every /api/ request to logs table (skips warmup/health/broadcast)
```

### 3.7 /utils
```
utils/constants.js     — ALL enums and constants:
                          MODELS: all 9 model strings (exact, verified)
                          VISION: MODEL_CHAIN, SUPPORTED_MIME_TYPES, MAX_INLINE_BYTES,
                                  SCREENSHOT_QUALITY (0.75), SCREENSHOT_MAX_DIM (1280)
                          SNIPPET_TYPES: 'code'|'research'|'image'|'file'
                          ENDPOINTS: GROQ, MISTRAL_CHAT, MISTRAL_OCR, CODESTRAL_FIM, TAVILY, SERPER
                          RATE_LIMITS: per-route limits + MISTRAL budget + VISION bucket
                          PROVIDER_STATUS: ok, rate_limited, down, unknown
                          PROVIDER_COOLDOWN: rate_limited=60s, down=120s
                          AGENT: MAX_TOKENS=6000, CODESTRAL_MAX_TOKENS=2000, VISION_MAX_TOKENS=1500,
                                 CONTEXT_WARN_PCT=0.80, MAX_RETRIES=5, TASK_TTL_SECONDS=3600,
                                 MEMORY_SUMMARIES=5, DEBOUNCE_SETTINGS_MS=1500, DIFF_PAGE_LINES=50
                          SSE: HEARTBEAT_INTERVAL_MS=15000, EVENT_TYPES (trace/finding/warning/complete/pulse/heartbeat)
                          SCRAPER: MAX_SNIPPET_LENGTH=2000, MAX_SNIPPETS_COUNT=20,
                                   SCREENSHOT_QUALITY=0.75, MAX_TEXT_FILE_BYTES=500000
                          TABLES: all 18 table name strings
                          GITHUB: OWNER, REPOS, SANDBOX_BRANCH='ai-sandbox', DEFAULT_BRANCH='main'
                          HTTP: status code constants
                          JWT: EXPIRES_IN='7d', ALGORITHM='HS256'

utils/env-check.js     — validates 18 required env vars on startup, process.exit(1) if missing
utils/commandSafety.js — validateStructured(), sanitizeOutput(), buildExecOptions()
                          Allowlist: node/npm/npx/git/ls/cat/grep/find/esbuild + more
                          Hard blocked: bash/sh/python/curl/wget/sudo + more
                          No shell: execFile() only, shell: false
utils/formatter.js     — truncate, stripHtml, formatBytes, formatDuration,
                          safeJson, toTitle, redact, codeBlock, shortId
```

---

## 4. SUPABASE SCHEMA — 18 TABLES

Live DB verified (project ID: `bgngzxdfdghrtuqefjhn`, region: us-east-1):

```sql
users              — id TEXT PK, github_username TEXT, last_login TIMESTAMPTZ, created_at
sessions           — id UUID PK, user_id FK→users, page_url, page_title, name,
                     created_at, updated_at
snippets           — id UUID PK, user_id FK→users, session_id FK→sessions (nullable),
                     number INT4, type CHECK('code'|'research'|'image'|'file'),
                     content TEXT, source_url TEXT, pinned BOOL default false,
                     metadata JSONB nullable, mime_type TEXT nullable,
                     file_size INT4 nullable, created_at
conversations      — id UUID PK, user_id FK, session_id FK nullable,
                     role CHECK('user'|'assistant'|'system'), content TEXT,
                     card_type TEXT default 'text', metadata JSONB default {},
                     created_at
personality        — id UUID PK, user_id FK, key TEXT, value TEXT, updated_at
settings           — user_id TEXT PK FK→users, autonomy_level INT4 default 1,
                     confirmation_prompts BOOL default true,
                     auto_session_split INT4 default 80,
                     learning_triggers BOOL default true,
                     reasoning_log BOOL default false,
                     snippet_limit INT4 default 20,
                     auto_sync BOOL default true,
                     prompt_injection BOOL default true,
                     active_model TEXT, fallback_order JSONB, updated_at
active_model       — user_id TEXT PK FK→users, model TEXT, updated_at
tasks              — id UUID PK, user_id FK, intent TEXT,
                     steps JSONB default [], current_step INT4 default 0,
                     status CHECK('pending'|'running'|'paused'|'done'|'failed'),
                     context_snapshot JSONB, result_summary TEXT,
                     created_at, updated_at
task_checkpoints   — id UUID PK, task_id FK→tasks, user_id FK, snapshot JSONB, created_at
repo_mappings      — id UUID PK, user_id FK, file_path TEXT, repo TEXT,
                     branch TEXT default 'main', created_at
repo_cache         — id UUID PK, user_id FK, repo TEXT, branch TEXT, tree JSONB, cached_at
deployments        — id UUID PK, user_id FK, repo TEXT,
                     status CHECK('pending'|'building'|'success'|'failed'),
                     commit_sha TEXT, build_log TEXT, deployed_at
context_summaries  — id UUID PK, user_id FK, summary TEXT, session_name TEXT, created_at
reasoning_log      — id UUID PK, user_id FK, task_id FK→tasks nullable,
                     trace TEXT, model TEXT, created_at
rate_usage         — id UUID PK, user_id FK, endpoint TEXT, count INT4, window_start, created_at
logs               — id UUID PK, user_id FK nullable, endpoint TEXT, method TEXT,
                     status INT4, duration_ms INT4, model TEXT, tokens_used INT4,
                     error TEXT, created_at
broadcast_queue    — id UUID PK, user_id FK, event_id TEXT, type TEXT,
                     content TEXT, created_at, expires_at
shadow_branches    — id UUID PK, user_id FK, repo TEXT, branch_name TEXT,
                     file_path TEXT, operation CHECK('write'|'delete'|'replace'),
                     created_at, expires_at
```

RLS enabled on all 18 tables.

---

## 5. ENVIRONMENT VARIABLES — 18 REQUIRED

```bash
JWT_SECRET=
ACCESS_PIN=                  # PIN stored in HF env, verified at login (no OAuth)

GROQ_API_KEY=                # gsk_ prefix
MISTRAL_API_KEY=             # api.mistral.ai — devstral + mistral-large + leanstral
CODESTRAL_API_KEY=           # codestral.mistral.ai — SEPARATE key from MISTRAL
GEMINI_API_KEY=              # all Gemini + Gemma models via Google AI SDK

TAVILY_API_KEY=              # 2 keys available
SERPER_API_KEY=
FIRECRAWL_API_KEY=           # primary DOM scraper (better than Jina)

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

GITHUB_PAT=                  # repo + workflow scopes
GITHUB_USERNAME=             # VinnsEdesigner

UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

HF_SPACE_URL=
NODE_ENV=

# Dev only — REMOVE from HF env before going fully live
DEV_TOKEN=
```

---

## 6. AI MODEL WATERFALL

**Full agent waterfall order (lib/ai.js):**
```
1. groq/llama-3.3-70b-versatile          primary brain (skip if preferCode=true)
2. mistral/devstral-medium-2507          code writing  (api.mistral.ai, 1 RPS shared bucket)
3. mistral/mistral-large-2512            fallback brain (api.mistral.ai, same 1 RPS bucket)
4. gemini/gemini-3.1-flash-lite-preview  500 RPD fast fallback
5. google/gemma-4-26b-a4b-it             1.5K RPD MoE
6. google/gemma-4-31b-it                 1.5K RPD dense
7. gemini/gemini-2.5-flash               20 RPD ABSOLUTE LAST RESORT
```

**Vision model chain (lib/agent/visionHandler.js):**
```
1. gemini-3.1-flash-lite-preview   primary vision (500 RPD)
2. gemma-4-26b-a4b-it              fallback (1.5K RPD)
3. gemma-4-31b-it                  fallback (1.5K RPD)
4. gemini-2.5-flash                last resort (20 RPD, best quality)
```

**Codestral FiM:**
```
Endpoint: codestral.mistral.ai/v1/fim/completions
Model:    codestral-latest
Key:      CODESTRAL_API_KEY (separate from MISTRAL_API_KEY)
Intent:   surgical_edit → send prefix + suffix → fill the gap
Rate:     1 RPS INDEPENDENT bucket from api.mistral.ai
```

**Search waterfall:**
```
Tavily → Serper
Jina (r.jina.ai) = free, URL reading only fallback
```

---

## 7. SCRAPER — COMPLETE FILE MAP

```
/SCRAPER-
├── build.js                        — esbuild IIFE bundler
│                                     BACKEND_URL define injected at build time
├── package.json                    — devDep: esbuild ^0.20
├── build/
│   ├── scraper.js                  — compiled minified IIFE bookmarklet bundle
│   └── loader.txt                  — javascript: URL to install as browser bookmark
├── .github/workflows/
│   └── build.yml                   — push → npm run build → commit build/scraper.js
└── src/
    ├── index.js                    — entry: toggle off if loaded, calls init()
    ├── core.js                     — getToken(), getSessionId(), initHud()
    ├── dom-reader.js               — readPage() → { url, title, content }
    │                                 5000 char limit, TreeWalker (skips script/style/noscript)
    ├── mini-agent.js               — askLiteAgent(msg, snippets, history) → POST /api/lite-agent
    │                                 escalates to POST /api/agent when needed
    │                                 __BACKEND_URL__ replaced at build time
    ├── selection.js                — initSelection(onSelect), getSelected(), clearSelection()
    │                                 Uses selectionchange + touchend (NOT mouseup — unreliable Android)
    │                                 300ms debounce on selectionchange
    ├── storage.js                  — getToken/setToken, getSessionId/resetSession
    │                                 getSnippets/saveSnippets/addSnippet/removeSnippet/clearSnippets
    ├── sync.js                     — syncToBackend(onStatus) → POST /api/scraper-agent
    │                                 pollSettings(token) → GET /api/sync
    │                                 __BACKEND_URL__ replaced at build time
    └── hud/
        ├── index.js                — initHud() — orchestrates all HUD modules
        ├── shell.js                — FAB + panel DOM, buildShell(), togglePanel()
        │                             showWarn(msg), setBadge(id, label, state)
        │                             getFab(), getPanel()
        ├── tabs.js                 — initTabs(), switchTab(name), restoreLastTab()
        ├── ask.js                  — AGENT tab
        │                             sendMessage(), generateSuggest(), addBubble()
        │                             Chat history drawer (localStorage, 20 sessions)
        │                             Syntax highlighting (JS/TS/PY/SH/JSON/CSS/HTML)
        │                             ASCII tree detection + rendering
        │                             Prompt injection: selectors → contentEditable → clipboard
        ├── snippets.js             — SNIPPETS tab
        │                             createSelectionOverlay(), stageSelection(type)
        │                             deleteSnippet() with 5s undo stack
        │                             renderSnippets(), openModal(snippet)
        ├── settings.js             — SETTINGS tab: height slider, theme, snippet limit
        ├── status.js               — setStatus(color, msg), refreshAuthBadge()
        ├── drag.js                 — initFabDrag() + initPanelResize()
        │                             restoreFabPosition(), restorePanelHeight()
        ├── persist.js              — startPoll()/stopPoll() — 15s interval → pollSettings
        ├── inject.js               — injectIntoPage(text) — injection with fallbacks
        └── styles/
            ├── index.js            — injectStyles() — assembles all CSS modules
            ├── vars.js             — CSS vars, JetBrains Mono import, light theme override
            ├── fab.js              — FAB + status dot styles
            ├── panel.js            — panel shell, drag handle, logo, status bar, tabs
            ├── agent.js            — agent tab, history drawer, chat bubbles, inject banner
            ├── code.js             — IDE code block, syntax tokens, ASCII tree block
            ├── snippets.js         — snippets tab, undo bar, view modal
            ├── settings.js         — settings tab layout
            └── buttons.js          — all button variants
```

---

## 8. DASHBOARD — FULL PLANNED ARCHITECTURE

**The entire dashboard is a GREENFIELD BUILD. 0 files exist.**
**Stack:** Vanilla JS (ES modules), no framework, GitHub Pages deployment
**Philosophy:** React-like component thinking, pure vanilla execution
**Design:** HuggingFace data-dense, OLED pure black, mobile-first

### 8.1 Deployment
```
Push main → GitHub Actions → GitHub Pages
URL: https://vinnsedesigner.github.io/dashboard
Workflow: .github/workflows/deploy.yml
```

### 8.2 Full Planned File Structure

```
/dashboard
├── index.html                          app shell, import map, all <link> styles
├── sw.js                               service worker — offline queue
│
├── /pages                              tab-level controllers
│   ├── terminal.js                     Terminal tab orchestrator
│   ├── pulse.js                        Pulse tab orchestrator
│   ├── repos.js                        Repos tab orchestrator
│   ├── snippets.js                     Snippets tab orchestrator
│   ├── logs.js                         Logs tab orchestrator
│   └── settings.js                     Settings tab orchestrator (6 sections)
│
├── /components
│   ├── navbar.js                       top 56px bar: ☰ + session + status dot
│   ├── tab-rail.js                     bottom 56px: 6 tabs, notification dots
│   ├── session-drawer.js               session list — closes on tab switch
│   ├── model-switcher.js               dropdown → PATCH /api/active-model on change
│   ├── status-indicator.js             3-layer status (see Section 8.4)
│   ├── offline-indicator.js            offline queue fallback banner
│   ├── auth-gate.js                    PIN login modal, token storage
│   ├── loader.js                       full-screen loading states
│   │
│   ├── /terminal                       message card type components
│   │   ├── user-command.js             user bubble, right-aligned
│   │   ├── agent-reply.js              agent bubble, left-aligned, markdown parsed
│   │   ├── tool-card.js                tool in progress: name + status + collapsible result
│   │   ├── diff-card.js                syntax-highlighted diff, 50-line pages + [Load More]
│   │   ├── error-card.js               red border + [↩ Retry] button
│   │   ├── broadcast-card.js           purple border, unsolicited agent finding
│   │   ├── thinking-stream.js          always-present collapsed trace box (28px collapsed)
│   │   ├── confirm-card.js             [✅ Proceed] [✏️ Modify] [❌ Cancel]
│   │   └── image-card.js               image snippet in terminal: thumbnail + [🔍 Analyze]
│   │
│   ├── /pulse
│   │   ├── health-panel.js             HF Space, Supabase, GitHub, each AI provider
│   │   ├── activity-stream.js          live SSE event log, color coded, infinite scroll
│   │   ├── token-meters.js             quota bars per provider, 80% warn, reset countdown
│   │   │                               TOKEN QUOTA LIVES HERE ONLY — NOT in Settings
│   │   └── deploy-panel.js             last 5 deployments, status, collapsible logs
│   │
│   ├── /repos
│   │   ├── file-tree.js                expandable tree, click → read file → terminal tool-card
│   │   ├── action-log.js               recent git ops + commit SHAs
│   │   └── stop-button.js              abort current agent operation
│   │
│   └── /snippets
│       ├── snippet-card.js             #N preview [type grey] [view] [🗑] [📍]
│       ├── snippet-filters.js          [All][Code][Research][Image][File] filter row
│       ├── snippet-search.js           text search across content
│       └── image-preview.js            thumbnail preview for image-type snippets
│
├── /api                                backend API wrappers
│   ├── client.js                       base fetch: token injection, error handling, retry
│   ├── agent.js                        POST /api/agent, PATCH /api/active-model
│   ├── lite-agent.js                   POST /api/lite-agent
│   ├── broadcast.js                    EventSource SSE, reconnect with Last-Event-ID
│   ├── github.js                       POST /api/github + rollback + tree
│   ├── sessions.js                     CRUD /api/session
│   ├── snippets.js                     GET/POST/DELETE /api/snippets
│   ├── settings.js                     GET/PATCH /api/settings
│   ├── health.js                       GET /api/health (polled every 30s in Pulse)
│   └── vision.js                       POST /api/vision [NEW]
│
├── /context
│   └── state.js                        AppState singleton
│                                         auth: { token, userId }
│                                         session: { id, name, list }
│                                         model: { active, fallbackOrder, statuses }
│                                         settings: { full settings object }
│                                         sseConnected: bool
│                                         offlineQueue: []
│
├── /hooks                              reactive logic modules (vanilla, not React)
│   ├── useAgent.js                     agent request lifecycle, streaming state
│   ├── useSession.js                   session load, switch, create
│   ├── usePersonality.js               load personality rows for settings display
│   ├── useGitHub.js                    file tree, rollback, file read
│   ├── useBroadcast.js                 SSE subscription, event routing by type
│   ├── useOffline.js                   offline detection, localStorage command queue
│   └── useVision.js                    image analysis, snippet upload [NEW]
│
├── /utils
│   ├── formatter.js                    date, bytes, duration, truncate, escapeHtml
│   ├── storage.js                      localStorage: token, offline queue, preferences
│   ├── constants.js                    SSE event types, tab names, card types
│   ├── tokenCounter.js                 client-side token estimate (~4 chars/token)
│   ├── streamChunker.js                50-100ms SSE chunk buffer (prevents DOM freeze on mobile)
│   └── logger.js                       client-side structured logger (dev console)
│
├── /styles
│   ├── global.css                      CSS vars, reset, typography
│   ├── layout.css                      navbar, tab-rail, panel scaffold
│   ├── terminal.css                    all message card types
│   ├── pulse.css                       health panel, meters, deploy cards
│   ├── repos.css                       file tree, action log
│   ├── snippets.css                    snippet cards, filters, image thumbnails
│   ├── logs.css                        log table, severity colors
│   └── settings.css                    6-section settings layout
│
└── .github/workflows/
    └── deploy.yml                      push main → GitHub Pages
```

### 8.3 Tab Specifications

**Tab Rail (bottom, 56px, horizontal scroll):**
```
[ 💬 Terminal ] [ ⚡ Pulse ] [ 📁 Repos ] [ 🕷️ Snippets ] [ 📋 Logs ] [ ⚙️ Settings ]
Notification dots appear on tabs with new unread activity
Switching any tab closes the session drawer
```

**💬 Terminal:**
```
Message card types:
  user-command    plain bubble right-aligned
  agent-reply     left-aligned, markdown parsed, code blocks highlighted
  tool-card       tool name + [⏳→✅/❌] + collapsible result JSON
  diff-card       syntax highlighted, 50-line page + [Load More] (LAW 17)
  error-card      red border + [↩ Retry]
  broadcast-card  purple (#7c3aed) border, unsolicited finding
  thinking-stream always present, collapsed 28px bar by default
                  content: classifier → intent, tools injected, model, fallbacks
                  auto-expands: model switch / error / all providers down
                  auto-collapses: agent idle
  confirm-card    [✅ Proceed] [✏️ Modify plan] [❌ Cancel]
  image-card      thumbnail + [🔍 Analyze] → POST /api/vision [NEW]

Input bar extras:
  [⚡ Force Mode] toggle — bypasses intentClassifier, ALL tools injected
  Current model pill
```

**⚡ Pulse:**
```
1. SYSTEM HEALTH
   HF Space (latency ms), Supabase (ping), GitHub API (rate limit status)
   Each AI provider: dot (ok/rate-limited/down) + latency ms
   Self-diagnosis alerts from selfDiagnose.js findings via SSE

2. LIVE ACTIVITY
   SSE trace/finding/warning/complete events as they arrive
   Color: grey=trace, cyan=finding, amber=warning, red=error
   Infinite scroll, never truncated

3. TOKEN QUOTA — ONLY LIVES HERE (not duplicated in Settings)
   Progress bar per provider (groq separate, mistral shared, gemini/gemma separate)
   80% threshold warning indicator
   Monthly reset countdown timer

4. DEPLOYMENTS
   Last 5 records: repo + status badge + commit SHA + relative time
   Collapsible build log per record
```

**📁 Repos:**
```
Repo selector: [backend] [SCRAPER-] [dashboard]
Branch selector: main / ai-sandbox
File tree: expandable dirs, click file → read_file → renders in terminal tool-card
Action log: recent write/delete/branch/PR/rollback ops + commit SHAs
[⛔ Stop] — aborts current running agent task
```

**🕷️ Snippets:**
```
Filter row: [All] [Code] [Research] [Image] [File]
Search bar: client-side text search
Snippet card layout:
  #N  preview (truncated 80 chars)           [type badge grey]
  source URL  ·  timestamp
  ────────────────────────────────────────
  [view]  [🗑]  [📍 pin]

Image type extras: thumbnail preview, [🔍 Analyze] button → POST /api/vision
File type extras: file icon + size badge
Pinned snippets always on top
```

**📋 Logs:**
```
Table: time | endpoint | method | status | duration | model | tokens | error
Color: 2xx=teal (#22d3ee dim), 4xx=amber, 5xx=red (NO green text — use teal for success)
Filters: status group, endpoint prefix, date range
Click row → expand full log entry JSON
```

**⚙️ Settings (6 sections, ALL scrollable):**
```
1. AI Models
   Primary model selector (dropdown, PATCH /api/active-model on change)
   Fallback order list (reorderable)
   Per-model: token budget, avg latency 24hr, last used, recent errors

2. API Keys — READ-ONLY STATUS ONLY
   Provider name + availability dot + last checked timestamp
   "Edit keys in HF Spaces env vars panel" note
   Zero input fields. Zero key editing here.

3. GitHub
   Connected PAT (masked: VinnsE****)
   Default repo + branch
   Shadow branch naming convention
   PAT health indicator

4. Agent Behaviour
   Autonomy level (0-3 slider)
   Confirmation prompts toggle
   Auto-session split threshold
   Learning triggers toggle
   Reasoning log toggle (off by default → saves Supabase rows)

5. Scraper/Bookmarklet
   Snippet limit (1-20)
   Auto-sync on/off
   Prompt injection on/off
   [📋 Copy bookmarklet URL] button
   All changes → PATCH /api/settings → SSE → bookmarklet on next 15s poll

6. Account
   GitHub username display
   [🔄 Refresh token] button
   Danger zone: [Wipe data] [Reset memory]
```

### 8.4 Design System

**Design Tokens (global.css):**
```css
:root {
  --bg-base:         #000000;
  --bg-surface:      #0a0a0a;
  --bg-elevated:     #111111;
  --bg-hover:        #1a1a1a;

  --accent-purple:   #7c3aed;   /* broadcast cards ONLY */
  --accent-yellow:   #f59e0b;   /* warnings */
  --accent-red:      #ef4444;   /* errors, destructive */
  --accent-blue:     #3b82f6;   /* links, info */
  --accent-cyan:     #22d3ee;   /* live/streaming indicators, 2xx status */

  /* NO GREEN TEXT ANYWHERE — use cyan for success indicators */

  --text-primary:    #e6edf3;
  --text-secondary:  #b1bac4;
  --text-muted:      #7d8590;
  --text-disabled:   #484f58;

  --border-subtle:   #111111;
  --border-default:  #1e1e1e;
  --border-strong:   #2e2e2e;
  --border-selected: #444444;   /* selected state: thicker grey */

  --font-sans:  'Geist', 'Inter', sans-serif;
  --font-mono:  'Geist Mono', 'JetBrains Mono', monospace;
}
```

**Button Selected State:**
```
background: var(--bg-elevated) → #111111
border: 2px solid var(--border-selected) → #444444
color: var(--text-primary) → #e6edf3
No colored text. No colored background. Grey only.
```

**Layout:**
```
┌─────────────────────────────────────────┐
│  navbar (56px) — ☰ + session + status   │
├─────────────────────────────────────────┤
│                                         │
│    main content (scrollable per tab)    │
│                                         │
├─────────────────────────────────────────┤
│  tab rail (56px) [ 💬 ⚡ 📁 🕷️ 📋 ⚙️ ] │
└─────────────────────────────────────────┘
```

**3-Layer Status:**
```
Layer 1 — System (navbar dot):
  ● All systems online
  ● Degraded (fallback active)
  ● Backend unreachable
  💤 HF Space waking...

Layer 2 — Agent (Terminal, above input):
  ⚪ Idle | 🔵 Thinking | 🟡 Working | ● Done | 🔴 Failed | 📡 Broadcasting

Layer 3 — Tool call (inside tool-card):
  ⏳ Calling... | ✅ Done | ❌ Rate limit → switching | 🔄 Retry (2/5) | ↩ Rolled back
```

### 8.5 Dashboard Build Order (56 files, 9 phases)

```
Phase 1 — Shell + Auth (blocks everything else)
  1.  index.html + styles/global.css + styles/layout.css
  2.  utils/constants.js + utils/formatter.js + utils/storage.js
  3.  context/state.js — AppState singleton
  4.  api/client.js — base fetch wrapper + token injection
  5.  components/auth-gate.js — PIN modal
  6.  components/navbar.js + components/tab-rail.js
  7.  components/loader.js

Phase 2 — SSE + Real-time Backbone
  8.  api/broadcast.js — EventSource + Last-Event-ID reconnect
  9.  hooks/useBroadcast.js — event routing
  10. components/status-indicator.js
  11. components/offline-indicator.js
  12. utils/streamChunker.js

Phase 3 — Terminal Tab (core value)
  13. components/terminal/thinking-stream.js
  14. components/terminal/user-command.js
  15. components/terminal/agent-reply.js (markdown)
  16. components/terminal/tool-card.js
  17. components/terminal/diff-card.js (50-line pagination)
  18. components/terminal/error-card.js
  19. components/terminal/broadcast-card.js
  20. components/terminal/confirm-card.js
  21. components/terminal/image-card.js
  22. components/model-switcher.js
  23. api/agent.js
  24. hooks/useAgent.js
  25. styles/terminal.css
  26. pages/terminal.js

Phase 4 — Sessions
  27. api/sessions.js
  28. components/session-drawer.js
  29. hooks/useSession.js

Phase 5 — Repos Tab
  30. api/github.js
  31. components/repos/file-tree.js
  32. components/repos/action-log.js
  33. components/repos/stop-button.js
  34. hooks/useGitHub.js
  35. styles/repos.css
  36. pages/repos.js

Phase 6 — Snippets Tab (includes vision)
  37. api/snippets.js
  38. api/vision.js
  39. components/snippets/snippet-card.js
  40. components/snippets/snippet-filters.js
  41. components/snippets/snippet-search.js
  42. components/snippets/image-preview.js
  43. hooks/useVision.js
  44. styles/snippets.css
  45. pages/snippets.js

Phase 7 — Pulse Tab
  46. api/health.js
  47. components/pulse/health-panel.js
  48. components/pulse/activity-stream.js
  49. components/pulse/token-meters.js
  50. components/pulse/deploy-panel.js
  51. styles/pulse.css
  52. pages/pulse.js

Phase 8 — Logs + Settings
  53. styles/logs.css + pages/logs.js
  54. hooks/usePersonality.js
  55. api/settings.js
  56. styles/settings.css + pages/settings.js

Phase 9 — Polish
  57. utils/tokenCounter.js + utils/logger.js
  58. sw.js (service worker, offline queue)
  59. .github/workflows/deploy.yml
```

---

## 9. CORE ARCHITECTURAL LAWS (25 TOTAL)

```
REAL-TIME + DATA
1. UI change = immediate API call = real effect. No orphan UI state. Ever.
2. No Vercel. No serverless. All backend logic lives in HF Spaces Express.js.
3. No GitHub OAuth on scraper. Single PAT in HF env vars. Solo tool = no OAuth.
4. No QStash. HF Spaces has no timeout — heavy ops run directly in Express.
5. Screenshots NOW ALLOWED in scraper (base64 in localStorage only).
   Supabase gets URL + metadata JSON only. No raw base64 in DB.
6. reasoning_log is toggleable. Full CoT traces eat Supabase free tier rows fast.
7. SSE is the nervous system. Every state change pushes via SSE to connected clients.
8. Bookmarklet polls /api/sync every 15s. SSE not reliable in injected context.
9. Dashboard → Backend = direct API (instant).
   Backend → Dashboard = SSE push (instant).
   Backend → Bookmarklet = 15s poll (acceptable).
10. All interactive elements fire real API calls. Zero fake UI. Zero orphaned state.

RATE LIMITS + MODELS
11. Mistral api.mistral.ai: 1 RPS global. Enforce 1s gap (timestamp check, not full queue).
12. Codestral codestral.mistral.ai: separate 1 RPS bucket. Independent gap enforcer.
    Both can fire simultaneously fine — they are different endpoints.
13. Mistral token budget: 1B tokens/month SHARED across ALL mistral APIs.
    rateMonitor tracks globally. Warn at 800M.

MEMORY + CONTEXT
14. Episodic memory mandatory. Session end → 3-sentence summary → context_summaries.
    Agent loads last 5 summaries on start (~300 tokens total).
15. Thinking stream always present in Terminal, collapsed by default (28px bar).
    Auto-expands on model switch/error. Auto-collapses on idle.

UX LAWS
16. Settings toggles: 1.5s debounced delta sync. Single PATCH with accumulated changes.
17. Diff cards paginate at 50 lines + [Load More]. Prevents DOM freeze on mobile Chrome.
18. SSE message ID handshake on reconnect. Backend replays from broadcast_queue.
19. SSE heartbeat: 15s ping/pong. Prevents orphaned processes on tab sleep.
20. Task states cached to Upstash Redis (1hr TTL). HF Space restart resumes from Redis.

VISION (NEW)
21. Vision calls use Gemini/Gemma chain ONLY (vision-capable models).
    Never Groq or Mistral for image analysis.
22. Base64 image data = scraper localStorage only. Supabase gets URL + metadata.
23. analyze_image and fetch_to_snippets are agent tools — execute via executor.js.
24. Image snippets in dashboard show thumbnail + [🔍 Analyze] → POST /api/vision.
25. systemPrompt.js is the single source of truth.
    No hardcoded system prompts anywhere else in the codebase.
```

---

## 10. SSE EVENT STRUCTURE

```js
// Every SSE event shape:
{ id: string, type: string, content: any, timestamp: string }

// Type enum:
"trace"     → thinking stream (grey monospace in Terminal)
"finding"   → agent discovery (broadcast-card, purple border)
"warning"   → needs attention (amber)
"complete"  → background task done
"pulse"     → system status update
"heartbeat" → 15s keep-alive (no UI update needed)

// Reconnect with message replay:
const es = new EventSource('/api/broadcast', {
  headers: { 'Last-Event-ID': lastReceivedId }
});
// Backend checks broadcast_queue for missed events and replays them
```

---

## 11. EXTERNAL SERVICES

```
✅ Groq          llama-3.3-70b (gsk_ key) — primary brain
✅ Gemini/Gemma  flash-lite + 2.5-flash + gemma-26b + gemma-31b — fallback + vision
✅ Mistral       devstral-medium-2507, mistral-large-2512, leanstral (api.mistral.ai)
✅ Codestral     codestral-latest FiM (codestral.mistral.ai, SEPARATE key + bucket)
✅ Supabase      project: bgngzxdfdghrtuqefjhn | region: us-east-1 | 18 tables
✅ Tavily        2 API keys available
✅ Serper        key confirmed
✅ Firecrawl     key confirmed (primary DOM scraper)
✅ GitHub PAT    repo + workflow scopes — VinnsEdesigner
✅ Upstash Redis URL + token confirmed
✅ UptimeRobot   pings /api/warmup every 5min (external, phone-independent)
🆓 Jina Reader  r.jina.ai/{url} — free forever, URL reading fallback only
```

---

## 12. FILE COUNT SUMMARY

```
/backend    ~55 files + Dockerfile
            Pending: vision.js, visionHandler.js, fetchToSnippets.js, systemPrompt.js (4 files)

/SCRAPER-   20 source files + workflows + compiled bundle

/dashboard  0 files currently — 59 files planned (9 phases)

Total planned: ~138 files across 3 repos
```

---

*End of CONTEXT.md v4.0*
*Key changes from v3:*
*Vision capability added (analyze_image + fetch_to_snippets tools, /api/vision endpoint)*
*systemPrompt.js centralization (single source of truth)*
*image/file snippet types confirmed in live Supabase DB*
*VISION + SNIPPET_TYPES constants confirmed in utils/constants.js*
*Complete dashboard architecture with 59 files, 9 phases, image components*
*25 architectural laws (was 20)*
*Scraper repo confirmed as VinnsEdesigner/SCRAPER- (hyphen suffix)*
