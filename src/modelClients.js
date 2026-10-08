/**
 * One client factory for every model provider.
 *
 * This works because Gemini and Mistral both expose OpenAI-compatible
 * chat-completions endpoints:
 *
 *   Gemini:  https://generativelanguage.googleapis.com/v1beta/openai/
 *   Mistral: https://api.mistral.ai/v1
 *
 * ...which are the same shape your local llama.cpp/Qwen servers already
 * speak. So instead of writing a bespoke integration per vendor, every
 * provider is just a { baseURL, apiKey, model } config passed to the same
 * `openai` SDK instance.
 *
 * If a specific provider's compatibility layer ever diverges (missing a
 * feature, different error shape), give it its own file that exports the
 * same { chat(messages, opts) } interface and swap it in — nothing else
 * in the pipeline needs to change.
 */

'use strict';

const OpenAI = require('openai');

/**
 * Thrown instead of a generic Error when a provider says this agent
 * can't serve the request right now: a 429 rate limit/quota error, a
 * 402/403 billing/tier restriction (Mistral 403 "not available in your
 * subscription tier", Cerebras 402 "Payment required"), a transient
 * server-side unavailability (Gemini 503 "UNAVAILABLE... high demand...
 * try again later", or a generic 500/502/504), or a client-side timeout
 * (local fetch/undici giving up waiting on a slow local model). All of
 * these mean the same thing to the caller: this specific agent is
 * unavailable right now, not that the subtask itself is broken. Carries
 * enough info for agentRegistry + orchestrator to put that agent on a
 * cooldown and retry with a different one.
 *
 * New provider error shapes keep showing up here one at a time (429,
 * then 402/403, then 503, then client-timeout) — rather than keep
 * enumerating individual status codes as they're discovered, `reason`
 * below buckets into categories by what they actually mean for retry
 * behavior, and the HTTP status ranges/phrases each maps from are
 * intentionally broad.
 */
