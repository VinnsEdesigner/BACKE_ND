'use strict';

// commandSafety.js
// Validates structured commands before execFile() call.
// No shell parsing needed — execFile() bypasses shell entirely.
// Allowlist-based: if not explicitly allowed, it's blocked.

const path = require('path');

// ── CONTAINER ROOT ────────────────────────────────────────────────────────────
// All operations must stay within /app (HF Spaces working dir)

const CONTAINER_ROOT = '/app';

// ── ALLOWLIST ─────────────────────────────────────────────────────────────────
// ONLY these executables can be called. Everything else is blocked by default.
// Allowlist > blocklist. Unknown = blocked. Always.

const ALLOWED_EXECUTABLES = new Set([
  // Node / npm
  'node', 'npm', 'npx',

  // Git (read + write — args validated separately)
  'git',

  // Filesystem read-only
  'ls', 'cat', 'head', 'tail',
  'grep', 'find', 'du', 'df',
  'pwd', 'wc', 'stat',

  // System info (read-only)
  'whoami', 'id', 'env', 'printenv',
  'ps', 'uptime', 'date', 'uname',
  'hostname', 'free',

  // Build tools
  'esbuild',

  // File operations (args validated strictly)
  'rm', 'mv', 'cp', 'mkdir', 'touch',

  // Process management (args validated strictly)
  'kill',

  // Archive
  'tar', 'unzip', 'zip',
]);

// ── HARD BLOCKED EXECUTABLES ──────────────────────────────────────────────────
// These are blocked regardless of args. Ever. No exceptions.

const HARD_BLOCKED_EXECUTABLES = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', // shell spawning
  'python', 'python3', 'ruby', 'perl',  // interpreter spawning
  'nc', 'ncat', 'netcat', 'socat',      // network exposure
  'dd',                                  // raw disk writes
  'mkfs', 'fdisk', 'parted',            // disk formatting
  'curl', 'wget',                        // network fetch (use searchRouter)
  'ssh', 'scp', 'sftp', 'rsync',        // remote access
  'sudo', 'su', 'doas',                 // privilege escalation
  'crontab', 'at', 'batch',             // scheduled execution
  'systemctl', 'service', 'launchctl',  // service control
  'docker', 'podman',                   // container ops
  'useradd', 'userdel', 'passwd',       // user management
  'iptables', 'ufw', 'firewall-cmd',    // firewall changes
  'mount', 'umount',                    // filesystem mounting
  'chroot',                             // root changes
  'strace', 'ltrace', 'gdb',           // system tracing
  'nmap', 'tcpdump', 'wireshark',       // network scanning
]);

// ── READ-ONLY EXECUTABLES ─────────────────────────────────────────────────────
// These never mutate state. Skip confirmation gate entirely.

const READ_ONLY_EXECUTABLES = new Set([
  'ls', 'cat', 'head', 'tail', 'grep',
  'find', 'du', 'df', 'pwd', 'wc', 'stat',
  'whoami', 'id', 'env', 'printenv',
  'ps', 'uptime', 'date', 'uname',
  'hostname', 'free',
]);

// ── READ-ONLY GIT SUBCOMMANDS ─────────────────────────────────────────────────

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show',
  'branch', 'tag', 'remote', 'fetch',
  'ls-files', 'ls-tree', 'describe',
]);

// ── NEEDS CONFIRMATION RULES ──────────────────────────────────────────────────
// Per-executable argument rules that require confirmation.

const NEEDS_CONFIRM_RULES = {
  rm:  () => true,                              // any rm needs confirm
  mv:  () => true,                              // any mv needs confirm
  cp:  () => true,                              // any cp needs confirm
  git: (args) => {
    const sub = args[0];
    return ['push', 'reset', 'clean',
            'rebase', 'merge', 'cherry-pick',
            'stash', 'checkout'].includes(sub);
  },
  npm: (args) => {
    const sub = args[0];
    return ['install', 'uninstall', 'update',
            'publish', 'unpublish', 'deprecate',
            'ci'].includes(sub);
  },
  kill: () => true,
  tar:  (args) => args.some(a => a.includes('x')), // extract needs confirm
};

// ── HARD BLOCKED ARG COMBINATIONS ────────────────────────────────────────────
// Per-executable argument combinations that are NEVER allowed.

