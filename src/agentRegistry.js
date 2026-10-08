/**
 * The agent pool. Each entry is a runnable identity (a specific model +
 * config) tagged with:
 *
 *  - domains: which project sides it may work on ('backend' | 'frontend')
 *  - tier:    how much it can be trusted with (1 = small local model or
 *             size-limited hosted model, 2 = capable mid model, 3 =
 *             strongest). Override per agent with <ID>_TIER in .env,
 *             e.g. GROQ_TIER=2.
 *
 * pickAgent(domain, { complexity, load }) routes by tier: small subtasks
 * go to tier 1, medium to tier 2, large and repairs to tier 3. WITHIN a
 * tier the agent with the fewest subtasks in the current project is
 * chosen (ties rotate round-robin), so every available model in a tier
 * gets a share of the work. A failed agent is escalated past by the
 * orchestrator (excludeIds) to the next tier up.
 *
 * Add a provider by adding an entry here — nothing else in the pipeline
 * needs to change, since genericAgent.js is provider-agnostic.
 */

'use strict';

const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');
const { createModelClient } = require('./modelClients');
const { runGenericAgent } = require('./genericAgent');

/**
 * Local llama.cpp servers are CPU-bound and can take much longer than a
 * hosted API to start streaming. The undici dispatcher timeouts AND the
 * OpenAI SDK's own `timeout` must agree, or the shorter one silently
 * cancels a generation that was about to succeed. Only local clients get
 * this override.
 */
const LOCAL_HEADERS_TIMEOUT_MS = 15 * 60_000;

// Caps one response so a runaway completion doesn't run for 20+ minutes
// at ~7 tokens/s on CPU.
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

