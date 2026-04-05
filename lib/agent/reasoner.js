'use strict';

const { complete }   = require('../ai');
const broadcastEmitter = require('./broadcastEmitter');
const logger         = require('../logger');
const { AGENT }      = require('../../utils/constants');

// ── REASONER ──────────────────────────────────────────────────────────────────
// Chain-of-thought planning before tool execution.
// Generates ordered step plan with rationale before agent acts.
// Saves reasoning to broadcastEmitter trace stream.

const SYSTEM_PROMPT = `You are a planning agent. Given a task and context, output a JSON execution plan.

Output ONLY valid JSON — no markdown, no preamble.

Schema:
{
  "steps": [
    {
      "tool":        "tool_name",
      "description": "what this step does in plain English",
      "args":        { "key": "value" }
    }
  ],
  "rationale":       "why this plan in 1-2 sentences",
  "risk_level":      "low" | "medium" | "high",
  "estimated_tools": ["tool1", "tool2"]
}

Rules:
- Maximum 8 steps per plan
- Only use tools from the available list
- If task is unclear, plan a read_file step first to gather context
- risk_level is high only if deleting files or merging PRs`;

/**
 * Generate an execution plan for a task.
 *
 * @param {string} userId
 * @param {string} intent   - from intentClassifier
 * @param {object} context  - { message, repo, branch, availableTools, snippets }
 * @returns {{ steps[], rationale, risk_level, estimated_tools }}
 */
async function plan(userId, intent, context = {}) {
  const {
    message        = '',
    repo           = '',
    branch         = 'main',
    availableTools = [],
    snippets       = [],
  } = context;

  // Emit trace to dashboard
  await broadcastEmitter.trace(userId, `classifier → "${intent}"`);
  await broadcastEmitter.trace(userId, `planning steps...`);

  const toolList   = availableTools.map((t) => t.function?.name || t.name).join(', ');
  const snippetCtx = snippets.length > 0
    ? `\nStaged snippets: ${snippets.map((s) => `#${s.number}[${s.type}]`).join(', ')}`
    : '';

  const userPrompt = [
    `Task: ${message}`,
    `Intent: ${intent}`,
    repo ? `Repo: ${repo} (branch: ${branch})` : '',
    `Available tools: ${toolList || 'none'}`,
    snippetCtx,
  ].filter(Boolean).join('\n');

  try {
    const result = await complete({
      messages:    [{ role: 'user', content: userPrompt }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   600,
      preferCode:  intent !== 'chat' && intent !== 'explain',
    });

    // Parse JSON response
    let parsed;
    try {
      const clean = result.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      logger.warn('reasoner:plan', 'Failed to parse plan JSON — using fallback', {
        raw: result.text.slice(0, 200),
      });
      parsed = fallbackPlan(intent, message, repo);
    }

    // Emit plan to trace stream
    await broadcastEmitter.trace(userId,
      `plan: ${(parsed.steps || []).length} steps — risk: ${parsed.risk_level || 'low'}`
    );

    logger.info('reasoner:plan', `Plan generated`, {
      userId,
      intent,
      steps:    (parsed.steps || []).length,
      risk:     parsed.risk_level,
      tokens:   result.tokens_used,
    });

    return parsed;
  } catch (err) {
    logger.error('reasoner:plan', 'Planning failed', err);
    await broadcastEmitter.trace(userId, `⚠ planning failed → using fallback`);
    return fallbackPlan(intent, message, repo);
  }
}

// ── FALLBACK PLAN ─────────────────────────────────────────────────────────────

function fallbackPlan(intent, message, repo) {
  // Minimal safe plan when AI planning fails
  const steps = intent === 'search'
    ? [{ tool: 'web_search', description: 'Search for information', args: { query: message } }]
    : repo
      ? [{ tool: 'read_file', description: 'Read context before acting', args: { repo, path: '' } }]
      : [];

  return {
    steps,
    rationale:       'Fallback plan — AI planning unavailable',
    risk_level:      'low',
    estimated_tools: steps.map((s) => s.tool),
  };
}

module.exports = { plan };
