/**
 * Multi-provider LLM client with fallback chains.
 *
 * All providers below are OpenAI-compatible, so one fetch-based client
 * handles them. Requires Node 18+ (global fetch).
 *
 * A "chain" is an ordered list of { provider, model }. If a call fails
 * (rate limit, 5xx, timeout, deprecated model, bad output), the next entry
 * in the chain is tried automatically.
 *
 * Override any chain from .env, e.g.:
 *   PLANNER_CHAIN=mistral:mistral-large-latest,groq:openai/gpt-oss-120b
 * Format: provider:model,provider:model  (model may itself contain ":")
 */

const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
  },
};

function parseChain(str, fallback) {
  const source = (str || '').trim() || fallback;
  return source
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) throw new Error(`Bad chain entry "${entry}" (use provider:model)`);
      return {
        provider: entry.slice(0, idx).trim().toLowerCase(),
        model: entry.slice(idx + 1).trim(),
      };
    });
}

// Verify these model IDs against each provider's current model list —
// free-tier catalogs change often. Override via .env without touching code.
const CHAINS = {
  planner: parseChain(
    process.env.PLANNER_CHAIN,
    'mistral:mistral-large-latest,groq:openai/gpt-oss-120b,groq:llama-3.3-70b-versatile'
  ),
  backend: parseChain(
    process.env.BACKEND_CHAIN,
    'groq:qwen/qwen3-32b,mistral:mistral-medium-latest,groq:llama-3.3-70b-versatile'
  ),
  frontend: parseChain(
    process.env.FRONTEND_CHAIN,
    'groq:llama-3.3-70b-versatile,mistral:mistral-small-latest,groq:qwen/qwen3-32b'
  ),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip reasoning blocks / code fences and parse the first JSON object. */
function extractJson(raw) {
  if (!raw) throw new Error('Empty response');
  let text = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json|```/gi, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`No JSON object found in: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function callOnce({ provider, model }, { messages, temperature, json, maxTokens }, useJsonMode) {
  const cfg = PROVIDERS[provider];
  const apiKey = process.env[cfg.keyEnv];

  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json && useJsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${provider}/${model} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw err;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider}/${model} returned empty content`);
  return content;
}

/**
 * chat({ chain, messages, temperature, json, maxTokens, validate })
 *
 * validate(content) -> any. If it throws, the entry is treated as failed
 * and the next one in the chain is tried. Its return value is `result`.
 *
 * Returns { content, result, provider, model }.
 */
async function chat({ chain, messages, temperature = 0.2, json = false, maxTokens, validate }) {
  const errors = [];

  for (const entry of chain) {
    const cfg = PROVIDERS[entry.provider];
    if (!cfg) {
      errors.push(`Unknown provider "${entry.provider}"`);
      continue;
    }
    if (!process.env[cfg.keyEnv]) {
      errors.push(`${entry.provider}: ${cfg.keyEnv} not set (skipped)`);
      continue;
    }

    let useJsonMode = true;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const content = await callOnce(entry, { messages, temperature, json, maxTokens }, useJsonMode);
        const result = validate ? validate(content) : content;
        return { content, result, provider: entry.provider, model: entry.model };
      } catch (err) {
        errors.push(`${entry.provider}/${entry.model} (try ${attempt}): ${err.message}`);

        // Model/provider doesn't support json mode -> retry same entry without it
        if (err.status === 400 && json && useJsonMode) {
          useJsonMode = false;
          continue;
        }

        // Rate limit / server error -> short wait, one retry, then next entry
        if ((err.status === 429 || err.status >= 500) && attempt === 1) {
          await sleep(Math.min((err.retryAfter || 2) * 1000, 10000));
          continue;
        }

        break; // move on to next chain entry
      }
    }
  }

  throw new Error(`All providers in chain failed:\n- ${errors.join('\n- ')}`);
}

module.exports = { chat, extractJson, CHAINS, PROVIDERS, parseChain };