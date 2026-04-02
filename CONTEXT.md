# CONTEXT.md — AI Dev Assistant System
> Master architecture document. Last updated: 2026-04-03
> Author: Vinns | Stack: Vanilla JS PWA + HF Spaces Express.js + Supabase

---

## 0. SYSTEM OVERVIEW

Three interconnected components:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   [SCRAPER]  ──sync──▶  [BACKEND]  ◀──▶  [DASHBOARD] │
│   bookmarklet           HF Spaces          GitHub   │
│   (any page)            Express.js         Pages    │
│                         + Supabase                  │
│                              ▲                      │
│                              │ GitHub PAT           │
│                              ▼                      │
│                       [GitHub API]                  │
│                    (all repos, full access)         │
└─────────────────────────────────────────────────────┘
```

**Scraper** = browser bookmarklet injected into any webpage. Captures text selections,
page metadata, full DOM content. Syncs everything to backend via API.
Has its own floating mini UI with lite agent chat + snippet staging.

**Backend** = Express.js app hosted on Hugging Face Spaces (free tier, 2vCPU/16GB RAM).
Central brain. Handles auth, AI inference, GitHub operations, Supabase reads/writes,
rate limiting, logging. Kept alive 24/7 via UptimeRobot external pinger.
No Vercel. No serverless. No timeouts. Persistent Node.js process only.

**Dashboard** = GitHub Pages SPA (React-free, vanilla JS). The control center.
Hosts the AI agent Terminal, Pulse mission control, GitHub repo observer, Snippets manager,
Logs forensics, and Settings. Communicates only with backend via direct API calls + SSE.

---

## 0A. CORE ARCHITECTURAL LAWS

These are non-negotiable. Every file must respect these:

```
1. UI change = immediate API call = real effect. No orphan UI state. Ever.
2. No Vercel. No serverless functions. All logic lives in HF Spaces Express.js.
3. No GitHub OAuth. Single PAT stored in HF env vars. Solo tool = no OAuth overhead.
4. No QStash. HF Spaces has no timeout — heavy ops run directly in Express.
5. No html2canvas screenshots. DOM + selected text only. Screenshots = payload bloat.
6. reasoning_log is toggleable. Full CoT traces eat Supabase free tier rows fast.
7. SSE is the nervous system. Every state change pushes via SSE to all connected clients.
8. Bookmarklet polls /api/sync every 15s. SSE not reliable in injected bookmarklet context.
9. Dashboard → Backend = direct API calls (instant).
   Backend → Dashboard = SSE push (instant).
   Backend → Bookmarklet = 15s poll (acceptable lag).
