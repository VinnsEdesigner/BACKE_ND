/**
 * @file modelRouter.js
 * @location /backend/lib/agent/modelRouter.js
 *
 * @purpose
 * Selects the best available AI model for a given task intent.
 * Sits between intentClassifier.js and ai.complete().
 * Uses the provider health state from ai.js to skip unavailable models.
 * Never guesses model strings — uses MODELS constants only.
 *
 * @exports
 *   selectModel(intent, modelStatus) → { model, providerKey, preferCode, fimOnly, reasoning, fallback }
 *   INTENT_MODEL_MAP                 → intent to model-chain configuration
 *   MODEL_PROVIDER_KEY               → model string to ai.js health key mapping
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
 *   none (reads model health via passed-in modelStatus argument)
 *
 * @dependency-level 3
 */

'use strict';

const { MODELS } = require('../../utils/constants');
const logger = require('../logger').child('modelRouter');

// ─────────────────────────────────────────────────────────────────────────────
// MODEL → PROVIDER KEY MAP
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PROVIDER_KEY = {
  [MODELS.GROQ_BRAIN]:        'groq',
  [MODELS.MISTRAL_CODE]:      'mistral_chat',
  [MODELS.MISTRAL_LARGE]:     'mistral_chat',
  [MODELS.MISTRAL_LEAN]:      'mistral_chat',
  [MODELS.CODESTRAL_FIM]:     'codestral',
  [MODELS.GEMINI_FLASH]:      'gemini',
  [MODELS.GEMINI_FLASH_LITE]: 'gemini_lite',
  [MODELS.GEMMA_4_26B]:       'gemma_26b',
  [MODELS.GEMMA_4_31B]:       'gemma_31b',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTENT → MODEL CHAIN MAP
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_MODEL_MAP = {
  chat: {
    preferCode: false,
    fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: true,
    // Safe placeholder so future refactors don't trip on undefined.
    chain: [],
    fimFallback: {
      preferCode: true,
      fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: false,
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
    fimOnly: false,
    chain: [
      MODELS.GEMINI_FLASH_LITE,
      MODELS.GROQ_BRAIN,
      MODELS.GEMMA_4_26B,
      MODELS.MISTRAL_LARGE,
      MODELS.GEMMA_4_31B,
      MODELS.GEMINI_FLASH,
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LAST RESORT
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

function isModelAvailable(model, modelStatus) {
  if (!modelStatus || typeof modelStatus !== 'object') return true;

  const providerKey = MODEL_PROVIDER_KEY[model];
  if (!providerKey) return true;

  const state = modelStatus[providerKey];
  if (!state || typeof state !== 'object') return true;

  return state.available === true;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SELECTOR
// ─────────────────────────────────────────────────────────────────────────────

function selectModel(intent, modelStatus = null) {
  const config = INTENT_MODEL_MAP[intent];

  if (!config) {
    logger.warn(`Unknown intent '${intent}' — using last resort chain`);

    const picked = pickFromChain(LAST_RESORT_CHAIN, modelStatus);
    if (picked) {
      return {
        model: picked.model,
        providerKey: picked.providerKey,
        preferCode: false,
        fimOnly: false,
        reasoning: `Unknown intent '${intent}' — selected first available model`,
        fallback: true,
      };
    }

    logger.error('All providers appear down — returning groq as placeholder');
    return {
      model: MODELS.GROQ_BRAIN,
      providerKey: 'groq',
      preferCode: false,
      fimOnly: false,
      reasoning: 'All providers down — placeholder model returned',
      fallback: true,
    };
  }

  if (config.fimOnly) {
    const codestralAvailable = isModelAvailable(MODELS.CODESTRAL_FIM, modelStatus);

    if (codestralAvailable) {
      logger.debug(`FiM selected for intent '${intent}'`);
      return {
        model: MODELS.CODESTRAL_FIM,
        providerKey: 'codestral',
        preferCode: true,
        fimOnly: true,
        reasoning: 'Surgical edit → codestral FiM (fill-in-middle)',
        fallback: false,
      };
    }

    logger.warn('Codestral unavailable — falling back to full rewrite chain');

    const fallbackConfig = config.fimFallback;
    const picked = pickFromChain(fallbackConfig.chain, modelStatus);

    if (picked) {
      return {
        model: picked.model,
        providerKey: picked.providerKey,
        preferCode: fallbackConfig.preferCode,
        fimOnly: false,
        reasoning: `Codestral unavailable — using ${picked.model} for full rewrite patch`,
        fallback: true,
      };
    }
  }

  const picked = pickFromChain(config.chain, modelStatus);

  if (picked) {
    const isPrimary = picked.model === config.chain[0];

    logger.debug(`Selected ${picked.model} for intent '${intent}'`, {
      fallback: !isPrimary,
    });

    return {
      model: picked.model,
      providerKey: picked.providerKey,
      preferCode: config.preferCode,
      fimOnly: false,
      reasoning: isPrimary
        ? `Primary model for '${intent}'`
        : `Primary unavailable — fallback to ${picked.model}`,
      fallback: !isPrimary,
    };
  }

  logger.warn(`All preferred models for '${intent}' unavailable — last resort`);

  const lastResort = pickFromChain(LAST_RESORT_CHAIN, modelStatus);

  if (lastResort) {
    return {
      model: lastResort.model,
      providerKey: lastResort.providerKey,
      preferCode: false,
      fimOnly: false,
      reasoning: `All preferred models for '${intent}' down — last resort: ${lastResort.model}`,
      fallback: true,
    };
  }

  logger.error('All providers down');
  return {
    model: MODELS.GROQ_BRAIN,
    providerKey: 'groq',
    preferCode: false,
    fimOnly: false,
    reasoning: 'All providers down — placeholder',
    fallback: true,
  };
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
