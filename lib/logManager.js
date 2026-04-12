'use strict';

// logManager.js
// Structured JSON file logger with rotation, tailing, pub/sub, and redaction.
// No dependency on broadcastEmitter — SSE wiring lives in selfDiagnose/server.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const LOG_DIR            = path.join('/app', 'logs');
const LOG_FILE           = path.join(LOG_DIR, 'app.log');
const ROTATED_FILE       = path.join(LOG_DIR, 'app.log.1');
const MAX_LOG_BYTES      = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_TAIL_INTERVAL_MS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL STATE
// ─────────────────────────────────────────────────────────────────────────────

// FIX: start with a resolved chain so it never starts poisoned
let writeChain  = Promise.resolve();
const subscribers = new Set();
const tailers     = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogPath() {
  ensureLogDir();
  return LOG_FILE;
}

function getLogDir() {
  ensureLogDir();
  return LOG_DIR;
}

// ─────────────────────────────────────────────────────────────────────────────
// REDACTION
// ─────────────────────────────────────────────────────────────────────────────

function redactString(input) {
  if (typeof input !== 'string' || !input) return input;

  return input
    .replace(
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      '[JWT REDACTED]'
    )
    .replace(
      /Bearer\s+[a-zA-Z0-9_.\-]+/gi,
      'Bearer [REDACTED]'
    )
    .replace(
      /\b(sk-|gsk_|AIza|hf_|xoxb-|xoxp-|AKIA|rk_live_|rk_test_)[a-zA-Z0-9_\-]{8,}/g,
      '[API KEY REDACTED]'
    )
    .replace(
      /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
      '[PRIVATE KEY REDACTED]'
    )
    .replace(
      /(https?:\/\/)[^:@\s]+:[^@\s]+@/gi,
      '$1[REDACTED]:[REDACTED]@'
    )
    .replace(
      /Authorization:\s*[A-Za-z]+\s+[a-zA-Z0-9_.\-]+/gi,
      'Authorization: [REDACTED]'
    );
}

function redactValue(key, value, seen) {
  if (value == null) return value;

  if (typeof value === 'string') {
    if (/token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization/i.test(key)) {
      return '[REDACTED]';
    }
    return redactString(value);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  // FIX: only add objects to WeakSet — primitives would throw TypeError
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = redactValue(k, v, seen);
  }
  return out;
}

function cleanMeta(meta) {
  // Only pass objects to WeakSet — primitives are handled by redactValue guards
  return redactValue('meta', meta, new WeakSet());
}

// ─────────────────────────────────────────────────────────────────────────────
// SERIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function createEntry(level, namespace, message, meta = {}) {
  return {
    timestamp: new Date().toISOString(),
    level,
    namespace,
    message:   typeof message === 'string' ? redactString(message) : String(message),
    meta:      cleanMeta(meta),
    pid:       process.pid,
    host:      os.hostname(),
  };
}

