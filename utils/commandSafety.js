'use strict';

// commandSafety.js
// Validates structured commands before execFile() call.
// No shell parsing needed — execFile() bypasses shell entirely.
// Allowlist-based: if not explicitly allowed, it is blocked.

const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONTAINER ROOT
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER_ROOT = '/app';

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_EXECUTABLES = new Set([
  // Node / npm
  'node', 'npm', 'npx',

  // Git
  'git',

  // Filesystem read-only
  'ls', 'cat', 'head', 'tail',
  'grep', 'find', 'du', 'df',
  'pwd', 'wc', 'stat',

  // System info
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

// ─────────────────────────────────────────────────────────────────────────────
// HARD BLOCKED EXECUTABLES
// ─────────────────────────────────────────────────────────────────────────────

const HARD_BLOCKED_EXECUTABLES = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash',
  'python', 'python3', 'ruby', 'perl',
  'nc', 'ncat', 'netcat', 'socat',
  'dd',
  'mkfs', 'fdisk', 'parted',
  'curl', 'wget',
  'ssh', 'scp', 'sftp', 'rsync',
  'sudo', 'su', 'doas',
  'crontab', 'at', 'batch',
  'systemctl', 'service', 'launchctl',
  'docker', 'podman',
  'useradd', 'userdel', 'passwd',
  'iptables', 'ufw', 'firewall-cmd',
  'mount', 'umount',
  'chroot',
  'strace', 'ltrace', 'gdb',
  'nmap', 'tcpdump', 'wireshark',
]);

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY EXECUTABLES
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_EXECUTABLES = new Set([
  'ls', 'cat', 'head', 'tail', 'grep',
  'find', 'du', 'df', 'pwd', 'wc', 'stat',
  'whoami', 'id', 'env', 'printenv',
  'ps', 'uptime', 'date', 'uname',
  'hostname', 'free',
]);

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY GIT SUBCOMMANDS
// ─────────────────────────────────────────────────────────────────────────────

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show',
  'branch', 'tag', 'remote', 'fetch',
  'ls-files', 'ls-tree', 'describe',
]);

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PATHS
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PATHS = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/var', '/boot', '/root', '/sys', '/proc', '/dev',
  '/run', '/tmp', '/opt', '/srv',
];

