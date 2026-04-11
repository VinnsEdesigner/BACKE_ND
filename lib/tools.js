/**
 * @file tools.js
 * @location /backend/lib/tools.js
 *
 * @purpose
 * Defines all available agent tools in OpenAI-compatible function schema format.
 * Maps canonical intents to tool sets for conditional injection.
 * Separates read-only tools (bookmarklet-safe) from write/destructive tools
 * (dashboard-only). Vision tools are read-only and available in both contexts.
 *
 * @exports
 *   schema(intent)                       → tool schema array for intent (no context filter)
 *   schemaForContext(intent, context)    → context-aware tool schema array
 *   allSchema()                          → all tool schemas (force mode)
 *   readOnlySchema()                     → read-only tool schemas (bookmarklet safe)
 *   isValid(name)                        → bool — tool name exists
 *   isReadOnly(name)                     → bool — tool is in READ_ONLY_TOOLS
 *   isWriteTool(name)                    → bool — tool is in WRITE_TOOLS
 *   namesForIntent(intent)               → string[] tool names for intent
 *   namesForContext(intent, context)     → string[] context-filtered tool names
 *   allNames()                           → string[] all tool names
 *   readOnlyNames()                      → string[] read-only tool names
 *   TOOL_DEFINITIONS                     → raw tool schema map
 *   INTENT_TOOLS                         → intent → tool names map
 *   READ_ONLY_TOOLS                      → Set of read-only tool names
 *   WRITE_TOOLS                          → Set of write/destructive tool names
 *
 * @imports
 *   none — standalone schema definitions
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
// Every tool used by executor.js must be defined here.
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
          repo:   {
            type:        'string',
            description: 'Repository name (e.g. backend, dashboard, SCRAPER-)',
          },
          path:   {
            type:        'string',
            description: 'File path relative to repo root (e.g. api/agent.js)',
          },
          branch: {
            type:        'string',
            description: 'Branch name. Defaults to main.',
            default:     'main',
          },
        },
        required: ['repo', 'path'],
      },
    },
  },

  write_file: {
    type: 'function',
    function: {
      name:        'write_file',
      description: 'Create or update a file in a GitHub repository. Always shadows to ai-sandbox branch before writing to target branch.',
      parameters:  {
        type:       'object',
        properties: {
          repo:    {
            type:        'string',
            description: 'Repository name',
          },
          path:    {
            type:        'string',
            description: 'File path relative to repo root',
          },
          content: {
            type:        'string',
            description: 'Full file content to write — never partial',
          },
          message: {
            type:        'string',
            description: 'Git commit message',
          },
          branch:  {
            type:        'string',
            description: 'Target branch. Defaults to main.',
            default:     'main',
          },
        },
        required: ['repo', 'path', 'content', 'message'],
      },
    },
  },

  delete_file: {
    type: 'function',
    function: {
      name:        'delete_file',
      description: 'Delete a file from a GitHub repository. Always backs up to ai-sandbox before deletion.',
      parameters:  {
        type:       'object',
        properties: {
          repo:    {
            type:        'string',
            description: 'Repository name',
          },
          path:    {
            type:        'string',
            description: 'File path to delete',
          },
          message: {
            type:        'string',
            description: 'Git commit message',
          },
          branch:  {
            type:        'string',
            description: 'Target branch. Defaults to main.',
            default:     'main',
          },
        },
        required: ['repo', 'path', 'message'],
      },
    },
  },

  list_files: {
    type: 'function',
    function: {
      name:        'list_files',
      description: 'List files and directories at a path in a GitHub repository.',
      parameters:  {
        type:       'object',
        properties: {
          repo:   {
            type:        'string',
            description: 'Repository name',
          },
          path:   {
            type:        'string',
            description: 'Directory path. Defaults to repo root.',
            default:     '',
          },
          branch: {
            type:        'string',
            description: 'Branch name. Defaults to main.',
            default:     'main',
          },
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
      description: 'Create a new branch in a GitHub repository from a source branch.',
      parameters:  {
        type:       'object',
        properties: {
          repo:        {
            type:        'string',
            description: 'Repository name',
          },
          branch_name: {
            type:        'string',
            description: 'Name for the new branch',
          },
          from_branch: {
            type:        'string',
            description: 'Source branch to create from. Defaults to main.',
            default:     'main',
          },
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
          repo:  {
            type:        'string',
            description: 'Repository name',
          },
          title: {
            type:        'string',
            description: 'Pull request title',
          },
          body:  {
            type:        'string',
            description: 'Pull request description body',
          },
          head:  {
            type:        'string',
            description: 'Source branch (the branch with changes)',
          },
          base:  {
            type:        'string',
            description: 'Target branch to merge into. Defaults to main.',
            default:     'main',
          },
        },
        required: ['repo', 'title', 'head'],
      },
    },
  },

  merge_pr: {
    type: 'function',
    function: {
      name:        'merge_pr',
      description: 'Merge an open pull request by PR number.',
      parameters:  {
        type:       'object',
        properties: {
          repo:          {
            type:        'string',
            description: 'Repository name',
          },
          pull_number:   {
            type:        'number',
            description: 'Pull request number to merge',
          },
          merge_message: {
            type:        'string',
            description: 'Optional merge commit message',
          },
        },
        required: ['repo', 'pull_number'],
      },
    },
  },

  // ── Web / URL tools ────────────────────────────────────────────────────────

  web_search: {
    type: 'function',
    function: {
      name:        'web_search',
      description: 'Search the web for current information, documentation, news, or references.',
      parameters:  {
        type:       'object',
        properties: {
          query:       {
            type:        'string',
            description: 'Search query string',
          },
          max_results: {
            type:        'number',
            description: 'Maximum number of results to return. Defaults to 5.',
            default:     5,
          },
        },
        required: ['query'],
      },
    },
  },

  read_url: {
    type: 'function',
    function: {
      name:        'read_url',
      description: 'Fetch and read the full text content of a URL. Uses Jina reader with Firecrawl fallback.',
      parameters:  {
        type:       'object',
        properties: {
          url: {
            type:        'string',
            description: 'Fully qualified URL to fetch (must include https://)',
          },
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
      description: 'Save an important fact, preference, or decision to long-term persistent memory.',
      parameters:  {
        type:       'object',
        properties: {
          key:   {
            type:        'string',
            description: 'Memory key — snake_case identifier (e.g. preferred_framework)',
          },
          value: {
            type:        'string',
            description: 'Value to store for this key',
          },
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
      description: 'Execute a whitelisted command on the HF Spaces server. Only allowlisted executables pass validation — no shell, no curl, no sudo.',
      parameters:  {
        type:       'object',
        properties: {
          executable: {
            type:        'string',
            description: 'Binary name to run (e.g. npm, git, node, ls)',
          },
          args:       {
            type:        'array',
            items:       { type: 'string' },
            description: 'Array of arguments to pass to the executable',
          },
          cwd:        {
            type:        'string',
            description: 'Working directory for the command. Defaults to /app.',
            default:     '/app',
          },
        },
        required: ['executable'],
      },
    },
  },

  read_logs: {
    type: 'function',
    function: {
      name:        'read_logs',
      description: 'Read recent structured server logs for debugging and self-diagnosis.',
      parameters:  {
        type:       'object',
        properties: {
          lines:     {
            type:        'number',
            description: 'Number of recent log lines to read. Defaults to 100.',
            default:     100,
          },
          level:     {
            type:        'string',
            description: 'Filter by log level: debug | info | warn | error',
          },
          namespace: {
            type:        'string',
            description: 'Filter by logger namespace (e.g. agent, ai, github)',
          },
        },
        required: [],
      },
    },
  },

  check_file_exists: {
    type: 'function',
    function: {
      name:        'check_file_exists',
      description: 'Check whether a file or directory exists on the HF Spaces server filesystem.',
      parameters:  {
        type:       'object',
        properties: {
          path: {
            type:        'string',
            description: 'Absolute or /app-relative path to check',
          },
        },
        required: ['path'],
      },
    },
  },

  // ── Vision tools ───────────────────────────────────────────────────────────
  // Both are READ-ONLY — safe in bookmarklet context.
  // analyze_image: calls visionHandler → Gemini/Gemma vision chain.
  // fetch_to_snippets: fetches URL/file content → saves to Supabase snippets.
  // Neither mutates GitHub repos or runs commands.

  analyze_image: {
    type: 'function',
    function: {
      name:        'analyze_image',
      description: 'Analyze an image using the Gemini/Gemma vision chain. Accepts a public image URL or a snippet ID referencing a stored image. Returns a detailed analysis answering the provided question.',
      parameters:  {
        type:       'object',
        properties: {
          image_url:  {
            type:        'string',
            description: 'Public URL of the image to analyze',
          },
          snippet_id: {
            type:        'string',
            description: 'UUID of an existing image-type snippet in Supabase to analyze',
          },
          question:   {
            type:        'string',
            description: 'What to ask or look for in the image',
          },
          mime_type:  {
            type:        'string',
            description: 'MIME type of the image (e.g. image/jpeg, image/png). Required when passing image_url.',
          },
        },
        required: ['question'],
      },
    },
  },

  fetch_to_snippets: {
    type: 'function',
    function: {
      name:        'fetch_to_snippets',
      description: 'Fetch content from a URL or file and save it as a snippet in Supabase. Supports research pages, code files, and image metadata. Content is saved to the snippets table for later retrieval.',
      parameters:  {
        type:       'object',
        properties: {
          url:   {
            type:        'string',
            description: 'URL to fetch content from',
          },
          type:  {
            type:        'string',
            enum:        ['code', 'research', 'image', 'file'],
            description: 'Snippet type: code | research | image | file',
          },
          label: {
            type:        'string',
            description: 'Human-readable label for this snippet (used as title)',
          },
        },
        required: ['url', 'type'],
      },
    },
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY TOOLS
// Safe to expose in bookmarklet context (context: 'bookmarklet').
// These never mutate GitHub repos, never run commands, never delete data.
// Vision tools are included — they read/analyze only.
// fetch_to_snippets writes to Supabase snippets — but this is safe in
// bookmarklet context (it's the scraper's primary purpose).
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'web_search',
  'read_url',
  'remember',
  'read_logs',
  'check_file_exists',
  'analyze_image',
  'fetch_to_snippets',
]);

// ─────────────────────────────────────────────────────────────────────────────
// WRITE / DESTRUCTIVE TOOLS
// Dashboard context only. Never available in bookmarklet context.
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
// Maps every canonical intent to its relevant tool names.
// Must stay in sync with intentClassifier.js INTENTS enum.
// vision intent added — analyze_image is its primary tool.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_TOOLS = {
  chat:          [],

  reasoning:     [
    'read_file',
    'list_files',
    'web_search',
    'read_url',
    'read_logs',
    'check_file_exists',
  ],

  code_write:    [
    'write_file',
    'read_file',
    'list_files',
    'remember',
    'run_command',
    'check_file_exists',
  ],

  surgical_edit: [
    'read_file',
    'write_file',
    'list_files',
    'check_file_exists',
  ],

  code_review:   [
    'read_file',
    'list_files',
    'read_logs',
    'check_file_exists',
  ],

  research:      [
    'web_search',
    'read_url',
    'read_file',
    'list_files',
    'fetch_to_snippets',
  ],

  git_ops:       [
    'create_branch',
    'create_pr',
    'merge_pr',
    'list_files',
    'read_file',
  ],

  deploy:        [
    'run_command',
    'read_file',
    'list_files',
    'check_file_exists',
    'read_logs',
  ],

  search:        [
    'web_search',
    'read_url',
  ],

  // Vision intent — analyze_image is primary.
  // fetch_to_snippets included so agent can save image findings.
  // web_search included for reverse image search / context lookup.
  vision:        [
    'analyze_image',
    'fetch_to_snippets',
    'web_search',
    'read_url',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a tool name is registered in TOOL_DEFINITIONS.
 * @param {string} name
 * @returns {boolean}
 */
