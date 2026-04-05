'use strict';

const { complete } = require('../ai');
const logger       = require('../logger');

// ── DIFF EXPLAINER ────────────────────────────────────────────────────────────
// Takes a git diff string and produces a plain English explanation.
// Used after every file write to show user what changed.
// Paginated at AGENT.DIFF_PAGE_LINES lines — prevents DOM freeze on mobile.

const SYSTEM_PROMPT = `You explain code diffs in plain English.
Be concise. Use bullet points. Max 4 bullets.
Format each bullet as: "Changed/Added/Removed X in file: reason"
No markdown headers. No preamble.`;

/**
 * Explain a git diff in plain English.
 *
 * @param {string} diff    - unified diff string
 * @param {object} context - { filePath, repo, intent }
 * @returns {string} plain English explanation
 */
async function explain(diff, context = {}) {
  if (!diff || typeof diff !== 'string' || diff.trim().length === 0) {
    return 'No changes detected.';
  }

  // Truncate very large diffs before sending to AI
  const truncated = diff.length > 3000 ? diff.slice(0, 3000) + '\n... (truncated)' : diff;

  const prompt = context.filePath
    ? `File: ${context.filePath}\nRepo: ${context.repo || 'unknown'}\nIntent: ${context.intent || 'unknown'}\n\nDiff:\n${truncated}`
    : truncated;

  try {
    const result = await complete({
      messages:    [{ role: 'user', content: prompt }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   300,
    });

    logger.debug('diffExplainer:explain', 'Diff explained', {
      file:   context.filePath,
      tokens: result.tokens_used,
    });

    return result.text;
  } catch (err) {
    logger.warn('diffExplainer:explain', 'AI explanation failed — using raw summary', err);
    return summarizeRaw(diff);
  }
}

/**
 * Fast fallback: count additions/removals without AI.
 */
function summarizeRaw(diff) {
  const lines    = diff.split('\n');
  const added    = lines.filter((l) => l.startsWith('+')).length;
  const removed  = lines.filter((l) => l.startsWith('-')).length;
  const files    = [...new Set(lines.filter((l) => l.startsWith('+++') || l.startsWith('---')).map((l) => l.replace(/^[+-]{3} /, '')))];
  return `+${added} lines, -${removed} lines across ${files.length} file(s).`;
}

module.exports = { explain };
