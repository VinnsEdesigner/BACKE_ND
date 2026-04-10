'use strict';

/**
 * @file selfDiagnose.js
 * @location /backend/lib/agent/selfDiagnose.js
 *
 * @purpose
 * Scans structured log entries and converts them into typed diagnostic findings.
 * Detects rate limits, provider outages, build failures, memory pressure,
 * SSE issues, database issues, git issues, filesystem issues, auth issues,
 * and error bursts.
 *
 * This module is intentionally pure:
 * - it does not emit SSE directly
 * - it does not require user context
 * - it never throws from detector failures
 *
 * @exports
 *   analyzeEntries(entries)        → pure analysis of already-loaded log entries
 *   scanRecentLogs(options)        → reads recent logs and analyzes them
 *   createLiveMonitor(options)     → subscribes to logManager live entries
 *   toBroadcastCard(finding)       → converts a finding into SSE-friendly payload shape
 *   detectEntry(entry)             → runs all detectors for one entry
 *   summarizeFindings(findings)    → compact human summary
 *   severityRank(severity)         → ordering helper
 *
 * @imports
 *   crypto                         → stable hash generation
 *   ../logManager                  → readLogs, subscribe
 *   ../../utils/constants          → SSE
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none directly; toBroadcastCard() returns SSE-shaped payloads
 *
 * @env-vars
 *   none
 *
 * @dependency-level 4
 */

const crypto = require('crypto');
const { readLogs, subscribe } = require('../logManager');
const { SSE } = require('../../utils/constants');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SCAN_LINES = 200;
const DEFAULT_DEDUPE_MS = 5 * 60 * 1000;
const DEFAULT_MEMORY_WARNING_RSS_MB = 900;
const DEFAULT_MEMORY_CRITICAL_RSS_MB = 1300;
const DEFAULT_ERROR_BURST_WINDOW = 20;
const DEFAULT_ERROR_BURST_THRESHOLD = 5;

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function safeLower(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.toLowerCase();
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input).toLowerCase();
  }
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input).toLowerCase();
    } catch {
      return '';
    }
  }
  return String(input).toLowerCase();
}

function stringifyMeta(meta) {
  if (!meta) return '';
  try {
    return JSON.stringify(meta);
  } catch {
    return '';
  }
}

function numberFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickNestedNumber(meta, keys) {
  if (!meta || typeof meta !== 'object') return null;

  for (const key of keys) {
    const n = numberFromValue(meta[key]);
    if (n !== null) return n;
  }

  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (value && typeof value === 'object') {
      const nested = pickNestedNumber(value, keys);
      if (nested !== null) return nested;
    }
  }

  return null;
}

function stableEvidenceKey(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';

  // Only stable, low-volatility fields belong in the dedupe signature.
  const stable = {
    provider: evidence.provider || null,
    model: evidence.model || null,
    service: evidence.service || null,
    status: evidence.status ?? null,
    statusCode: evidence.statusCode ?? null,
    code: evidence.code ?? null,
    rssMb: evidence.rssMb ?? null,
    errorCount: evidence.errorCount ?? null,
    windowSize: evidence.windowSize ?? null,
  };

  return stringifyMeta(stable);
}

// FIX: hash only stable fields — do NOT include volatile evidence/meta blobs.
function hashFinding(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex');
}

function baseFinding({
  category,
  severity,
  title,
  summary,
  entry,
  confidence = 0.8,
  autoFixable = false,
  suggestedActions = [],
  evidence = {},
}) {
  return {
    id: hashFinding([
      category,
      severity,
      title,
      entry?.namespace,
      entry?.message,
      stableEvidenceKey(evidence),
    ]),
    category,
    severity,
    title,
    summary,
    confidence,
    autoFixable,
    suggestedActions,
    source: {
      timestamp: entry?.timestamp || null,
      namespace: entry?.namespace || null,
      level: entry?.level || null,
    },
    evidence,
  };
}

function mergeFindings(findings) {
  const byId = new Map();

  for (const finding of findings) {
    if (!finding) continue;

    const existing = byId.get(finding.id);
    if (!existing) {
      byId.set(finding.id, { ...finding, count: 1 });
      continue;
    }

    existing.count += 1;
    existing.confidence = Math.max(existing.confidence, finding.confidence || 0);
    existing.severity = severityMax(existing.severity, finding.severity);
    existing.suggestedActions = Array.from(
      new Set([
        ...(existing.suggestedActions || []),
        ...(finding.suggestedActions || []),
      ])
    );
  }

  return Array.from(byId.values());
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'warning': return 2;
    case 'info': return 1;
    default: return 0;
  }
}