function buildRegistry() {
  const registry = [];

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

  if (process.env.GEMINI_API_KEY) {
    registry.push({
      id: 'gemini',
      displayName: 'Gemini',
      domains: ['backend', 'frontend'],
      tier: tierFor('gemini', 3),
      client: createModelClient({
        baseURL:
          process.env.GEMINI_BASE_URL ||
          'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
        supportsNativeTools: true,
      }),
    });
  } else {
    console.log('[agentRegistry] GEMINI_API_KEY not set — Gemini disabled.');
  }

  if (process.env.MISTRAL_API_KEY) {
    registry.push({
      id: 'mistral',
      displayName: 'Mistral',
      domains: ['backend', 'frontend'],
      tier: tierFor('mistral', 3),
      client: createModelClient({
        baseURL: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
        apiKey: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL || 'codestral-latest',
        supportsNativeTools: true,
      }),
    });
  } else {
    console.log('[agentRegistry] MISTRAL_API_KEY not set — Mistral disabled.');
  }

  if (process.env.DEEPSEEK_API_KEY) {
    registry.push({
      id: 'deepseek',
      displayName: 'DeepSeek',
      domains: ['backend', 'frontend'],
      tier: tierFor('deepseek', 3),
      client: createModelClient({
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        supportsNativeTools: true,
      }),
    });
  } else {
    console.log('[agentRegistry] DEEPSEEK_API_KEY not set — DeepSeek disabled.');
  }

  // Same account as the planner (groqProvider.js), registered as an
  // execution agent too. Tier 1 by default: on the free tier it hits
  // payload_too_large as a conversation grows, so it is only reliable
  // for small, single-file subtasks. Raise with GROQ_TIER=2 if you are
  // on a paid plan.
  if (process.env.GROQ_API_KEY) {
    registry.push({
      id: 'groq',
      displayName: 'Groq',
      domains: ['backend', 'frontend'],
      tier: tierFor('groq', 1),
      client: createModelClient({
        baseURL: process.env.GROQ_EXEC_BASE_URL || 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_EXEC_MODEL || 'openai/gpt-oss-120b',
        supportsNativeTools: true,
      }),
    });
  } else {
    console.log('[agentRegistry] GROQ_API_KEY not set — Groq execution agent disabled.');
  }

  // Cerebras removed — this account gets 402 Payment Required on every
  // request. Re-add if billing is sorted out.

  // Assumed to mean DashScope (Alibaba Cloud's Qwen API). Set
  // DASHSCOPE_BASE_URL for the mainland-China endpoint.
  if (process.env.DASHSCOPE_API_KEY) {
    registry.push({
      id: 'dashscope',
      displayName: 'DashScope (Qwen)',
      domains: ['backend', 'frontend'],
      tier: tierFor('dashscope', 2),
      client: createModelClient({
        baseURL:
          process.env.DASHSCOPE_BASE_URL ||
          'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        apiKey: process.env.DASHSCOPE_API_KEY,
        model: process.env.DASHSCOPE_MODEL || 'qwen-plus',
        supportsNativeTools: true,
      }),
    });
  } else {
    console.log('[agentRegistry] DASHSCOPE_API_KEY not set — DashScope disabled.');
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
      '[agentRegistry] No agents configured at all. Check your local ' +
        'llama.cpp servers and/or API keys.'
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

/* ------------------------------------------------------------------ */
/* Picking                                                             */
/* ------------------------------------------------------------------ */

const REQUIRED_TIER = {
  small: 1,
  medium: 2,
  large: 3,
};

// One cursor per domain. This is only used when multiple agents have
// exactly the same contribution score.
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
 *
 * This keeps task count important while still accounting for actual work.
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
 * Pick the least-contributed eligible agent.
 *
 * This is the main fairness mechanism.
 *
 * IMPORTANT:
 * We do NOT first choose a tier and then balance inside that tier.
 *
 * Instead:
 *
 *   1. Determine which agents are capable enough.
 *   2. Among those agents, choose the least-contributed one.
 *   3. Use round-robin only for exact ties.
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
 * Returns whether an agent is capable enough for the requested
 * complexity.
 *
 * We still respect capability.
 *
 * small  -> tier 1+
 * medium -> tier 2+
 * large  -> tier 3+
 *
 * However, if there are not enough high-tier agents available, we can
 * degrade one level rather than getting stuck.
 */
function capableAgents(candidates, requiredTier) {
  return candidates.filter((agent) => agent.tier >= requiredTier);
}

/**
 * Choose an agent using FAIR-SHARE routing.
 *
 * Old behaviour:
 *
 *   required tier -> find tier -> choose least loaded in that tier
 *
 * New behaviour:
 *
 *   required capability -> build eligible pool -> choose least
 *   contributed agent
 *
 * Example:
 *
 *   Mistral   tier 3  score 8
 *   Gemini    tier 3  score 2
 *   DeepSeek  tier 3  score 5
 *   Groq      tier 1  score 0
 *
 * Large task:
 *   Gemini wins because it is the least contributed tier-3 agent.
 *
 * Small task:
 *   Groq wins because it is capable and has contributed least.
 *
 * This prevents Mistral from automatically receiving everything.
 */
function choose(candidates, domain, requiredTier, load) {
  const available = candidates.filter((agent) => isAvailable(agent.id));

  if (available.length === 0) {
    // Nothing currently available. Return the agent that will become
    // available soonest, preferring the required capability.
    const capableCooling = candidates
      .filter((agent) => agent.tier >= requiredTier)
      .sort(
        (a, b) =>
          cooldownRemainingMs(a.id) - cooldownRemainingMs(b.id)
      );

    if (capableCooling.length > 0) {
      return capableCooling[0];
    }

    return [...candidates].sort(
      (a, b) =>
        cooldownRemainingMs(a.id) - cooldownRemainingMs(b.id)
    )[0];
  }

  // ---------------------------------------------------------------
  // 1. Prefer agents that are capable enough.
  // ---------------------------------------------------------------

  const capable = capableAgents(available, requiredTier);

  if (capable.length > 0) {
    return pickFairAgent(capable, domain, load);
  }

  // ---------------------------------------------------------------
  // 2. No fully capable agent is available.
  //
  // Degrade by ONE tier only.
  // ---------------------------------------------------------------

  const degradedTier = requiredTier - 1;

  if (degradedTier >= 1) {
    const degraded = available.filter(
      (agent) => agent.tier === degradedTier
    );

    if (degraded.length > 0) {
      console.warn(
        `[agentRegistry] no tier-${requiredTier}+ agent available for "${domain}"; ` +
          `degrading to tier ${degradedTier} using fair-share routing`
      );

      return pickFairAgent(degraded, domain, load);
    }
  }

  // ---------------------------------------------------------------
  // 3. Last resort.
  // ---------------------------------------------------------------

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
 *
 * `load` can now be either:
 *
 * {
 *   mistral: {
 *     subtasks: 2,
 *     files: 7,
 *     lines: 320
 *   }
 * }
 *
 * or the old:
 *
 * {
 *   mistral: 2
 * }
 *
 * The new format is preferred.
 */
function pickAgent(domain, options = {}) {
  const excludeIds = options.excludeIds || [];
  const requiredTier = REQUIRED_TIER[options.complexity] || 1;
  const load = options.load || {};

  const candidates = REGISTRY.filter(
    (agent) =>
      agent.domains.includes(domain) &&
      !excludeIds.includes(agent.id)
  );

  if (candidates.length === 0) {
    throw new Error(
      `No agent is configured for domain "${domain}"` +
        (excludeIds.length
          ? ` excluding [${excludeIds.join(', ')}]`
          : '') +
        `. Configured: ${
          REGISTRY.map((a) => a.id).join(', ') || 'none'
        }`
    );
  }

  const chosen = choose(
    candidates,
    domain,
    requiredTier,
    load
  );

  console.log(
    `[agentRegistry] selected ${chosen.id} for ${domain} ` +
      `(required=t${requiredTier}, actual=t${chosen.tier}, ` +
      `score=${contributionScore(chosen.id, load).toFixed(2)})`
  );

  return {
    id: chosen.id,
    displayName: chosen.displayName,
    tier: chosen.tier,
    coolingDownMs: isAvailable(chosen.id)
      ? 0
      : cooldownRemainingMs(chosen.id),

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