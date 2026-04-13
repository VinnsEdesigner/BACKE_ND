/**
 * @file systemPrompt.js
 * @location /backend/lib/personality/systemPrompt.js
 *
 * @purpose
 * Single source of truth for all system prompts (LAW 15, LAW 25).
 *
 * ARCHITECTURE — Lazy Instruction Loading + Layered Memory:
 *
 * Instead of assembling ALL personality blocks on every request,
 * this module uses a three-layer memory system and only loads
 * instruction blocks that are relevant to the current intent.
 *
 * [HOT LAYER] — Always loaded. Always in context. ~600 tokens.
 *   identity.js       — who Nexy is + Vinns brief
 *   toneEngine.js     — per-intent tone (~80 tokens, changes every request)
 *
 * [WARM LAYER] — Loaded per request when relevant. ~400-600 tokens total.
 *   behaviorDNA.js    — always (behavioral rules core to Nexy's personality)
 *   relationshipMemory — always (Vinns' stored preferences from DB)
 *   memorySummarizer   — 2 summaries for bookmarklet, 5 for dashboard
 *
 * [COLD LAYER] — Only loaded when intent requires deep system knowledge.
 *   selfAwareness.js  — loaded ONLY for: code_write, surgical_edit, git_ops,
 *                       deploy, reasoning, code_review
 *                       SKIPPED for: chat, search, research, vision
 *   dynamicContext.js — loaded ONLY for dashboard (readOnly: false)
 *                       SKIPPED entirely for bookmarklet (readOnly: true)
 *
 * This means a simple "yo what's up" chat message injects:
 *   identity + tone + behavior + relationship + 2 summaries ≈ ~900 tokens
 *
 * A "write me a new API endpoint" code_write request injects:
 *   identity + tone + behavior + relationship + selfAwareness + dynamic + summaries ≈ ~2000 tokens
 *
 * The model only gets what it needs for the task at hand.
 *
 * NATIVE TOOL CALLING:
 *   Tool calling instructions are NOT appended here anymore.
 *   api/agent.js and api/lite-agent.js handle tool calling
 *   natively via provider-specific tool_calls fields.
 *   This prompt never includes "respond with ONLY valid JSON" instructions.
 *   For Gemini fallback (no native tool support), a single XML tag
 *   instruction is appended by the caller, not here.
 *
 * @exports
 *   buildSystemPrompt(userId, agentContext) → Promise<string>
 *   COLD_LAYER_INTENTS                      → Set of intents that load cold layer
 *
 * @imports
 *   ./prompts/identity            → getIdentityBlock()
 *   ./prompts/selfAwareness       → getSelfAwarenessBlock()
 *   ./prompts/behaviorDNA         → getBehaviorBlock()
 *   ./prompts/toneEngine          → getToneBlock()
 *   ./prompts/relationshipMemory  → getRelationshipBlock()
 *   ./prompts/dynamicContext      → getDynamicContextBlock()
 *   ../agent/memorySummarizer     → loadSummaries()
 *   ../logger                     → structured logger
 *
 * @tables
 *   personality        (via relationshipMemory)
 *   context_summaries  (via memorySummarizer)
 *   snippets           (via dynamicContext — dashboard only)
 *   tasks              (via dynamicContext — dashboard only)
 *
 * @dependency-level 5
 */

'use strict';

const { getIdentityBlock }        = require('./prompts/identity');
const { getSelfAwarenessBlock }   = require('./prompts/selfAwareness');
const { getBehaviorBlock }        = require('./prompts/behaviorDNA');
const { getToneBlock }            = require('./prompts/toneEngine');
const { getRelationshipBlock }    = require('./prompts/relationshipMemory');
const { getDynamicContextBlock }  = require('./prompts/dynamicContext');
const { loadSummaries }           = require('../agent/memorySummarizer');
const logger                      = require('../logger').child('systemPrompt');

