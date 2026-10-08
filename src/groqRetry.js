async function withGroqRetry(fn, maxRetries = 8) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err?.response?.status;
      const isLastAttempt = attempt === maxRetries - 1;

      if (status === 429 && !isLastAttempt) {
        const msg = err.message || '';
        const msMatch = msg.match(/try again in ([\d.]+)ms/i);
        const sMatch = msg.match(/try again in ([\d.]+)s/i);

        let hintedWaitMs = null;
        if (msMatch) hintedWaitMs = parseFloat(msMatch[1]) + 250;
        else if (sMatch) hintedWaitMs = parseFloat(sMatch[1]) * 1000 + 250;

        const minFloorMs = 2000 * (attempt + 1);
        const waitMs = hintedWaitMs ? Math.max(hintedWaitMs, minFloorMs) : minFloorMs;

        console.warn(`[groq retry] rate limited — waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw err;
    }
  }
}

module.exports = { withGroqRetry };