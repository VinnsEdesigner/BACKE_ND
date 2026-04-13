/**
 * @file systemPrompt.js
 * @location /backend/lib/personality/systemPrompt.js
 *
 * Single source of truth for all system prompts (LAW 15, LAW 25).
 *
 * LAYERED MEMORY ARCHITECTURE:
 *   Layer 1 — Identity block (always, ~200 tokens) — who Nexy is
 *   Layer 2 — Relationship memory + session summaries (always, ~300 tokens)
 *             bookmarklet: last 2 summaries | dashboard: last 5
 *   Layer 3 — JIT instruction files pre-fetched per intent (0-800 tokens)
 *             fetched from backend repo, appended tagged [JIT: filename]
 *   Layer 4 — Page context (bookmarklet ONLY — goes in USER message NOT here)
 *   Layer 5 — Conversation history via contextCompressor (handled by caller)
 *
 * NOTE: formatPageContext is intentionally NOT called here.
 * Page DOM context is injected by api/lite-agent.js into the USER message.
 * Putting it in the system prompt caused the model to treat DOM content
 * as part of its identity rather than as user-provided context.
 *
 * Tool calling instructions are NOT injected here —
 * api/agent.js and api/lite-agent.js append them separately.
 */

'use strict';

const { getIdentityBlock }       = require('./prompts/identity');
const { getSelfAwarenessBlock }  = require('./prompts/selfAwareness');
const { getBehaviorBlock }       = require('./prompts/behaviorDNA');
const { getToneBlock }           = require('./prompts/toneEngine');
const { getRelationshipBlock }   = require('./prompts/relationshipMemory');
const { loadSummaries }          = require('../agent/memorySummarizer');
const gh                         = require('../github');
const logger                     = require('../logger').child('systemPrompt');
const {
  GITHUB,
  INSTRUCTION_FILES,
  MEMORY,
} = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// JIT INSTRUCTION FILE LOADER
// Fetches instruction files from backend repo based on intent.
// Returns map of { filename → content } or empty map on failure.
// Each file is tagged [JIT: filename] when injected into prompt.
// Non-fatal — if fetch fails, Nexy still has identity + memory.
// ─────────────────────────────────────────────────────────────────────────────

