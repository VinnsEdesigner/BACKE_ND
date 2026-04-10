/**
 * @file tools.js
 * @location /backend/lib/tools.js
 *
 * @purpose
 * Defines all available agent tools in OpenAI-compatible schema format.
 * Maps canonical intents to tool sets for conditional injection.
 * Provides read-only vs full tool separation for bookmarklet vs dashboard contexts.
 *
 * @exports
 *   schema(intent)              → tool schema array for an intent
 *   schemaForContext(intent, context) → context-aware tool schema (read-only vs full)
 *   allSchema()                 → all tools (force mode)
 *   readOnlySchema()            → read-only tools only (bookmarklet safe)
 *   isValid(name)               → check if tool name exists
 *   isReadOnly(name)            → check if tool is read-only
 *   namesForIntent(intent)      → tool names for an intent
 *   namesForContext(intent, context) → context-aware tool names
 *   TOOL_DEFINITIONS            → raw tool schemas
 *   INTENT_TOOLS                → intent → tool names map
 *   READ_ONLY_TOOLS             → set of read-only tool names
 *
 * @imports
 *   none (standalone schema definitions)
 *
 * @tables
 *   none
 *
 * @sse-events
 *   none
 *
 * @env-vars
 *   none
 *
 * @dependency-level 0
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// OpenAI-compatible function tool schemas.
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = {

  // ── GitHub file operations ─────────────────────────────────────────────────

  read_file: {
    type: 'function',
    function: {
      name:        'read_file',
      description: 'Read the contents of a file from a GitHub repository.',
      parameters:  {
        type:       'object',
        properties: {
          repo:   { type: 'string', description: 'Repository name (e.g. backend)' },
          path:   { type: 'string', description: 'File path (e.g. api/agent.js)' },
          branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
        },
        required: ['repo', 'path'],
      },
    },
  },

  write_file: {
    type: 'function',
    function: {
      name:        'write_file',
      description: 'Create or update a file in a GitHub repository. Always pushes to ai-sandbox branch first.',
      parameters:  {
        type:       'object',
        properties: {
          repo:    { type: 'string', description: 'Repository name' },
          path:    { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content to write' },
          message: { type: 'string', description: 'Commit message' },
          branch:  { type: 'string', description: 'Target branch (default: main)', default: 'main' },
        },
        required: ['repo', 'path', 'content', 'message'],
      },
    },
  },

  delete_file: {
    type: 'function',
    function: {
      name:        'delete_file',
      description: 'Delete a file from a GitHub repository. Always backs up to ai-sandbox first.',
      parameters:  {
        type:       'object',
        properties: {
          repo:    { type: 'string', description: 'Repository name' },
          path:    { type: 'string', description: 'File path to delete' },
          message: { type: 'string', description: 'Commit message' },
          branch:  { type: 'string', description: 'Target branch (default: main)', default: 'main' },
        },
        required: ['repo', 'path', 'message'],
      },
    },
  },

  list_files: {
    type: 'function',
    function: {
      name:        'list_files',
      description: 'List files and directories in a GitHub repository path.',
      parameters:  {
        type:       'object',
        properties: {
          repo:   { type: 'string', description: 'Repository name' },
          path:   { type: 'string', description: 'Directory path (default: root)', default: '' },
          branch: { type: 'string', description: 'Branch name (default: main)', default: 'main' },
        },
        required: ['repo'],
      },
    },
  },

  // ── Git operations ─────────────────────────────────────────────────────────

  create_branch: {
    type: 'function',
    function: {
      name:        'create_branch',
      description: 'Create a new branch in a GitHub repository.',
      parameters:  {
        type:       'object',
        properties: {
          repo:        { type: 'string', description: 'Repository name' },
          branch_name: { type: 'string', description: 'New branch name' },
          from_branch: { type: 'string', description: 'Source branch (default: main)', default: 'main' },
        },
        required: ['repo', 'branch_name'],
      },
    },
  },

  create_pr: {
    type: 'function',
    function: {
      name:        'create_pr',
      description: 'Open a pull request in a GitHub repository.',
      parameters:  {
        type:       'object',
        properties: {
          repo:  { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'PR title' },
          body:  { type: 'string', description: 'PR description' },
          head:  { type: 'string', description: 'Source branch' },
          base:  { type: 'string', description: 'Target branch (default: main)', default: 'main' },
        },
        required: ['repo', 'title', 'head'],
      },
    },
  },

  merge_pr: {
    type: 'function',
    function: {
      name:        'merge_pr',
      description: 'Merge an open pull request.',
      parameters:  {
        type:       'object',
        properties: {
          repo:          { type: 'string', description: 'Repository name' },
          pull_number:   { type: 'number', description: 'PR number to merge' },
          merge_message: { type: 'string', description: 'Optional merge commit message' },
        },
        required: ['repo', 'pull_number'],
      },
    },
  },

  // ── Web search ─────────────────────────────────────────────────────────────

  web_search: {
    type: 'function',
    function: {
      name:        'web_search',
      description: 'Search the web for current information, documentation, or news.',
      parameters:  {
        type:       'object',
        properties: {
          query:       { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results to return (default: 5)', default: 5 },
        },
        required: ['query'],
      },
    },
  },

  read_url: {
    type: 'function',
    function: {
      name:        'read_url',
      description: 'Fetch and read the full content of a URL.',
      parameters:  {
        type:       'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },

  // ── Memory ─────────────────────────────────────────────────────────────────

  remember: {
    type: 'function',
    function: {
      name:        'remember',
      description: 'Save an important fact or preference to long-term memory.',
      parameters:  {
        type:       'object',
        properties: {
          key:   { type: 'string', description: 'Memory key (e.g. preferred_framework)' },
          value: { type: 'string', description: 'Value to remember' },
        },
        required: ['key', 'value'],
      },
    },
  },

  // ── System / Server ────────────────────────────────────────────────────────

  run_command: {
    type: 'function',
    function: {
      name:        'run_command',
      description: 'Execute a shell command on the HF Spaces server. Only allowed executables pass validation.',
      parameters:  {
        type:       'object',
        properties: {
          executable: { type: 'string', description: 'Binary name (e.g. npm, git, ls)' },
          args:       { type: 'array', items: { type: 'string' }, description: 'Argument array' },
          cwd:        { type: 'string', description: 'Working directory (default: /app)', default: '/app' },
        },
        required: ['executable'],
      },
    },
  },

  read_logs: {
    type: 'function',
    function: {
      name:        'read_logs',
      description: 'Read recent server logs for debugging and self-diagnosis.',
      parameters:  {
        type:       'object',
        properties: {
          lines:     { type: 'number', description: 'Number of recent lines to read (default: 100)', default: 100 },
          level:     { type: 'string', description: 'Filter by log level (debug, info, warn, error)', default: null },
          namespace: { type: 'string', description: 'Filter by namespace', default: null },
        },
        required: [],
      },
    },
  },

  check_file_exists: {
    type: 'function',
    function: {
      name:        'check_file_exists',
      description: 'Check if a file or directory exists on the server filesystem.',
      parameters:  {
        type:       'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to check' },
        },
        required: ['path'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY TOOLS
// These are safe to expose in bookmarklet context.
// They never mutate state, never write files, never run destructive commands.
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'web_search',
  'read_url',
  'remember',
  'read_logs',
  'check_file_exists',
]);

// ─────────────────────────────────────────────────────────────────────────────
// WRITE/DESTRUCTIVE TOOLS
// Only available in dashboard context.
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  'write_file',
  'delete_file',
  'create_branch',
  'create_pr',
  'merge_pr',
  'run_command',
]);

// ─────────────────────────────────────────────────────────────────────────────
// INTENT → TOOLS MAP
// Maps canonical intents to tool names.
// Uses only canonical intent names from intentClassifier.js INTENTS.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_TOOLS = {
  chat:          [],
  reasoning:     ['read_file', 'list_files', 'web_search', 'read_url', 'read_logs'],
  code_write:    ['write_file', 'read_file', 'list_files', 'remember', 'run_command', 'check_file_exists'],
  surgical_edit: ['read_file', 'write_file', 'list_files', 'check_file_exists'],
  code_review:   ['read_file', 'list_files', 'read_logs'],
  research:      ['web_search', 'read_url', 'read_file', 'list_files'],
  git_ops:       ['create_branch', 'create_pr', 'merge_pr', 'list_files', 'read_file'],
  deploy:        ['run_command', 'read_file', 'list_files', 'check_file_exists', 'read_logs'],
  search:        ['web_search', 'read_url'],
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getToolSchema(name) {
  return TOOL_DEFINITIONS[name] || null;
}

function isValid(name) {
  return Boolean(TOOL_DEFINITIONS[name]);
}

function isReadOnly(name) {
  return READ_ONLY_TOOLS.has(name);
}

function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GETTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get tool schema array for a given intent (all tools, no context filtering).
 *
 * @param {string} intent
 * @returns {Array}
 */
