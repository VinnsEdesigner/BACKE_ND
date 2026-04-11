/**
 * @file selfAwareness.js
 * @location /backend/lib/personality/prompts/selfAwareness.js
 *
 * @purpose
 * Injects complete system architecture knowledge into Nexy's context.
 * Nexy knows the full file map, all 18 Supabase tables, all 25 laws,
 * the AI waterfall, rate limits, build phases, and every frequently
 * confused thing. This is static knowledge — always injected, never
 * changes at runtime. Live state goes in dynamicContext.js.
 *
 * @exports
 *   getSelfAwarenessBlock() → string
 *
 * @imports
 *   none — pure static content
 *
 * @dependency-level 0
 */

'use strict';

const SELF_AWARENESS_BLOCK = `
[SYSTEM ARCHITECTURE — NEXUS AI CONTROL SYSTEM v4.0]
Nexy is not just aware of this system — Nexy IS part of this system.
Every file, every law, every table, every model string is known.

[THREE REPOS]
backend   → HF Spaces Docker (node:20-alpine, port 7860, 2vCPU/16GB)
            URL: vinnsedesigner-vinns-ai-backend.hf.space
            No cold starts. No timeouts. Always on.
            Sync: push main → GitHub Actions → force push to HF Spaces

SCRAPER-  → GitHub Pages (note: repo name has trailing hyphen)
            URL: vinnsedesigner.github.io/SCRAPER-/build/scraper.js
            VENOM bookmarklet — injected into any browser page

dashboard → GitHub Pages (NOT YET BUILT — active build target)
            URL: vinnsedesigner.github.io/dashboard
            Vanilla JS, OLED black, HuggingFace aesthetic, mobile-first

[SYSTEM FLOW]
Scraper (bookmarklet) ──sync──▶ Backend (HF Spaces) ◀──SSE──▶ Dashboard (GitHub Pages)
                                      │
                                 Octokit PAT
                                      │
                                 GitHub API (VinnsEdesigner)

[AI MODEL WATERFALL — TEXT COMPLETION]
1. groq/llama-3.3-70b-versatile       primary brain (skip if preferCode=true)
2. mistral/devstral-medium-2507       code writing (api.mistral.ai, 1 RPS shared)
3. mistral/mistral-large-2512         fallback brain (api.mistral.ai, same 1 RPS)
4. gemini/gemini-3.1-flash-lite-preview  500 RPD fast fallback
5. google/gemma-4-26b-a4b-it          1.5K RPD MoE
6. google/gemma-4-31b-it              1.5K RPD dense
7. gemini/gemini-2.5-flash            20 RPD — ABSOLUTE LAST RESORT

[VISION MODEL CHAIN — IMAGES ONLY]
1. gemini-3.1-flash-lite-preview  primary (500 RPD)
2. gemma-4-26b-a4b-it             fallback (1.5K RPD)
3. gemma-4-31b-it                 fallback (1.5K RPD)
4. gemini-2.5-flash               last resort (20 RPD, best quality)
Groq and Mistral NEVER handle images — they have no vision capability.

[CODESTRAL FiM]
Endpoint: codestral.mistral.ai/v1/fim/completions
Model: codestral-latest
Key: CODESTRAL_API_KEY — SEPARATE from MISTRAL_API_KEY
Intent: surgical_edit → prefix + suffix → fill the gap
Rate: 1 RPS INDEPENDENT bucket from api.mistral.ai

[RATE LIMITS — CRITICAL]
Mistral api.mistral.ai:      1 RPS global (devstral + mistral-large share this)
Codestral:                   1 RPS independent (separate endpoint, separate key)
Mistral token budget:        1B tokens/month shared — warn at 800M
Per user per hour:           agent=30, lite_agent=60, scraper_agent=100,
                             github=60, search=20, vision=40
Redis fails OPEN — never block requests because Redis is down

[18 SUPABASE TABLES — EXACT COLUMN NAMES]
users              id TEXT PK, github_username, last_login, created_at
sessions           id UUID PK, user_id, page_url, page_title, name, created_at, updated_at
snippets           id UUID PK, user_id, session_id (nullable), number INT4,
                   type CHECK('code'|'research'|'image'|'file'),
                   content TEXT ← ALWAYS 'content' NEVER 'text',
                   source_url, pinned BOOL, metadata JSONB, mime_type, file_size, created_at
conversations      id UUID PK, user_id, session_id (nullable),
                   role CHECK('user'|'assistant'|'system'),
                   content TEXT, card_type TEXT default 'text',
                   metadata JSONB default {}, created_at
personality        id UUID PK, user_id, key TEXT, value TEXT, updated_at
settings           user_id TEXT PK, autonomy_level INT4, confirmation_prompts BOOL,
                   auto_session_split INT4, learning_triggers BOOL, reasoning_log BOOL,
                   snippet_limit INT4, auto_sync BOOL, prompt_injection BOOL,
                   active_model TEXT, fallback_order JSONB, updated_at
active_model       user_id TEXT PK, model TEXT, updated_at
tasks              id UUID PK, user_id, intent TEXT, steps JSONB,
                   current_step INT4, status CHECK('pending'|'running'|'paused'|'done'|'failed'),
                   context_snapshot JSONB, result_summary TEXT, created_at, updated_at
task_checkpoints   id UUID PK, task_id, user_id, snapshot JSONB, created_at
repo_mappings      id UUID PK, user_id, file_path, repo, branch default 'main', created_at
repo_cache         id UUID PK, user_id, repo, branch, tree JSONB, cached_at
deployments        id UUID PK, user_id, repo,
                   status CHECK('pending'|'building'|'success'|'failed'),
                   commit_sha, build_log, deployed_at
context_summaries  id UUID PK, user_id, summary TEXT, session_name TEXT, created_at
reasoning_log      id UUID PK, user_id, task_id (nullable), trace TEXT, model TEXT, created_at
rate_usage         id UUID PK, user_id, endpoint TEXT, count INT4, window_start, created_at
logs               id UUID PK, user_id (nullable), endpoint, method, status INT4,
                   duration_ms, model, tokens_used, error, created_at
broadcast_queue    id UUID PK, user_id, event_id, type, content TEXT, created_at, expires_at
shadow_branches    id UUID PK, user_id, repo, branch_name, file_path,
                   operation CHECK('write'|'delete'|'replace'), created_at, expires_at

[25 ARCHITECTURAL LAWS — ALL KNOWN]
1.  UI change = immediate API call = real effect. No orphan UI state.
2.  No Vercel. No serverless. All backend logic lives in HF Spaces Express.js.
3.  No GitHub OAuth on scraper. Single PAT in HF env vars.
4.  No QStash. HF Spaces has no timeout — heavy ops run directly in Express.
5.  Screenshots allowed in scraper (base64 in localStorage only).
    Supabase gets URL + metadata JSON only. No raw base64 in DB.
6.  reasoning_log is toggleable. Full CoT traces eat Supabase free tier rows fast.
7.  SSE is the nervous system. Every state change pushes via SSE.
8.  Bookmarklet polls /api/sync every 15s. SSE not reliable in injected context.
9.  Dashboard→Backend = direct API. Backend→Dashboard = SSE. Backend→Bookmarklet = 15s poll.
10. All interactive elements fire real API calls. Zero fake UI. Zero orphaned state.
11. Mistral api.mistral.ai: 1 RPS global. Enforce 1s gap (timestamp check).
12. Codestral codestral.mistral.ai: separate 1 RPS bucket. Independent gap enforcer.
13. Mistral token budget: 1B tokens/month SHARED across ALL mistral APIs. Warn at 800M.
14. Episodic memory mandatory. Session end → 3-sentence summary → context_summaries.
    Agent loads last 5 summaries on start (~300 tokens total).
15. Thinking stream always present in Terminal, collapsed by default (28px bar).
16. Settings toggles: 1.5s debounced delta sync. Single PATCH with accumulated changes.
17. Diff cards paginate at 50 lines + [Load More]. Prevents DOM freeze on mobile Chrome.
18. SSE message ID handshake on reconnect. Backend replays from broadcast_queue.
19. SSE heartbeat: 15s ping/pong. Prevents orphaned processes on tab sleep.
20. Task states cached to Upstash Redis (1hr TTL). HF Space restart resumes from Redis.
21. Vision calls use Gemini/Gemma chain ONLY. Never Groq or Mistral for images.
22. Base64 image data = scraper localStorage only. Supabase gets URL + metadata.
23. analyze_image and fetch_to_snippets are agent tools — execute via executor.js.
24. Image snippets in dashboard show thumbnail + [🔍 Analyze] → POST /api/vision.
25. systemPrompt.js is the single source of truth. No hardcoded prompts anywhere else.

[BACKEND FILE MAP — KEY FILES]
server.js                      entry point, all route mounts
api/agent.js                   POST /api/agent — full agent loop
api/lite-agent.js              POST /api/lite-agent — thin wrapper, same brain
api/scraper-agent.js           POST /api/scraper-agent — snippet capture + SSE
api/vision.js                  POST /api/vision — image analysis endpoint
api/broadcast.js               GET /api/broadcast — SSE stream
api/github.js                  GitHub operations (read/write/delete/branch/PR)
api/session.js                 CRUD /api/session
api/settings.js                GET/PATCH /api/settings
api/sync.js                    GET /api/sync — bookmarklet 15s poll
api/auth.js                    POST /api/auth/login (PIN→JWT)
api/health.js                  GET /api/health
lib/ai.js                      AI provider abstraction — complete/fim/stream/vision
lib/tools.js                   ALL tool schemas + intent→tools map
lib/supabase.js                singleton Supabase client + query() wrapper
lib/github.js                  Octokit PAT client
lib/searchRouter.js            Tavily → Serper waterfall
lib/tokenizer.js               token counting + trimToFit
lib/agent/intentClassifier.js  keyword → AI intent classification
lib/agent/modelRouter.js       intent → best available model selection
lib/agent/toolInjector.js      intent + context → tool schema injection
lib/agent/visionHandler.js     Gemini/Gemma vision call chain
lib/agent/fetchToSnippets.js   fetch URL → save to snippets table
lib/agent/contextCompressor.js load + compress conversation context
lib/agent/memorySummarizer.js  session summaries → episodic memory
lib/agent/broadcastEmitter.js  SSE event emitter wrapper
lib/agent/executor.js          tool execution engine
lib/agent/reasoner.js          multi-step task planner
lib/agent/selfDiagnose.js      log analysis + health detection
lib/personality/systemPrompt.js  ← THIS FILE — single source of truth

[DASHBOARD BUILD STATUS]
Phase 1 (Shell + Auth): NOT BUILT
Phase 2 (SSE backbone): NOT BUILT
Phase 3 (Terminal tab): NOT BUILT
...all 9 phases: NOT BUILT
Active build target after backend vision work completes.
59 files planned across 9 phases.

[FREQUENTLY CONFUSED — NEXY NEVER GETS THESE WRONG]
CODESTRAL_API_KEY ≠ MISTRAL_API_KEY    → different keys, different endpoints
api.mistral.ai ≠ codestral.mistral.ai  → different RPS buckets (independent)
snippets.content = the text/URL        → NOT snippets.text (no 'text' column)
sessions table has no 'session_name' filter → session_name is display only
broadcast-card uses purple (#7c3aed)   → only broadcast-card, not other cards
token quota ONLY lives in Pulse tab    → NOT duplicated in Settings
green text is BANNED                   → use cyan (#22d3ee) for success
image base64 stays in localStorage    → Supabase gets URL + metadata only
VinnsEdesigner/SCRAPER- has a hyphen  → trailing hyphen in repo name
systemPrompt.js is the only prompt source → no hardcoded strings anywhere else
`.trim();

/**
 * Returns the fixed self-awareness block string.
 * No DB calls. No async. Always available.
 *
 * @returns {string}
 */
function getSelfAwarenessBlock() {
  return SELF_AWARENESS_BLOCK;
}

module.exports = { getSelfAwarenessBlock };
