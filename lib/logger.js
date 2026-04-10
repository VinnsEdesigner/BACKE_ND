'use strict';

// logger.js
// Wraps logManager with console output + fire-and-forget file logging.
// Never throws. Never blocks request flow.
// Supports: logger.info('ns', 'msg', meta) and logger.info('msg', meta)

const util       = require('util');
const logManager = require('./logManager');

const DEFAULT_NAMESPACE = 'app';

// ─────────────────────────────────────────────────────────────────────────────
// ERROR NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function normalizeError(err) {
  if (!(err instanceof Error)) return err;

  return {
    name:    err.name,
    message: err.message,
    stack:   err.stack,
    cause:
      err.cause instanceof Error
        ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
        : err.cause ?? undefined,
  };
}

function normalizeMeta(meta) {
  if (meta === undefined || meta === null) return meta;
  if (meta instanceof Error) return normalizeError(meta);
  if (typeof meta !== 'object') return meta;

  if (Array.isArray(meta)) {
    return meta.map((item) => normalizeMeta(item));
  }

  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      out[key] = normalizeError(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => normalizeMeta(item));
    } else if (value && typeof value === 'object') {
      out[key] = normalizeMeta(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ARG PARSING
// FIX: corrected 2-arg case logic
// ─────────────────────────────────────────────────────────────────────────────

function parseCallArgs(args) {
  if (args.length === 0) {
    return { namespace: DEFAULT_NAMESPACE, message: '', meta: undefined };
  }

  // logger.info('message')
  if (args.length === 1) {
    return { namespace: DEFAULT_NAMESPACE, message: args[0], meta: undefined };
  }

  if (args.length === 2) {
    // FIX: distinguish by second arg type, not first
    // logger.info('message', { meta })   → second is object/non-string
    // logger.info('namespace', 'message') → both are strings
    if (typeof args[1] !== 'string') {
      return {
        namespace: DEFAULT_NAMESPACE,
        message:   args[0],
        meta:      args[1],
      };
    }
    // logger.info('namespace', 'message')
    return {
      namespace: args[0] && typeof args[0] === 'string' ? args[0] : DEFAULT_NAMESPACE,
      message:   args[1],
      meta:      undefined,
    };
  }

  // logger.info('namespace', 'message', meta)
  return {
    namespace: typeof args[0] === 'string' && args[0].trim()
      ? args[0]
      : DEFAULT_NAMESPACE,
    message: args[1],
    meta:    args[2],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLE OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

function formatConsoleLine(level, namespace, message, meta) {
  const ts = new Date().toISOString();

  const safeMessage =
    typeof message === 'string'
      ? logManager.redactString(message)
      : util.inspect(message, { depth: 4 });

  const metaStr =
    meta === undefined
      ? ''
      : ` ${logManager.redactString(
          util.inspect(normalizeMeta(meta), {
            depth:       5,
            breakLength: 120,
            compact:     true,
            sorted:      true,
          })
        )}`;

  return `[${ts}] [${level.toUpperCase()}] [${namespace}] ${safeMessage}${metaStr}`;
}

function consoleWrite(level, line) {
  try {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  } catch {
    // console should never take the app down
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

function dispatch(level, namespace, message, meta) {
  const ns             = namespace && typeof namespace === 'string'
    ? namespace
    : DEFAULT_NAMESPACE;
  const normalizedMeta = normalizeMeta(meta);
  const line           = formatConsoleLine(level, ns, message, normalizedMeta);

  consoleWrite(level, line);

  // Fire-and-forget — never let logging block request flow
  Promise.resolve()
    .then(() => logManager.log(level, ns, message, normalizedMeta))
    .catch((err) => {
      try { console.error('[logger] logManager failure:', err); } catch { /* ignore */ }
    });

  // FIX: return void — callers don't use return value of logger calls
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

function debug(...args) {
  const { namespace, message, meta } = parseCallArgs(args);
  dispatch('debug', namespace, message, meta);
}

function info(...args) {
  const { namespace, message, meta } = parseCallArgs(args);
  dispatch('info', namespace, message, meta);
}

function warn(...args) {
  const { namespace, message, meta } = parseCallArgs(args);
  dispatch('warn', namespace, message, meta);
}

function error(...args) {
  const { namespace, message, meta } = parseCallArgs(args);
  dispatch('error', namespace, message, meta);
}

function log(level, ...args) {
  const { namespace, message, meta } = parseCallArgs(args);
  dispatch(level, namespace, message, meta);
}

/**
 * Creates a child logger with a fixed namespace.
 * Useful for module-level loggers.
 *
 * @param {string} namespace
 * @returns {{ debug, info, warn, error, log }}
 *
 * @example
 * const log = logger.child('auth');
 * log.info('Token issued', { userId });
 */
function child(namespace) {
  return {
    debug: (message, meta) => dispatch('debug', namespace, message, meta),
    info:  (message, meta) => dispatch('info',  namespace, message, meta),
    warn:  (message, meta) => dispatch('warn',  namespace, message, meta),
    error: (message, meta) => dispatch('error', namespace, message, meta),
    log:   (level, message, meta) => dispatch(level, namespace, message, meta),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { debug, info, warn, error, log, child };