function schema(intent = 'chat') {
  const toolNames = INTENT_TOOLS[intent] || [];
  return toolNames
    .filter((name) => TOOL_DEFINITIONS[name])
    .map((name) => TOOL_DEFINITIONS[name]);
}

/**
 * Get tool schema array for a given intent, filtered by context.
 * Bookmarklet context only gets read-only tools.
 * Dashboard context gets all tools for the intent.
 *
 * @param {string} intent
 * @param {'bookmarklet' | 'dashboard' | 'api'} context
 * @returns {Array}
 */
function schemaForContext(intent = 'chat', context = 'dashboard') {
  const toolNames = INTENT_TOOLS[intent] || [];

  const filtered = context === 'bookmarklet'
    ? toolNames.filter((name) => READ_ONLY_TOOLS.has(name))
    : toolNames;

  return filtered
    .filter((name) => TOOL_DEFINITIONS[name])
    .map((name) => TOOL_DEFINITIONS[name]);
}

/**
 * Get all tool schemas (force mode).
 *
 * @returns {Array}
 */
function allSchema() {
  return Object.values(TOOL_DEFINITIONS);
}

/**
 * Get read-only tool schemas only (bookmarklet safe).
 *
 * @returns {Array}
 */
function readOnlySchema() {
  return Array.from(READ_ONLY_TOOLS)
    .filter((name) => TOOL_DEFINITIONS[name])
    .map((name) => TOOL_DEFINITIONS[name]);
}

