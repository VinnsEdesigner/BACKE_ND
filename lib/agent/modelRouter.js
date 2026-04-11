/**
 * @file modelRouter.js
 * @location /backend/lib/agent/modelRouter.js
 *
 * @purpose
 * Selects the best available AI model for a given task intent.
 * Sits between intentClassifier.js and ai.complete() / ai.vision().
 * Uses the provider health snapshot from ai.modelStatus() to skip
 * unavailable models. Never guesses model strings — uses MODELS constants only.
 *
 * Return shape:
 * {
 *   model:       string,   — exact model string from MODELS
 *   providerKey: string,   — health map key from ai.js
 *   preferCode:  boolean,  — pass to ai.complete() options
 *   fimOnly:     boolean,  — true = use ai.fim() not ai.complete()
 *   visionOnly:  boolean,  — true = use visionHandler not ai.complete()
 *   reasoning:   string,   — human-readable selection reason (for SSE trace)
 *   fallback:    boolean,  — true = primary model was unavailable
 * }
 *
 * @exports
 *   selectModel(intent, modelStatus) → selection result object
 *   INTENT_MODEL_MAP                 → intent → chain config map
 *   MODEL_PROVIDER_KEY               → model string → health key map
 *   LAST_RESORT_CHAIN                → absolute fallback model chain
 *
 * @imports
 *   ../../utils/constants → MODELS
 *   ../logger             → child('modelRouter')
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
 * @dependency-level 3
 */

'use strict';

const { MODELS } = require('../../utils/constants');
const logger     = require('../logger').child('modelRouter');

