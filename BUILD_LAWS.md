# BUILD LAWS — AI Dev Assistant System
> Non-negotiable rules for every coding session.
> Violating any law = guaranteed bugs, debugging hell, wasted sessions.
> Author: Vinns | Last updated: 2026-04-03

---

## LAW 1 — READ BEFORE WRITE

Before writing any file, answer these 6 questions:

```
1. What does this file export?
2. What does it import? Do those files exist yet?
3. What env vars does it touch? Are they in env-check.js?
4. What Supabase tables does it read/write?
5. What SSE events does it emit or receive?
6. Does it depend on something not built yet?
   → YES = build that dependency first, then come back
```

If any answer is "not sure" → STOP. Resolve before writing.

---

## LAW 2 — DEPENDENCY ORDER IS SACRED

Files are written strictly bottom-up. Lower files never import from higher files.

```
Level 0 (imports nothing):
  constants.js · Dockerfile · package.json

Level 1 (imports Level 0 only):
  env-check.js · logger.js · supabase.js

Level 2 (imports Level 0-1):
  cors.js · verify-token.js · rateMonitor.js · searchRouter.js

Level 3 (imports Level 0-2):
  auth.js · health.js · warmup.js · broadcast.js · sync.js
  ai.js · tools.js · tokenizer.js · prompt.js · contextManager.js

Level 4 (imports Level 0-3):
  /lib/personality/* · /lib/agent/* (all modules)

Level 5 (imports everything below):
  agent.js · lite-agent.js · scraper-agent.js · github.js
  search.js · session.js · requestLogger.js

Level 6 (imports all routes):
  server.js (entry point — mounts everything)
```

Touch a lower level file = safe, nothing above breaks.
Touch a higher level file = only affects files above it.
This is how we avoid the endless bug loop. 🔒

---

## LAW 3 — PHASE COMPLETION IS ALL OR NOTHING

A phase is NOT done until every single condition is met:

```
✅ Every file in the phase is written
✅ Every import/export matches exactly (no phantom imports)
✅ Every env var used is declared in env-check.js
✅ Every Supabase table referenced exists in schema
✅ No file references anything from a future phase
✅ server.js boots cleanly on this phase alone
✅ No TODO comments left in production paths
```

Half-done phases = guaranteed cascade failures later.

---

## LAW 4 — EXACT MODEL STRINGS ONLY

Never guess model IDs. Use only these verified strings:

```js
// ── GROQ (via Groq SDK) ──
GROQ_MODEL_BRAIN    = 'llama-3.3-70b-versatile'
GROQ_ENDPOINT       = 'https://api.groq.com/openai/v1'

// ── MISTRAL CHAT (via api.mistral.ai) ──
MISTRAL_MODEL_CODE  = 'devstral-medium-2507'      // code writing
MISTRAL_MODEL_LARGE = 'mistral-large-2512'         // fallback brain
MISTRAL_MODEL_LEAN  = 'labs-leanstral-2603'        // last resort
MISTRAL_ENDPOINT    = 'https://api.mistral.ai/v1/chat/completions'

// ── CODESTRAL FiM (via codestral.mistral.ai) ──
CODESTRAL_MODEL     = 'codestral-latest'           // surgical code edits
CODESTRAL_ENDPOINT  = 'https://codestral.mistral.ai/v1/fim/completions'

// ── MISTRAL OCR (via api.mistral.ai) ──
MISTRAL_OCR_MODEL   = 'mistral-ocr-2505'
MISTRAL_OCR_ENDPOINT = 'https://api.mistral.ai/v1/ocr'

// ── GEMINI (via Google AI SDK) ──
GEMINI_MODEL        = 'gemini-2.5-flash'           // universal fallback

// ── MISTRAL RATE LIMIT RULES ──
// api.mistral.ai    → 1 RPS shared (devstral + mistral-large + leanstral)
// codestral.mistral.ai → 1 RPS separate bucket (independent)
// Token budget: 1B tokens/month shared across ALL mistral APIs
// Warn at 800M tokens consumed
```

---

## LAW 5 — EXACT API CALL SHAPES

Use only these verified request patterns:

```js
// ── GROQ ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const res = await groq.chat.completions.create({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: '...' }],
  max_tokens: 6000,
  stream: false
});
// response: res.choices[0].message.content

// ── MISTRAL CHAT ──
const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
  },
  body: JSON.stringify({
    model: 'devstral-medium-2507',
    messages: [{ role: 'user', content: '...' }],
    max_tokens: 6000,
    stream: false
  })
});
const data = await res.json();
// response: data.choices[0].message.content

// ── CODESTRAL FiM ──
const res = await fetch('https://codestral.mistral.ai/v1/fim/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.CODESTRAL_API_KEY}`
  },
  body: JSON.stringify({
    model: 'codestral-latest',
    prompt: '<prefix_code_here>',   // code before the gap
    suffix: '<suffix_code_here>',   // code after the gap
    max_tokens: 2000,
    stop: ['</s>']
  })
});
const data = await res.json();
// response: data.choices[0].message.content