class RateLimitError extends Error {
  constructor(message, { retryAfterMs, reason } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.isRateLimit = true;
    this.reason = reason ?? 'unknown';
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

// Rate limits and transient overload are usually gone in seconds to a
// couple minutes; a billing/tier restriction won't resolve itself on
// any useful timescale, so it gets a much longer cooldown so the pool
// doesn't keep wasting attempts on the same broke/restricted account
// every few subtasks for the rest of the run.
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 30_000;
const DEFAULT_BILLING_COOLDOWN_MS = 30 * 60_000;

/**
 * Recognizes a "this agent is unavailable right now" error across
 * providers without needing per-vendor error-shape parsing. Checks
 * `.status` where the SDK/proxy preserves it, and otherwise falls back
 * to matching well-known phrases in the error text.
 *
 * Also extracts a retry-after hint where a provider supplies one:
 * Gemini's rate-limit error body includes a RetryInfo block like
 * `"retryDelay":"47s"`; the OpenAI SDK separately exposes a
 * `Retry-After` response header as `err.headers['retry-after']` when
 * the proxy forwards it. Billing and transient-overload errors don't
 * carry a useful retry hint, so they get their category's default.
 */
function parseRateLimitInfo(err) {
  const status = err?.status ?? err?.response?.status;
  const message = String(err?.message ?? err ?? '');

  const isBilling =
    status === 402 ||
    status === 403 ||
    /payment required/i.test(message) ||
    /subscription tier/i.test(message);

  if (isBilling) {
    return {
      isRateLimit: true,
      reason: 'billing',
      retryAfterMs: DEFAULT_BILLING_COOLDOWN_MS,
    };
  }

  // A request that's structurally too large for this account's tier
  // (e.g. Groq's free "on_demand" tier caps at 8000 tokens/minute
  // total). Unlike a rate limit, retrying the SAME subtask again won't
  // help — the request doesn't get any smaller — so this gets the long
  // billing-style cooldown rather than a short one that would just
  // re-fail on the next attempt at roughly the same request size.
  const isPayloadTooLarge =
    status === 413 ||
    /request too large/i.test(message) ||
    /tokens per minute/i.test(message) ||
    /\bTPM\b/.test(message);

  if (isPayloadTooLarge) {
    return {
      isRateLimit: true,
      reason: 'payload_too_large',
      retryAfterMs: DEFAULT_BILLING_COOLDOWN_MS,
    };
  }

  const isRateLimit =
    status === 429 ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /rate.?limit/i.test(message) ||
    /quota exceeded/i.test(message);

  if (isRateLimit) {
    const headerRetryAfter = err?.headers?.['retry-after'];

    if (headerRetryAfter && !Number.isNaN(Number(headerRetryAfter))) {
      return {
        isRateLimit: true,
        reason: 'rate_limit',
        retryAfterMs: Number(headerRetryAfter) * 1000,
      };
    }

    const retryDelayMatch = message.match(
      /retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/
    );

    return {
      isRateLimit: true,
      reason: 'rate_limit',
      retryAfterMs: retryDelayMatch
        ? Math.ceil(parseFloat(retryDelayMatch[1]) * 1000)
        : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    };
  }

  // Client-side timeout: the local fetch/undici stack gave up waiting
  // for response headers or body before the provider ever returned a
  // status code. Common with local llama.cpp servers on CPU-bound
  // generation for large subtasks — has nothing to do with whether the
  // subtask itself is doable, so it's treated as retryable-elsewhere
  // exactly like a transient 5xx, not as a hard failure.
  const isTimeout =
    err?.name === 'AbortError' ||
    err?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    err?.code === 'UND_ERR_BODY_TIMEOUT' ||
    err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    err?.cause?.code === 'UND_ERR_BODY_TIMEOUT' ||
    /timed out/i.test(message) ||
    /\bETIMEDOUT\b/.test(message);

  if (isTimeout) {
    return {
      isRateLimit: true,
      reason: 'timeout',
      retryAfterMs: DEFAULT_TRANSIENT_COOLDOWN_MS,
    };
  }

  // Transient server-side unavailability: 5xx status, or provider
  // phrasing like Gemini's "UNAVAILABLE"/"high demand"/"try again
  // later", or the generic "overloaded"/"service unavailable" language
  // most providers converge on.
  const isTransient =
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /\bUNAVAILABLE\b/i.test(message) ||
    /overloaded/i.test(message) ||
    /service unavailable/i.test(message) ||
    /high demand/i.test(message) ||
    /try again later/i.test(message);

  if (isTransient) {
    return {
      isRateLimit: true,
      reason: 'transient',
      retryAfterMs: DEFAULT_TRANSIENT_COOLDOWN_MS,
    };
  }

  return { isRateLimit: false, reason: null, retryAfterMs: null };
}

/**
 * @param {object} config
 * @param {string} config.baseURL
 * @param {string} config.apiKey
 * @param {string} config.model
 * @param {boolean} [config.supportsNativeTools] whether this endpoint
 *   reliably honors the `tools` parameter and returns real `tool_calls`.
 *   Hosted APIs (Gemini, Mistral) generally do; small local models
 *   served through llama.cpp often don't, hence the text-JSON fallback
 *   protocol used elsewhere in this pipeline.
 * @param {Function} [config.fetch] optional custom fetch implementation,
 *   passed straight through to the OpenAI SDK client. Used by
 *   agentRegistry.js to give local (llama.cpp) clients a long-timeout
 *   undici dispatcher, since CPU-bound generation on a big subtask can
 *   legitimately take much longer than the SDK's default headers
 *   timeout. Hosted providers don't set this and keep the SDK default.
 * @param {number} [config.timeoutMs] optional request timeout passed to
 *   the SDK's own `timeout` option. This is a SEPARATE mechanism from
 *   the fetch dispatcher's headersTimeout/bodyTimeout — the SDK wraps
 *   every request in its own AbortController regardless of what
 *   dispatcher is used, so this must be set to at least as long as the
 *   dispatcher timeout or the SDK will cancel a request the dispatcher
 *   itself would have allowed to keep running.
 * @param {number} [config.maxTokens] caps a single response's length
 *   (passed as `max_tokens` on every request). Defaults to 4096.
 */
function createModelClient(config) {
  const clientOptions = {
    apiKey: config.apiKey || 'unused',
    baseURL: config.baseURL,
    maxRetries: 0, // don't let the SDK silently retry into a second generation
  };

  if (typeof config.fetch === 'function') {
    clientOptions.fetch = config.fetch;
  }

  if (config.timeoutMs) {
    clientOptions.timeout = config.timeoutMs;
  }

  const client = new OpenAI(clientOptions);

  return {
    supportsNativeTools: Boolean(config.supportsNativeTools),

    async chat(messages, { tools, temperature = 0.1 } = {}) {
      const payload = {
        model: config.model,
        messages,
        temperature,
        max_tokens: config.maxTokens || 4096,
      };

      if (tools && config.supportsNativeTools) {
        payload.tools = tools;
      }

      try {
        const completion = await client.chat.completions.create(payload);
                const message = completion.choices?.[0]?.message || null;

        if (message) {
          // Non-enumerable, so it is never serialized back to the provider
          // when this message is pushed into the conversation history.
          Object.defineProperty(message, 'usage', {
            enumerable: false,
            value: {
              promptTokens: completion.usage?.prompt_tokens || 0,
              completionTokens: completion.usage?.completion_tokens || 0,
              totalTokens:
                completion.usage?.total_tokens ||
                (completion.usage?.prompt_tokens || 0) +
                  (completion.usage?.completion_tokens || 0),
            },
          });
        }

        return message;
      } catch (err) {
        const rateLimitInfo = parseRateLimitInfo(err);

        if (rateLimitInfo.isRateLimit) {
          throw new RateLimitError(err?.message || String(err), {
            retryAfterMs: rateLimitInfo.retryAfterMs,
            reason: rateLimitInfo.reason,
          });
        }

        throw err;
      }
    },
  };
}

module.exports = { createModelClient, RateLimitError };