/**
 * Tests which models on an OpenAI-compatible endpoint work for the agent loop.
 *
 *   node src/checkModels.js [--base=URL] [--key=ENV_VAR_NAME] [--long] model-a model-b ...
 *
 * Defaults: base = LLAMA_API_BASE_URL (or NVIDIA), key = $LLAMA_API_KEY.
 *
 * For each model it checks:
 *   1. a tiny chat request
 *   2. a native tool call (the pipeline's agents need this)
 *   3. with --long: a ~12-14k-token prompt, since agents re-send their history
 *      on every loop and some free tiers cap the context well below the
 *      model's real window
 *
 * Examples:
 *   node src/checkModels.js --base=https://api-inference.modelscope.cn/v1 --key=QWEN_API_KEY --long Qwen/Qwen3.5-397B-A17B
 *   node src/checkModels.js @cf/meta/llama-3.3-70b-instruct-fp8-fast
 */

require('dotenv').config();

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const baseURL = (flag('base') || process.env.LLAMA_API_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const keyEnvName = flag('key') || 'LLAMA_API_KEY';
const key = process.env[keyEnvName];
const withLong = args.includes('--long');
const models = args.filter((a) => !a.startsWith('--'));

const TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
};

// ~56k characters, roughly 12-14k tokens
const FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(1250);

async function post(model, body, timeoutMs = 90000) {
  const started = Date.now();

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, temperature: 0, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }

  return { ok: res.ok, status: res.status, json, text, ms: Date.now() - started };
}

function errorText(result) {
  const message =
    result.json?.error?.message ||
    result.json?.errors?.[0]?.message ||
    result.json?.detail ||
    result.json?.message ||
    result.text;

  return `HTTP ${result.status}: ${String(message).replace(/\s+/g, ' ').slice(0, 200)}`;
}

async function check(model) {
  console.log(`\n${model}`);

  const verdict = { chat: false, tools: false, long: null };

  try {
    const chat = await post(model, {
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 16,
    });

    if (!chat.ok) {
      console.log(`  chat:  FAIL — ${errorText(chat)}`);
      return;
    }

    verdict.chat = true;
    console.log(`  chat:  OK (${chat.ms}ms)`);

    const tools = await post(model, {
      messages: [
        {
          role: 'user',
          content: 'Call the write_file tool with path "a.txt" and content "hi". Do not reply with text.',
        },
      ],
      tools: [TOOL],
      max_tokens: 200,
    });

    if (!tools.ok) {
      console.log(`  tools: FAIL — ${errorText(tools)}`);
    } else {
      const calls = tools.json?.choices?.[0]?.message?.tool_calls;

      verdict.tools = Array.isArray(calls) && calls.length > 0;

      console.log(
        verdict.tools
          ? `  tools: OK (${tools.ms}ms)`
          : '  tools: no tool_calls returned (not reliable for the agent loop)'
      );
    }

    if (withLong) {
      const long = await post(
        model,
        {
          messages: [
            {
              role: 'user',
              content: `${FILLER}\n\nIgnore everything above. Reply with the single word OK.`,
            },
          ],
          max_tokens: 16,
        },
        180000
      );

      verdict.long = long.ok;

      console.log(
        long.ok
          ? `  long:  OK — accepted a ~12-14k-token prompt (${long.ms}ms)`
          : `  long:  FAIL — ${errorText(long)}`
      );
    }

    const usable = verdict.chat && verdict.tools && verdict.long !== false;

    console.log(
      usable
        ? '  => USABLE for the pipeline'
        : '  => NOT usable (needs chat + tools' + (withLong ? ' + long context' : '') + ')'
    );
  } catch (err) {
    console.log(`  FAIL — ${err.message}`);
  }
}

(async () => {
  if (!key) {
    console.log(`No ${keyEnvName} set in .env`);
    return;
  }

  if (models.length === 0) {
    console.log('Pass at least one model id. Example:');
    console.log('  node src/checkModels.js --base=https://api-inference.modelscope.cn/v1 --key=QWEN_API_KEY --long Qwen/Qwen3.5-397B-A17B');
    return;
  }

  console.log(`Endpoint: ${baseURL}  (key from ${keyEnvName})`);

  for (const model of models) {
    await check(model);
  }

  console.log('');
})();