10. Rollback, toggles, model switches — all fire real API calls on tap. Zero fake UI.
11. Mistral api.mistral.ai: 1 RPS global. Enforce 1s gap between calls (timestamp check, not full queue).
12. Codestral codestral.mistral.ai: separate 1 RPS bucket. Independent gap enforcer. Both APIs fire simultaneously fine.
13. Mistral token budget: 1B tokens/month shared across ALL mistral models. rateMonitor tracks globally, warns at 800M.
14. Episodic memory mandatory. Session end → 3-sentence summary → context_summaries. Agent loads last 5 summaries on start.
15. Thinking stream: always present in Terminal, collapsed by default. Auto-expands on model switch/error. Auto-collapses on idle.
16. Settings toggles: 1.5s debounced delta sync. Accumulate changes, fire single PATCH /api/settings bundle.
17. Diff cards paginate at 50 lines + [Load More]. Prevents DOM freeze on mobile Chrome.
18. SSE message ID handshake on reconnect. Backend replays missing payloads from broadcast_queue.
19. SSE heartbeat: 15s ping/pong bound to Upstash Redis execution lock. Prevents orphaned processes on tab sleep.
20. Task states cached to Upstash Redis (1hr TTL). HF Space restart resumes from Redis, not zero.
```

---

## 1. REPOSITORY STRUCTURE

### Three separate GitHub repos:

```
github.com/vinns/scraper        → bookmarklet source + build
github.com/vinns/dashboard      → dashboard SPA → auto-deploys to GitHub Pages
github.com/vinns/backend        → Express.js API → auto-deploys to HF Spaces
```

---

## 2. /scraper — Bookmarklet

### Purpose
Injected into any browser tab. Captures context from whatever page the user is on.
Reads full DOM content in real-time. Stages snippets numbered sequentially.
Syncs captured data to backend. Has floating mini UI with lite agent.

### Folder Structure
```
/scraper
├── /src
│   ├── index.js          # bookmarklet entry, injects everything
│   ├── core.js           # init, auth token check, session start
│   ├── hud.js            # floating collapsible mini UI
│   ├── mini-agent.js     # lite agent chat + prompt injection
│   ├── selection.js      # text selection capture (selectionchange + touchend)
│   ├── dom-reader.js     # full page DOM content extraction (real-time)
│   ├── storage.js        # localStorage buffer before sync
│   └── sync.js           # POST to /api/scraper-agent (with auth token)
├── /styles
│   └── hud.css           # HUD overlay styles, injected via JS
├── /build
│   └── bookmarklet.min.js  # minified output — this is what gets installed
├── /.github/workflows
│   └── build.yml         # on push → minify → commit bookmarklet.min.js
└── README.md
```

### Selection Capture (selection.js)
```
Uses selectionchange + touchend combo (not mouseup).
mouseup is unreliable on Android Chrome — selectionchange fires correctly.
300ms debounce on selectionchange to avoid mid-drag triggers.
Popup clamped to viewport — never goes offscreen on mobile.
```

### Floating Mini UI Structure
```
┌─ 🕷 scraper ●  [0 staged] [−] [×] ─┐
│                                      │
│  LITE AGENT                          │
│  ┌──────────────────────────────┐    │
│  │ suggested prompt (if active) │    │  ← inject banner ABOVE input
│  │ [dismiss]        [inject ↗]  │    │
│  └──────────────────────────────┘    │
│  ┌──────────────────────────────┐    │
│  │ ask about this page...       │    │
│  └──────────────────────────────┘ ↑  │
│  [suggest prompt]     [inject →]     │
│                                      │
│  STAGED SNIPPETS  (0/20)             │
│  ┌──────────────────────────────┐    │  ← fixed height, scrollable after 3
│  │ #1  preview text...  code 🗑 │    │
│  │ #2  preview text... resrch 🗑│    │
│  │ #3  preview text...  code 🗑 │    │
│  └──────────────────────────────┘    │
│                                      │
│  [⇅ sync to dashboard]               │
│  ─────────────────────────────────   │
│  ● not synced          llama-3.3-70b │
└──────────────────────────────────────┘
```

### Snippet Limits
```js
MAX_SNIPPET_LENGTH = 2000   // chars per snippet
MAX_SNIPPETS_COUNT = 20     // per session
SNIPPET_BOX_SCROLL_AFTER = 3  // fixed height + scroll after 3 items
```

### Lite Agent Escalation Logic
```
Default → POST /api/lite-agent
  → stripped system prompt
  → no tools injected
  → page DOM as context
  → fast, low token cost

Auto-escalates to POST /api/agent when:
  → task involves GitHub operations
  → task involves file writes
  → task involves web search
  → complexity detected by intent classifier
```

### Prompt Injection
```
Lite agent generates suggestion
  → inject banner appears ABOVE the input row (never covered by snippets)
  → finds active input on page via document.querySelector
  → injects text into input bar
  → user hits send
  → works on Claude.ai, ChatGPT, any standard input
  → fallback: copy to clipboard if shadow DOM detected
```

### Sync Flow
```
User highlights text → selection popup appears (selectionchange/touchend)
  → [+ code] or [+ research] or [ask agent →]
        ↓
