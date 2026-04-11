/**
 * @file systemPrompt.js
 * @location /backend/lib/personality/systemPrompt.js
 *
 * @purpose
 * Single source of truth for all system prompts (LAW 15, LAW 25).
 * Assembles all personality layers into one coherent system prompt
 * per request. Handles both dashboard (full) and bookmarklet (readOnly)
 * contexts via a single function — one Nexy everywhere.
 *
 * Assembly order:
 *   1. identity          — who Nexy is + Vinns brief (fixed)
 *   2. selfAwareness     — full system architecture knowledge (fixed)
 *   3. behavior          — response rules + variance (fixed)
 *   4. tone              — dynamic per intent (~80 tokens)
 *   5. relationshipMemory — Vinns' learned preferences (dynamic)
 *   6. dynamicContext    — live model health + active state (dynamic)
 *   7. memoryBlock       — last 5 session summaries (dynamic)
 *   8. pageContext       — bookmarklet DOM context (optional)
 *
 * Tool calling instructions are NOT injected here —
 * api/agent.js appends them separately after tool injection.
 *
 * @exports
 *   buildSystemPrompt(userId, agentContext) → Promise<string>
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
 *   ../../utils/constants         → AGENT
 *
 * @tables
 *   personality        (via relationshipMemory)
 *   context_summaries  (via memorySummarizer)
 *   snippets           (via dynamicContext)
 *   tasks              (via dynamicContext)
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   none directly — all handled by imported modules
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
const { AGENT }                   = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN BUDGET GUARD
// Estimate tokens (~4 chars/token) and warn if approaching limit.
// System prompt should stay well under 2000 tokens to leave room
// for conversation history and tool results.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_WARN_TOKENS = 2000;

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE CONTEXT FORMATTER
// Formats bookmarklet page DOM context into a compact block.
// Truncates content to 3000 chars — enough for agent, not wasteful.
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
// Formats episodic memory summaries into a compact block.
// ─────────────────────────────────────────────────────────────────────────────

function formatMemoryBlock(summaries) {
  if (!summaries || typeof summaries !== 'string' || !summaries.trim()) return '';
  return `[EPISODIC MEMORY — RECENT SESSIONS]\n${summaries.trim()}`;
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
 * @property {Object}  [pageContext]      - bookmarklet DOM context
 * @property {Array}   [tools=[]]         - injected tool names (for reference only)
 */

/**
 * Build the complete system prompt for a request.
 *
 * Used by both api/agent.js (full dashboard agent) and
 * api/lite-agent.js (bookmarklet agent) via readOnly flag.
 * One function. One Nexy. Everywhere.
 *
 * Loads dynamic blocks in parallel (Promise.all) to minimize
 * latency overhead on every request.
 *
 * @param {string}       userId
 * @param {AgentContext} agentContext
 * @returns {Promise<string>} assembled system prompt
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

  // ── Static blocks (sync — no DB, no network) ──────────────────────────────
  const identityBlock      = getIdentityBlock();
  const selfAwarenessBlock = getSelfAwarenessBlock();
  const behaviorBlock      = getBehaviorBlock();
  const toneBlock          = getToneBlock(intent);

  // ── Dynamic blocks (async — parallel to minimize latency) ─────────────────
  let relationshipBlock = '';
  let dynamicBlock      = '';
  let memoryRaw         = '';

  try {
    [relationshipBlock, dynamicBlock, memoryRaw] = await Promise.all([
      getRelationshipBlock(userId),
      getDynamicContextBlock(userId, { intent, repo, branch, sessionId, readOnly }),
      loadSummaries(userId),
    ]);
  } catch (err) {
    // Non-fatal — Nexy still works with partial context
    logger.warn('buildSystemPrompt', 'One or more dynamic blocks failed to load', {
      userId,
      error: err.message,
    });
  }

  const memoryBlock      = formatMemoryBlock(memoryRaw);
  const pageContextBlock = formatPageContext(pageContext);

  // ── Tool reference block ───────────────────────────────────────────────────
  // Mentions available tools by name so Nexy is aware of what it has.
  // Full tool calling instructions are appended by api/agent.js separately.
  let toolReferenceBlock = '';
  if (Array.isArray(tools) && tools.length > 0) {
    toolReferenceBlock = `[AVAILABLE TOOLS THIS REQUEST]\n${tools.join(', ')}`;
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  const blocks = [
    identityBlock,
    selfAwarenessBlock,
    behaviorBlock,
    toneBlock,
    relationshipBlock,
    dynamicBlock,
    memoryBlock,
    pageContextBlock,
    toolReferenceBlock,
  ].filter((block) => typeof block === 'string' && block.trim().length > 0);

  const assembled = blocks.join('\n\n').trim();

  // ── Token budget guard ─────────────────────────────────────────────────────
  const tokenEstimate = estimateTokens(assembled);
  if (tokenEstimate > SYSTEM_PROMPT_WARN_TOKENS) {
    logger.warn('buildSystemPrompt', `System prompt is large: ~${tokenEstimate} tokens`, {
      userId,
      intent,
      blocks: blocks.length,
    });
  } else {
    logger.debug('buildSystemPrompt', `System prompt assembled: ~${tokenEstimate} tokens`, {
      userId,
      intent,
      readOnly,
    });
  }

  return assembled;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { buildSystemPrompt };