// ─────────────────────────────────────────────────────────────────────────────
// COLD LAYER INTENT SET
// Only these intents get selfAwareness injected.
// Everything else (chat, search, vision, research) skips the ~600 token block.
// ─────────────────────────────────────────────────────────────────────────────

const COLD_LAYER_INTENTS = new Set([
  'code_write',
  'surgical_edit',
  'code_review',
  'git_ops',
  'deploy',
  'reasoning',
]);

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN BUDGET GUARD
// System prompt target: under 2000 tokens for bookmarklet, under 2500 for dashboard.
// ~4 chars per token heuristic.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKMARKLET_WARN_TOKENS = 2000;
const DASHBOARD_WARN_TOKENS   = 2500;

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE CONTEXT FORMATTER
// Only used in bookmarklet context — injected once here, never duplicated.
// lite-agent.js previously injected this AGAIN in the user message — that's
// fixed by having lite-agent.js check if pageContext was already in systemPrompt.
// ─────────────────────────────────────────────────────────────────────────────

function formatPageContext(pageContext) {
  if (!pageContext || typeof pageContext !== 'object') return '';

  const url     = pageContext.url   || 'unknown';
  const title   = pageContext.title || 'unknown';
  const content = typeof pageContext.content === 'string'
    ? pageContext.content.slice(0, 3000)
    : '';

  if (!content && url === 'unknown') return '';

  return [
    '[CURRENT PAGE — BOOKMARKLET CONTEXT]',
    `URL: ${url}`,
    `Title: ${title}`,
    content ? `Content:\n${content}` : '',
  ].filter(Boolean).join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY BLOCK FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

function formatMemoryBlock(summaries) {
  if (!summaries || typeof summaries !== 'string' || !summaries.trim()) return '';
  return `[EPISODIC MEMORY — RECENT SESSIONS]\n${summaries.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL REFERENCE BLOCK
// Lists available tool names so the model is aware of what it has.
// Does NOT include calling instructions — those are provider-specific
// and handled by ai.js (native tool_calls) or appended by the caller
// for Gemini XML fallback.
// ─────────────────────────────────────────────────────────────────────────────

function formatToolReference(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return `[AVAILABLE TOOLS THIS REQUEST]\n${tools.join(', ')}\n\nUse tools when you need to gather information or take action. Do not speculate — call the tool instead. After a tool result is returned, continue your response using that result.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AgentContext
 * @property {string}  [intent='chat']    - canonical intent from intentClassifier
 * @property {string}  [repo]             - active GitHub repo name
 * @property {string}  [branch='main']    - active branch
 * @property {string}  [sessionId]        - current session UUID
 * @property {boolean} [readOnly=false]   - true = bookmarklet context
 * @property {Object}  [pageContext]      - bookmarklet DOM context (injected HERE, not in user msg)
 * @property {Array}   [tools=[]]         - injected tool names (for reference only)
 * @property {boolean} [pageContextInjected] - set to true after this fn injects pageContext
 */

/**
 * Build the complete system prompt for a request.
 *
 * Layered memory strategy:
 *   HOT:  identity + tone               → always
 *   WARM: behavior + relationship + memory → always
 *   COLD: selfAwareness + dynamicContext  → intent-gated
 *
 * @param {string}       userId
 * @param {AgentContext} agentContext
 * @returns {Promise<{ prompt: string, pageContextInjected: boolean }>}
 */
async function buildSystemPrompt(userId, agentContext = {}) {
  const {
    intent      = 'chat',
    repo        = null,
    branch      = 'main',
    sessionId   = null,
    readOnly    = false,
    pageContext  = null,
    tools       = [],
  } = agentContext;

  const needsColdLayer = COLD_LAYER_INTENTS.has(intent);

  // ── HOT LAYER (sync — zero latency) ────────────────────────────────────────
  const identityBlock = getIdentityBlock();
  const toneBlock     = getToneBlock(intent);
  const behaviorBlock = getBehaviorBlock();

  // ── COLD LAYER — selfAwareness (sync but large, only when needed) ──────────
  const selfAwarenessBlock = needsColdLayer ? getSelfAwarenessBlock() : '';

  // ── WARM LAYER (async — parallel DB reads) ─────────────────────────────────
  // Bookmarklet: 2 summaries max (token budget)
  // Dashboard:   5 summaries (full memory)
  const summaryLimit = readOnly ? 2 : 5;

  let relationshipBlock = '';
  let dynamicBlock      = '';
  let memoryRaw         = '';

  try {
    const promises = [
      getRelationshipBlock(userId),
      loadSummaries(userId, summaryLimit),
    ];

    // dynamicContext only for dashboard — bookmarklet doesn't need model health
    // or active task counts (these are dashboard-facing concepts)
    if (!readOnly) {
      promises.push(
        getDynamicContextBlock(userId, { intent, repo, branch, sessionId, readOnly })
      );
    }

    const results = await Promise.all(promises);
    relationshipBlock = results[0] || '';
    memoryRaw         = results[1] || '';
    dynamicBlock      = results[2] || '';  // undefined if readOnly, coerced to ''
  } catch (err) {
    logger.warn('buildSystemPrompt', 'One or more warm/cold blocks failed to load', {
      userId,
      error: err.message,
    });
  }

  const memoryBlock = formatMemoryBlock(memoryRaw);

  // ── Page context — inject HERE for bookmarklet ─────────────────────────────
  // This is the SINGLE injection point. lite-agent.js must NOT re-inject
  // pageContext into the user message content when it's been injected here.
  // The return value includes pageContextInjected flag so the caller knows.
  let pageContextBlock  = '';
  let pageContextInjected = false;

  if (readOnly && pageContext) {
    pageContextBlock    = formatPageContext(pageContext);
    pageContextInjected = Boolean(pageContextBlock);
  }

  // ── Tool reference ─────────────────────────────────────────────────────────
  const toolReferenceBlock = formatToolReference(tools);

  // ── Assembly order (recency bias — behavioral rules closer to message) ──────
  // selfAwareness → identity → memory → tone → behavior → pageContext → tools
  // This order puts behavioral rules and tools closest to the conversation,
  // which the model weights more heavily due to recency bias in attention.
  const blocks = [
    selfAwarenessBlock,    // cold — system knowledge (when needed)
    identityBlock,         // hot  — who Nexy is
    relationshipBlock,     // warm — Vinns' learned preferences
    memoryBlock,           // warm — episodic session summaries
    dynamicBlock,          // cold — live model health + tasks (dashboard only)
    toneBlock,             // hot  — per-intent communication style
    behaviorBlock,         // warm — behavioral DNA (always)
    pageContextBlock,      // conditional — bookmarklet page context
    toolReferenceBlock,    // conditional — available tools for this request
  ].filter((block) => typeof block === 'string' && block.trim().length > 0);

  const assembled = blocks.join('\n\n').trim();

  // ── Token budget guard ─────────────────────────────────────────────────────
  const tokenEstimate = estimateTokens(assembled);
  const warnThreshold = readOnly ? BOOKMARKLET_WARN_TOKENS : DASHBOARD_WARN_TOKENS;

  if (tokenEstimate > warnThreshold) {
    logger.warn('buildSystemPrompt', `System prompt large: ~${tokenEstimate} tokens`, {
      userId,
      intent,
      needsColdLayer,
      readOnly,
      blocks: blocks.length,
    });
  } else {
    logger.debug('buildSystemPrompt', `System prompt assembled: ~${tokenEstimate} tokens`, {
      userId,
      intent,
      needsColdLayer,
      readOnly,
    });
  }

  return {
    prompt:               assembled,
    pageContextInjected,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { buildSystemPrompt, COLD_LAYER_INTENTS };