selection.js captures + assigns sequential number (#1, #2...)
storage.js buffers to localStorage
        ↓
[⇅ sync to dashboard] tapped → sync.js reads auth token
  → if no token: HUD shows "Login to dashboard first"
  → if token present: POST /api/scraper-agent
        ↓
Backend saves to Supabase snippets table (numbered)
SSE pushes update to dashboard immediately
        ↓
HUD confirms: "✓ 3 snippets synced"
```

### Settings Sync (15s poll)
```
Bookmarklet polls GET /api/sync every 15s when injected
Receives latest settings diff → applies immediately:
  → prompt injection on/off
  → snippet limits
  → auth status
```

---

## 3. /backend — HF Spaces Express.js

### Purpose
Central API layer. Persistent Node.js process — no cold starts, no timeouts.
All AI inference, GitHub operations, Supabase persistence, auth verification,
logging, rate limiting run here. Kept alive 24/7 via UptimeRobot.

### Hosting
```
Platform: Hugging Face Spaces (free tier)
Runtime: Docker → Node.js Express app
Specs: 2 vCPU, 16GB RAM
Sleep prevention: UptimeRobot pings /api/warmup every 5min (external, phone-independent)
Dashboard also pings /api/warmup every 10min while open (secondary keepalive)
Auth: Single GitHub PAT in HF env vars (no OAuth complexity)
```

### Folder Structure
```
/backend
├── server.js               # Express app entry point
├── Dockerfile              # HF Spaces deployment
├── /api
│   ├── auth.js             # login, token issue, token refresh (JWT + PAT)
│   ├── agent.js            # main AI agent endpoint (no timeout — HF Spaces)
│   ├── lite-agent.js       # stripped agent for bookmarklet (fast, low tokens)
│   ├── scraper-agent.js    # receives scraper sync payloads
│   ├── github.js           # GitHub proxy — all repo operations via PAT
│   ├── session.js          # session CRUD
│   ├── search.js           # web search routing (Tavily/Brave/Serper/Jina)
│   ├── broadcast.js        # agent → dashboard push channel (SSE)
│   ├── sync.js             # bookmarklet settings poll endpoint (15s)
│   ├── health.js           # health check + API key status (reads HF env)
│   └── warmup.js           # keep-warm ping endpoint
├── /lib
│   ├── /personality
│   │   ├── base.js
│   │   ├── tone.js
│   │   ├── memory.js
│   │   ├── code-style.js
│   │   ├── decisions.js
│   │   ├── flags.js
│   │   ├── learning.js     # event-driven only (not every task)
│   │   ├── context.js
│   │   ├── patterns.js
│   │   ├── libraries.js
│   │   ├── freedom.js
│   │   └── inject.js
│   ├── /agent
│   │   ├── taskState.js        # task lifecycle + Upstash Redis TTL cache (1hr)
│   │   ├── repoMap.js
│   │   ├── reasoner.js
│   │   ├── executor.js
│   │   ├── validator.js        # dryRun validation before GitHub commit
│   │   ├── retryHandler.js
│   │   ├── sessionBridge.js
│   │   ├── diffExplainer.js
│   │   ├── intentClassifier.js
│   │   ├── toolInjector.js     # + context pruning (keyword relevance scorer)
│   │   ├── confirmationGate.js
│   │   ├── shadowBranch.js     # ai-sandbox branch strategy
│   │   ├── broadcastEmitter.js # + trace events for thinking stream
│   │   └── memorySummarizer.js # episodic memory — 3-sentence session summaries
│   ├── supabase.js
│   ├── ai.js               # provider abstraction + JSON schema normalizer
│   ├── tools.js
│   ├── tokenizer.js
│   ├── logger.js
│   ├── prompt.js
│   ├── rateMonitor.js
│   ├── contextManager.js
│   └── searchRouter.js
├── /middleware
│   ├── cors.js
│   ├── verify-token.js
│   ├── rate-limit.js       # Upstash Redis
│   └── requestLogger.js
├── /utils
│   ├── constants.js
│   ├── formatter.js
│   └── env-check.js        # validates all env vars on startup
└── Dockerfile
```

---

## 3A. KEY ARCHITECTURAL DECISIONS

### Conditional Tool Injection (toolInjector.js)
```
intentClassifier.js classifies intent first (~100 tokens cheap call)
toolInjector.js injects ONLY relevant tools:

  "chat"       → no tools (just memory + personality)
  "code_write" → GitHub write tools only
  "code_edit"  → GitHub read + write tools
  "search"     → web search tool only
  "git_ops"    → branch/PR/merge tools only
  "deploy"     → deploy tools only

Saves thousands of tokens per request vs always-on injection.
```

### JSON Schema Normalization (ai.js)
```
Every AI provider returns tool calls in different formats.
ai.js wraps all providers with a unified schema normalizer:

  Groq format    → normalized
  Mistral format → normalized
  Gemini format  → normalized

All callers receive identical object structure regardless of provider.
Zero parsing errors on model fallback/switch.
```

### Agent Learning — Event-Driven (learning.js)
```
Learning NEVER triggers on every task. Event-driven only:
  → User corrects agent output
  → User rolls back an agent action
  → User modifies agent plan before confirming
  → Every 10th completed task (periodic batch)
  → User says "remember this"
  → Session end (summary learning)
```

### Episodic Memory (memorySummarizer.js)
```
Triggers:
  → Context hits 80% token budget
  → User opens new session
  → User says "save this session"
  → 24hr inactivity auto-archive
  → Agent detects topic shift

On trigger:
  → Sends last N messages to devstral-medium
  → Prompt: "Summarize in 3 sentences: what was built,
     decisions made, what's pending"
  → Stores in Supabase context_summaries (60 tokens/summary)

On session start:
  → Agent loads last 5 summaries silently (~300 tokens)
  → Injected into system prompt as "past memory"
  → Agent knows codebase + patterns before first message

What gets summarized:
  ✅ Decisions made + reasoning
  ✅ Files written/edited
  ✅ Patterns established
  ✅ Pending tasks
  ✅ Errors hit + solutions
  ❌ Raw code (stored separately in Supabase)
  ❌ Repetitive back-and-forth
```

### Force Mode (Terminal UI)
```
Toggle in Terminal input bar: [⚡ Force Mode]

When ON:
  → Bypasses intentClassifier
  → Force-injects ALL tools into system prompt
  → Use when classifier misreads complex prompts
  → Indicator shows in thinking stream: "⚡ force mode active"

When OFF (default):
  → Normal intentClassifier → toolInjector flow
```

### Thinking Stream (Terminal — always present)
```
Greyed collapsible box always visible above input bar.

Collapsed by default (28px bar):
  ▸ behind the scenes                          [−]

Expanded (max 120px, 5 lines, scrolls internally):
  ┌─ 👁 behind the scenes ──────────── [−] ─┐
  │  14:32:01  classifier → "code_edit"      │
  │  14:32:02  injecting github tools        │
  │  14:32:04  ⚠ groq limit → devstral      │
  │  14:32:06  writing api/auth.js...        │
  └──────────────────────────────────────────┘

Auto-expands when:
  → Model switch occurs
  → Error / retry fires
  → All providers down

Auto-collapses when:
  → Agent goes idle

Entry format: timestamp + event (monospace, --text-disabled)
Older entries fade opacity. Clears on new command sent.
Fed via SSE trace events from broadcastEmitter.
```

### Shadow Branch / ai-sandbox Strategy
```
All destructive operations push to ai-sandbox branch first:
  write_file    → ai-sandbox ✅
  delete_file   → ai-sandbox ✅
  replace_file  → ai-sandbox ✅
  read_file     → NO ❌
  web_search    → NO ❌

validator.js runs dryRun check before any GitHub commit:
  → Codestral reviews code for failure vectors on low-memory devices
  → Only commits if validation passes

Rollback: restore from ai-sandbox via GitHub API
ai-sandbox kept 48hrs then auto-deleted
```
### Real-Time Sync Law
```
Every interactive element owns its API call:

  Toggle flips     → PATCH /api/settings fires instantly
                   → backend updates Supabase
                   → SSE pushes to all connected clients
                   → bookmarklet gets on next 15s poll

  Rollback tapped  → POST /api/github/rollback fires instantly
                   → real GitHub API call
                   → result via SSE back to dashboard

  Model switched   → PATCH /api/active-model fires instantly
                   → next agent call uses new model

  API key status   → GET /api/health every 30s
                   → keys live in HF env, dashboard reads status only
                   → NO key editing in dashboard UI
```

### Agent Broadcast Channel
```
Agent pushes unsolicited updates to dashboard at any time.
Messages buffer in Supabase broadcast_queue if dashboard offline.
Delivered on SSE reconnect. Queue auto-clears after 24hrs.

Message types:
  { type: "finding",  content: "..." }
  { type: "warning",  content: "..." }
  { type: "complete", content: "..." }
  { type: "pulse",    content: "..." }
```

### Confirmation Gate
```
Fires BEFORE any destructive operation:
  → file write/delete/replace
  → PR merge
  → repo settings change

Non-destructive (no confirmation):
  → file read, web search, list files, branch creation
```

### Offline Queue (dashboard)
```
If HF Space is waking up (cold start) and user sends command:
  → command saved to localStorage queue
  → retried automatically when SSE reconnects
  → prevents silent failures during warmup
```

---

## 3B. BACKEND INTERNAL DNA

### /lib/ai.js
```
Model roles:
  Primary logic/chat   → groq/llama-3.3-70b-versatile
  Code writing         → mistral/devstral-medium        (api.mistral.ai)
  Code editing/patch   → mistral/codestral-fim          (codestral.mistral.ai — FiM)
  Fallback 1           → mistral/mistral-large          (api.mistral.ai)
  Fallback 2           → gemini/gemini-2.5-flash
  Last resort          → mistral/leanstral              (api.mistral.ai)

Two separate Mistral clients:
  mistralClient    → https://api.mistral.ai/v1/chat/completions
                     covers: devstral, mistral-large, leanstral
                     RPS: 1/sec (1s gap enforcer — timestamp check)
  codestralClient  → https://codestral.mistral.ai/v1/fim/completions
                     covers: codestral-fim only
                     RPS: 1/sec (independent gap enforcer)

Mistral rate limits:
  Token budget: 1B tokens/month SHARED across both APIs
  RPS: 1/sec per API endpoint (two independent buckets)
  Context windows:
    mistral-large   → 128k
    devstral-medium → 32k
    leanstral       → 32k
    codestral-fim   → 32k

Codestral FiM usage pattern:
  code_edit intent → read file → send prefix + suffix
  → codestral fills the gap surgically
  → cheaper + safer than rewriting whole file

Provider waterfall:
  429 → mark rate-limited 60s → try next
  5xx → mark down 120s → try next
  Mistral 429 → wait 1s (RPS) before trying next mistral model
  All fail → { error: "all_providers_down" }

Streaming fallback (law #12 from Gemini refinements):
  Rate limit mid-stream → seamless handover to fallback model
  Stream continues uninterrupted — no error card shown

Exports:
  ai.complete(options)       → { text, model, tokens_used }
  ai.fim(prefix, suffix)     → codestral FiM completion
  ai.stream(options, cb)     → streams chunks via callback
  ai.currentModel()          → active model string
  ai.modelStatus()           → all provider health states
```

### /lib/rateMonitor.js
```
Throttles BEFORE hitting limits:
  Warning: 80% quota → auto-throttle
  Hard:    100%      → 429 response

Limits per user/hour:
  /api/agent         → 30
  /api/lite-agent    → 60
  /api/scraper-agent → 100
  /api/github        → 60
  /api/search        → 20
```

### /api/health.js
```
Reads API key presence from HF env vars (never exposes values).
Returns status per provider: { groq: "ok", mistral: "ok", gemini: "ok" }
Dashboard Settings > API Keys shows this status only — read-only.
No key editing in dashboard. Edit keys in HF Spaces env vars panel.
```

---

## 4. /dashboard — GitHub Pages SPA

### Purpose
Main user interface. OLED pure black. HuggingFace data-dense aesthetic.
Mobile-first, full experience on Android. Vanilla JS, no framework.

### Design Laws
```
- No green text anywhere in UI
- Selected buttons: grey bg + thicker grey border (no colored text)
- Section headers: white text
- Snippet type badges: grey only (no cyan/purple)
- Zero new font colors globally (white + grey palette only)
- Tab switches close session drawer automatically
- All tabs scrollable (including Settings)
- Token quota lives in Pulse only (not duplicated in Settings)
```

### Deployment
```
Push to main → GitHub Actions → GitHub Pages
URL: https://vinns.github.io/dashboard
```

### Tab Rail
```
[ 💬 Terminal ] [ ⚡ Pulse ] [ 📁 Repos ] [ 🕷️ Snippets ] [ 📋 Logs ] [ ⚙️ Settings ]

Notification dots on tabs with new activity.
Switching tabs closes session drawer.
```

### Folder Structure
```
/dashboard
├── index.html
├── /pages
│   ├── terminal.js
│   ├── pulse.js
│   ├── repos.js
│   ├── snippets.js
│   ├── logs.js
│   └── settings.js
├── /components
│   ├── navbar.js
│   ├── tab-rail.js
│   ├── session-drawer.js       # auto-closes on tab switch
│   ├── /terminal
│   │   ├── user-command.js
│   │   ├── agent-reply.js
│   │   ├── tool-card.js
│   │   ├── diff-card.js
│   │   ├── error-card.js
│   │   ├── broadcast-card.js   # purple border
│   │   ├── thinking-stream.js
│   │   └── confirm-card.js
│   ├── /pulse
│   │   ├── health-panel.js
│   │   ├── activity-stream.js
│   │   ├── token-meters.js     # quota bars — PULSE ONLY
│   │   └── deploy-panel.js
│   ├── /repos
│   │   ├── file-tree.js
│   │   ├── action-log.js
│   │   └── stop-button.js
│   ├── /snippets
│   │   ├── snippet-card.js
│   │   ├── snippet-filters.js
│   │   └── snippet-search.js
│   ├── status-indicator.js
│   ├── model-switcher.js
│   ├── offline-indicator.js
│   ├── auth-gate.js
│   └── loader.js
├── /api
│   ├── agent.js
│   ├── lite-agent.js
│   ├── broadcast.js            # SSE subscription
│   ├── github.js
│   └── supabase.js
├── /context
│   └── state.js                # global app state
├── /hooks
│   ├── useAgent.js
│   ├── useSession.js
│   ├── usePersonality.js
│   ├── useGitHub.js
│   ├── useBroadcast.js
│   └── useOffline.js
├── /styles
│   ├── global.css
│   ├── tab-rail.css
│   ├── terminal.css
│   ├── pulse.css
│   ├── repos.css
│   ├── snippets.css
│   ├── logs.css
│   └── settings.css
├── /utils
│   ├── formatter.js
│   ├── storage.js              # localStorage offline queue
│   ├── constants.js
│   ├── tokenCounter.js
│   ├── streamChunker.js        # 50-100ms SSE chunk buffer (prevents DOM freeze)
│   └── logger.js
└── /.github/workflows
    └── deploy.yml
```

---

## 5. UX DESIGN SYSTEM

### Design Tokens (global.css)
```css
:root {
  --bg-base:       #000000;
  --bg-surface:    #0a0a0a;
  --bg-elevated:   #111111;
  --bg-hover:      #1a1a1a;

  --accent-purple:   #7c3aed;   /* AI/agent/broadcast cards only */
  --accent-yellow:   #f59e0b;   /* warnings */
  --accent-red:      #ef4444;   /* errors, destructive */
  --accent-blue:     #3b82f6;   /* links, info */
  --accent-cyan:     #22d3ee;   /* live/streaming indicators */

  /* NO green text anywhere in UI */

  --text-primary:   #e6edf3;
  --text-secondary: #b1bac4;
  --text-muted:     #7d8590;
  --text-disabled:  #484f58;

  --border-subtle:  #111111;
  --border-default: #1e1e1e;
  --border-strong:  #2e2e2e;
  --border-selected: #444444;   /* thicker border for selected state */

  --font-sans: 'Geist', 'Inter', sans-serif;
  --font-mono: 'Geist Mono', 'JetBrains Mono', monospace;

  --text-xs: 11px; --text-sm: 13px; --text-base: 15px;
  --text-lg: 17px; --text-xl: 20px; --text-2xl: 24px;

  --space-1:4px; --space-2:8px; --space-3:12px;
  --space-4:16px; --space-6:24px; --space-8:32px;

  --radius-sm:4px; --radius-md:8px; --radius-lg:12px; --radius-xl:16px;
}
```

### Button Selected State
```
Selected button:
  background: var(--bg-elevated)   → #111111
  border: 2px solid var(--border-selected)  → #444444
  color: var(--text-primary)       → #e6edf3
  (no colored text, no colored bg)
```

### Layout (Mobile-First)
```
┌──────────────────────────────────────────────┐
│  navbar (56px) — hamburger + session + status │
├──────────────────────────────────────────────┤
│                                              │
│         main content panel                  │
│         (full screen per tab, scrollable)   │
│                                             │
├──────────────────────────────────────────────┤
│  tab rail (56px) — horizontal scrollable     │
│  [ 💬 ] [ ⚡ ] [ 📁 ] [ 🕷️ ] [ 📋 ] [ ⚙️ ] │
└──────────────────────────────────────────────┘
```

### Terminal Tab — Message Types
```
🟢 User command      → plain bubble, right-aligned
🤖 Agent reply       → plain bubble, left-aligned
⚙️  Tool call card   → bordered, icon + progress
📄 Diff card         → collapsible, syntax highlighted
🔴 Error card        → red border, [↩ Retry]
📡 Broadcast card    → purple border
💭 Thinking stream   → collapsible, dimmed monospace
✅ Confirmation card → [✅ Proceed] [✏️ Modify] [❌ Cancel]
```

### 3-Layer Live Status
```
Layer 1 — System (navbar dot):
  ● All systems online
  ● Degraded (fallback active)
  ● Backend unreachable
  💤 HF Space waking...

Layer 2 — Agent (Terminal, above input):
  ⚪ Idle  🔵 Thinking  🟡 Working  ● Done  🔴 Failed  📡 Broadcasting

Layer 3 — Tool call (inside tool card):
  ⏳ Calling...  ✅ Done  ❌ Rate limit → switching  🔄 Retry (2/5)  ↩ Rolled back
```

---

## 6. TAB SPECIFICATIONS

### ⚡ Pulse — Mission Control
```
Sections:
  1. SYSTEM HEALTH    → HF Space, Supabase, GitHub API, each AI provider (dot + latency)
  2. LIVE ACTIVITY    → scrollable log stream, color coded, never truncated
  3. TOKEN QUOTA      → progress bar per provider, 80% warning, reset countdown
                        THIS IS THE ONLY PLACE TOKEN QUOTA LIVES
  4. DEPLOYMENTS      → last 5 records, build status, collapsible logs
```

### ⚙️ Settings — 6 Sections (all scrollable)
```
1. AI Models
   → Primary model selector
   → Fallback order (drag to reorder)
   → Per-model token budget limits
   → Model avg latency (24hr)        ← replaces token quota (moved to Pulse)
   → Last used timestamp per model
   → Recent errors per model (health log)

2. API Keys
   → Read-only status display ONLY
   → Shows: provider name + availability dot + last checked timestamp
   → NO key input fields
   → "Edit keys in HF Spaces env vars panel" note

3. GitHub
   → Connected PAT account (masked)
   → Default repo + branch
   → Shadow branch naming convention
   → PAT health indicator

4. Agent Behaviour
   → Autonomy level (0-3)
   → Confirmation prompts on/off
   → Auto-session split threshold
   → Learning triggers on/off
   → reasoning_log on/off (toggleable — saves Supabase rows)

5. Scraper/Bookmarklet
   → Snippet limits
   → Auto-sync on/off
   → Prompt injection on/off
   → Bookmarklet version + update button
   All toggles → PATCH /api/settings instantly → SSE → bookmarklet on next poll

6. Account
   → Profile
   → JWT token management
   → Danger zone (wipe data, reset memory)
```

### 🕷️ Snippets Tab
```
Snippet card layout:
  #N  preview text...          [type badge grey]
  source · timestamp
  ──────────────────────────────
  [view]  [🗑]  [📍]

  → "view" text (no eye icon)
  → bin icon only (no "delete" text)
  → pin icon only (no "pin" text)
  → type badge: grey only (no cyan/purple)
```

---

## 7. SUPABASE TABLES

```sql
sessions          -- scraper sessions
snippets          -- staged snippets (numbered, code/research)
personality       -- AI detected user preferences
conversations     -- terminal chat history
repo_mappings     -- file → agent assignment
deployments       -- HF/GitHub deployment records
active_model      -- current model per user
tasks             -- multi-step agent task states
repo_cache        -- GitHub file trees (TTL 5min)
reasoning_log     -- CoT traces (toggleable, optional)
rate_usage        -- per-user API call tracking
context_summaries -- compressed conversation history
task_checkpoints  -- session bridge snapshots (distinct from context_summaries)
logs              -- all backend request logs
users             -- auth + GitHub PAT (encrypted)
broadcast_queue   -- buffered agent broadcasts (24hr TTL)
shadow_branches   -- shadow branch registry (48hr TTL)
settings          -- per-user settings (synced to bookmarklet via poll)
```

Total: **18 tables**
Note: screenshots table removed (no html2canvas). settings table added for real-time sync.

---

## 8. ENVIRONMENT VARIABLES

```
# Auth
JWT_SECRET=

# AI Providers
GROQ_API_KEY=
MISTRAL_API_KEY=          # api.mistral.ai (large, devstral, leanstral)
CODESTRAL_API_KEY=        # codestral.mistral.ai (FiM — separate key)
GEMINI_API_KEY=

# Search
TAVILY_API_KEY=
SERPER_API_KEY=
FIRECRAWL_API_KEY=        # replaces Jina as primary DOM scraper

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# GitHub (PAT)
GITHUB_PAT=
GITHUB_USERNAME=

# Upstash (rate limiting + task state TTL)
UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

# HF Spaces
HF_SPACE_URL=
```

Total: **17 env vars**

---

## 9. API KEYS STATUS

```
✅ Confirmed have:
├── Groq          → llama-3.3-70b (gsk_ key)
├── Gemini        → gemini-2.5-flash
├── Mistral       → mistral-large, devstral-medium, leanstral (api.mistral.ai)
├── Codestral     → codestral-fim (codestral.mistral.ai — separate key)
├── Supabase      → URL + service_role key
├── Tavily        → 2 keys available
├── Serper        → key confirmed
├── Firecrawl     → key confirmed (bonus — better than Jina for DOM scraping)
├── GitHub PAT    → repo + workflow scopes
├── Upstash Redis → URL + token confirmed
└── UptimeRobot   → account confirmed (setup after HF deploy)

🆓 No signup needed:
└── Jina Reader   → r.jina.ai/{url} prefix (backup to Firecrawl)

⏳ Still needed:
└── Brave Search  → brave.com/search/api (optional, Tavily covers it)

🔑 CODESTRAL_API_KEY is separate from MISTRAL_API_KEY — different key, different endpoint
```

---

## 10. FILE COUNT SUMMARY

```
/scraper    → 9 source files + 1 workflow   (removed screenshot.js)
/dashboard  → 44 source files + 1 workflow
/backend    → 44 source files + Dockerfile  (removed queue.js, webhook.js, deploy.js)

Total: ~99 files across 3 repos
```

---

## 11. BUILD ORDER

```
Phase 1 — Infrastructure (backend foundation)
  1. Dockerfile + server.js + env-check.js
  2. auth.js + verify-token.js + supabase.js
  3. health.js + warmup.js
  4. broadcast.js (SSE — nervous system, needed by everything)
  5. UptimeRobot: configure ping to /api/warmup

Phase 2 — Scraper Pipeline
  6.  Scraper: core.js + hud.js + selection.js + dom-reader.js
  7.  Scraper: mini-agent.js + storage.js + sync.js
  8.  Backend: scraper-agent.js + lite-agent.js + sync.js (poll endpoint)
  9.  Dashboard: snippets.js page

Phase 3 — GitHub Integration
  10. Backend: github.js + shadowBranch.js (PAT-based)
  11. Dashboard: repos.js page

Phase 4 — AI Agent Core
  12. Backend: lib/ai.js (schema normalizer)
  13. Backend: intentClassifier.js + toolInjector.js
  14. Backend: confirmationGate.js
  15. Backend: api/agent.js
  16. Dashboard: terminal.js (all 8 card types)

Phase 5 — Broadcast + Pulse
  17. Backend: broadcastEmitter.js
  18. Dashboard: pulse.js (token quota lives here)
  19. Dashboard: status-indicator.js (3-layer)

Phase 6 — Polish
  20. Dashboard: logs.js + settings.js (scrollable, API keys read-only)
  21. Backend: learning.js (event-driven)
  22. Backend: requestLogger.js + rateMonitor.js
  23. Dashboard: streamChunker.js + offline queue + all remaining components
```

---

*End of CONTEXT.md v4.0*
*Key changes from v3: Codestral FiM added, Devstral as code model, Mistral rate limit laws,
Episodic memory (memorySummarizer.js), Force Mode toggle, Thinking Stream refined,
ai-sandbox branch strategy, dryRun validator, SSE heartbeat + resync handshake,
Upstash Redis task state TTL, debounced delta sync, diff pagination,
Firecrawl replaces Jina, shadow DOM piercing in dom-reader.js,
17 env vars, 20 core architectural laws.*