const HARD_BLOCKED_COMBINATIONS = {
  rm: (args) => {
    const hasRecursive = args.some(a =>
      a === '-rf' || a === '-fr' || a === '-r' ||
      a === '--recursive' || (a.startsWith('-') && a.includes('r'))
    );
    const hasForce = args.some(a =>
      a === '-f' || a === '--force' ||
      (a.startsWith('-') && a.includes('f'))
    );
    const hasDangerousTarget = args.some(a =>
      a === '/' || a === '/*' || a === '/.' ||
      a === '~' || a === '$HOME' ||
      a === '.' || a === '..' || a === '*' ||
      a.startsWith('/etc') || a.startsWith('/usr') ||
      a.startsWith('/bin') || a.startsWith('/lib') ||
      a.startsWith('/var') || a.startsWith('/boot') ||
      a.startsWith('/root') || a.startsWith('/sys') ||
      a.startsWith('/proc')
    );
    return (hasRecursive && hasForce && hasDangerousTarget) ||
           (hasRecursive && hasDangerousTarget);
  },

  git: (args) => {
    const sub = args[0];
    if (sub === 'push') {
      return args.some(a =>
        a === '--force' || a === '-f' ||
        a === '--force-with-lease'
      );
    }
    if (sub === 'reset') {
      return args.includes('--hard');
    }
    if (sub === 'clean') {
      return args.some(a => a.includes('f'));
    }
    return false;
  },

  npm: (args) => {
    return ['publish', 'unpublish', 'deprecate'].includes(args[0]);
  },

  kill: (args) => {
    // kill -9 1 (init process) is never allowed
    const hasSIGKILL = args.some(a => a === '-9' || a === '-SIGKILL');
    const targetsInit = args.includes('1');
    return hasSIGKILL && targetsInit;
  },
};

// ── SYSTEM PATHS ──────────────────────────────────────────────────────────────
// Arguments pointing to these paths are blocked for mutating commands.

const SYSTEM_PATHS = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/var', '/boot', '/root', '/sys', '/proc', '/dev',
  '/run', '/tmp', '/opt', '/srv',
];

// ── SHELL METACHARACTERS ──────────────────────────────────────────────────────
// These in args mean something is wrong — args should be plain values.

