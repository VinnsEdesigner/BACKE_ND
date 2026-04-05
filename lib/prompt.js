'use strict';

const { build: buildPersonality } = require('./personality/inject');
const { loadSummaries }           = require('./agent/memorySummarizer');
const tokenizer                   = require('./tokenizer');
const logger                      = require('./logger');
const { AGENT }                   = require('../utils/constants');

// ── PROMPT BUILDER ────────────────────────────────────────────────────────────
// Assembles final system prompt for every agent request.
// Structure: [identity][tone][code style][memory][context][tools][task]

/**
 * Build complete system prompt for an agent request.
 *
 * @param {string} userId
 * @param {object} options
 *   toneMode      {string}  - 'chat'|'code'|'explain'|'review'|'debug'
 *   requestMeta   {object}  - { repo, branch, taskId }
 *   memorySummary {string}  - pre-loaded episodic memory block
 *   snippetBlock  {string}  - relevant scraper snippets block
 *   toolBlock     {string}  - tool calling instructions
 *
 * @returns {string} assembled system prompt
 */
async function build(userId, options = {}) {
  const {
    toneMode      = 'chat',
    requestMeta   = {},
    memorySummary = '',
    snippetBlock  = '',
    toolBlock     = '',
  } = options;

  const parts = [];

  try {
    // 1. Personality block (identity + tone + code style + flags)
    const personalityBlock = await buildPersonality(userId, { toneMode, requestMeta });
    parts.push(personalityBlock);

    // 2. Episodic memory (last 5 session summaries)
    if (memorySummary) {
      parts.push('');
      parts.push(memorySummary);
    }

    // 3. Relevant scraper snippets
    if (snippetBlock) {
      parts.push('');
      parts.push(snippetBlock);
    }

    // 4. Tool calling instructions
    if (toolBlock) {
      parts.push('');
      parts.push(toolBlock);
    }

  } catch (err) {
    logger.error('prompt:build', 'Failed to build prompt', err);
    // Fallback — minimal prompt so agent still works
    return 'You are Nexus, a senior full-stack engineer. Be direct and concise.';
  }

  return parts.filter(Boolean).join('\n').trim();
}

/**
 * Build lite agent system prompt (no personality, just task focus).
 */
function buildLite(pageContext = null) {
  const parts = [
    'You are a focused web research assistant injected into the browser.',
    'Keep responses concise and actionable — the user is reading on mobile.',
    'Do not perform file operations, GitHub actions, or multi-step plans.',
    'If a task requires those, say: "This needs the full agent — send from Dashboard."',
    'Always respond in plain text. No markdown headers. Short paragraphs.',
  ];

  if (pageContext?.url) {
    parts.push(`\nCurrent page: ${pageContext.url}`);
  }

  return parts.join('\n');
}

module.exports = { build, buildLite };
