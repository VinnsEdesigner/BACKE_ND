'use strict';

// contextCompressor.js
// Loads user memory + preferences + recent conversation history,
// then compresses it into a compact prompt bundle for ai.complete().
//
// Design goals:
// - Grounded: no phantom schema assumptions beyond fields already used in code
// - Safe: never throws on partial/malformed rows
// - Cheap: compresses older history into a digest
// - Practical: returns a shape that maps directly into ai.complete()

const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger').child('contextCompressor');
const { TABLES, AGENT } = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_SYSTEM_PROMPT = [
  'You are NEXY, a grounded AI dev assistant for Vinns.',
  'Use the provided memory, preferences, repo context, and runtime signals.',
  'Never invent files, tables, tools, or APIs.',
  'If something is missing or uncertain, say so plainly.',
].join(' ');

const DEFAULT_RECENT_TURNS = 20; // "last 20 turns" from the architecture docs
const DEFAULT_SUMMARY_LIMIT = AGENT.MEMORY_SUMMARIES || 5;
const DEFAULT_RECENT_MESSAGE_KEEP = 12;
const DEFAULT_DIGEST_MAX_CHARS = 2200;
const DEFAULT_SECTION_MAX_CHARS = 2400;
const DEFAULT_PROMPT_BUDGET_TOKENS = 12000;

// ─────────────────────────────────────────────────────────────────────────────
// LAZY SUPABASE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase env vars missing for contextCompressor');
  }

  supabaseClient = createClient(url, key);
  return supabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILS
// ─────────────────────────────────────────────────────────────────────────────

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (value != null && typeof value !== 'object') {
      const asString = String(value).trim();
      if (asString) return asString;
    }
  }
  return '';
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function collapseWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(text, maxChars, tailChars = 0) {
  const value = collapseWhitespace(text);
  if (!value) return '';

  if (value.length <= maxChars) return value;

  if (tailChars > 0 && value.length > maxChars + tailChars) {
    const head = value.slice(0, maxChars);
    const tail = value.slice(-tailChars);
    return `${head}\n…\n${tail}`;
  }

  return `${value.slice(0, maxChars)}…`;
}

function estimateTokensFromText(text) {
  const value = String(text || '');
  // Rough but stable approximation for English-heavy prompts.
  return Math.ceil(value.length / 4);
}

function estimateTokensFromMessages(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 8; // role / separator overhead
    total += estimateTokensFromText(msg?.content || '');
  }
  return total;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueByKey(rows, keyFn) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function normalizeConversationRow(row) {
  if (!row || typeof row !== 'object') return null;

  const role = firstString(row.role, row.message_role, row.actor).toLowerCase();
  const content = firstString(
    row.content,
    row.message,
    row.text,
    row.reply,
    row.body
  );

  if (!content) return null;

  const normalizedRole =
    role === 'system' || role === 'assistant' || role === 'user'
      ? role
      : 'user';

  return {
    role: normalizedRole,
    content: collapseWhitespace(content),
    created_at: row.created_at || row.updated_at || null,
    metadata: row.metadata || null,
    source: 'conversation',
  };
}

function normalizeSummaryRow(row) {
  if (!row || typeof row !== 'object') return null;

  const summary = firstString(
    row.summary,
    row.content,
    row.text,
    row.value,
    row.note
  );

  if (!summary) return null;

  return {
    summary: collapseWhitespace(summary),
    created_at: row.created_at || row.updated_at || null,
    source: 'summary',
  };
}

function normalizePersonalityRow(row) {
  if (!row || typeof row !== 'object') return null;

  const key = firstString(row.key, row.name, row.preference, row.label);
  const value = firstString(row.value, row.content, row.text, row.data, row.note);

  if (!key && !value) return null;

  return {
    key: key || 'preference',
    value: value || '',
    created_at: row.created_at || row.updated_at || null,
    updated_at: row.updated_at || row.created_at || null,
    source: 'personality',
  };
}

