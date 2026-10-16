/**
 * The agent pool. Each entry is a runnable identity (a specific model +
 * config) tagged with:
 *
 *  - domains: which project sides it may work on ('backend' | 'frontend')
 *  - tier:    how much it can be trusted with (1 = small / size-limited
 *             model, 2 = capable mid model, 3 = strongest). Override per
 *             agent with <ID>_TIER in .env, e.g. QWEN_TIER=3.
 *
 * pickAgent(domain, { complexity, load }) uses FAIR-SHARE routing: build the
 * pool of agents capable enough for the subtask's complexity, then pick the
 * least-contributed one (ties rotate round-robin). A failed agent is
 * escalated past by the orchestrator (excludeIds).
 *
 * Models are hosted by default (Llama / Qwen / Mistral via API keys). Local
 * llama.cpp / Ollama agents only load if you opt in:
 *   USE_LOCAL_MODELS=true   (llama.cpp servers on 8080 / 8081)
 *   OLLAMA_MODEL=...        (Ollama)
 *
 * Add a provider by adding an addHosted(...) call — nothing else in the
 * pipeline needs to change, since genericAgent.js is provider-agnostic.
 */

'use strict';

const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');
const { createModelClient } = require('./modelClients');
const { runGenericAgent } = require('./genericAgent');

/**
 * Local servers are CPU-bound and can take much longer than a hosted API to
 * start streaming. The undici dispatcher timeouts AND the OpenAI SDK's own
 * `timeout` must agree, or the shorter one silently cancels a generation
 * that was about to succeed. Only local clients get this override.
 */
const LOCAL_HEADERS_TIMEOUT_MS = 15 * 60_000;

// Caps one local response so a runaway completion doesn't run for 20+
// minutes at ~7 tokens/s on CPU.
const LOCAL_MAX_TOKENS = 2048;

const localDispatcher = new UndiciAgent({
  headersTimeout: LOCAL_HEADERS_TIMEOUT_MS,
  bodyTimeout: LOCAL_HEADERS_TIMEOUT_MS,
  connectTimeout: 30_000,
});

function localFetch(url, opts) {
  return undiciFetch(url, { ...opts, dispatcher: localDispatcher });
}

function tierFor(id, defaultTier) {
  const fromEnv = Number(process.env[`${id.toUpperCase().replace(/-/g, '_')}_TIER`]);
  return [1, 2, 3].includes(fromEnv) ? fromEnv : defaultTier;
}

/**
 * Registers a hosted, OpenAI-compatible agent if an API key is set.
 * `keyEnv` can be one env var name or an array; the first one that is set
 * is used.
 */
function addHosted(registry, {
  id,
  displayName,
  keyEnv,
  baseURL,
  model,
  defaultTier,
  supportsNativeTools = true,
}) {
  const keyNames = [].concat(keyEnv);
  const activeKeyName = keyNames.find((name) => process.env[name]);

  if (!activeKeyName) {
    console.log(`[agentRegistry] ${keyNames.join(' / ')} not set — ${displayName} disabled.`);
    return;
  }

  registry.push({
    id,
    displayName,
    domains: ['backend', 'frontend'],
    tier: tierFor(id, defaultTier),
    client: createModelClient({
      baseURL,
      apiKey: process.env[activeKeyName],
      model,
      supportsNativeTools,
    }),
  });
}