function isValid(name) {
  return Object.prototype.hasOwnProperty.call(TOOL_DEFINITIONS, name);
}

/**
 * Check if a tool is in the READ_ONLY_TOOLS set.
 * @param {string} name
 * @returns {boolean}
 */
function isReadOnly(name) {
  return READ_ONLY_TOOLS.has(name);
}

/**
 * Check if a tool is in the WRITE_TOOLS set.
 * @param {string} name
 * @returns {boolean}
 */
function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GETTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get tool schema array for a given intent — no context filtering.
 * Returns all tools mapped to this intent regardless of context.
 *
 * @param {string} intent - canonical intent string
 * @returns {Array} OpenAI-compatible tool schema array
 */
function schema(intent = 'chat') {
  const toolNames = INTENT_TOOLS[intent] || [];
  return toolNames
    .filter((name) => isValid(name))
    .map((name) => TOOL_DEFINITIONS[name]);
}

/**
 * Get tool schema array filtered by execution context.
 * Bookmarklet context: only READ_ONLY_TOOLS pass through.
 * Dashboard/api context: all intent tools returned.
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
    .filter((name) => isValid(name))
    .map((name) => TOOL_DEFINITIONS[name]);
}

/**
 * Get all tool schemas — used in force mode.
 * Always returns the full set regardless of context.
 *
 * @returns {Array}
 */