function serializeEntry(entry) {
  return JSON.stringify(entry);
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      timestamp: null,
      level:     'raw',
      namespace: 'log',
      message:   trimmed,
      meta:      {},
      pid:       process.pid,
      host:      os.hostname(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTATION
// ─────────────────────────────────────────────────────────────────────────────

function rotateIfNeeded(incomingBytes = 0) {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return;

  const size = fs.statSync(LOG_FILE).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;

  if (fs.existsSync(ROTATED_FILE)) {
    fs.unlinkSync(ROTATED_FILE);
  }

  fs.renameSync(LOG_FILE, ROTATED_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBERS
// ─────────────────────────────────────────────────────────────────────────────

function subscribe(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('subscribe(listener) requires a function');
  }

  subscribers.add(listener);
  return () => unsubscribe(listener);
}

function unsubscribe(listener) {
  subscribers.delete(listener);
}

function notifySubscribers(entry) {
  if (!subscribers.size) return;

  for (const listener of subscribers) {
    queueMicrotask(() => {
      try {
        listener(entry);
      } catch {
        // Subscriber failures never break logging
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE QUEUE
// ─────────────────────────────────────────────────────────────────────────────

// FIX: recover from any previous failure before each write
// This prevents a single failed write from poisoning all future writes
function enqueueWrite(task) {
  writeChain = writeChain
    .catch(() => undefined)   // ← recover from previous failure
    .then(task)
    .catch((err) => {
      console.error('[logManager] write failed:', err);
      return undefined;       // ← keep chain alive on this failure too
    });

  return writeChain;
}

async function log(level, namespace, message, meta = {}) {
  const entry = createEntry(level, namespace, message, meta);
  const line  = serializeEntry(entry) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');

  return enqueueWrite(async () => {
    ensureLogDir();
    rotateIfNeeded(bytes);
    fs.appendFileSync(getLogPath(), line, 'utf8');
    notifySubscribers(entry);
    return entry;
  });
}

function debug(namespace, message, meta = {}) {
  return log('debug', namespace, message, meta);
}

function info(namespace, message, meta = {}) {
  return log('info', namespace, message, meta);
}

function warn(namespace, message, meta = {}) {
  return log('warn', namespace, message, meta);
}

function error(namespace, message, meta = {}) {
  return log('error', namespace, message, meta);
}

// ─────────────────────────────────────────────────────────────────────────────
// READ API
// ─────────────────────────────────────────────────────────────────────────────

function readLogs(options = {}) {
  const {
    lines     = DEFAULT_TAIL_LINES,
    level     = null,
    namespace = null,
    raw       = false,
  } = options;

  ensureLogDir();

  if (!fs.existsSync(LOG_FILE)) {
    return { path: LOG_FILE, count: 0, entries: [], raw: '' };
  }

  const text   = fs.readFileSync(LOG_FILE, 'utf8');
  const parsed = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean)
    .filter((entry) => {
      if (level     && entry.level     !== level)     return false;
      if (namespace && entry.namespace !== namespace) return false;
      return true;
    });

  const sliced = parsed.slice(-Math.max(1, lines));

  return {
    path:    LOG_FILE,
    count:   sliced.length,
    entries: sliced,
    raw:     raw ? sliced.map((e) => JSON.stringify(e)).join('\n') : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TAIL WATCHER
// ─────────────────────────────────────────────────────────────────────────────

function startTailWatcher(onEntry, options = {}) {
  if (typeof onEntry !== 'function') {
    throw new TypeError('startTailWatcher(onEntry) requires a function');
  }

  ensureLogDir();

  const intervalMs    = options.intervalMs  || DEFAULT_TAIL_INTERVAL_MS;
  const emitExisting  = Boolean(options.emitExisting);

  const state = {
    active: true,
    offset: 0,
    buffer: '',
    timer:  null,
  };

  try {
    if (fs.existsSync(LOG_FILE) && !emitExisting) {
      state.offset = fs.statSync(LOG_FILE).size;
    }
  } catch {
    state.offset = 0;
  }

  const tick = () => {
    if (!state.active) return;

    try {
      if (!fs.existsSync(LOG_FILE)) return;

      const stats = fs.statSync(LOG_FILE);

      if (stats.size < state.offset) {
        state.offset = 0;
        state.buffer = '';
      }

      if (stats.size === state.offset) return;

      const bytesToRead = stats.size - state.offset;

      // FIX: fd is closed in finally — no leak on readSync error
      let fd;
      try {
        fd = fs.openSync(LOG_FILE, 'r');
        const buffer    = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, state.offset);

        if (bytesRead <= 0) return;

        state.offset  += bytesRead;
        state.buffer  += buffer.toString('utf8', 0, bytesRead);
      } finally {
        if (fd != null) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
      }

      const lines  = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) onEntry(entry);
      }
    } catch (err) {
      onEntry({
        timestamp: new Date().toISOString(),
        level:     'error',
        namespace: 'logManager',
        message:   'Tail watcher tick failed',
        meta:      { error: err.message },
        pid:       process.pid,
        host:      os.hostname(),
      });
    }
  };

  tailers.add(state);

  // BUG9 FIX: if emitExisting, run first tick synchronously BEFORE starting interval
  // prevents race condition where interval fires before initial read completes
  if (emitExisting) {
    tick();
    // Start interval only after first tick initiated
    state.timer = setInterval(tick, intervalMs);
  } else {
    state.timer = setInterval(tick, intervalMs);
  }

  if (typeof state.timer.unref === 'function') state.timer.unref();

  return {
    stop() { stopTailWatcher(state); },
  };
  
function stopTailWatcher(handle) {
  if (!handle) return;
  handle.active = false;
  if (handle.timer) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  tailers.delete(handle);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  log,
  debug,
  info,
  warn,
  error,
  readLogs,
  getLogPath,
  getLogDir,
  startTailWatcher,
  stopTailWatcher,
  subscribe,
  unsubscribe,
  redactString,
};
