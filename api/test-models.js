'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const logger = require('../lib/logger');
const { MODELS, ENDPOINTS, HTTP } = require('../utils/constants');

// ── INDIVIDUAL MODEL TESTERS ──────────────────────────────────────────────────

async function testGroq() {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const res = await groq.chat.completions.create({
      model: MODELS.GROQ_BRAIN,
      messages: [{ role: 'user', content: 'say ok' }],
      max_tokens: 5,
    });
    const text = res.choices[0]?.message?.content?.trim();
    return { status: 'ok', model: MODELS.GROQ_BRAIN, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.GROQ_BRAIN, error: err.message };
  }
}

async function testMistralLarge() {
  try {
    const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODELS.MISTRAL_LARGE,
        messages: [{ role: 'user', content: 'say ok' }],
        max_tokens: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    const text = data.choices[0]?.message?.content?.trim();
    return { status: 'ok', model: MODELS.MISTRAL_LARGE, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.MISTRAL_LARGE, error: err.message };
  }
}

async function testDevstral() {
  try {
    const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODELS.MISTRAL_CODE,
        messages: [{ role: 'user', content: 'say ok' }],
        max_tokens: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    const text = data.choices[0]?.message?.content?.trim();
    return { status: 'ok', model: MODELS.MISTRAL_CODE, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.MISTRAL_CODE, error: err.message };
  }
}

async function testLeanstral() {
  try {
    const res = await fetch(ENDPOINTS.MISTRAL_CHAT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODELS.MISTRAL_LEAN,
        messages: [{ role: 'user', content: 'say ok' }],
        max_tokens: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    const text = data.choices[0]?.message?.content?.trim();
    return { status: 'ok', model: MODELS.MISTRAL_LEAN, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.MISTRAL_LEAN, error: err.message };
  }
}

async function testCodestral() {
  try {
    const res = await fetch(ENDPOINTS.CODESTRAL_FIM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CODESTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODELS.CODESTRAL_FIM,
        prompt: 'function add(a, b) {',
        suffix: '}',
        max_tokens: 10,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    const text = data.choices[0]?.message?.content?.trim();
    return { status: 'ok', model: MODELS.CODESTRAL_FIM, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.CODESTRAL_FIM, error: err.message };
  }
}

async function testGemini() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODELS.GEMINI_FLASH });
    const result = await model.generateContent('say ok');
    const text = result.response.text().trim();
    return { status: 'ok', model: MODELS.GEMINI_FLASH, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.GEMINI_FLASH, error: err.message };
  }
}

async function testGeminiFlashLite() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODELS.GEMINI_FLASH_LITE });
    const result = await model.generateContent('say ok');
    const text = result.response.text().trim();
    return { status: 'ok', model: MODELS.GEMINI_FLASH_LITE, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.GEMINI_FLASH_LITE, error: err.message };
  }
}

async function testGemma4_26B() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODELS.GEMMA_4_26B });
    const result = await model.generateContent('say ok');
    const text = result.response.text().trim();
    return { status: 'ok', model: MODELS.GEMMA_4_26B, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.GEMMA_4_26B, error: err.message };
  }
}

async function testGemma4_31B() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: MODELS.GEMMA_4_31B });
    const result = await model.generateContent('say ok');
    const text = result.response.text().trim();
    return { status: 'ok', model: MODELS.GEMMA_4_31B, response: text };
  } catch (err) {
    return { status: 'error', model: MODELS.GEMMA_4_31B, error: err.message };
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

async function testModels(req, res) {
  logger.info('test-models', 'Running model tests...');

  // Run all tests in parallel (faster)
  // Note: Mistral tests share 1 RPS bucket but since this is a one-time
  // test endpoint, slight overlap is acceptable
  const [
    groq, mistralLarge, devstral, leanstral,
    codestral, gemini, geminiLite, gemma26b, gemma31b
  ] = await Promise.allSettled([
    testGroq(),
    testMistralLarge(),
    testDevstral(),
    testLeanstral(),
    testCodestral(),
    testGemini(),
    testGeminiFlashLite(),
    testGemma4_26B(),
    testGemma4_31B(),
  ]);

  const results = {
    groq:              groq.value        || { status: 'error', error: groq.reason?.message },
    mistral_large:     mistralLarge.value || { status: 'error', error: mistralLarge.reason?.message },
    devstral:          devstral.value     || { status: 'error', error: devstral.reason?.message },
    leanstral:         leanstral.value    || { status: 'error', error: leanstral.reason?.message },
    codestral_fim:     codestral.value    || { status: 'error', error: codestral.reason?.message },
    gemini_flash:      gemini.value       || { status: 'error', error: gemini.reason?.message },
    gemini_flash_lite: geminiLite.value   || { status: 'error', error: geminiLite.reason?.message },
    gemma_4_26b:       gemma26b.value     || { status: 'error', error: gemma26b.reason?.message },
    gemma_4_31b:       gemma31b.value     || { status: 'error', error: gemma31b.reason?.message },
  };

  // Summary
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(r => r.status === 'ok').length;
  const failed = total - passed;

  const summary = {
    passed,
    failed,
    total,
    all_ok: failed === 0,
  };

  logger.info('test-models', `Results: ${passed}/${total} models ok`, summary);

  return res.status(HTTP.OK).json({
    summary,
    results,
    timestamp: new Date().toISOString(),
  });
}

module.exports = testModels;
