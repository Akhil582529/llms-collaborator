/**
 * Health check for every model the orchestrator can use.
 *
 *   node src/checkProviders.js
 *
 * Sends one tiny request to each provider using the same keys, base URLs
 * and model names as agentRegistry.js, and says in plain words why a
 * provider would fail.
 *
 * Local models also get:
 *  - a tool-call test: the agent loop needs ONE JSON object per turn, and
 *    "wrote zero files" from a local model usually means it could not
 *    produce that (cut off at the token cap, or not valid JSON);
 *  - a speed measurement (tokens/second) and what that means for real files;
 *  - a prompt-size check: how many tokens the agent's FIRST message really
 *    uses (role prompt + project context + UI guides) against the server's
 *    context window. A small window leaves no room for the conversation, so
 *    the agent fails after a few tool rounds.
 *
 * Run it BEFORE starting a project to see which models will actually work.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 15 * 60_000; // local CPU models can be very slow
const HOSTED_TIMEOUT_MS = 90_000;

const HOSTED = [
  {
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    base: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  },
  {
    id: 'mistral',
    keyVar: 'MISTRAL_API_KEY',
    base: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
    model: process.env.MISTRAL_MODEL || 'codestral-latest',
  },
  {
    id: 'deepseek',
    keyVar: 'DEEPSEEK_API_KEY',
    base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  },
  {
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    base: process.env.GROQ_EXEC_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_EXEC_MODEL || 'openai/gpt-oss-120b',
  },
  {
    id: 'dashscope',
    keyVar: 'DASHSCOPE_API_KEY',
    base: process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: process.env.DASHSCOPE_MODEL || 'qwen-plus',
  },
];

const LOCAL = [
  {
    id: 'qwen-local',
    roles: ['backend', 'frontend'],
    base: process.env.QWEN_BASE_URL || 'http://127.0.0.1:8081/v1',
    model: process.env.QWEN_MODEL || 'Qwen2.5-Coder-7B-Instruct',
  },
  {
    id: 'llama-local',
    roles: ['backend', 'frontend'],
    base: process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080/v1',
    model: process.env.LLAMA_MODEL || 'Llama-3.1-8B-Instruct',
  },
];

// Same cap agentRegistry applies to local models.
const LOCAL_MAX_TOKENS = 2048;

// What you start llama-server with (-c 8192). Used if the server does not
// report its context size itself.
const ASSUMED_CTX = Number(process.env.LOCAL_CTX || 8192);

async function chat({ base, key, model, content, maxTokens, timeoutMs }) {
  const url = `${base.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const text = await res.text();

    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { status: res.status, ms: Date.now() - started, json, text };
  } catch (error) {
    return {
      status: 0,
      ms: Date.now() - started,
      error:
        error.name === 'AbortError'
          ? `no answer within ${Math.round(timeoutMs / 1000)}s`
          : error.cause?.code || error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(result) {
  const fromJson =
    result.json?.error?.message ||
    (Array.isArray(result.json) && result.json[0]?.error?.message) ||
    result.json?.message;

  return String(fromJson || result.text || result.error || '').replace(/\s+/g, ' ').slice(0, 260);
}

function explain(result) {
  switch (result.status) {
    case 0:
      return 'Cannot reach the server. For a local model: is llama-server running on that port?';
    case 400:
      return 'Request rejected. Usually a wrong model name in .env, or the prompt exceeds the context window.';
    case 401:
      return 'API key rejected. Check the key in .env.';
    case 402:
      return 'No credit on the account. Top up the balance.';
    case 403:
      return 'Key valid but not allowed: free quota used up, "free tier only" mode on, or region/permission limit.';
    case 404:
      return 'Model or URL not found. Check the model name and base URL in .env.';
    case 429:
      return 'Quota or rate limit reached (per-minute tokens/requests, or the free daily allowance).';
    default:
      return result.status >= 500 ? 'Provider-side error. Try again later.' : '';
  }
}

function line(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(12)} ${detail}`);
}

async function checkHosted(provider) {
  const key = process.env[provider.keyVar];

  if (!key) {
    console.log(`  --    ${provider.id.padEnd(12)} ${provider.keyVar} not set (agent is disabled)`);
    return { id: provider.id, ok: null };
  }

  const result = await chat({
    base: provider.base,
    key,
    model: provider.model,
    content: 'Reply with the single word: ok',
    maxTokens: 64,
    timeoutMs: HOSTED_TIMEOUT_MS,
  });

  if (result.status === 200) {
    const text = result.json?.choices?.[0]?.message?.content || '';
    line(provider.id, true, `${provider.model} answered in ${result.ms} ms ${text ? `("${text.trim().slice(0, 20)}")` : ''}`);
    return { id: provider.id, ok: true };
  }

  line(provider.id, false, `${provider.model} -> HTTP ${result.status || 'no response'} in ${result.ms} ms`);
  console.log(`        why:     ${explain(result)}`);
  console.log(`        message: ${errorMessage(result)}`);

  return { id: provider.id, ok: false };
}

/* ------------------------------------------------------------------ */
/* Prompt-size check                                                    */
/* ------------------------------------------------------------------ */

