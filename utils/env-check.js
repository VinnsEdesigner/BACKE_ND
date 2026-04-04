'use strict';

const REQUIRED_VARS = [
  // Auth
  'JWT_SECRET',
  'ACCESS_PIN',

  // AI Providers
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'CODESTRAL_API_KEY',
  'GEMINI_API_KEY',

  // Search
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'FIRECRAWL_API_KEY',

  // Supabase
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',

  // GitHub
  'GITHUB_PAT',
  'GITHUB_USERNAME',

  // Upstash Redis
  'UPSTASH_REDIS_URL',
  'UPSTASH_REDIS_TOKEN',

  // HF Spaces
  'HF_SPACE_URL',
  'NODE_ENV',
];

function checkEnv() {
  const missing = [];

  for (const key of REQUIRED_VARS) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error('\n❌ STARTUP FAILED — Missing required environment variables:\n');
    for (const key of missing) {
      console.error(`   • ${key}`);
    }
    console.error('\nSet these in HF Spaces → Settings → Variables and secrets.\n');
    process.exit(1);
  }

  console.log(`✅ env-check passed — all ${REQUIRED_VARS.length} vars present`);
}

module.exports = { checkEnv };
