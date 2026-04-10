# BUILD_LAWS.md — Nexus AI Control System v2.0
> Non-negotiable rules for every coding session.
> Violating any law = guaranteed bugs, debugging hell, wasted sessions.
> Author: Vinns | Last updated: 2026-04-10

---

## LAW 1 — READ BEFORE WRITE

Before writing any file, answer these 7 questions. If any answer is "unsure" → STOP. Resolve first.

```
1. What does this file export?
2. What does it import? Do those files exist yet?
3. What env vars does it touch? Are they in env-check.js?
4. What Supabase tables does it read/write? Do those columns exist?
5. What SSE events does it emit or receive?
6. Does it depend on something not built yet?
   → YES = build that dependency first, then come back.
7. [Dashboard only] Does this component make an API call?
   → YES = every interaction must fire a real call. No fake state.
```

---

## LAW 2 — DEPENDENCY ORDER IS SACRED

Files are written strictly bottom-up. Lower levels never import from higher.

### Backend Dependency Levels
```
Level 0 (imports nothing):
  utils/constants.js  ·  utils/formatter.js
  Dockerfile  ·  package.json

Level 1 (imports Level 0 only):
  utils/env-check.js  ·  utils/commandSafety.js
  lib/logManager.js

Level 2 (imports Level 0-1):
  lib/logger.js  ·  lib/supabase.js

Level 3 (imports Level 0-2):
  middleware/cors.js  ·  middleware/verify-token.js  ·  middleware/rate-limit.js
  lib/searchRouter.js  ·  lib/tokenizer.js  ·  lib/github.js  ·  lib/tools.js

Level 4 (imports Level 0-3):
  lib/ai.js  ·  lib/contextManager.js  ·  lib/prompt.js
  lib/personality/base.js  ·  lib/personality/tone.js
  lib/personality/memory.js  ·  lib/personality/code-style.js
  lib/personality/libraries.js  ·  lib/personality/context.js
  lib/personality/decisions.js  ·  lib/personality/flags.js
  lib/personality/freedom.js  ·  lib/personality/patterns.js
  lib/personality/learning.js

Level 5 (imports Level 0-4):
  lib/personality/inject.js
  lib/personality/systemPrompt.js   ← [NEW] imports inject.js + ai.js
  lib/agent/intentClassifier.js
  lib/agent/modelRouter.js
  lib/agent/toolInjector.js
  lib/agent/taskState.js
  lib/agent/repoMap.js
  lib/agent/retryHandler.js
  lib/agent/validator.js

Level 6 (imports Level 0-5):
  api/broadcast.js
  lib/agent/broadcastEmitter.js
  lib/agent/memorySummarizer.js
  lib/agent/contextCompressor.js
  lib/agent/sessionBridge.js
  lib/agent/shadowBranch.js
  lib/agent/diffExplainer.js
  lib/agent/confirmationGate.js
  lib/agent/selfDiagnose.js
  lib/agent/visionHandler.js        ← [NEW] imports ai.js + supabase.js
  lib/agent/fetchToSnippets.js      ← [NEW] imports supabase.js + searchRouter.js

Level 7 (imports Level 0-6):
  lib/agent/reasoner.js
  lib/agent/executor.js
  middleware/requestLogger.js

Level 8 (imports everything below):
  api/auth.js  ·  api/health.js  ·  api/warmup.js  ·  api/sync.js
  api/session.js  ·  api/settings.js  ·  api/scraper-agent.js
  api/lite-agent.js  ·  api/search.js  ·  api/github.js
  api/vision.js     ← [NEW]
  api/agent.js

Level 9 (imports all routes):
  server.js — entry point, mounts everything
```

