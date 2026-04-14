'use strict';

/**
 * @file logManager.js
 * @location /backend/lib/logManager.js
 *
 * Standalone log manager used by selfDiagnose.js.
 * Mirrors logger.js dual-output (stdout + file).
 * NOTE: logger.js IS the primary logger. This file exists for
 * selfDiagnose.js which imports readLogs/subscribe/startTailWatcher
 * directly from here. Both files share the same log file on disk.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_DIR            = path.join('/app', 'logs');
const LOG_FILE           = path.join(LOG_DIR, 'app.log');
const ROTATED_FILE       = path.join(LOG_DIR, 'app.log.1');
const MAX_LOG_BYTES      = 10 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_TAIL_INTERVAL_MS = 1000;

let writeChain    = Promise.resolve();
const subscribers = new Set();
const tailers     = new Set();

// ── ANSI colors (matches logger.js) ──────────────────────────────────────────
const COLORS = {
  reset: '\x1b[0m',
  debug: '\x1b[36m',
  info:  '\x1b[32m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  raw:   '\x1b[90m',
};

function colorize(level, text) {
  return `${COLORS[level] || COLORS.reset}${text}${COLORS.reset}`;
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogPath() { ensureLogDir(); return LOG_FILE; }
function getLogDir()  { ensureLogDir(); return LOG_DIR;  }

function redactString(input) {
  if (typeof input !== 'string' || !input) return input;
  return input
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9_.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-|gsk_|AIza|hf_|xoxb-|xoxp-|AKIA|rk_live_|rk_test_)[a-zA-Z0-9_\-]{8,}/g, '[API KEY REDACTED]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/(https?:\/\/)[^:@\s]+:[^@\s]+@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/Authorization:\s*[A-Za-z]+\s+[a-zA-Z0-9_.\-]+/gi, 'Authorization: [REDACTED]');
}

function redactValue(key, value, seen) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization/i.test(key)) return '[REDACTED]';
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return typeof value === 'bigint' ? value.toString() : value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization/i.test(k)) { out[k] = '[REDACTED]'; continue; }
    out[k] = redactValue(k, v, seen);
  }
  return out;
}

function cleanMeta(meta) { return redactValue('meta', meta, new WeakSet()); }

function createEntry(level, namespace, message, meta = {}) {
  return {
    timestamp: new Date().toISOString(),
    level, namespace,
    message:   typeof message === 'string' ? redactString(message) : String(message),
    meta:      cleanMeta(meta),
    pid:       process.pid,
    host:      os.hostname(),
  };
}

function serializeEntry(entry) { return JSON.stringify(entry); }

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return { timestamp: null, level: 'raw', namespace: 'log', message: trimmed, meta: {}, pid: process.pid, host: os.hostname() }; }
}

function formatForStdout(entry) {
  const ts      = entry.timestamp ? entry.timestamp.slice(11, 23) : '??:??:??.???';
  const level   = entry.level.toUpperCase().padEnd(5);
  const ns      = entry.namespace ? `[${entry.namespace}]` : '';
  const metaStr = entry.meta && Object.keys(entry.meta).length > 0 ? ' ' + JSON.stringify(entry.meta) : '';
  return colorize(entry.level, `${ts} ${level} ${ns} ${entry.message}${metaStr}`);
}

function rotateIfNeeded(incomingBytes = 0) {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return;
  const size = fs.statSync(LOG_FILE).size;
  if (size + incomingBytes <= MAX_LOG_BYTES) return;
  if (fs.existsSync(ROTATED_FILE)) fs.unlinkSync(ROTATED_FILE);
  fs.renameSync(LOG_FILE, ROTATED_FILE);
}

function subscribe(listener) {
  if (typeof listener !== 'function') throw new TypeError('subscribe(listener) requires a function');
  subscribers.add(listener);
  return () => unsubscribe(listener);
}
function unsubscribe(listener) { subscribers.delete(listener); }
function notifySubscribers(entry) {
  if (!subscribers.size) return;
  for (const listener of subscribers) {
    queueMicrotask(() => { try { listener(entry); } catch {} });
  }
}

function enqueueWrite(task) {
  writeChain = writeChain.catch(() => undefined).then(task).catch((err) => {
    console.error('[logManager] write failed:', err);
    return undefined;
  });
  return writeChain;
}

// ── CORE — dual output ────────────────────────────────────────────────────────
async function log(level, namespace, message, meta = {}) {
  const entry    = createEntry(level, namespace, message, meta);
  const jsonLine = serializeEntry(entry) + '\n';
  const bytes    = Buffer.byteLength(jsonLine, 'utf8');

  // stdout — immediate
  const stdoutLine = formatForStdout(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(stdoutLine + '\n');
  } else {
    process.stdout.write(stdoutLine + '\n');
  }

  // file — queued
  return enqueueWrite(async () => {
    ensureLogDir();
    rotateIfNeeded(bytes);
    fs.appendFileSync(getLogPath(), jsonLine, 'utf8');
    notifySubscribers(entry);
    return entry;
  });
}

function debug(namespace, message, meta = {}) { return log('debug', namespace, message, meta); }
function info(namespace, message, meta = {})  { return log('info',  namespace, message, meta); }
function warn(namespace, message, meta = {})  { return log('warn',  namespace, message, meta); }
function error(namespace, message, meta = {}) { return log('error', namespace, message, meta); }

function tail(options = {}) { return readLogs(options); }

function readLogs(options = {}) {
  const { lines = DEFAULT_TAIL_LINES, level = null, namespace = null, raw = false } = options;
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return { path: LOG_FILE, count: 0, entries: [], raw: '' };
  const text   = fs.readFileSync(LOG_FILE, 'utf8');
  const parsed = text.split(/\r?\n/).map(parseLine).filter(Boolean).filter((entry) => {
    if (level     && entry.level     !== level)     return false;
    if (namespace && entry.namespace !== namespace) return false;
    return true;
  });
  const sliced = parsed.slice(-Math.max(1, lines));
  return { path: LOG_FILE, count: sliced.length, entries: sliced, raw: raw ? sliced.map((e) => JSON.stringify(e)).join('\n') : '' };
}

function stopTailWatcher(handle) {
  if (!handle) return;
  handle.active = false;
  if (handle.timer) { clearInterval(handle.timer); handle.timer = null; }
  tailers.delete(handle);
}

function startTailWatcher(onEntry, options = {}) {
  if (typeof onEntry !== 'function') throw new TypeError('startTailWatcher(onEntry) requires a function');
  ensureLogDir();
  const intervalMs   = options.intervalMs  || DEFAULT_TAIL_INTERVAL_MS;
  const emitExisting = Boolean(options.emitExisting);
  const state = { active: true, offset: 0, buffer: '', timer: null };
  try {
    if (fs.existsSync(LOG_FILE) && !emitExisting) state.offset = fs.statSync(LOG_FILE).size;
  } catch { state.offset = 0; }

  const tick = () => {
    if (!state.active) return;
    try {
      if (!fs.existsSync(LOG_FILE)) return;
      const stats = fs.statSync(LOG_FILE);
      if (stats.size < state.offset) { state.offset = 0; state.buffer = ''; }
      if (stats.size === state.offset) return;
      const bytesToRead = stats.size - state.offset;
      let fd;
      try {
        fd = fs.openSync(LOG_FILE, 'r');
        const buffer    = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, state.offset);
        if (bytesRead <= 0) return;
        state.offset  += bytesRead;
        state.buffer  += buffer.toString('utf8', 0, bytesRead);
      } finally {
        if (fd != null) { try { fs.closeSync(fd); } catch {} }
      }
      const lines  = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) onEntry(entry);
      }
    } catch (err) {
      onEntry({ timestamp: new Date().toISOString(), level: 'error', namespace: 'logManager', message: 'Tail watcher tick failed', meta: { error: err.message }, pid: process.pid, host: os.hostname() });
    }
  };

  tailers.add(state);
  if (emitExisting) tick();
  state.timer = setInterval(tick, intervalMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  return { stop() { stopTailWatcher(state); } };
}

module.exports = {
  log, debug, info, warn, error,
  tail, readLogs,
  getLogPath, getLogDir,
  startTailWatcher, stopTailWatcher,
  subscribe, unsubscribe,
  redactString,
};