async function loadJITFiles(intent) {
  const filePaths = INSTRUCTION_FILES.INTENT_MAP[intent] || [];
  if (filePaths.length === 0) return {};

  const results = {};

  await Promise.all(filePaths.map(async (filePath) => {
    try {
      const result = await gh.readFile(
        GITHUB.REPOS.BACKEND,
        filePath,
        GITHUB.DEFAULT_BRANCH
      );
      const filename = filePath.split('/').pop();
      results[filename] = typeof result === 'string'
        ? result
        : (result.content || '');
      logger.debug('systemPrompt:loadJITFiles', `Loaded JIT file: ${filename}`, { intent });
    } catch (err) {
      // Non-fatal — instruction files missing is not a blocker
      logger.warn('systemPrompt:loadJITFiles', `Failed to load JIT file: ${filePath}`, {
        intent,
        error: err.message,
      });
    }
  }));

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// JIT BLOCK FORMATTER
// Formats pre-fetched instruction files into prompt blocks.
// Each file gets its own tagged section so Nexy knows what it's reading.
// ─────────────────────────────────────────────────────────────────────────────

function formatJITBlocks(jitFiles) {
  if (!jitFiles || Object.keys(jitFiles).length === 0) return '';

  const blocks = Object.entries(jitFiles).map(([filename, content]) => {
    if (!content || !content.trim()) return '';
    // Truncate very large instruction files — 2000 chars each max
    const truncated = content.length > 2000
      ? content.slice(0, 2000) + '\n... (truncated — use read_file for full content)'
      : content;
    return `[JIT: ${filename}]\n${truncated.trim()}`;
  }).filter(Boolean);

  return blocks.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY BLOCK FORMATTER
// Formats episodic summaries — layer 2 of memory.
// Summaries count depends on context:
//   bookmarklet → 2 (MEMORY.LAYER_2_SUMMARIES)
//   dashboard   → 5 (MEMORY.LAYER_2_SUMMARIES_FULL)
// ─────────────────────────────────────────────────────────────────────────────

function formatMemoryBlock(summaries) {
  if (!summaries || typeof summaries !== 'string' || !summaries.trim()) return '';
  return `[EPISODIC MEMORY — RECENT SESSIONS]\n${summaries.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN ESTIMATOR
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL REFERENCE BLOCK
// Tells Nexy what tools are available this request.
// NOT the calling format — that's appended by api/agent.js and lite-agent.js.
// ─────────────────────────────────────────────────────────────────────────────

function formatToolReferenceBlock(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return `[AVAILABLE TOOLS THIS REQUEST]\n${tools.join(', ')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AgentContext
 * @property {string}  [intent='chat']   - canonical intent from intentClassifier
 * @property {string}  [repo]            - active GitHub repo name
 * @property {string}  [branch='main']   - active branch
 * @property {string}  [sessionId]       - current session UUID
 * @property {boolean} [readOnly=false]  - true = bookmarklet context
 * @property {Array}   [tools=[]]        - injected tool names (reference only)
 */

/**
 * Build the complete system prompt for a request.
 *
 * PAGE CONTEXT IS NOT ASSEMBLED HERE.
 * It belongs in the user message (Layer 4).
 * api/lite-agent.js injects it into the user message content.
 *
 * @param {string}       userId
 * @param {AgentContext} agentContext
 * @returns {Promise<string>}
 */
async function buildSystemPrompt(userId, agentContext = {}) {
  const {
    intent    = 'chat',
    repo      = null,
    branch    = 'main',
    sessionId = null,
    readOnly  = false,
    tools     = [],
  } = agentContext;

  // ── Layer 1: Static identity blocks (sync, always present) ────────────────
  const identityBlock      = getIdentityBlock();
  const selfAwarenessBlock = getSelfAwarenessBlock();
  const behaviorBlock      = getBehaviorBlock();
  const toneBlock          = getToneBlock(intent);

  // ── Layer 2: Relationship memory + session summaries (async, parallel) ─────
  // bookmarklet gets 2 summaries (lighter), dashboard gets full 5
  const summaryLimit = readOnly
    ? MEMORY.LAYER_2_SUMMARIES
    : MEMORY.LAYER_2_SUMMARIES_FULL;

  let relationshipBlock = '';
  let memoryRaw         = '';

  try {
    [relationshipBlock, memoryRaw] = await Promise.all([
      getRelationshipBlock(userId),
      loadSummaries(userId, summaryLimit),
    ]);
  } catch (err) {
    logger.warn('buildSystemPrompt', 'Layer 2 dynamic blocks failed', {
      userId, error: err.message,
    });
  }

  const memoryBlock = formatMemoryBlock(memoryRaw);

  // ── Layer 3: JIT instruction files (async, intent-gated) ──────────────────
  // Only fetched for intents that need deep system knowledge.
  // chat/search/vision get no JIT files — saves tokens + latency.
  // Navigator block always present so Nexy knows files exist.
  let jitBlock = '';

  if (MEMORY.LAYER_3_JIT) {
    const jitFiles = await loadJITFiles(intent);
    jitBlock = formatJITBlocks(jitFiles);
  }

  const navigatorBlock = INSTRUCTION_FILES.NAVIGATOR_PROMPT;

  // ── Execution context block (replaces dynamicContext for bookmarklet) ──────
  // Bookmarklet skips model health + active tasks (irrelevant overhead).
  // Dashboard-side dynamic context is handled by dynamicContext.js upstream.
  let executionBlock = '';
  if (readOnly) {
    executionBlock = `[EXECUTION CONTEXT]\nRunning in bookmarklet (read-only). No write_file, delete_file, run_command. Tools are read-only only.`;
  } else if (repo) {
    executionBlock = `[EXECUTION CONTEXT]\nDashboard mode. Active repo: ${repo} (${branch}). Full tool access.`;
  }

  // ── Tool reference ─────────────────────────────────────────────────────────
  const toolReferenceBlock = formatToolReferenceBlock(tools);

  // ── Assemble all blocks (filter empty) ────────────────────────────────────
  // ORDER MATTERS — identity first, JIT last so model reads identity before
  // diving into technical instruction files.
  const blocks = [
    identityBlock,        // Layer 1a
    selfAwarenessBlock,   // Layer 1b
    behaviorBlock,        // Layer 1c
    toneBlock,            // Layer 1d — dynamic but still "who Nexy is"
    relationshipBlock,    // Layer 2a
    memoryBlock,          // Layer 2b
    navigatorBlock,       // Layer 3 navigator (always — tells Nexy JIT exists)
    jitBlock,             // Layer 3 content (only if intent needs it)
    executionBlock,       // Runtime context
    toolReferenceBlock,   // Tool names available
    // Layer 4 (page context) → NOT HERE → injected in user message by caller
    // Layer 5 (history) → NOT HERE → managed by contextCompressor
  ].filter((b) => typeof b === 'string' && b.trim().length > 0);

  const assembled = blocks.join('\n\n').trim();

  // ── Token budget check ─────────────────────────────────────────────────────
  const tokenEstimate = estimateTokens(assembled);
  const tokenTarget   = MEMORY.SYSTEM_PROMPT_TOKEN_TARGET;
  const tokenWarn     = MEMORY.SYSTEM_PROMPT_TOKEN_WARN;

  if (tokenEstimate > tokenWarn) {
    logger.warn('buildSystemPrompt', `System prompt large: ~${tokenEstimate} tokens (warn: ${tokenWarn})`, {
      userId, intent, readOnly, blocks: blocks.length,
    });
  } else {
    logger.debug('buildSystemPrompt', `System prompt: ~${tokenEstimate} tokens`, {
      userId, intent, readOnly,
      target:  tokenTarget,
      jit:     jitBlock.length > 0,
      memory:  memoryBlock.length > 0,
    });
  }

  return assembled;
}

module.exports = { buildSystemPrompt };
