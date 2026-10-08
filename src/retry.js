/**
 * Shared retry-with-backoff for LLM API calls. Retries on rate-limit/
 * transient-overload style errors (429, 503) with exponential backoff;
 * anything else (bad request, auth failure, etc.) fails immediately since
 * retrying won't help.
 */

function isRetryableStatus(err) {
  const status = err.status || err.statusCode;
  return status === 429 || status === 503;
}

async function withRetry(fn, { maxRetries = 3, baseDelayMs = 1000, label = 'request' } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxRetries - 1;
      if (!isRetryableStatus(err) || isLastAttempt) throw err;

      const delayMs = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[retry] ${label} — ${err.status || err.statusCode} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = { withRetry };