function severityMax(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function isErrorish(entry) {
  return (
    entry?.level === 'error' ||
    entry?.level === 'warn' ||
    entry?.message?.toLowerCase?.().includes('error') ||
    entry?.message?.toLowerCase?.().includes('failed')
  );
}

function getSearchBlob(entry) {
  return safeLower([
    entry?.timestamp,
    entry?.level,
    entry?.namespace,
    entry?.message,
    stringifyMeta(entry?.meta),
  ].filter(Boolean).join(' '));
}

function hasAny(search, needles) {
  return needles.some((needle) => search.includes(needle));
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTORS
// ─────────────────────────────────────────────────────────────────────────────

function detectRateLimit(entry) {
  const search = getSearchBlob(entry);
  const status = pickNestedNumber(entry?.meta, ['status', 'statusCode', 'code']);

  if (
    status === 429 ||
    hasAny(search, [
      'rate limit',
      'rate-limited',
      'too many requests',
      'quota exceeded',
      '429',
      'rps limit',
    ])
  ) {
    const provider =
      entry?.meta?.provider ||
      entry?.meta?.model ||
      entry?.meta?.service ||
      entry?.namespace ||
      'unknown';

    return baseFinding({
      category: 'rate_limit',
      severity: 'warning',
      title: 'Rate limit encountered',
      summary: `A provider or service hit a rate limit (${provider}).`,
      entry,
      confidence: 0.95,
      autoFixable: true,
      suggestedActions: [
        'Switch to the next available fallback provider',
        'Throttle repeated requests for this route',
        'Reduce token usage for the current task',
      ],
      evidence: {
        provider,
        status,
        message: entry?.message,
        meta: entry?.meta,
      },
    });
  }

  return null;
}

function detectProviderDown(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'all_providers_down',
      'provider down',
      'marked down',
      'unavailable',
      'service unavailable',
      'health check failed',
      'down until',
    ])
  ) {
    return baseFinding({
      category: 'provider_down',
      severity: 'critical',
      title: 'AI provider outage detected',
      summary: 'One or more AI providers appear to be unavailable.',
      entry,
      confidence: 0.9,
      autoFixable: true,
      suggestedActions: [
        'Mark the provider offline in health state',
        'Switch to a fallback model',
        'Broadcast a warning to the terminal',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectBuildFailure(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'build failed',
      'buildfailure',
      'esbuild failed',
      'cannot find module',
      'module not found',
      'syntaxerror',
      'referenceerror',
      'typeerror',
      'npm err!',
      'rollup failed',
      'vite failed',
      'webpack failed',
    ])
  ) {
    return baseFinding({
      category: 'build_failure',
      severity: 'critical',
      title: 'Build failure detected',
      summary: 'A build or bundling step failed during execution.',
      entry,
      confidence: 0.92,
      autoFixable: false,
      suggestedActions: [
        'Inspect the failing file and stack trace',
        'Check the last dependency or import change',
        'Run the build locally with verbose output',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectMemoryPressure(entry) {
  const search = getSearchBlob(entry);
  const rssMb = pickNestedNumber(entry?.meta, [
    'rssMb',
    'rss_mb',
    'memoryMb',
    'memory_mb',
    'heapUsedMb',
  ]) || null;

  if (
    (rssMb !== null && rssMb >= DEFAULT_MEMORY_WARNING_RSS_MB) ||
    hasAny(search, [
      // Be specific — avoid bare 'rss' which matches too much.
      '"rss":',
      'rss_mb',
      'rss_bytes',
      'heap out of memory',
      'heapused',
      'heap total',
      'memory pressure',
      'out of memory',
      'memory leak',
    ])
  ) {
    const severity =
      rssMb !== null && rssMb >= DEFAULT_MEMORY_CRITICAL_RSS_MB
        ? 'critical'
        : 'warning';

    return baseFinding({
      category: 'memory_pressure',
      severity,
      title: 'Memory pressure detected',
      summary:
        rssMb !== null
          ? `Memory usage is high at approximately ${rssMb} MB RSS.`
          : 'Memory pressure or leak symptoms were observed.',
      entry,
      confidence: 0.88,
      autoFixable: true,
      suggestedActions: [
        'Trim caches and stale buffers',
        'Check for runaway log buffering',
        'Inspect long-lived intervals or listeners',
      ],
      evidence: {
        rssMb,
        message: entry?.message,
        meta: entry?.meta,
      },
    });
  }

  return null;
}

function detectSseFailure(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'sse failure',
      'eventsource failed',
      'heartbeat timeout',
      'heartbeat missed',
      'missed pong',
      'reconnect failed',
      'broadcast failed',
      'stream disconnected',
      'connection closed',
      'orphaned process',
      'sse disconnected',
    ])
  ) {
    return baseFinding({
      category: 'sse_failure',
      severity: 'warning',
      title: 'Realtime stream disruption',
      summary: 'The SSE or heartbeat pipeline appears degraded.',
      entry,
      confidence: 0.9,
      autoFixable: true,
      suggestedActions: [
        'Reconnect the stream',
        'Replay any missing events from broadcast_queue',
        'Check the heartbeat timer and retry path',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectDatabaseIssue(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'supabase',
      'postgres',
      'database error',
      'relation does not exist',
      'foreign key',
      'unique violation',
      'timed out',
      'connection refused',
      'deadlock',
      'serialization failure',
    ])
  ) {
    return baseFinding({
      category: 'database_issue',
      severity: 'warning',
      title: 'Database issue detected',
      summary: 'A database call failed or returned an unhealthy signal.',
      entry,
      confidence: 0.86,
      autoFixable: false,
      suggestedActions: [
        'Check the failing table name and payload shape',
        'Retry if it is a transient timeout',
        'Verify schema alignment before writing again',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectGitIssue(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'non-fast-forward',
      'rejected',
      'merge conflict',
      'permission denied',
      'protected branch',
      'failed to push',
      'could not resolve host',
      'remote rejected',
    ])
  ) {
    return baseFinding({
      category: 'git_issue',
      severity: 'warning',
      title: 'Git operation failed',
      summary: 'A git-related command or API operation failed.',
      entry,
      confidence: 0.84,
      autoFixable: false,
      suggestedActions: [
        'Check branch protections and upstream state',
        'Rebase or merge cleanly before retrying',
        'Verify the auth token and remote target',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectFileSystemIssue(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'enoent',
      'eacces',
      'eperm',
      'ebusy',
      'directory not empty',
      'file exists',
      'path too long',
      'is a directory',
      'not a directory',
    ])
  ) {
    return baseFinding({
      category: 'filesystem_issue',
      severity: 'warning',
      title: 'Filesystem issue detected',
      summary: 'A file read/write or path resolution operation failed.',
      entry,
      confidence: 0.87,
      autoFixable: false,
      suggestedActions: [
        'Verify the file path and directory exists',
        'Check permissions for the target location',
        'Confirm the build output path is correct',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectAuthIssue(entry) {
  const search = getSearchBlob(entry);

  if (
    hasAny(search, [
      'unauthorized',
      'forbidden',
      'invalid token',
      'jwt expired',
      'token expired',
      'authentication failed',
      'missing auth',
    ])
  ) {
    return baseFinding({
      category: 'auth_issue',
      severity: 'warning',
      title: 'Authentication issue detected',
      summary: 'A request failed due to auth or token validation problems.',
      entry,
      confidence: 0.88,
      autoFixable: false,
      suggestedActions: [
        'Verify the JWT or PAT is present in env vars',
        'Check token expiration and refresh flow',
        'Confirm the request is using the expected identity',
      ],
      evidence: { message: entry?.message, meta: entry?.meta },
    });
  }

  return null;
}

function detectErrorBurst(entries) {
  const recent = entries.slice(-DEFAULT_ERROR_BURST_WINDOW);
  const errorCount = recent.filter(isErrorish).length;

  if (errorCount >= DEFAULT_ERROR_BURST_THRESHOLD) {
    return baseFinding({
      category: 'error_burst',
      severity: 'critical',
      title: 'Error burst detected',
      summary: `Detected ${errorCount} error-like entries in the last ${recent.length} logs.`,
      entry: recent[recent.length - 1] || null,
      confidence: 0.93,
      autoFixable: false,
      suggestedActions: [
        'Inspect the last few errors in the terminal',
        'Check whether a recent deploy introduced regressions',
        'Pause non-essential automation until stable',
      ],
      evidence: { errorCount, windowSize: recent.length },
    });
  }

  return null;
}

const DETECTORS = [
  detectRateLimit,
  detectProviderDown,
  detectBuildFailure,
  detectMemoryPressure,
  detectSseFailure,
  detectDatabaseIssue,
  detectGitIssue,
  detectFileSystemIssue,
  detectAuthIssue,
];

function detectEntry(entry) {
  const findings = [];

  for (const detector of DETECTORS) {
    try {
      const finding = detector(entry);
      if (finding) findings.push(finding);
    } catch {
      // Detector failures must never break diagnosis.
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

function buildSnapshot(entries, findings) {
  const counts = {
    total: entries.length,
    errors: entries.filter((e) => e?.level === 'error').length,
    warnings: entries.filter((e) => e?.level === 'warn').length,
    info: entries.filter((e) => e?.level === 'info').length,
    debug: entries.filter((e) => e?.level === 'debug').length,
  };

  const categories = {};
  for (const finding of findings) {
    categories[finding.category] = (categories[finding.category] || 0) + 1;
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const warning = findings.filter((f) => f.severity === 'warning');

  return {
    ok: findings.length === 0,
    counts,
    categories,
    criticalCount: critical.length,
    warningCount: warning.length,
    highestSeverity:
      critical.length > 0 ? 'critical' : warning.length > 0 ? 'warning' : 'info',
  };
}

function summarizeFindings(findings) {
  if (!findings.length) {
    return {
      summary: 'No issues detected in the sampled logs.',
      recommendedActions: [],
    };
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const warning = findings.filter((f) => f.severity === 'warning');

  if (critical.length) {
    return {
      summary: `${critical.length} critical issue(s) need attention.`,
      recommendedActions: critical.flatMap((f) => f.suggestedActions || []).slice(0, 5),
    };
  }

  return {
    summary: `${warning.length} warning(s) detected.`,
    recommendedActions: warning.flatMap((f) => f.suggestedActions || []).slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ANALYSIS API
// ─────────────────────────────────────────────────────────────────────────────

function analyzeEntries(entries = []) {
  const lines = Array.isArray(entries) ? entries : [];
  const findings = [];

  for (const entry of lines) {
    const result = detectEntry(entry);
    if (result.length) findings.push(...result);
  }

  const deduped = mergeFindings(findings);
  const burstFinding = detectErrorBurst(lines);
  if (burstFinding) deduped.push(burstFinding);

  const sorted = deduped.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  );

  return {
    ...buildSnapshot(lines, sorted),
    ...summarizeFindings(sorted),
    findings: sorted,
  };
}

function scanRecentLogs(options = {}) {
  const {
    lines = DEFAULT_SCAN_LINES,
    level = null,
    namespace = null,
    raw = false,
  } = options;

  const result = readLogs({ lines, level, namespace, raw });
  const entries = result?.entries || [];

  return {
    path: result?.path || null,
    readCount: result?.count || entries.length,
    diagnosis: analyzeEntries(entries),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE MONITOR
// ─────────────────────────────────────────────────────────────────────────────

function createLiveMonitor(options = {}) {
  const {
    onFinding = null,
    onAnalysis = null,
    onEntry = null,
    dedupeMs = DEFAULT_DEDUPE_MS,
  } = options;

  if (onFinding != null && typeof onFinding !== 'function') {
    throw new TypeError('onFinding must be a function');
  }
  if (onAnalysis != null && typeof onAnalysis !== 'function') {
    throw new TypeError('onAnalysis must be a function');
  }
  if (onEntry != null && typeof onEntry !== 'function') {
    throw new TypeError('onEntry must be a function');
  }

  const seen = new Map();

  function shouldEmit(finding) {
    const now = Date.now();
    const key = finding.id;
    const lastSeen = seen.get(key);

    if (lastSeen && now - lastSeen < dedupeMs) return false;

    seen.set(key, now);
    return true;
  }

  const unsubscribeFn = subscribe((entry) => {
    try {
      if (onEntry) onEntry(entry);

      const findings = detectEntry(entry).filter(shouldEmit);
      if (!findings.length) return;

      if (onAnalysis) onAnalysis(analyzeEntries([entry]));

      for (const finding of findings) {
        if (onFinding) onFinding(finding);
      }
    } catch {
      // Live monitor must never crash the process.
    }
  });

  return {
    stop() {
      if (typeof unsubscribeFn === 'function') unsubscribeFn();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE ADAPTER
// ─────────────────────────────────────────────────────────────────────────────

function toBroadcastCard(finding) {
  if (!finding) return null;

  return {
    type:
      finding.severity === 'critical'
        ? SSE.EVENT_TYPES.WARNING
        : finding.severity === 'warning'
          ? SSE.EVENT_TYPES.FINDING
          : SSE.EVENT_TYPES.PULSE,
    content: {
      event: 'self_diagnosis',
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      summary: finding.summary,
      autoFixable: finding.autoFixable,
      suggestedActions: finding.suggestedActions,
      evidence: finding.evidence,
      source: finding.source,
      count: finding.count || 1,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  analyzeEntries,
  scanRecentLogs,
  createLiveMonitor,
  toBroadcastCard,
  detectEntry,
  summarizeFindings,
  severityRank,
};