function buildRegistry() {
  const registry = [];

  /* ---------------- Hosted: Mistral ---------------- */
  addHosted(registry, {
    id: 'mistral',
    displayName: 'Mistral',
    keyEnv: 'MISTRAL_API_KEY',
    baseURL: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    model: process.env.MISTRAL_MODEL || 'codestral-latest',
    defaultTier: 3,
  });

  /* ---------------- Hosted: Llama ---------------- */
  // Any OpenAI-compatible host:
  //   LLAMA_API_BASE_URL, LLAMA_API_KEY (or OPENROUTER_API_KEY), LLAMA_API_MODEL
  // Defaults to OpenRouter's paid Llama 3.3 70B slug (the :free variant was
  // removed).
  addHosted(registry, {
    id: 'llama',
    displayName: 'Llama 3.3 70B',
    keyEnv: ['LLAMA_API_KEY', 'OPENROUTER_API_KEY'],
    baseURL: process.env.LLAMA_API_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.LLAMA_API_MODEL || 'meta-llama/llama-3.3-70b-instruct',
    defaultTier: 2,
  });

  /* ---------------- Hosted: Qwen ---------------- */
  // Any OpenAI-compatible host:
  //   QWEN_API_BASE_URL, QWEN_API_KEY, QWEN_API_MODEL
  // Falls back to Groq if only GROQ_API_KEY is set, but Groq's free tier caps
  // Qwen at ~7000 input tokens/min, which is too small for agent loops.
  // OpenRouter (or any paid host) is recommended.
  addHosted(registry, {
    id: 'qwen',
    displayName: 'Qwen',
    keyEnv: ['QWEN_API_KEY', 'GROQ_API_KEY'],
    baseURL: process.env.QWEN_API_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.QWEN_API_MODEL || 'qwen/qwen3.8-27b',
    defaultTier: 2,
  });

  /* ---------------- Hosted: Qwen (via DashScope) ---------------- */
  // Alibaba Cloud's Qwen API. Set DASHSCOPE_BASE_URL for the
  // mainland-China endpoint.
  addHosted(registry, {
    id: 'dashscope',
    displayName: 'DashScope (Qwen)',
    keyEnv: 'DASHSCOPE_API_KEY',
    baseURL:
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: process.env.DASHSCOPE_MODEL || 'qwen-plus',
    defaultTier: 2,
  });

  /* ---------------- Hosted: gpt-oss (via Groq) ---------------- */
  // Tier 1 by default: on the free tier it hits payload_too_large as a
  // conversation grows, so it is only reliable for small, single-file
  // subtasks. Raise with GROQ_TIER=2 if you are on a paid plan.
  addHosted(registry, {
    id: 'groq',
    displayName: 'Groq (gpt-oss)',
    keyEnv: 'GROQ_API_KEY',
    baseURL: process.env.GROQ_EXEC_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_EXEC_MODEL || 'openai/gpt-oss-120b',
    defaultTier: 1,
  });

  /* ---------------- Hosted: Gemini ---------------- */
  addHosted(registry, {
    id: 'gemini',
    displayName: 'Gemini',
    keyEnv: 'GEMINI_API_KEY',
    baseURL:
      process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    defaultTier: 3,
  });

  /* ---------------- Hosted: DeepSeek ---------------- */
  addHosted(registry, {
    id: 'deepseek',
    displayName: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    defaultTier: 3,
  });

  // Cerebras removed — this account gets 402 Payment Required on every
  // request. Re-add with addHosted() if billing is sorted out.

  /* ---------------- Local (opt-in only) ---------------- */
  if (process.env.USE_LOCAL_MODELS === 'true') {
    registry.push({
      id: 'qwen-local',
      displayName: 'Qwen2.5-Coder (local)',
      domains: ['backend', 'frontend'],
      tier: tierFor('qwen-local', 1),
      client: createModelClient({
        baseURL: process.env.QWEN_BASE_URL || 'http://127.0.0.1:8081/v1',
        apiKey: 'local-qwen',
        model: process.env.QWEN_MODEL || 'Qwen2.5-Coder-7B-Instruct',
        supportsNativeTools: false,
        fetch: localFetch,
        timeoutMs: LOCAL_HEADERS_TIMEOUT_MS,
        maxTokens: LOCAL_MAX_TOKENS,
      }),
    });

    registry.push({
      id: 'llama-local',
      displayName: 'Llama-3.1 (local)',
      domains: ['backend', 'frontend'],
      tier: tierFor('llama-local', 1),
      client: createModelClient({
        baseURL: process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080/v1',
        apiKey: 'local-llama',
        model: process.env.LLAMA_MODEL || 'Llama-3.1-8B-Instruct',
        supportsNativeTools: false,
        fetch: localFetch,
        timeoutMs: LOCAL_HEADERS_TIMEOUT_MS,
        maxTokens: LOCAL_MAX_TOKENS,
      }),
    });
  } else {
    console.log('[agentRegistry] USE_LOCAL_MODELS not "true" — llama.cpp local agents disabled.');
  }

  // Gated on explicitly setting OLLAMA_MODEL. Local, so same long-timeout
  // dispatcher and token cap as the llama.cpp agents, and tier 1.
  if (process.env.OLLAMA_MODEL) {
    registry.push({
      id: 'ollama-local',
      displayName: `Ollama (${process.env.OLLAMA_MODEL})`,
      domains: ['backend', 'frontend'],
      tier: tierFor('ollama-local', 1),
      client: createModelClient({
        baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
        model: process.env.OLLAMA_MODEL,
        supportsNativeTools: process.env.OLLAMA_SUPPORTS_TOOLS === 'true',
        fetch: localFetch,
        timeoutMs: LOCAL_HEADERS_TIMEOUT_MS,
        maxTokens: LOCAL_MAX_TOKENS,
      }),
    });
  } else {
    console.log('[agentRegistry] OLLAMA_MODEL not set — local Ollama agent disabled.');
  }

  // Skip agents you know are out of credit / quota. Cooldowns only live in
  // memory, so without this every restart re-tries every dead provider and
  // wastes an attempt (and a few seconds) on each one per subtask.
  //   DISABLED_AGENTS=deepseek,dashscope
  const disabled = (process.env.DISABLED_AGENTS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  for (const id of disabled) {
    const index = registry.findIndex((agent) => agent.id === id);

    if (index >= 0) {
      registry.splice(index, 1);
      console.log(`[agentRegistry] ${id} disabled via DISABLED_AGENTS.`);
    }
  }

  if (registry.length === 0) {
    throw new Error(
      '[agentRegistry] No agents configured at all. Set at least one API ' +
        'key (MISTRAL_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, ...) or ' +
        'USE_LOCAL_MODELS=true.'
    );
  }

  return registry;
}

const REGISTRY = buildRegistry();

console.log(
  `[agentRegistry] ${REGISTRY.length} agent(s) available: ` +
    REGISTRY.map((a) => `${a.id} [${a.domains.join(',')}] t${a.tier}`).join(', ')
);

/* ------------------------------------------------------------------ */
/* Cooldowns                                                           */
/* ------------------------------------------------------------------ */

// agentId -> timestamp (ms) before which this agent should be skipped.
const cooldownUntil = new Map();

const DEFAULT_COOLDOWN_MS = 60_000;
// High enough for the 30-minute billing/tier cooldown (modelClients.js).
const MAX_COOLDOWN_MS = 30 * 60_000;

function markCooldown(agentId, retryAfterMs, reason) {
  const waitMs = Math.min(
    Math.max(retryAfterMs || DEFAULT_COOLDOWN_MS, 1000),
    MAX_COOLDOWN_MS
  );

  cooldownUntil.set(agentId, Date.now() + waitMs);

  console.warn(
    `[agentRegistry] ${agentId} unavailable (${reason || 'unknown'}) — cooling down for ${Math.round(waitMs / 1000)}s`
  );
}

function isAvailable(agentId) {
  const until = cooldownUntil.get(agentId);
  return !until || Date.now() >= until;
}

function cooldownRemainingMs(agentId) {
  const until = cooldownUntil.get(agentId);
  if (!until) return 0;
  return Math.max(until - Date.now(), 0);
}

/* ------------------------------------------------------------------ */
/* Picking                                                             */
/* ------------------------------------------------------------------ */

const REQUIRED_TIER = {
  small: 1,
  medium: 2,
  large: 3,
};

// One cursor per domain. Only used when multiple agents have exactly the
// same contribution score.
const roundRobinCursors = {
  backend: 0,
  frontend: 0,
  any: 0,
};

/**
 * Returns the current contribution score of an agent.
 *
 * We intentionally don't use only "number of subtasks" because one agent
 * may write 1 tiny file while another writes 8 files / 500 lines.
 *
 * Score:
 *   subtasks       = 1 point
 *   files          = 0.5 points each
 *   lines          = 0.01 points each
 */
function contributionScore(agentId, load = {}) {
  const stats = load[agentId];

  if (!stats) {
    return 0;
  }

  if (typeof stats === 'number') {
    return stats;
  }

  return (
    (stats.subtasks || 0) +
    (stats.files || 0) * 0.5 +
    (stats.lines || 0) * 0.01
  );
}

/**
 * Pick the least-contributed eligible agent (main fairness mechanism).
 * Round-robin is used only for exact ties.
 */
function pickFairAgent(pool, domain, load) {
  if (!pool.length) {
    return null;
  }

  const scored = pool.map((agent) => ({
    agent,
    score: contributionScore(agent.id, load),
  }));

  const minScore = Math.min(...scored.map((item) => item.score));

  const candidates = scored
    .filter((item) => item.score === minScore)
    .map((item) => item.agent);

  if (candidates.length === 1) {
    return candidates[0];
  }

  const cursorKey = domain || 'any';
  const cursor = roundRobinCursors[cursorKey] || 0;

  roundRobinCursors[cursorKey] = cursor + 1;

  return candidates[cursor % candidates.length];
}

/**
 * small  -> tier 1+
 * medium -> tier 2+
 * large  -> tier 3+
 */
function capableAgents(candidates, requiredTier) {
  return candidates.filter((agent) => agent.tier >= requiredTier);
}

/**
 * FAIR-SHARE routing:
 *
 *   required capability -> build eligible pool -> choose least
 *   contributed agent
 *
 * If no fully capable agent is available, degrade by ONE tier only, then
 * fall back to anything available.
 */
function choose(candidates, domain, requiredTier, load) {
  const available = candidates.filter((agent) => isAvailable(agent.id));

  if (available.length === 0) {
    // Nothing currently available. Return the agent that will become
    // available soonest, preferring the required capability.
    const capableCooling = candidates
      .filter((agent) => agent.tier >= requiredTier)
      .sort((a, b) => cooldownRemainingMs(a.id) - cooldownRemainingMs(b.id));

    if (capableCooling.length > 0) {
      return capableCooling[0];
    }

    return [...candidates].sort(
      (a, b) => cooldownRemainingMs(a.id) - cooldownRemainingMs(b.id)
    )[0];
  }

  // 1. Prefer agents that are capable enough.
  const capable = capableAgents(available, requiredTier);

  if (capable.length > 0) {
    return pickFairAgent(capable, domain, load);
  }

  // 2. No fully capable agent is available — degrade by ONE tier only.
  const degradedTier = requiredTier - 1;

  if (degradedTier >= 1) {
    const degraded = available.filter((agent) => agent.tier === degradedTier);

    if (degraded.length > 0) {
      console.warn(
        `[agentRegistry] no tier-${requiredTier}+ agent available for "${domain}"; ` +
          `degrading to tier ${degradedTier} using fair-share routing`
      );

      return pickFairAgent(degraded, domain, load);
    }
  }

  // 3. Last resort.
  return pickFairAgent(available, domain, load);
}

/**
 * Picks the agent for a subtask and returns a bound
 * { id, displayName, tier, run(...) }.
 *
 * @param {string} domain 'backend' | 'frontend'
 * @param {object} [options]
 * @param {string[]} [options.excludeIds]
 * @param {'small'|'medium'|'large'} [options.complexity]
 * @param {object} [options.load] { [agentId]: { subtasks, files, lines } }
 *   (or the old { [agentId]: number } format)
 */
function pickAgent(domain, options = {}) {
  const excludeIds = options.excludeIds || [];
  const requiredTier = REQUIRED_TIER[options.complexity] || 1;
  const load = options.load || {};

  const candidates = REGISTRY.filter(
    (agent) => agent.domains.includes(domain) && !excludeIds.includes(agent.id)
  );

  if (candidates.length === 0) {
    throw new Error(
      `No agent is configured for domain "${domain}"` +
        (excludeIds.length ? ` excluding [${excludeIds.join(', ')}]` : '') +
        `. Configured: ${REGISTRY.map((a) => a.id).join(', ') || 'none'}`
    );
  }

  const chosen = choose(candidates, domain, requiredTier, load);

  console.log(
    `[agentRegistry] selected ${chosen.id} for ${domain} ` +
      `(required=t${requiredTier}, actual=t${chosen.tier}, ` +
      `score=${contributionScore(chosen.id, load).toFixed(2)})`
  );

  return {
    id: chosen.id,
    displayName: chosen.displayName,
    tier: chosen.tier,
    coolingDownMs: isAvailable(chosen.id) ? 0 : cooldownRemainingMs(chosen.id),

    run(subtaskDescription, apiContract, techStack) {
      return runGenericAgent({
        role: domain,
        client: chosen.client,
        agentId: chosen.id,
        subtaskDescription,
        apiContract,
        techStack,
      });
    },
  };
}

function listRegisteredAgents() {
  return REGISTRY.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    domains: a.domains,
    tier: a.tier,
    coolingDownMs: cooldownRemainingMs(a.id),
  }));
}

module.exports = { pickAgent, listRegisteredAgents, markCooldown };