// ── GEMINI ──
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
const result = await model.generateContent('...');
// response: result.response.text()

// ── SUPABASE ──
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
// usage:
const { data, error } = await supabase.from('table').select('*');

// ── UPSTASH REDIS ──
import { Redis } from '@upstash/redis';
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});
// usage:
await redis.set('key', value, { ex: 3600 }); // 1hr TTL
const val = await redis.get('key');

// ── GITHUB (Octokit + PAT) ──
import { Octokit } from 'octokit';
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
// usage:
await octokit.rest.repos.getContent({ owner, repo, path });
await octokit.rest.repos.createOrUpdateFileContents({
  owner, repo, path, message, content, sha
});

// ── TAVILY ──
const res = await fetch('https://api.tavily.com/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    api_key: process.env.TAVILY_API_KEY,
    query: '...',
    max_results: 5
  })
});
const data = await res.json();
// response: data.results[]

// ── SERPER ──
const res = await fetch('https://google.serper.dev/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-KEY': process.env.SERPER_API_KEY
  },
  body: JSON.stringify({ q: '...' })
});
const data = await res.json();
// response: data.organic[]

// ── FIRECRAWL ──
import FirecrawlApp from '@mendable/firecrawl-js';
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });
const result = await firecrawl.scrapeUrl('https://...', {
  formats: ['markdown', 'html']
});
// response: result.markdown
```

---

## LAW 6 — SSE STRUCTURE IS FIXED

Every SSE event from backend follows this exact shape:

```js
// Emitting (backend):
res.write(`data: ${JSON.stringify({ type, content, timestamp })}\n\n`);

// Types:
//  "trace"     → thinking stream entries (live agent activity)
//  "finding"   → agent discovered something (broadcast card)
//  "warning"   → needs attention (broadcast card)
//  "complete"  → background task done (broadcast card)
//  "pulse"     → system status update
//  "heartbeat" → 15s ping (no UI update, just keep-alive)

// Receiving (dashboard):
eventSource.onmessage = (e) => {
  const { type, content, timestamp } = JSON.parse(e.data);
  // route by type
};

// Message ID handshake on reconnect:
const eventSource = new EventSource('/api/broadcast', {
  headers: { 'Last-Event-ID': lastReceivedId }
});
```

---

## LAW 7 — ENV VARS ARE LOCKED

Never hardcode keys. Every env var must be declared in env-check.js.
The complete list of 17 required vars:

```
JWT_SECRET
GROQ_API_KEY
MISTRAL_API_KEY
CODESTRAL_API_KEY
GEMINI_API_KEY
TAVILY_API_KEY
SERPER_API_KEY
FIRECRAWL_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GITHUB_PAT
GITHUB_USERNAME
UPSTASH_REDIS_URL
UPSTASH_REDIS_TOKEN
HF_SPACE_URL
```

env-check.js validates ALL of these on server startup.
Missing var = server refuses to start with clear error message.

---

## LAW 8 — MISTRAL 1 RPS GAP ENFORCER

Every call to api.mistral.ai must go through the gap enforcer:

```js
let lastMistralCall = 0;

async function mistralGap() {
  const now = Date.now();
  const wait = 1000 - (now - lastMistralCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMistralCall = Date.now();
}

// Usage — always call before any api.mistral.ai request:
await mistralGap();
const res = await fetch('https://api.mistral.ai/v1/chat/completions', ...);

// Codestral has its own independent enforcer:
let lastCodestralCall = 0;
async function codestralGap() { /* same pattern */ }
```

---

## LAW 9 — NO SILENT FAILURES

Every async operation has explicit error handling:

```js
// ✅ correct
try {
  const { data, error } = await supabase.from('table').select('*');
  if (error) throw error;
  return data;
} catch (err) {
  logger.error('supabase:select', err);
  throw err; // re-throw — never swallow
}

// ❌ wrong — never do this
const { data } = await supabase.from('table').select('*');
return data; // error silently undefined
```

---

## LAW 10 — STOP AND FLAG RULE

If at any point during writing a file:
- An import doesn't exist yet
- A table name is uncertain
- A model string is unverified
- An API shape is unclear

→ STOP writing immediately
→ Flag the exact blocker
→ Resolve it before continuing
→ Never guess and move on

Guessing = Lab Scope bug loop. We don't do that here. 🔒

---

*End of BUILD_LAWS.md*
*These laws exist because of real pain. Respect them every session.*