### Dashboard Dependency Levels
```
Level 0 (imports nothing):
  utils/constants.js  ·  utils/formatter.js

Level 1 (imports Level 0):
  utils/storage.js  ·  utils/tokenCounter.js  ·  utils/logger.js
  utils/streamChunker.js

Level 2 (imports Level 0-1):
  context/state.js  ·  api/client.js

Level 3 (imports Level 0-2):
  api/agent.js  ·  api/broadcast.js  ·  api/github.js
  api/sessions.js  ·  api/snippets.js  ·  api/settings.js
  api/health.js  ·  api/vision.js  ·  api/lite-agent.js

Level 4 (imports Level 0-3):
  hooks/useBroadcast.js  ·  hooks/useAgent.js  ·  hooks/useSession.js
  hooks/useGitHub.js  ·  hooks/useVision.js  ·  hooks/usePersonality.js
  hooks/useOffline.js

Level 5 (imports Level 0-4 — leaf components):
  components/auth-gate.js  ·  components/loader.js
  components/status-indicator.js  ·  components/offline-indicator.js
  components/model-switcher.js
  All /components/terminal/* components
  All /components/pulse/* components
  All /components/repos/* components
  All /components/snippets/* components

Level 6 (imports Level 0-5):
  components/navbar.js  ·  components/tab-rail.js  ·  components/session-drawer.js

Level 7 (imports everything below):
  pages/terminal.js  ·  pages/pulse.js  ·  pages/repos.js
  pages/snippets.js  ·  pages/logs.js  ·  pages/settings.js

Level 8:
  index.html — the HTML shell that imports everything
```

---

## LAW 3 — PHASE COMPLETION IS ALL OR NOTHING

A phase is NOT done until every single condition is met:

```
✅ Every file in the phase is written
✅ Every import/export matches exactly (no phantom imports)
✅ Every env var used is declared in env-check.js
✅ Every Supabase table/column referenced exists in live schema
✅ No file references anything from a future phase
✅ server.js boots cleanly on this phase alone (backend)
✅ No TODO comments left in production code paths
✅ [Dashboard] Every UI interaction fires a real API call — no fake UI
```

Half-done phases = guaranteed cascade failures. Finish the phase. Then start the next.

---

## LAW 4 — EXACT MODEL STRINGS ONLY

Never guess model IDs. Use ONLY these verified strings from utils/constants.js:

```js
// ── GROQ (via Groq SDK) ──
GROQ_BRAIN:       'llama-3.3-70b-versatile'
GROQ_ENDPOINT:    'https://api.groq.com/openai/v1'

// ── MISTRAL CHAT (via api.mistral.ai) ──
MISTRAL_CODE:     'devstral-medium-2507'       // code writing
MISTRAL_LARGE:    'mistral-large-2512'          // fallback brain
MISTRAL_LEAN:     'labs-leanstral-2603'         // last resort
MISTRAL_OCR:      'mistral-ocr-2505'            // OCR
MISTRAL_ENDPOINT: 'https://api.mistral.ai/v1/chat/completions'

// ── CODESTRAL FiM (via codestral.mistral.ai) ──
CODESTRAL_FIM:    'codestral-latest'
CODESTRAL_ENDPOINT: 'https://codestral.mistral.ai/v1/fim/completions'
// CODESTRAL_API_KEY is SEPARATE from MISTRAL_API_KEY

// ── GEMINI (via Google AI SDK) ──
GEMINI_FLASH:      'gemini-2.5-flash'           // 20 RPD — last resort, best quality
GEMINI_FLASH_LITE: 'gemini-3.1-flash-lite-preview' // 500 RPD — primary vision + fallback
GEMMA_4_26B:       'gemma-4-26b-a4b-it'         // 1.5K RPD MoE
GEMMA_4_31B:       'gemma-4-31b-it'             // 1.5K RPD dense

// ── VISION CHAIN (in order) ──
VISION.MODEL_CHAIN: [
  'gemini-3.1-flash-lite-preview',   // 500 RPD — primary
  'gemma-4-26b-a4b-it',              // 1.5K RPD
  'gemma-4-31b-it',                  // 1.5K RPD
  'gemini-2.5-flash',                // 20 RPD — last resort
]
// Groq and Mistral are NOT vision-capable — never use them for images
```

---

## LAW 5 — EXACT API CALL SHAPES

Use only these verified request patterns:

```js
// ── GROQ ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const res = await groq.chat.completions.create({
  model:      'llama-3.3-70b-versatile',
  messages:   [{ role: 'user', content: '...' }],
  max_tokens: 6000,
  stream:     false
});
// response: res.choices[0].message.content

// ── MISTRAL CHAT ──
await mistralGap(); // ALWAYS call before any api.mistral.ai request
const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
  body: JSON.stringify({ model: 'devstral-medium-2507', messages: [...], max_tokens: 6000 })
});
// response: (await res.json()).choices[0].message.content

// ── CODESTRAL FiM ──
await codestralGap(); // ALWAYS call before any codestral.mistral.ai request
const res = await fetch('https://codestral.mistral.ai/v1/fim/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CODESTRAL_API_KEY}` },
  body: JSON.stringify({
    model:      'codestral-latest',
    prompt:     '<prefix>',   // code before the gap
    suffix:     '<suffix>',   // code after the gap
    max_tokens: 2000,
    stop:       ['</s>']
  })
});
// response: (await res.json()).choices[0].message.content