const SHELL_METACHAR_RE = /[|;&`$<>!?*{}[\]\\]/;

// ── CORE VALIDATOR ────────────────────────────────────────────────────────────

/**
 * Validates a structured command before execFile() call.
 *
 * @param {string}   executable      - Binary name (e.g. 'npm')
 * @param {string[]} args            - Argument array (e.g. ['run', 'build'])
 * @param {string}   cwd             - Working directory (must be within /app)
 * @param {boolean}  hasConfirmation - Whether user confirmed
 * @returns {{ allowed: boolean, reason: string|null, isReadOnly: boolean }}
 */
function validateStructured(executable, args = [], cwd = CONTAINER_ROOT, hasConfirmation = false) {
  // ── Input type checks ────────────────────────────────────────────────────
  if (!executable || typeof executable !== 'string') {
    return fail('executable must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    return fail('args must be an array');
  }
  if (typeof cwd !== 'string') {
    return fail('cwd must be a string');
  }

  const exec = executable.trim().toLowerCase();

  // ── Hard blocked executables ─────────────────────────────────────────────
  if (HARD_BLOCKED_EXECUTABLES.has(exec)) {
    return fail(`Executable '${exec}' is permanently blocked`);
  }

  // ── Allowlist check ──────────────────────────────────────────────────────
  if (!ALLOWED_EXECUTABLES.has(exec)) {
    return fail(`Executable '${exec}' is not in the allowed list`);
  }

  // ── CWD validation ───────────────────────────────────────────────────────
  const cwdResult = validateCwd(cwd);
  if (!cwdResult.allowed) return fail(cwdResult.reason);

  // ── Arg validation ───────────────────────────────────────────────────────
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return fail(`All args must be strings — received: ${typeof arg}`);
    }
    // Block shell metacharacters in args
    if (SHELL_METACHAR_RE.test(arg)) {
      return fail(
        `Arg contains shell metacharacters: '${arg.slice(0, 50)}'` +
        ` — use structured input only`
      );
    }
  }

  // ── Hard blocked combinations ────────────────────────────────────────────
  const blockedCheck = HARD_BLOCKED_COMBINATIONS[exec];
  if (blockedCheck && blockedCheck(args)) {
    return fail(
      `Blocked argument combination for '${exec}': ` +
      `${args.slice(0, 5).join(' ')}`
    );
  }

  // ── System path protection (for mutating commands) ───────────────────────
  if (!READ_ONLY_EXECUTABLES.has(exec)) {
    for (const arg of args) {
      for (const sysPath of SYSTEM_PATHS) {
        if (arg === sysPath || arg.startsWith(sysPath + '/')) {
          return fail(
            `System path '${arg}' is protected — ` +
            `operation on system directories not allowed`
          );
        }
      }
    }
  }

  // ── isReadOnly determination ─────────────────────────────────────────────
  const isReadOnly = determineReadOnly(exec, args);

  // ── Confirmation gate ────────────────────────────────────────────────────
  if (!isReadOnly) {
    const needsConfirm = NEEDS_CONFIRM_RULES[exec];
    if (needsConfirm && needsConfirm(args) && !hasConfirmation) {
      return {
        allowed:    false,
        reason:     `'${exec} ${args.slice(0,3).join(' ')}' requires explicit confirmation`,
        isReadOnly: false,
        needsConfirmation: true,  // signal to confirmationGate.js
      };
    }
  }

  return { allowed: true, reason: null, isReadOnly };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function fail(reason) {
  return { allowed: false, reason, isReadOnly: false };
}

function validateCwd(cwd) {
  // Resolve to absolute, block traversal
  const resolved = path.resolve(cwd);

  // Must stay within container root
  if (!resolved.startsWith(CONTAINER_ROOT)) {
    return {
      allowed: false,
      reason:  `cwd '${cwd}' resolves outside container root (${CONTAINER_ROOT})`,
    };
  }

  // Block path traversal attempts
  if (cwd.includes('..')) {
    return {
      allowed: false,
      reason:  `Path traversal detected in cwd: '${cwd}'`,
    };
  }

  return { allowed: true, reason: null };
}

function determineReadOnly(exec, args) {
  if (READ_ONLY_EXECUTABLES.has(exec)) return true;
  if (exec === 'git' && GIT_READ_ONLY.has(args[0])) return true;
  if (exec === 'npm' && ['list', 'outdated', 'audit'].includes(args[0])) return true;
  if (exec === 'node' && args.some(a => a === '--version' || a === '-v')) return true;
  return false;
}

// ── OUTPUT SANITIZER ──────────────────────────────────────────────────────────

/**
 * Removes known secret shapes from command output.
 * Uses known-prefix matching ONLY — never greedy length-based.
 *
 * @param {string} output - Raw command output string
 * @returns {string} Sanitized output safe for logging
 */
function sanitizeOutput(output) {
  if (!output || typeof output !== 'string') return '';

  return output
    // JWT tokens (three base64url segments)
    .replace(
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      '[JWT REDACTED]'
    )
    // Bearer tokens
    .replace(
      /Bearer\s+[a-zA-Z0-9_.\-]+/gi,
      'Bearer [REDACTED]'
    )
    // Known API key prefixes
    .replace(
      /\b(sk-|gsk_|AIza|hf_|xoxb-|xoxp-|AKIA|rk_live_|rk_test_)[a-zA-Z0-9_\-]{8,}/g,
      '[API KEY REDACTED]'
    )
    // PEM private key blocks
    .replace(
      /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
      '[PRIVATE KEY REDACTED]'
    )
    // URL credentials (https://user:pass@host)
    .replace(
      /(https?:\/\/)[^:@\s]+:[^@\s]+@/gi,
      '$1[REDACTED]:[REDACTED]@'
    )
    // Authorization headers
    .replace(
      /Authorization:\s*[A-Za-z]+\s+[a-zA-Z0-9_.\-]+/gi,
      'Authorization: [REDACTED]'
    )
    // Supabase service role keys (long base64 strings after known patterns)
    .replace(
      /service_role[^\s]*\s+([a-zA-Z0-9_.\-]{20,})/gi,
      'service_role [REDACTED]'
    );
}

// ── EXEC OPTIONS BUILDER ──────────────────────────────────────────────────────

/**
 * Builds safe options object for child_process.execFile().
 *
 * @param {string} cwd - Validated working directory
 * @returns {object} Options for execFile()
 */
function buildExecOptions(cwd = CONTAINER_ROOT) {
  return {
    cwd,
    timeout:   30_000,        // 30s max execution time
    maxBuffer: 1024 * 1024,   // 1MB output cap
    env: {
      // Minimal safe environment — no secrets passed through
      PATH:     '/usr/local/bin:/usr/bin:/bin:/app/node_modules/.bin',
      NODE_ENV: process.env.NODE_ENV || 'production',
      HOME:     '/app',
    },
    // Never spawn a shell — this is the key safety guarantee
    shell: false,
  };
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  validateStructured,
  sanitizeOutput,
  buildExecOptions,
  determineReadOnly,
  ALLOWED_EXECUTABLES,
  HARD_BLOCKED_EXECUTABLES,
  READ_ONLY_EXECUTABLES,
  CONTAINER_ROOT,
};