function normalizeRepoContext(repoContext) {
  if (!repoContext) return null;

  // Keep this generic on purpose:
  // can accept strings, arrays, or object snapshots without hard assumptions.
  if (typeof repoContext === 'string') {
    return collapseWhitespace(repoContext);
  }

  if (Array.isArray(repoContext)) {
    return repoContext
      .map((item) => {
        if (typeof item === 'string') return collapseWhitespace(item);
        if (item && typeof item === 'object') {
          const label = firstString(item.path, item.name, item.file, item.repo, item.title);
          const value = firstString(item.summary, item.content, item.text, safeJson(item));
          return label ? `${label}: ${truncateText(value, 260)}` : truncateText(value, 260);
        }
        return firstString(item);
      })
      .filter(Boolean);
  }

  if (typeof repoContext === 'object') {
    const lines = [];
    for (const [key, value] of Object.entries(repoContext)) {
      if (value == null) continue;

      if (typeof value === 'string') {
        lines.push(`${key}: ${truncateText(value, 260)}`);
      } else if (Array.isArray(value)) {
        const list = value
          .map((item) => (typeof item === 'string' ? item : safeJson(item)))
          .filter(Boolean)
          .slice(0, 12);

        if (list.length) {
          lines.push(`${key}:\n- ${list.join('\n- ')}`);
        }
      } else {
        lines.push(`${key}: ${truncateText(safeJson(value), 260)}`);
      }
    }
    return lines.length ? lines.join('\n') : null;
  }

  return null;
}