// ── GEMINI (text) ──
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });
const result = await model.generateContent('...');
// response: result.response.text()

// ── GEMINI VISION ──
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });
const result = await model.generateContent([
  { text: 'question about the image' },
  { inlineData: { mimeType: 'image/jpeg', data: base64string } }
  // OR for URL:
  // { fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } }
]);
// response: result.response.text()

// ── SUPABASE ──
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await supabase.from('table').select('*');
// Always check error before using data

// ── UPSTASH REDIS ──
import { Redis } from '@upstash/redis';
const redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
await redis.set('key', value, { ex: 3600 }); // 1hr TTL
const val = await redis.get('key');

// ── GITHUB (Octokit PAT) ──
import { Octokit } from 'octokit';
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
await octokit.rest.repos.getContent({ owner: 'VinnsEdesigner', repo, path });
await octokit.rest.repos.createOrUpdateFileContents({ owner: 'VinnsEdesigner', repo, path, message, content, sha });

// ── TAVILY ──
const res = await fetch('https://api.tavily.com/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: '...', max_results: 5 })
});
// response: (await res.json()).results[]

// ── SERPER ──
const res = await fetch('https://google.serper.dev/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
  body: JSON.stringify({ q: '...' })
});
// response: (await res.json()).organic[]

// ── JINA URL READER (free, no key) ──
const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'application/json' } });
// response: (await res.json()).data?.content

// ── FIRECRAWL ──
import FirecrawlApp from '@mendable/firecrawl-js';
const fc = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
const result = await fc.scrapeUrl('https://...', { formats: ['markdown'] });
// response: result.markdown
```

---

## LAW 6 — SSE STRUCTURE IS FIXED

Every SSE event from backend follows this exact shape. Never deviate.

```js
// ── Emitting (backend broadcastEmitter.js) ──
await broadcastEmit(userId, {
  type:    SSE.EVENT_TYPES.TRACE,   // 'trace'|'finding'|'warning'|'complete'|'pulse'|'heartbeat'
  content: { message: '...', timestamp: new Date().toISOString() }
});

// ── Wire format on the wire ──
res.write(`id: ${event.id}\n`);
res.write(`data: ${JSON.stringify({ id, type, content, timestamp })}\n\n`);

// ── Receiving (dashboard useBroadcast.js) ──
const es = new EventSource(`${BACKEND_URL}/api/broadcast`, {
  headers: { 'Last-Event-ID': lastReceivedId, 'Authorization': `Bearer ${token}` }
});
es.onmessage = (e) => {
  const { id, type, content, timestamp } = JSON.parse(e.data);
  // route by type
};