// ─────────────────────────────────────────────────────────────────────────────
// MODEL → PROVIDER KEY MAP
// Maps exact model strings → ai.js health map keys.
// Every model that appears in any chain must have an entry here.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PROVIDER_KEY = {
  [MODELS.GROQ_BRAIN]:        'groq',
  [MODELS.MISTRAL_CODE]:      'mistral_chat',
  [MODELS.MISTRAL_LARGE]:     'mistral_chat',
  [MODELS.MISTRAL_LEAN]:      'mistral_chat',   // shares same bucket as other mistral models
  [MODELS.CODESTRAL_FIM]:     'codestral',
  [MODELS.GEMINI_FLASH]:      'gemini',
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT → MODEL CHAIN MAP
// Each intent defines:
//   preferCode  → passed to ai.complete() to skip Groq for code-heavy tasks
//   fimOnly     → route to ai.fim() instead of ai.complete()
//   visionOnly  → route to visionHandler instead of ai.complete()
//   chain       → ordered model preference list (first available wins)
//   fimFallback → used when fimOnly=true but codestral is unavailable
//
// Vision intent chain lists Gemini/Gemma models only (LAW 21).
// visionHandler.js manages its own internal waterfall — modelRouter
// signals the intent so agent.js dispatches correctly.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_MODEL_MAP = {

  chat: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  reasoning: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  code_write: {
    preferCode: true,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.MISTRAL_CODE,
      MODELS.MISTRAL_LARGE,
      MODELS.GROQ_BRAIN,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  surgical_edit: {
    preferCode: true,
    fimOnly:    true,
    visionOnly: false,
    // chain is empty — fimOnly routes directly to codestral
    // fimFallback is used if codestral is unavailable
    chain: [],
    fimFallback: {
      preferCode: true,
      fimOnly:    false,
      visionOnly: false,
      chain: [
        MODELS.MISTRAL_CODE,
        MODELS.MISTRAL_LARGE,
        MODELS.GROQ_BRAIN,
        MODELS.GEMINI_FLASH_LITE,
        MODELS.GEMMA_4_26B,
        MODELS.GEMMA_4_31B,
        MODELS.GEMINI_FLASH,
      ],
    },
  },

  code_review: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.MISTRAL_LARGE,
      MODELS.MISTRAL_CODE,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  research: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  git_ops: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  deploy: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GROQ_BRAIN,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  search: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: false,
    chain: [
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GROQ_BRAIN,
      MODELS.GEMMA_4_26B,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

  // Vision intent — Gemini/Gemma models ONLY (LAW 21).
  // visionOnly: true signals agent.js to dispatch to visionHandler
  // instead of ai.complete(). The chain here is for routing metadata
  // and availability checks — visionHandler manages its own waterfall.
  // Never include Groq or Mistral here — they have no vision capability.
  vision: {
    preferCode: false,
    fimOnly:    false,
    visionOnly: true,
    chain: [
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GEMMA_4_26B,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// LAST RESORT CHAIN
// Text completion fallback when all preferred models for an intent are down.
// Vision models included — they can handle text too.
// MISTRAL_LEAN included as absolute last resort (very limited).
// ─────────────────────────────────────────────────────────────────────────────

const LAST_RESORT_CHAIN = [
  MODELS.GROQ_BRAIN,
  MODELS.GEMINI_FLASH_LITE,
  MODELS.GEMMA_4_26B,
  MODELS.MISTRAL_LARGE,
  MODELS.GEMMA_4_31B,
  MODELS.GEMINI_FLASH,
  MODELS.MISTRAL_LEAN,
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a model is available given the current provider health snapshot.
 * If modelStatus is null or the provider key is unknown, assumes available.
 *
 * @param {string} model        - exact model string
 * @param {Object} modelStatus  - snapshot from ai.modelStatus()
 * @returns {boolean}
 */
function isModelAvailable(model, modelStatus) {
  if (!modelStatus || typeof modelStatus !== 'object') return true;

  const providerKey = MODEL_PROVIDER_KEY[model];
  if (!providerKey) return true;

  const state = modelStatus[providerKey];
  if (!state || typeof state !== 'object') return true;

  return state.available === true;
}

/**
 * Walk a model chain and return the first available model.
 * Returns null if all models in the chain are unavailable.
 *
 * @param {string[]} chain
 * @param {Object}   modelStatus
 * @returns {{ model: string, providerKey: string } | null}
 */
function pickFromChain(chain, modelStatus) {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  for (const model of chain) {
    if (isModelAvailable(model, modelStatus)) {
      return {
        model,
        providerKey: MODEL_PROVIDER_KEY[model] || 'unknown',
      };
    }
  }

  return null;
}

/**
 * Build a standardized selection result object.
 *
 * @param {Object} params
 * @returns {Object}
 */
function buildSelection({
  model,
  providerKey,
  preferCode  = false,
  fimOnly     = false,
  visionOnly  = false,
  reasoning,
  fallback    = false,
}) {
  return {
    model,
    providerKey,
    preferCode,
    fimOnly,
    visionOnly,
    reasoning,
    fallback,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SELECTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the best available model for a given intent.
 *
 * Handles three special routing cases:
 *   fimOnly    → codestral FiM (surgical_edit)
 *   visionOnly → visionHandler chain (vision intent)
 *   normal     → standard text completion waterfall
 *
 * Always returns a valid selection object — never throws.
 * Falls back to GROQ_BRAIN as absolute last resort placeholder.
 *
 * @param {string} intent       - canonical intent from intentClassifier
 * @param {Object} modelStatus  - snapshot from ai.modelStatus() — null = assume all up
 * @returns {Object} selection result
 */
function selectModel(intent, modelStatus = null) {
  const config = INTENT_MODEL_MAP[intent];

  // ── Unknown intent — last resort chain ────────────────────────────────────
  if (!config) {
    logger.warn('selectModel', `Unknown intent "${intent}" — using last resort chain`);

    const picked = pickFromChain(LAST_RESORT_CHAIN, modelStatus);
    if (picked) {
      return buildSelection({
        model:      picked.model,
        providerKey: picked.providerKey,
        preferCode:  false,
        fimOnly:     false,
        visionOnly:  false,
        reasoning:   `Unknown intent "${intent}" — first available model selected`,
        fallback:    true,
      });
    }

    // Absolute placeholder — all providers appear down
    logger.error('selectModel', 'All providers appear down — returning Groq as placeholder');
    return buildSelection({
      model:      MODELS.GROQ_BRAIN,
      providerKey: 'groq',
      preferCode:  false,
      fimOnly:     false,
      visionOnly:  false,
      reasoning:   'All providers down — placeholder model returned',
      fallback:    true,
    });
  }

  // ── FiM routing — surgical_edit ───────────────────────────────────────────
  if (config.fimOnly) {
    const codestralAvailable = isModelAvailable(MODELS.CODESTRAL_FIM, modelStatus);

    if (codestralAvailable) {
      logger.debug('selectModel', `FiM selected for intent "${intent}"`);
      return buildSelection({
        model:      MODELS.CODESTRAL_FIM,
        providerKey: 'codestral',
        preferCode:  true,
        fimOnly:     true,
        visionOnly:  false,
        reasoning:   'Surgical edit → Codestral FiM (fill-in-middle)',
        fallback:    false,
      });
    }

    // Codestral unavailable — fall back to full rewrite chain
    logger.warn('selectModel', 'Codestral unavailable — falling back to full rewrite chain');

    const fallbackConfig = config.fimFallback;
    const picked         = pickFromChain(fallbackConfig.chain, modelStatus);

    if (picked) {
      return buildSelection({
        model:      picked.model,
        providerKey: picked.providerKey,
        preferCode:  fallbackConfig.preferCode,
        fimOnly:     false,
        visionOnly:  false,
        reasoning:   `Codestral unavailable — ${picked.model} selected for full rewrite patch`,
        fallback:    true,
      });
    }
  }

  // ── Vision routing ────────────────────────────────────────────────────────
  // visionOnly signals agent.js to dispatch to visionHandler.
  // We still pick a model from the vision chain so agent.js
  // can include it in SSE trace — visionHandler will re-run its
  // own waterfall internally and may end up using a different model.
  if (config.visionOnly) {
    const picked = pickFromChain(config.chain, modelStatus);

    if (picked) {
      logger.debug('selectModel', `Vision routing → ${picked.model}`);
      return buildSelection({
        model:      picked.model,
        providerKey: picked.providerKey,
        preferCode:  false,
        fimOnly:     false,
        visionOnly:  true,
        reasoning:   `Vision intent → ${picked.model} (Gemini/Gemma vision chain)`,
        fallback:    false,
      });
    }

    // All vision models down
    logger.error('selectModel', 'All vision models unavailable');
    return buildSelection({
      model:      MODELS.GEMINI_FLASH_LITE,
      providerKey: 'gemini_lite',
      preferCode:  false,
      fimOnly:     false,
      visionOnly:  true,
      reasoning:   'All vision models appear down — placeholder returned',
      fallback:    true,
    });
  }

  // ── Normal text completion routing ────────────────────────────────────────
  const picked = pickFromChain(config.chain, modelStatus);

  if (picked) {
    const isPrimary = picked.model === config.chain[0];

    logger.debug('selectModel', `Selected "${picked.model}" for intent "${intent}"`, {
      fallback: !isPrimary,
    });

    return buildSelection({
      model:      picked.model,
      providerKey: picked.providerKey,
      preferCode:  config.preferCode,
      fimOnly:     false,
      visionOnly:  false,
      reasoning:   isPrimary
        ? `Primary model for "${intent}"`
        : `Primary unavailable — fallback to ${picked.model}`,
      fallback:    !isPrimary,
    });
  }

  // ── All preferred models for intent exhausted — last resort ───────────────
  logger.warn('selectModel', `All preferred models for "${intent}" unavailable — last resort`);

  const lastResort = pickFromChain(LAST_RESORT_CHAIN, modelStatus);

  if (lastResort) {
    return buildSelection({
      model:      lastResort.model,
      providerKey: lastResort.providerKey,
      preferCode:  false,
      fimOnly:     false,
      visionOnly:  false,
      reasoning:   `All preferred models for "${intent}" down — last resort: ${lastResort.model}`,
      fallback:    true,
    });
  }

  // ── Absolute last resort — all providers appear down ─────────────────────
  logger.error('selectModel', 'All providers exhausted');
  return buildSelection({
    model:      MODELS.GROQ_BRAIN,
    providerKey: 'groq',
    preferCode:  false,
    fimOnly:     false,
    visionOnly:  false,
    reasoning:   'All providers down — placeholder',
    fallback:    true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  selectModel,
  INTENT_MODEL_MAP,
  MODEL_PROVIDER_KEY,
  LAST_RESORT_CHAIN,
};