function normalizeRuntimeContext(runtimeContext) {
  if (!runtimeContext) return null;

  if (typeof runtimeContext === 'string') {
    return collapseWhitespace(runtimeContext);
  }

  if (Array.isArray(runtimeContext)) {
    return runtimeContext
      .map((item) => (typeof item === 'string' ? item : safeJson(item)))
      .filter(Boolean)
      .map((line) => collapseWhitespace(line))
      .join('\n');
  }

  if (typeof runtimeContext === 'object') {
    const lines = [];
    for (const [key, value] of Object.entries(runtimeContext)) {
      if (value == null) continue;
      if (typeof value === 'string') {
        lines.push(`${key}: ${truncateText(value, 200)}`);
      } else {
        lines.push(`${key}: ${truncateText(safeJson(value), 260)}`);
      }
    }
    return lines.length ? lines.join('\n') : null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

function formatPersonalitySection(rows, maxChars = DEFAULT_SECTION_MAX_CHARS) {
  if (!rows.length) return '';

  const latestByKey = new Map();

  for (const row of rows) {
    const key = row.key.toLowerCase();
    const existing = latestByKey.get(key);

    if (!existing) {
      latestByKey.set(key, row);
      continue;
    }

    const existingTime = existing.updated_at || existing.created_at || '';
    const rowTime = row.updated_at || row.created_at || '';
    if (rowTime >= existingTime) {
      latestByKey.set(key, row);
    }
  }

  const items = Array.from(latestByKey.values())
    .slice(0, 20)
    .map((row) => `- ${row.key}: ${truncateText(row.value || '', 200)}`)
    .join('\n');

  if (!items) return '';

  return truncateText(
    `[USER PREFERENCES]\n${items}`,
    maxChars
  );
}

function formatSummariesSection(rows, maxChars = DEFAULT_SECTION_MAX_CHARS) {
  if (!rows.length) return '';

  const lines = rows
    .slice(0, DEFAULT_SUMMARY_LIMIT)
    .map((row, index) => {
      const when = row.created_at ? ` (${row.created_at})` : '';
      return `${index + 1}. ${truncateText(row.summary, 360)}${when}`;
    })
    .join('\n');

  if (!lines) return '';

  return truncateText(
    `[EPISODIC MEMORY — last ${Math.min(rows.length, DEFAULT_SUMMARY_LIMIT)} sessions]\n${lines}`,
    maxChars
  );
}

function formatRepoSection(repoContext, maxChars = DEFAULT_SECTION_MAX_CHARS) {
  const normalized = normalizeRepoContext(repoContext);
  if (!normalized) return '';

  const text = Array.isArray(normalized)
    ? normalized.join('\n')
    : normalized;

  return truncateText(
    `[REPO / SYSTEM CONTEXT]\n${text}`,
    maxChars
  );
}

function formatRuntimeSection(runtimeContext, maxChars = DEFAULT_SECTION_MAX_CHARS) {
  const normalized = normalizeRuntimeContext(runtimeContext);
  if (!normalized) return '';

  return truncateText(
    `[RUNTIME SIGNALS]\n${normalized}`,
    maxChars
  );
}

function formatConversationDigest(messages, maxChars = DEFAULT_DIGEST_MAX_CHARS) {
  if (!messages.length) return '';

  const lines = messages.map((msg) => {
    const prefix = msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
    const content = truncateText(msg.content, 180);
    return `- ${prefix}: ${content}`;
  });

  const digest = `[OLDER HISTORY DIGEST]\n${lines.join('\n')}`;
  return truncateText(digest, maxChars);
}

function formatRecentMessage(msg) {
  if (!msg || !msg.content) return null;

  return {
    role: msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user',
    content: collapseWhitespace(msg.content),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY WINDOW / COMPRESSION
// ─────────────────────────────────────────────────────────────────────────────

function splitConversationWindow(messages, keepCount = DEFAULT_RECENT_MESSAGE_KEEP) {
  const normalized = messages
    .map(formatRecentMessage)
    .filter(Boolean);

  if (normalized.length <= keepCount) {
    return {
      digest: '',
      recentMessages: normalized,
      droppedCount: 0,
    };
  }

  const dropped = normalized.slice(0, normalized.length - keepCount);
  const recentMessages = normalized.slice(-keepCount);
  const digest = formatConversationDigest(dropped);

  return {
    digest,
    recentMessages,
    droppedCount: dropped.length,
  };
}

function trimByTokenBudget({
  baseSystemPrompt,
  systemSections,
  messages,
  budgetTokens,
}) {
  const buildPrompt = () => {
    const sections = [
      baseSystemPrompt,
      ...systemSections.filter(Boolean),
    ].filter(Boolean);

    const systemPrompt = sections.join('\n\n');
    const tokenCount = estimateTokensFromText(systemPrompt) + estimateTokensFromMessages(messages);

    return { systemPrompt, tokenCount };
  };

  let { systemPrompt, tokenCount } = buildPrompt();

  // If within budget, return immediately.
  if (tokenCount <= budgetTokens) {
    return { systemPrompt, messages, tokenCount, truncated: false };
  }

  // Otherwise trim from the front of messages until it fits.
  let trimmedMessages = [...messages];
  let truncated = false;

  while (trimmedMessages.length > 1) {
    trimmedMessages.shift();
    truncated = true;

    const rebuilt = [
      baseSystemPrompt,
      ...systemSections.filter(Boolean),
    ].filter(Boolean).join('\n\n');

    systemPrompt = rebuilt;
    tokenCount = estimateTokensFromText(systemPrompt) + estimateTokensFromMessages(trimmedMessages);

    if (tokenCount <= budgetTokens) {
      return { systemPrompt, messages: trimmedMessages, tokenCount, truncated: true };
    }
  }

  return {
    systemPrompt,
    messages: trimmedMessages,
    tokenCount,
    truncated: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE LOADERS
// ─────────────────────────────────────────────────────────────────────────────

async function selectWithOrderFallback(table, builder, orderColumns = []) {
  let lastError = null;

  for (const column of orderColumns) {
    try {
      const { data, error } = await builder()
        .select('*')
        .order(column, { ascending: false });

      if (error) {
        lastError = error;
        continue;
      }

      return data || [];
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function fetchConversationRows({
  userId,
  sessionId = null,
  limitTurns = DEFAULT_RECENT_TURNS,
}) {
  const supabase = getSupabase();
  const limitRows = Math.max(1, limitTurns * 2);

  const baseQuery = () => {
    let q = supabase.from(TABLES.CONVERSATIONS);

    q = q.eq('user_id', userId);

    if (sessionId) {
      q = q.eq('session_id', sessionId);
    }

    return q.limit(limitRows);
  };

  const rows = await selectWithOrderFallback(
    TABLES.CONVERSATIONS,
    baseQuery,
    ['created_at', 'updated_at']
  );

  // Query returns newest-first. Reverse to chronological order.
  return rows.slice().reverse();
}

async function fetchSummaryRows({
  userId,
  limit = DEFAULT_SUMMARY_LIMIT,
}) {
  const supabase = getSupabase();

  const baseQuery = () => supabase
    .from(TABLES.CONTEXT_SUMMARIES)
    .eq('user_id', userId)
    .limit(Math.max(1, limit));

  const rows = await selectWithOrderFallback(
    TABLES.CONTEXT_SUMMARIES,
    baseQuery,
    ['created_at', 'updated_at']
  );

  return rows.slice().reverse();
}

async function fetchPersonalityRows({
  userId,
  limit = 200,
}) {
  const supabase = getSupabase();

  const baseQuery = () => supabase
    .from(TABLES.PERSONALITY)
    .eq('user_id', userId)
    .limit(Math.max(1, limit));

  const rows = await selectWithOrderFallback(
    TABLES.PERSONALITY,
    baseQuery,
    ['updated_at', 'created_at']
  );

  return rows.slice().reverse();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPRESSOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compresses already-loaded rows into an AI-friendly prompt bundle.
 *
 * @param {Object} input
 * @returns {{ systemPrompt: string, messages: Array, tokenCount: number, truncated: boolean, diagnostics: Object }}
 */
function compressContext(input = {}) {
  const {
    baseSystemPrompt   = DEFAULT_BASE_SYSTEM_PROMPT,
    conversationRows   = [],
    summaryRows        = [],
    personalityRows    = [],
    currentMessage     = null,
    repoContext        = null,
    runtimeContext     = null,
    keepRecentMessages = DEFAULT_RECENT_MESSAGE_KEEP,
    promptBudgetTokens = DEFAULT_PROMPT_BUDGET_TOKENS,
    preferCode         = false,
    modelName          = null,
  } = input;

  const normalizedConversations = toArray(conversationRows)
    .map(normalizeConversationRow)
    .filter(Boolean);

  const normalizedSummaries = toArray(summaryRows)
    .map(normalizeSummaryRow)
    .filter(Boolean);

  const normalizedPersonality = toArray(personalityRows)
    .map(normalizePersonalityRow)
    .filter(Boolean);

  const currentUserMessage = currentMessage
    ? formatRecentMessage({
        role: 'user',
        content: typeof currentMessage === 'string' ? currentMessage : currentMessage.content,
      })
    : null;

  const fullConversation = currentUserMessage
    ? [...normalizedConversations, currentUserMessage]
    : normalizedConversations;

  const { digest, recentMessages, droppedCount } = splitConversationWindow(
    fullConversation,
    keepRecentMessages
  );

  const systemSections = [
    formatPersonalitySection(normalizedPersonality),
    formatSummariesSection(normalizedSummaries),
    formatRepoSection(repoContext),
    formatRuntimeSection(runtimeContext),
    digest,
  ].filter(Boolean).map((section) => truncateText(section, DEFAULT_SECTION_MAX_CHARS));

  const compressed = trimByTokenBudget({
    baseSystemPrompt,
    systemSections,
    messages: recentMessages,
    budgetTokens: promptBudgetTokens,
  });

  return {
    systemPrompt: compressed.systemPrompt,
    messages: compressed.messages,
    tokenCount: compressed.tokenCount,
    truncated: compressed.truncated,
    preferCode: Boolean(preferCode),
    modelName,
    diagnostics: {
      conversationCount: normalizedConversations.length,
      summaryCount: normalizedSummaries.length,
      personalityCount: normalizedPersonality.length,
      keptMessages: compressed.messages.length,
      droppedMessages: droppedCount,
      digestIncluded: Boolean(digest),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADER + COMPRESSOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads DB memory rows and compresses them into an AI prompt bundle.
 *
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function loadCompressedContext(options = {}) {
  const {
    userId,
    sessionId = null,
    currentMessage = null,
    repoContext = null,
    runtimeContext = null,
    baseSystemPrompt = DEFAULT_BASE_SYSTEM_PROMPT,
    keepRecentMessages = DEFAULT_RECENT_MESSAGE_KEEP,
    promptBudgetTokens = DEFAULT_PROMPT_BUDGET_TOKENS,
    preferCode = false,
    modelName = null,
  } = options;

  if (!userId) {
    // Allow pure compression if the caller already has loaded rows.
    return compressContext({
      baseSystemPrompt,
      conversationRows: toArray(options.conversationRows),
      summaryRows: toArray(options.summaryRows),
      personalityRows: toArray(options.personalityRows),
      currentMessage,
      repoContext,
      runtimeContext,
      keepRecentMessages,
      promptBudgetTokens,
      preferCode,
      modelName,
    });
  }

  let conversationRows = [];
  let summaryRows = [];
  let personalityRows = [];

  try {
    conversationRows = await fetchConversationRows({
      userId,
      sessionId,
      limitTurns: keepRecentMessages,
    });
  } catch (err) {
    logger.warn('loadCompressedContext', 'Failed to load conversations', {
      userId,
      sessionId,
      error: err.message,
    });
  }

  try {
    summaryRows = await fetchSummaryRows({
      userId,
      limit: DEFAULT_SUMMARY_LIMIT,
    });
  } catch (err) {
    logger.warn('loadCompressedContext', 'Failed to load context summaries', {
      userId,
      error: err.message,
    });
  }

  try {
    personalityRows = await fetchPersonalityRows({
      userId,
    });
  } catch (err) {
    logger.warn('loadCompressedContext', 'Failed to load personality rows', {
      userId,
      error: err.message,
    });
  }

  return compressContext({
    baseSystemPrompt,
    conversationRows,
    summaryRows,
    personalityRows,
    currentMessage,
    repoContext,
    runtimeContext,
    keepRecentMessages,
    promptBudgetTokens,
    preferCode,
    modelName,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  compressContext,
  loadCompressedContext,
  fetchConversationRows,
  fetchSummaryRows,
  fetchPersonalityRows,
  normalizeConversationRow,
  normalizeSummaryRow,
  normalizePersonalityRow,
  estimateTokensFromText,
  estimateTokensFromMessages,
};
