'use strict';

const memory    = require('./memory');
const codeStyle = require('./code-style');
const logger    = require('../logger');

// ── LEARNING ──────────────────────────────────────────────────────────────────
// Event-driven behaviour adaptation — NEVER runs on every task.
// Only triggers on specific events (LAW from CONTEXT.md):
//   → User corrects agent output
//   → User rolls back an agent action
//   → User modifies agent plan before confirming
//   → Every 10th completed task (periodic batch)
//   → User says "remember this"
//   → Session end (summary learning)

// In-memory task counter per user
const taskCounters = new Map();

/**
 * Process a learning event from a user interaction.
 *
 * interaction: {
 *   event:    'correction' | 'rollback' | 'plan_modified' | 'periodic' | 'remember' | 'session_end',
 *   content:  string,         // what the user said or did
 *   context:  object,         // task context
 *   agentOutput?: string,     // what agent originally produced
 *   userCorrection?: string,  // what user changed it to
 * }
 */
async function process(userId, interaction) {
  const { event, content, agentOutput, userCorrection } = interaction;

  logger.debug('learning:process', `Event: ${event}`, { userId });

  try {
    switch (event) {

      case 'correction': {
        // User corrected agent output — detect style change
        if (agentOutput && userCorrection) {
          await detectStyleChange(userId, agentOutput, userCorrection);
        }
        // Save correction as memory fact
        await memory.save(userId, `correction:${Date.now()}`,
          `Agent said: "${truncate(agentOutput, 100)}" → User changed to: "${truncate(userCorrection, 100)}"`
        );
        break;
      }

      case 'rollback': {
        await memory.save(userId, `rollback:${Date.now()}`,
          `User rolled back: ${truncate(content, 150)}`
        );
        break;
      }

      case 'plan_modified': {
        await memory.save(userId, `plan_mod:${Date.now()}`,
          `User modified plan: ${truncate(content, 150)}`
        );
        break;
      }

      case 'remember': {
        // Explicit "remember this" — content should be key:value
        const [key, ...rest] = content.split(':');
        if (key && rest.length > 0) {
          await memory.save(userId, key.trim(), rest.join(':').trim());
        } else {
          await memory.save(userId, `note:${Date.now()}`, content);
        }
        break;
      }

      case 'periodic':
      case 'session_end': {
        logger.debug('learning:process', `${event} — no action needed (memorySummarizer handles session_end)`, { userId });
        break;
      }

      default:
        logger.warn('learning:process', `Unknown event type: ${event}`, { userId });
    }
  } catch (err) {
    logger.error('learning:process', `Failed to process event ${event}`, err);
    // Non-fatal — learning failures never break the main flow
  }
}

/**
 * Increment task counter. Returns true if periodic learning should trigger (every 10th).
 */
function incrementTaskCount(userId) {
  const count = (taskCounters.get(userId) || 0) + 1;
  taskCounters.set(userId, count);
  return count % 10 === 0;
}

/**
 * Get a summary of detected learning patterns for a user.
 */
async function getInsights(userId) {
  const { facts } = await memory.get(userId);
  const corrections  = facts.filter((f) => f.key.startsWith('correction:'));
  const rollbacks    = facts.filter((f) => f.key.startsWith('rollback:'));
  const planMods     = facts.filter((f) => f.key.startsWith('plan_mod:'));

  if (corrections.length + rollbacks.length + planMods.length === 0) return '';

  return [
    '[LEARNING INSIGHTS]',
    corrections.length > 0  ? `- ${corrections.length} output corrections made` : null,
    rollbacks.length > 0    ? `- ${rollbacks.length} rollbacks triggered`       : null,
    planMods.length > 0     ? `- ${planMods.length} plan modifications made`    : null,
  ].filter(Boolean).join('\n');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function detectStyleChange(userId, original, corrected) {
  const patch = {};

  // Detect quote style change
  if (corrected.includes("'") && !original.includes("'")) patch.quotes = 'single';
  if (corrected.includes('"') && !original.includes('"')) patch.quotes = 'double';

  // Detect semicolon preference
  const origSemi    = (original.match(/;$/gm) || []).length;
  const corrSemi    = (corrected.match(/;$/gm) || []).length;
  if (corrSemi > origSemi)  patch.semicolons = true;
  if (corrSemi < origSemi)  patch.semicolons = false;

  if (Object.keys(patch).length > 0) {
    await codeStyle.update(userId, patch);
    logger.debug('learning:detectStyleChange', 'Style updated', { userId, patch });
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

module.exports = { process, incrementTaskCount, getInsights };