function allSchema() {
  return Object.values(TOOL_DEFINITIONS);
}

/**
 * Get read-only tool schemas only — bookmarklet safe set.
 *
 * @returns {Array}
 */
function readOnlySchema() {
  return Array.from(READ_ONLY_TOOLS)
    .filter((name) => isValid(name))
    .map((name) => TOOL_DEFINITIONS[name]);
}

// ─────────────────────────────────────────────────────────────────────────────
// NAME GETTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get tool names for a given intent — no context filtering.
 *
 * @param {string} intent
 * @returns {string[]}
 */
function namesForIntent(intent = 'chat') {
  return (INTENT_TOOLS[intent] || []).filter((name) => isValid(name));
}

/**
 * Get tool names for a given intent filtered by context.
 *
 * @param {string} intent
 * @param {'bookmarklet' | 'dashboard' | 'api'} context
 * @returns {string[]}
 */
function namesForContext(intent = 'chat', context = 'dashboard') {
  const toolNames = (INTENT_TOOLS[intent] || []).filter((name) => isValid(name));

  if (context === 'bookmarklet') {
    return toolNames.filter((name) => READ_ONLY_TOOLS.has(name));
  }

  return toolNames;
}

/**
 * Get all registered tool names.
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
  return Array.from(READ_ONLY_TOOLS).filter((name) => isValid(name));
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
