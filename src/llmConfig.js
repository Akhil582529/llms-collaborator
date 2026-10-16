/**
 * LLM config — which providers exist and which models each ROLE uses.
 *
 * Every provider here speaks the OpenAI-compatible /chat/completions API,
 * so adding a new one is just a new entry in PROVIDERS.
 *
 * Each role has a FALLBACK CHAIN: tried top to bottom. If a provider is
 * rate limited / down / has no key set, the next one is used.
 *
 * NOTE: free-tier model IDs change often. Verify the IDs on each provider's
 * model list page if you get a 404 / "model not found".
 *
 * .env keys needed:
 *   GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY
 */

const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    minGapMs: 2200, // ~30 requests/min on free tier
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    minGapMs: 1100, // ~1 request/sec on free tier
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    minGapMs: 3200, // ~20 requests/min on free models
  },
};

const ROLE_CHAINS = {
  // Planning / orchestration — Mistral first (already works well for you)
  planner: [
    { provider: 'mistral', model: 'mistral-large-latest' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
  ],

  // Backend coding — Qwen family
  backend: [
    { provider: 'groq', model: 'qwen/qwen3.6-27b' },
    { provider: 'openrouter', model: 'qwen/qwen3.6-plus:free', json: false },
    { provider: 'mistral', model: 'mistral-small-latest' },
  ],

  // Frontend coding — Llama family
  frontend: [
    { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', json: false },
    { provider: 'mistral', model: 'mistral-small-latest' },
  ],
};

module.exports = { PROVIDERS, ROLE_CHAINS };