const approxTokens = (text) => Math.ceil(String(text || '').length / 3.6);

function listFiles(dir, base = dir, out = []) {
  let entries = [];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name.startsWith('.')) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }

  return out;
}

async function serverContextSize(base) {
  const root = base.replace(/\/+$/, '').replace(/\/v1$/, '');

  try {
    const res = await fetch(`${root}/props`);
    const json = await res.json();

    return json?.default_generation_settings?.n_ctx ?? json?.n_ctx ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the FIRST message the agent would send for a typical subtask
 * (role prompt + tech stack + API contract + file lists + UI guides) and
 * measures it. Later tool rounds only ADD to this (file contents the agent
 * reads, its own replies), so whatever is left of the context window after
 * this and the reply cap is all the conversation gets.
 */
async function checkPromptBudget(provider, role) {
  let rolePrompts;

  try {
    rolePrompts = require('./rolePrompts');
  } catch (error) {
    console.log(`        prompt size (${role}): could not load rolePrompts.js (${error.message})`);
    return;
  }

  const frontendDir = path.resolve(__dirname, '../../frontend');
  const backendDir = path.resolve(__dirname, '../../backend');

  const context = rolePrompts.formatContext({
    role: role,
    techStack: { frontend: 'react', backend: 'express', database: 'postgresql' },
    apiContract: [
      { method: 'GET', path: '/api/tasks', description: 'List tasks' },
      { method: 'POST', path: '/api/tasks', description: 'Create a task' },
      { method: 'PATCH', path: '/api/tasks/:id', description: 'Update a task' },
      { method: 'DELETE', path: '/api/tasks/:id', description: 'Delete a task' },
    ],
    ownFiles: listFiles(role === 'backend' ? backendDir : path.join(frontendDir, 'src')),
    otherFiles: listFiles(role === 'backend' ? path.join(frontendDir, 'src') : backendDir),
  });

  let description = 'Render board with three status columns and task count headers';
  let guidesNote = '';

  try {
    const { withGuides } = require('./projectGuides');
    const withGuide = withGuides(description, role, frontendDir);

    guidesNote = ` (UI guides add ~${approxTokens(withGuide) - approxTokens(description)} tokens)`;
    description = withGuide;
  } catch (error) {
    guidesNote = ' (projectGuides not measured)';
  }

  const promptTokens = approxTokens(rolePrompts.getRolePrompt(role) + context + description);
  const ctx = (await serverContextSize(provider.base)) || ASSUMED_CTX;
  const room = ctx - promptTokens - LOCAL_MAX_TOKENS;

  console.log(
    `        prompt size (${role}): first message ≈ ${promptTokens} tokens${guidesNote}; context window ${ctx}; reply cap ${LOCAL_MAX_TOKENS}`
  );

  if (room < 1500) {
    console.log(
      `        PROBLEM (${role}): only ≈ ${Math.max(room, 0)} tokens are left for the whole conversation. Every file the agent reads or writes is re-sent each round, so it runs out of context after a couple of tool calls and the run ends with "wrote zero files". Fix: start llama-server with a bigger -c (16384 if RAM allows), and/or shrink the guides/context sent to local models.`
    );
  } else {
    console.log(`        prompt budget (${role}): OK (≈ ${room} tokens left for the conversation)`);
  }
}

async function checkLocal(provider) {
  const ping = await chat({
    base: provider.base,
    model: provider.model,
    content: 'Reply with the single word: ok',
    maxTokens: 16,
    timeoutMs: TIMEOUT_MS,
  });

  if (ping.status !== 200) {
    line(provider.id, false, `${provider.base} -> HTTP ${ping.status || 'no response'}`);
    console.log(`        why:     ${explain(ping)}`);
    console.log(`        message: ${errorMessage(ping)}`);
    return { id: provider.id, ok: false };
  }

  line(provider.id, true, `server answered in ${ping.ms} ms`);

  if (ping.ms > 20_000) {
    console.log(
      '        note:           a one-word reply took over 20 s. The model was still loading, or the machine is short of memory and swapping (two 7-8B models plus the browser can be too much for 8-16 GB). Check Activity Monitor > Memory pressure.'
    );
  }

  // Tool-call test: the agent loop needs ONE JSON object per turn.
  const toolPrompt =
    'You are a coding agent. Reply with ONLY one JSON object on one line, no other text: ' +
    '{"name":"write_file","arguments":{"path":"src/components/Hello.js","content":"<a complete React component file that renders a heading and a button>"}}';

  const tool = await chat({
    base: provider.base,
    model: provider.model,
    content: toolPrompt,
    maxTokens: LOCAL_MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });

  if (tool.status !== 200) {
    console.log(`        tool-call test: request failed (HTTP ${tool.status}). ${errorMessage(tool)}`);
    for (const role of provider.roles) await checkPromptBudget(provider, role);
    return { id: provider.id, ok: false };
  }

  const choice = tool.json?.choices?.[0];
  const raw = choice?.message?.content || '';
  const tokens = tool.json?.usage?.completion_tokens;
  const finish = choice?.finish_reason;

  let parsed = null;

  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    parsed = null;
  }

  // A stray "{}" inside prose or a code fence is not a tool call.
  if (!parsed || typeof parsed.name !== 'string') {
    parsed = null;
  }

  let ok = false;

  if (parsed?.name === 'write_file' && String(parsed.arguments?.content || '').length > 20) {
    console.log(`        tool-call test: OK (valid JSON tool call, ${tokens ?? '?'} tokens, ${tool.ms} ms)`);
    ok = true;
  } else {
    console.log('        tool-call test: FAILED');

    if (finish === 'length') {
      console.log(
        `        why:     the reply was cut off at ${LOCAL_MAX_TOKENS} tokens (finish_reason=length), so the JSON is incomplete. Real components are longer than this: raise LOCAL_MAX_TOKENS in agentRegistry.js.`
      );
    } else if (!parsed) {
      console.log('        why:     the model did not return a valid JSON object. This is the usual cause of "wrote zero files".');
    } else {
      console.log('        why:     JSON was valid but not a write_file call with real content.');
    }

    console.log(`        model said: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  // Speed: what a real file costs on this machine.
  if (tokens && tool.ms > 0) {
    const tps = tokens / (tool.ms / 1000);
    const minutesFor = (n) => Math.max(1, Math.round(n / tps / 60));

    console.log(
      `        speed:          ≈ ${tps.toFixed(1)} tokens/s end to end → a 800-token file ≈ ${minutesFor(800)} min, a 2000-token file ≈ ${minutesFor(2000)} min`
    );

    if (tps < 8) {
      console.log(
        '                        That is slow for a 7-8B model on Apple Silicon. Look at the llama-server startup log: if it says it offloaded 0 layers to the GPU, add -ngl 99; if memory pressure is high, run only one local model at a time.'
      );
    }
  }

  for (const role of provider.roles) await checkPromptBudget(provider, role);

  return { id: provider.id, ok };
}

async function main() {
  console.log('\nHosted models');
  const results = [];

  for (const provider of HOSTED) {
    results.push(await checkHosted(provider));
  }

  console.log('\nLocal models');

  for (const provider of LOCAL) {
    results.push(await checkLocal(provider));
  }

  const working = results.filter((r) => r.ok === true).map((r) => r.id);
  const broken = results.filter((r) => r.ok === false).map((r) => r.id);

  console.log(`\nWorking now: ${working.join(', ') || 'none'}`);

  if (broken.length > 0) {
    console.log(`Not working: ${broken.join(', ')}`);
    console.log('Put broken ones in DISABLED_AGENTS (comma separated, in .env) to stop the orchestrator wasting attempts on them.\n');
  }
}

main();