// ─────────────────────────────────────────────────────────────────────────────
// NAME GETTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get tool names for a given intent.
 *
 * @param {string} intent
 * @returns {string[]}
 */
function namesForIntent(intent = 'chat') {
  return INTENT_TOOLS[intent] || [];
}

/**
 * Get tool names for a given intent, filtered by context.
 *
 * @param {string} intent
 * @param {'bookmarklet' | 'dashboard' | 'api'} context
 * @returns {string[]}
 */
function namesForContext(intent = 'chat', context = 'dashboard') {
  const toolNames = INTENT_TOOLS[intent] || [];

  if (context === 'bookmarklet') {
    return toolNames.filter((name) => READ_ONLY_TOOLS.has(name));
  }

  return toolNames;
}

/**
 * Get all tool names (deduplicated).
 *
 * @returns {string[]}
 */
function allNames() {
  return Object.keys(TOOL_DEFINITIONS);
}

/**
 * Get read-only tool names.
 *
 * @returns {string[]}
 */
function readOnlyNames() {
  return Array.from(READ_ONLY_TOOLS);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  schema,
  schemaForContext,
  allSchema,
  readOnlySchema,
  isValid,
  isReadOnly,
  isWriteTool,
  namesForIntent,
  namesForContext,
  allNames,
  readOnlyNames,
  TOOL_DEFINITIONS,
  INTENT_TOOLS,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
};
