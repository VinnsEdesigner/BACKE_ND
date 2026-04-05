'use strict';

const logger = require('./logger');

// ── TOOLS SCHEMA ──────────────────────────────────────────────────────────────
// OpenAI-compatible tool definitions (works with Groq + Mistral + Gemini).
// Handlers are wired in Phase 3 (github.js) and Phase 4 (agent.js).
// intentClassifier.js + toolInjector.js select which tools to inject per request.

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
};

// ── INTENT → TOOLS MAP ────────────────────────────────────────────────────────
// toolInjector.js uses this to inject only relevant tools per intent.

const INTENT_TOOLS = {
  chat:        [],
  code_write:  ['write_file', 'read_file', 'list_files', 'remember'],
  code_edit:   ['read_file', 'write_file', 'list_files'],
  code_review: ['read_file', 'list_files'],
  file_ops:    ['read_file', 'write_file', 'delete_file', 'list_files'],
  git_ops:     ['create_branch', 'create_pr', 'merge_pr', 'list_files'],
  search:      ['web_search', 'read_url'],
  debug:       ['read_file', 'list_files', 'web_search'],
  explain:     ['read_file', 'web_search', 'read_url'],
  multi_step:  Object.keys(TOOL_DEFINITIONS), // all tools
};

/**
 * Get tool schema array for a given intent.
 * Returns OpenAI-compatible array for injection into AI prompt.
 */
function schema(intent = 'chat') {
  const toolNames = INTENT_TOOLS[intent] || [];
  return toolNames
    .filter((name) => TOOL_DEFINITIONS[name])
    .map((name) => TOOL_DEFINITIONS[name]);
}

/**
 * Get all tool schemas (force mode — bypasses intentClassifier).
 */
function allSchema() {
  return Object.values(TOOL_DEFINITIONS);
}

/**
 * Check if a tool name is valid.
 */
function isValid(name) {
  return Boolean(TOOL_DEFINITIONS[name]);
}

/**
 * Get list of tool names for a given intent.
 */
function namesForIntent(intent) {
  return INTENT_TOOLS[intent] || [];
}

module.exports = { schema, allSchema, isValid, namesForIntent, INTENT_TOOLS };