// ── Terminal routing ──
'trace'     → thinking-stream.js (grey monospace)
'finding'   → broadcast-card.js (purple border)
'warning'   → broadcast-card.js (amber) OR error-card.js
'complete'  → broadcast-card.js (muted)
'pulse'     → status-indicator.js update
'heartbeat' → no UI update, reset reconnect timer only
```

---

## LAW 7 — ENV VARS ARE LOCKED

Never hardcode keys. All env vars validated on startup by env-check.js.

Complete list of 18 required vars:
```
JWT_SECRET              ACCESS_PIN
GROQ_API_KEY            MISTRAL_API_KEY         CODESTRAL_API_KEY       GEMINI_API_KEY
TAVILY_API_KEY          SERPER_API_KEY           FIRECRAWL_API_KEY
SUPABASE_URL            SUPABASE_SERVICE_ROLE_KEY
GITHUB_PAT              GITHUB_USERNAME
UPSTASH_REDIS_URL       UPSTASH_REDIS_TOKEN
HF_SPACE_URL            NODE_ENV
```

env-check.js validates ALL on server startup. Missing var = server refuses to start.
DEV_TOKEN is optional — remove from HF env before full production.

---

## LAW 8 — MISTRAL 1 RPS GAP ENFORCER

Every call to api.mistral.ai must go through the gap enforcer.
Codestral has its own INDEPENDENT enforcer.

```js
// In lib/ai.js — already implemented. Never bypass.
let lastMistralCall = 0;
async function mistralGap() {
  const wait = 1000 - (Date.now() - lastMistralCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMistralCall = Date.now();
}

let lastCodestralCall = 0;
async function codestralGap() {
  const wait = 1000 - (Date.now() - lastCodestralCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCodestralCall = Date.now();
}

// Both APIs can fire SIMULTANEOUSLY — they are independent buckets.
// api.mistral.ai: devstral + mistral-large + leanstral share 1 RPS
// codestral.mistral.ai: codestral-latest has its own 1 RPS
```

---

## LAW 9 — NO SILENT FAILURES

Every async operation has explicit error handling. Never swallow errors.

```js
// ✅ Correct
try {
  const { data, error } = await supabase.from('table').select('*');
  if (error) throw error;
  return data;
} catch (err) {
  logger.error('module:function', 'Context message', err);
  throw err; // re-throw — never swallow at business logic level
}

// ✅ Non-fatal ops (SSE, logging, cache) — log but continue
try {
  await broadcastEmitter.trace(userId, 'message');
} catch (err) {
  logger.warn('module', 'SSE emit failed — non-fatal', err);
  // Continue, do NOT throw
}

// ❌ Wrong — always
const { data } = await supabase.from('table').select('*');
return data; // error silently undefined, data silently null
```

---

## LAW 10 — STOP AND FLAG RULE

If at any point during writing a file:
- An import path is uncertain → STOP
- A table/column name is uncertain → STOP
- A model string is unverified → STOP
- An API endpoint is unclear → STOP
- A constant name is unsure → STOP

```
→ STOP writing immediately
→ Flag the exact blocker in a comment
→ Check CONTEXT.md or BUILD_LAWS.md
→ Resolve before continuing
→ Never guess and move on
```

Guessing = the Lab Scope bug loop. We don't do that here. 🔒

---

## LAW 11 — SUPABASE COLUMN NAMES ARE EXACT

Always use the verified column names from CONTEXT.md Section 4. Wrong column names fail silently.

```js
// snippets table — verified column names:
{ user_id, session_id, number, type, content, source_url, pinned, metadata, mime_type, file_size, created_at }

// conversations table — verified:
{ user_id, session_id, role, content, card_type, metadata, created_at }

// settings table — verified:
{ user_id, autonomy_level, confirmation_prompts, auto_session_split, learning_triggers,
  reasoning_log, snippet_limit, auto_sync, prompt_injection, active_model, fallback_order, updated_at }

// Common mistake: using 'text' instead of 'content' for snippets
// Common mistake: using 'session_name' as a filter when it's just a display field
// Common mistake: missing onConflict on upsert → duplicate key error
```

---

## LAW 12 — VISION LAWS

```
1. Vision models ONLY: gemini-3.1-flash-lite, gemma-4-26b, gemma-4-31b, gemini-2.5-flash
   Never send images to Groq or Mistral — they will error.

2. Image data flow:
   scraper → base64 in localStorage (never sent to backend as base64)
   backend gets → image URL + metadata JSON
   Supabase snippets.content = URL string (not base64)
   Supabase snippets.metadata = { mimeType, fileSize, width?, height? }

3. Vision endpoint: POST /api/vision
   Body: { imageUrl?, base64?, mimeType?, question, snippetId? }
   Response: { analysis: string, model: string, tokens_used: number }

4. visionHandler.js tries the chain in order:
   gemini-3.1-flash-lite → gemma-4-26b → gemma-4-31b → gemini-2.5-flash
   On 429 → mark rate-limited → try next
   All down → { error: 'vision_unavailable' }

5. VISION.MAX_INLINE_BYTES = 4MB — larger images must be passed as URL, not base64

6. Dashboard image-card fires POST /api/vision on [🔍 Analyze] tap
   Result renders as a new agent-reply card below the image-card
```

---

## LAW 13 — DASHBOARD UI LAWS

```
1. OLED pure black (#000000 bg-base). Never grey backgrounds for main bg.
2. NO green text anywhere in the UI. Use cyan (#22d3ee) for success/live indicators.
3. Selected buttons: grey bg (#111111) + thicker grey border (#444444). No colored text.
4. Section headers: var(--text-primary) white.
5. Snippet type badges: grey only. No cyan/purple on badges.
6. Tab switches close session drawer immediately.
7. All tabs scrollable (including Settings — all 6 sections).
8. Token quota ONLY in Pulse tab. Never duplicated in Settings.
9. Diff cards paginate at 50 lines + [Load More]. Never full-file render on mobile.
10. Thinking stream: always present, collapsed by default.
    Never remove it. Never auto-hide permanently.
11. Every toggle fires PATCH /api/settings instantly (1.5s debounced delta).
12. API Keys section in Settings = read-only status display ONLY.
    Zero input fields. Edit keys in HF Spaces env panel.
13. streamChunker.js: buffer SSE chunks 50-100ms before DOM update.
    Prevents mobile Chrome from freezing on rapid SSE events.
```

---

## LAW 14 — TOOL CALLING PATTERN

The agent uses JSON tool calling (not native OpenAI tool format). Shape is fixed:

```js
// Agent is instructed to respond with JSON to call a tool:
{ "tool": "tool_name", "args": { ...args } }

// executor.js registers handlers:
register('write_file', (args, ctx) => gh.writeFile(...));
register('analyze_image', (args, ctx) => visionHandler.analyzeImage(args.imageUrl, args.question, ctx.userId));
register('fetch_to_snippets', (args, ctx) => fetchToSnippets.fetch(args.url, args.type, args.label, ctx.userId, ctx.sessionId));

// Tool results are fed back into messages for next iteration:
messages.push({ role: 'user', content: `Tool ${toolName} result:\n${resultStr}\nContinue.` });

// Max 5 iterations per request (AGENT.MAX_ITERATIONS)
// Force mode: bypass intentClassifier, inject ALL tools
```

---

## LAW 15 — SYSTEM PROMPT CENTRALIZATION

All system prompts come from lib/personality/systemPrompt.js. No exceptions.

```js
// ✅ Correct — use systemPrompt.js
import { buildSystemPrompt, buildLiteSystemPrompt } from '../personality/systemPrompt.js';

// In api/agent.js:
const systemPrompt = await buildSystemPrompt(userId, { intent, repo, branch, tools });

// In api/lite-agent.js:
const systemPrompt = await buildLiteSystemPrompt(userId, pageContext);

// ❌ Wrong — never do this
const LITE_SYSTEM_PROMPT = `You are...`; // hardcoded string
const systemParts = [personalityBlock, memorySummary, ...].join('\n\n'); // inline assembly
```

---

## LAW 16 — GITHUB OWNER IS FIXED

```js
// Owner is always VinnsEdesigner — never a variable, never from env
const GITHUB = {
  OWNER: 'VinnsEdesigner',
  REPOS: { BACKEND: 'backend', DASHBOARD: 'dashboard', SCRAPER: 'SCRAPER-' },
  SANDBOX_BRANCH: 'ai-sandbox',
  DEFAULT_BRANCH: 'main',
};

// Destructive ops always shadow-backup first:
await shadowBranch.create(userId, repo, filePath, 'write'); // BEFORE writeFile
await shadowBranch.create(userId, repo, filePath, 'delete'); // BEFORE deleteFile

// Read ops never shadow-backup:
// read_file, list_files, web_search, check_file_exists → no backup needed
```

---

## LAW 17 — MOBILE-FIRST ALWAYS

Vinns uses Android Chrome only. No PC. Every component must:

```
Touch targets ≥ 44px height
Input font-size ≥ 16px (prevents auto-zoom on iOS/Android)
No hover-only states — touch works differently
Scroll performance: avoid heavy reflows in list renders
Long lists: use virtual/paginated render (50 items max before pagination)
Diff cards: 50 lines max before [Load More] — never full file on mobile
SSE events: buffer with streamChunker.js (50-100ms) before DOM update
No desktop-only interactions (drag-to-reorder needs touch events too)
Fixed bottom tab rail: 56px, always visible
Fixed top navbar: 56px, always visible
Main content area: calc(100vh - 112px) — no overflow tricks
```

---

## LAW 18 — AUTHENTICATION FLOW

```
Single PIN auth. No OAuth. No user management. Solo tool.

1. User enters PIN → POST /api/auth/login
2. Backend: pin === process.env.ACCESS_PIN → issue JWT
3. JWT payload: { userId: process.env.GITHUB_USERNAME, iat, exp }
4. JWT stored in dashboard: localStorage.getItem('nexus_auth_token')
5. All API calls: Authorization: Bearer <token>
6. All protected routes: verifyToken middleware → attaches req.user.userId
7. DEV_TOKEN bypass: only if process.env.DEV_TOKEN set (remove before full production)

Dashboard:
  auth-gate.js shows PIN modal if no valid token
  Every API call in api/client.js injects token from storage
  401 response → clear token → show auth-gate modal

Scraper:
  getToken() reads 'nexus_auth_token' from localStorage
  Token written by dashboard after login (shared localStorage domain)
  No token → HUD shows "Login to dashboard first"
```

---

## LAW 19 — RATE LIMIT HANDLING

```js
// When a provider returns 429:
markProvider('groq', 'rate_limited');  // cooldown: 60s
// When a provider returns 5xx:
markProvider('groq', 'down');          // cooldown: 120s
// Cooldowns auto-clear via Date.now() > downUntil check

// On 429 from any provider → try next in waterfall
// On all providers down → throw Error('all_providers_down')
// api/agent.js catches all_providers_down → returns 503 + emits SSE warning

// Mistral special case:
// devstral 429 → mistral_chat bucket marked → also skips mistral-large
// (they share the same 1 RPS bucket)

// Per-user rate limits (Upstash Redis):
// AGENT: 30/hr, LITE_AGENT: 60/hr, SCRAPER_AGENT: 100/hr, GITHUB: 60/hr, SEARCH: 20/hr, VISION: 40/hr
// Fail OPEN on Redis error — never block requests due to Redis being down
```

---

## LAW 20 — BUILD ORDER IS PHASE-LOCKED

```
Backend build order:
  Phase 1: env-check + server skeleton + auth (login works first)
  Phase 2: scraper pipeline (scraper-agent + lite-agent + sync)
  Phase 3: GitHub integration (github + session + settings + shadow branches)
  Phase 4: AI agent core (ai.js + intentClassifier + toolInjector + agent.js)
  Phase 5: Broadcast + Pulse (broadcastEmitter + SSE fully operational)
  Phase 6: Vision (visionHandler + fetchToSnippets + api/vision)
  Phase 7: systemPrompt.js centralization

Dashboard build order:
  Phase 1: Shell + Auth (nothing works without this)
  Phase 2: SSE + Broadcast backbone
  Phase 3: Terminal tab (core value of the whole system)
  Phase 4: Sessions
  Phase 5: Repos tab
  Phase 6: Snippets tab + vision
  Phase 7: Pulse tab
  Phase 8: Logs + Settings
  Phase 9: Polish + service worker

Never skip phases. Never build later phases if current phase has gaps.
```

---

## QUICK REFERENCE — FREQUENTLY CONFUSED THINGS

```
CODESTRAL_API_KEY ≠ MISTRAL_API_KEY         Different keys, different endpoints
api.mistral.ai   ≠ codestral.mistral.ai      Different RPS buckets (independent)
snippets.content = the text/URL              NOT snippets.text (no 'text' column)
sessions table has no 'session_name' filter  session_name is just a display field
broadcast-card uses purple (#7c3aed)         broadcast-card only — not other cards
token quota ONLY lives in Pulse tab          NOT in Settings tab
green text is BANNED                         Use cyan (#22d3ee) for success
image base64 stays in localStorage only      Supabase gets URL + metadata
systemPrompt.js is the only prompt source    No hardcoded prompt strings anywhere
VinnsEdesigner/SCRAPER- has a hyphen         The repo name has a trailing hyphen
```

---

*End of BUILD_LAWS.md v2.0*
*These laws exist because of real pain. Respect them every session.*
*Key additions from v1.0: LAW 12 (Vision), LAW 13 (Dashboard UI), LAW 14 (Tool calling),*
*LAW 15 (systemPrompt centralization), LAW 16 (GitHub owner), LAW 17 (Mobile-first),*
*LAW 18 (Auth flow), LAW 19 (Rate limit handling), LAW 20 (Build order),*
*Quick reference section, exact vision model strings, SCRAPER- hyphen note.*
