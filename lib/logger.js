'use strict';

// Structured logger — writes to stdout (HF Spaces captures logs)
// Format: [LEVEL] timestamp context message {meta?}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

function timestamp() {
  return new Date().toISOString();
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[MIN_LEVEL];
}

function format(level, context, message, meta) {
  const base = `[${level.toUpperCase()}] ${timestamp()} [${context}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    return `${base} ${JSON.stringify(meta)}`;
  }
  return base;
}

const logger = {
  debug(context, message, meta = {}) {
    if (!shouldLog('debug')) return;
    console.debug(format('debug', context, message, meta));
  },

  info(context, message, meta = {}) {
    if (!shouldLog('info')) return;
    console.info(format('info', context, message, meta));
  },

  warn(context, message, meta = {}) {
    if (!shouldLog('warn')) return;
    console.warn(format('warn', context, message, meta));
  },

  error(context, message, errOrMeta = {}) {
    if (!shouldLog('error')) return;
    if (errOrMeta instanceof Error) {
      console.error(format('error', context, message, {
        error: errOrMeta.message,
        stack: errOrMeta.stack,
      }));
    } else {
      console.error(format('error', context, message, errOrMeta));
    }
  },
};

module.exports = logger;
