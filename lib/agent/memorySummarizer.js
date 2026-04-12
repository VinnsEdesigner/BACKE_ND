'use strict';

const { complete } = require('../ai');
const { query }    = require('../supabase');
const logger       = require('../logger');
const { TABLES, AGENT, MODELS } = require('../../utils/constants');

// ── MEMORY SUMMARIZER ─────────────────────────────────────────────────────────
// Episodic memory — 3-sentence session summaries.
// Triggers: context 80% full, session end, topic shift, 24hr inactivity.
// Loads last 5 summaries on session start (~300 tokens).

const SYSTEM_PROMPT = `Summarize this conversation in exactly 3 sentences.
Sentence 1: What was built or changed.
Sentence 2: Key decisions made and why.
Sentence 3: What is pending or needs attention next.
Be specific. Mention file names, function names, or error messages if relevant.
No preamble. No markdown.`;

/**
 * Summarize a session's messages and store in context_summaries table.
 *
 * @param {string}   userId
 * @param {Array}    messages  - conversation messages array
 * @param {string}   sessionName
 * @returns {string} the summary text
 */
async function summarize(userId, messages, sessionName = '') {
  if (!messages || messages.length < 2) return '';

  // Build condensed transcript (user + assistant only, no system)
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');

  if (transcript.trim().length === 0) return '';

  try {
     
    const result = await complete({
      messages:    [{ role: 'user', content: transcript }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   150,
      preferCode:  false,  // BUG8 FIX: summarization is prose not code, use Groq
    });

    const summary = result.text.trim();

    // Store in Supabase
    await query(TABLES.CONTEXT_SUMMARIES, 'insert', {
      data: {
        user_id:      userId,
        summary,
        session_name: sessionName || null,
        created_at:   new Date().toISOString(),
      },
    });

    logger.info('memorySummarizer:summarize', 'Session summarized', {
      userId,
      tokens: result.tokens_used,
      session: sessionName,
    });

    return summary;
  } catch (err) {
    logger.error('memorySummarizer:summarize', 'Failed to summarize session', err);
    return '';
  }
}

/**
 * Load last N summaries for a user.
 * Injected into agent system prompt on session start.
 *
 * @param {string} userId
 * @param {number} limit   - number of summaries to load (default: AGENT.MEMORY_SUMMARIES = 5)
 * @returns {string} formatted memory block for prompt injection
 */
async function loadSummaries(userId, limit = AGENT.MEMORY_SUMMARIES) {
  try {
    const rows = await query(TABLES.CONTEXT_SUMMARIES, 'select', {
      filters: { user_id: userId },
      order:   { column: 'created_at', ascending: false },
      limit,
    });

    if (!rows || rows.length === 0) return '';

    // Reverse to chronological order
    const summaries = [...rows].reverse();

    const lines = summaries.map((r, i) => {
      const label = r.session_name ? `[Session: ${r.session_name}]` : `[Session ${i + 1}]`;
      return `${label}\n${r.summary}`;
    });

    return `[PAST MEMORY — last ${summaries.length} sessions]\n${lines.join('\n\n')}`;
  } catch (err) {
    logger.error('memorySummarizer:loadSummaries', 'Failed to load summaries', err);
    return '';
  }
}

module.exports = { summarize, loadSummaries };
