'use strict';

// ── FORMATTER ─────────────────────────────────────────────────────────────────
// Pure utility functions. No imports. No side effects.

/**
 * Truncate a string to maxLen characters, appending ellipsis if cut.
 */
function truncate(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/**
 * Strip all HTML tags from a string.
 */
function stripHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

/**
 * Convert bytes to a human-readable string (e.g. 1.2 KB, 3.4 MB).
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format milliseconds as a human-readable duration (e.g. 1.2s, 340ms).
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Safely parse JSON. Returns null on failure instead of throwing.
 */
function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Convert a snake_case or camelCase string to Title Case.
 */
function toTitle(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Redact sensitive values from an object for safe logging.
 * Replaces values of keys containing: key, token, secret, password, pat
 */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sensitive = ['key', 'token', 'secret', 'password', 'pat', 'auth'];
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      const lower = k.toLowerCase();
      if (sensitive.some((s) => lower.includes(s))) return [k, '[REDACTED]'];
      return [k, v];
    })
  );
}

/**
 * Wrap a string in a code block for markdown display.
 */
function codeBlock(str, lang = '') {
  return `\`\`\`${lang}\n${str}\n\`\`\``;
}

/**
 * Generate a short random ID (8 chars). Not cryptographically secure.
 * Use for trace IDs, temp keys, not auth.
 */
function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = {
  truncate,
  stripHtml,
  formatBytes,
  formatDuration,
  safeJson,
  toTitle,
  redact,
  codeBlock,
  shortId,
};