// ─────────────────────────────────────────────────────────────────────────────
// SHELL METACHARACTERS
// FIX: removed * and {} — legitimate in grep/find args
// Only block true injection characters
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_METACHAR_RE = /[|;&`$<>!\\]/;

// ─────────────────────────────────────────────────────────────────────────────
// NEEDS CONFIRMATION RULES
// ─────────────────────────────────────────────────────────────────────────────

const NEEDS_CONFIRM_RULES = {
  rm:  () => true,
  mv:  () => true,
  cp:  () => true,
  git: (args) => {
    const sub = args[0];
    return [
      'push', 'reset', 'clean',
      'rebase', 'merge', 'cherry-pick',
      'stash', 'checkout',
    ].includes(sub);
  },
  npm: (args) => {
    const sub = args[0];
    return [
      'install', 'uninstall', 'update',
      'publish', 'unpublish', 'deprecate',
      'ci',
    ].includes(sub);
  },
  kill: () => true,

  // FIX: only check flag args, not filenames which may contain 'x'
  tar: (args) => {
    const flags = args.filter((a) => a.startsWith('-'));
    return flags.some((a) => a.includes('x'));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HARD BLOCKED ARG COMBINATIONS
// ─────────────────────────────────────────────────────────────────────────────

const HARD_BLOCKED_COMBINATIONS = {
  rm: (args) => {
    const hasRecursive = args.some((a) =>
      a === '-rf' || a === '-fr' || a === '-r' ||
      a === '--recursive' ||
      (a.startsWith('-') && !a.startsWith('--') && a.includes('r'))
    );

    const hasDangerousTarget = args.some((a) =>
      a === '/' ||
      a === '/*' ||
      a === '/.' ||
      a === '~' ||
      a === '$HOME' ||
      a === '.' ||
      a === '..' ||
      a === '*' ||
      SYSTEM_PATHS.some((sp) => a === sp || a.startsWith(sp + '/'))
    );

    // FIX: simplified — recursive + dangerous target is enough to block.
    // Force flag is irrelevant — rm -r / is dangerous with or without -f.
    return hasRecursive && hasDangerousTarget;
  },

  git: (args) => {
    const sub = args[0];

    if (sub === 'push') {
      return args.some((a) =>
        a === '--force' ||
        a === '-f' ||
        a === '--force-with-lease'
      );
    }

    if (sub === 'reset') {
      return args.includes('--hard');
    }

    if (sub === 'clean') {
      const flags = args.filter((a) => a.startsWith('-'));
      return flags.some((a) => a.includes('f'));
    }

    return false;
  },

  npm: (args) => {
    return ['publish', 'unpublish', 'deprecate'].includes(args[0]);
  },

  kill: (args) => {
    const hasSIGKILL = args.some((a) => a === '-9' || a === '-SIGKILL');
    const targetsInit = args.includes('1');
    return hasSIGKILL && targetsInit;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function fail(reason) {
  return { allowed: false, reason, isReadOnly: false };
}

function validateCwd(cwd) {
  if (cwd.includes('..')) {
    return {
      allowed: false,
      reason: `Path traversal detected in cwd: '${cwd}'`,
    };
  }

  const resolved = path.resolve(cwd);

  if (!resolved.startsWith(CONTAINER_ROOT)) {
    return {
      allowed: false,
      reason: `cwd '${cwd}' resolves outside container root (${CONTAINER_ROOT})`,
    };
  }

  return { allowed: true, reason: null };
}

function determineReadOnly(exec, args) {
  if (READ_ONLY_EXECUTABLES.has(exec)) return true;
  if (exec === 'git' && GIT_READ_ONLY.has(args[0])) return true;
  if (exec === 'npm' && ['list', 'outdated', 'audit'].includes(args[0])) return true;
  if (exec === 'node' && args.some((a) => a === '--version' || a === '-v')) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a structured command before execFile() call.
 *
 * @param {string}   executable      - Binary name e.g. 'npm'
 * @param {string[]} args            - Argument array e.g. ['run', 'build']
 * @param {string}   cwd             - Working directory (must be within /app)
 * @param {boolean}  hasConfirmation - Whether user confirmed
 * @returns {{ allowed: boolean, reason: string|null, isReadOnly: boolean, needsConfirmation?: boolean }}
 */
function validateStructured(
  executable,
  args = [],
  cwd = CONTAINER_ROOT,
  hasConfirmation = false
) {
  // ── Type checks ───────────────────────────────────────────────────────────
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

  // ── Hard blocked executables ──────────────────────────────────────────────
  if (HARD_BLOCKED_EXECUTABLES.has(exec)) {
    return fail(`Executable '${exec}' is permanently blocked`);
  }

  // ── Allowlist check ───────────────────────────────────────────────────────
  if (!ALLOWED_EXECUTABLES.has(exec)) {
    return fail(`Executable '${exec}' is not in the allowed list`);
  }

  // ── CWD validation ────────────────────────────────────────────────────────
  const cwdResult = validateCwd(cwd);
  if (!cwdResult.allowed) return fail(cwdResult.reason);

  // ── Arg validation ────────────────────────────────────────────────────────
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return fail(`All args must be strings — received: ${typeof arg}`);
    }

    if (SHELL_METACHAR_RE.test(arg)) {
      return fail(
        `Arg contains shell metacharacters: '${arg.slice(0, 50)}'` +
        ` — use structured input only`
      );
    }
  }

  // ── Hard blocked combinations ─────────────────────────────────────────────
  const blockedCheck = HARD_BLOCKED_COMBINATIONS[exec];
  if (blockedCheck && blockedCheck(args)) {
    return fail(
      `Blocked argument combination for '${exec}': ` +
      `${args.slice(0, 5).join(' ')}`
    );
  }

  // ── System path protection (mutating commands only) ───────────────────────
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

  // ── isReadOnly determination ──────────────────────────────────────────────
  const isReadOnly = determineReadOnly(exec, args);

  // ── Confirmation gate ─────────────────────────────────────────────────────
  if (!isReadOnly) {
    const needsConfirm = NEEDS_CONFIRM_RULES[exec];
    if (needsConfirm && needsConfirm(args) && !hasConfirmation) {
      return {
        allowed:           false,
        reason:            `'${exec} ${args.slice(0, 3).join(' ')}' requires explicit confirmation`,
        isReadOnly:        false,
        needsConfirmation: true,
      };
    }
  }

  return { allowed: true, reason: null, isReadOnly };
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes known secret shapes from command output.
 * Known-prefix matching only — never greedy length-based.
 *
 * @param {string} output
 * @returns {string}
 */
function sanitizeOutput(output) {
  if (!output || typeof output !== 'string') return '';

  return output
    // JWTs (three base64url segments — also catches Supabase keys)
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
    // URL credentials
    .replace(
      /(https?:\/\/)[^:@\s]+:[^@\s]+@/gi,
      '$1[REDACTED]:[REDACTED]@'
    )
    // Authorization headers
    .replace(
      /Authorization:\s*[A-Za-z]+\s+[a-zA-Z0-9_.\-]+/gi,
      'Authorization: [REDACTED]'
    );
    // NOTE: Supabase service role keys are JWTs — caught above already ✅
}

// ─────────────────────────────────────────────────────────────────────────────
// EXEC OPTIONS BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds safe options object for child_process.execFile().
 *
 * @param {string} cwd - Validated working directory
 * @returns {object}
 */
function buildExecOptions(cwd = CONTAINER_ROOT) {
  return {
    cwd,
    timeout:   30_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH:     '/usr/local/bin:/usr/bin:/bin:/app/node_modules/.bin',
      NODE_ENV: process.env.NODE_ENV || 'production',
      HOME:     '/app',
    },
    shell: false, // KEY: no shell = no injection possible
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

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
