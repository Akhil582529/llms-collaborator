/**
 * Frontend Agent — uses a LOCAL Llama model through llama.cpp.
 *
 * This version does NOT send the `tools` parameter to llama.cpp. Passing
 * `tools` triggers llama.cpp's strict grammar-constrained native
 * tool-calling mode, which fails server-side (500 "does not match the
 * expected peg-native format") before any usable content reaches this
 * code. Tool usage is described in the prompt instead and the model's
 * plain-text JSON is parsed here.
 *
 * Fixes vs. the previous version:
 *
 * 1. The run no longer ends the instant the model emits a non-JSON
 *    response. An 8B model routinely says "I created App.js, next I'll
 *    add the styles" — treating that as "finished" is why CSS,
 *    package.json and entry files kept going missing. The agent now
 *    nudges (up to MAX_EMPTY_NUDGES times) and only stops on an explicit
 *    {"name": "done"} sentinel.
 *
 * 2. Tool-call extraction scans for the first JSON object that actually
 *    parses into a valid call, instead of blindly slicing from the first
 *    `{` in the response.
 *
 * 3. A write is only counted when the tool reports success AND a path.
 *
 * 4. package.json, public/index.html, src/index.js and src/api.js are
 *    now host-managed (see scaffold.js) — the prompt tells the agent not
 *    to touch them, so a subtask can no longer overwrite the app's entry
 *    point or wipe out CSS/dependencies another subtask relied on.
 *
 * 5. The assistant's own turn is compacted before being re-added to the
 *    conversation (written content replaced with a marker), so writing
 *    several components in a row doesn't overflow llama.cpp's context
 *    window mid-task.
 */

const path = require('path');
const OpenAI = require('openai');

const {
  createWriteFileTool,
  createReadFileTool,
  listExistingFiles,
} = require('./tools');

const { parseTextToolCalls } = require('./jsonToolCalls');
const { validateWrite } = require('./contentGuard');
const { BACKEND_PORT } = require('./backendAgent');

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');
const BACKEND_DIR = path.resolve(__dirname, '../../backend');

const MAX_TOOL_LOOPS = 14;
const MAX_EMPTY_NUDGES = 3;

const LLAMA_BASE_URL =
  process.env.LLAMA_BASE_URL || 'http://127.0.0.1:8080/v1';

const LLAMA_MODEL =
  process.env.LLAMA_MODEL || 'Llama-3.1-8B-Instruct';

const TOOL_NAMES = [
  'write_file',
  'read_file',
  'read_backend_file',
  'done',
];

/*
 * Host-managed files, enforced in CODE rather than only in the prompt —
 * see backendAgent.js for why the prompt alone isn't reliable enough.
 */
const PROTECTED_FRONTEND_PATHS = new Set([
  'package.json',
  'public/index.html',
  'src/index.js',
  'src/api.js',
]);

function normalizeRelPath(p) {
  return String(p || '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function isProtectedFrontendPath(p) {
  return PROTECTED_FRONTEND_PATHS.has(normalizeRelPath(p));
}

const SYSTEM_PROMPT = `You are the Frontend Agent in a multi-agent development pipeline.

You do NOT have native function/tool calling. Instead, to take an action,
respond with ONLY a single JSON object on its own — no other text before or
after it — in this exact shape:

{"name": "<tool_name>", "arguments": { ... }}

Available tools:

- write_file: Write a file to your frontend project.
  arguments: { "path": "relative/path.js", "content": "full file content" }

- read_file: Read an existing file from your frontend project.
  arguments: { "path": "relative/path.js" }

- read_backend_file: Read a file from the BACKEND project (read-only).
  arguments: { "path": "relative/path.js" }

- done: Signals that EVERY required file for THIS subtask has been written.
  arguments: {}

OWNERSHIP — read this carefully:

- package.json, public/index.html, src/index.js and src/api.js already
  exist and are managed by the host application. NEVER write or replace
  them.
- src/styles.css already exists with base dark-theme styling (cards,
  buttons, inputs, nav, tables). Read it before adding to it and only
  APPEND new rules for things it doesn't cover — never replace it
  wholesale, other subtasks' styling depends on what's already there.
- src/index.js already renders <App /> imported from './App' and imports
  './styles.css' — you do not need to create either wiring.
- ALL HTTP calls must go through src/api.js: import { get, post, put, del,
  setToken, getToken, clearToken } from './api'. Never call fetch()
  directly and never write your own request helper.
- Write ONE React component per file, named for what it does (e.g.
  Login.js, Dashboard.js). If a routing/wiring subtask asks you to
  assemble pages into App.js, only then should you write App.js.

Rules:

- Output EXACTLY ONE JSON tool call per response. Never combine multiple
  tool calls into one response, never add explanation text around the JSON.
- NEVER describe what you are about to do. Emit the tool call instead.
- You are NOT finished until every file THIS subtask is responsible for
  exists and is wired up (imported where it needs to be used).
- Before writing, consider using read_file on any existing frontend file you
  might need to extend, such as App.js or styles.css.
- If you're about to write code that calls a backend endpoint and aren't sure
  of the exact response shape, use read_backend_file first rather than
  guessing field names.
- Keep changes minimal and focused only on the requested subtask.
- Build clean, minimal, working code using the selected frontend framework;
  do not substitute React when Vue or Angular was selected.
- Do not invent unrelated features.
- When every required file for this subtask is written, respond with
  exactly:
  {"name": "done", "arguments": {}}
`;

function formatApiContract(apiContract) {
  if (!apiContract || apiContract.length === 0) return '';

  const lines = apiContract
    .map((e) => `- ${e.method} ${e.path} — ${e.description}`)
    .join('\n');

  return `\n\nAPI CONTRACT — call EXACTLY these endpoints, no more, no fewer, no path/method changes:\n${lines}`;
}

function formatTechStack(techStack) {
  if (!techStack) return '';

  const frontendInstructions = {
    react: `Use React functional components and hooks. Import react-router-dom for routing when needed (already in package.json). The backend is reachable via same-origin relative paths (e.g. '/api/expenses') thanks to the dev-server proxy — never hardcode http://localhost:${BACKEND_PORT}.`,
    vue: `Use Vue 3 composition API. vue-router is available when routing is needed. Call the backend via relative paths (e.g. '/api/expenses') — the dev-server proxy forwards them to http://localhost:${BACKEND_PORT}.`,
    angular: `Use Angular and TypeScript, following existing project conventions. Call the backend via relative paths (e.g. '/api/expenses') — the dev-server proxy forwards them to http://localhost:${BACKEND_PORT}.`,
  };

  return `\n\nSELECTED TECHNOLOGY STACK (must be followed):\n- Frontend: ${techStack.frontend}\n- Backend: ${techStack.backend}\n- Database: ${techStack.database}\n${frontendInstructions[techStack.frontend] || ''}`;
}

function formatExistingFiles(files, label) {
  if (!files || files.length === 0) return `\n\n${label}: none yet.`;
  return `\n\n${label} (you may need to read these before writing):\n${files
    .map((f) => `- ${f}`)
    .join('\n')}`;
}

/**
 * Returns the first JSON object in the response that parses into a valid
 * tool call, or null.
 */
function extractToolCall(content) {
  const calls = parseTextToolCalls(content, TOOL_NAMES);
  return calls.length > 0 ? calls[0] : null;
}

/**
 * Plain-text stand-in for an assistant turn that wrote a file. This is
 * deliberately NOT JSON shaped like a tool call: showing the model a
 * message such as {"name":"write_file","arguments":{"content":"<written
 * to disk>"}} taught it that a marker string is valid file content, and
 * it later wrote that exact literal text into real files (App.js, a SQL
 * file). Plain prose can't be echoed back as a "content" value.
 */
function compactAssistantTurn(call, fallbackText) {
  if (!call || !call.name) {
    return fallbackText || '';
  }

  if (call.name === 'write_file') {
    return `Wrote ${call.arguments?.path || 'a file'}.`;
  }

  if (call.name === 'read_file' || call.name === 'read_backend_file') {
    return `Read ${call.arguments?.path || 'a file'}.`;
  }

  return `Called ${call.name}.`;
}

async function run(subtaskDescription, apiContract = [], techStack = null) {
  const llama = new OpenAI({
    apiKey: 'local',
    baseURL: LLAMA_BASE_URL,
  });

  const writeFileTool = createWriteFileTool(FRONTEND_DIR);
  const readOwnTool = createReadFileTool(FRONTEND_DIR);
  const readBackendTool = createReadFileTool(
    BACKEND_DIR,
    'read_backend_file',
    'Read a file from the BACKEND project (read-only).'
  );

  const filesWritten = [];

  const toolMap = {
    write_file: { execute: writeFileTool.execute, isWrite: true },
    read_file: { execute: readOwnTool.execute, isWrite: false },
    read_backend_file: {
      execute: readBackendTool.execute,
      isWrite: false,
    },
  };

  const fullPrompt =
    subtaskDescription +
    formatTechStack(techStack) +
    formatApiContract(apiContract) +
    formatExistingFiles(
      listExistingFiles(FRONTEND_DIR),
      'EXISTING FRONTEND FILES (your own project)'
    ) +
    formatExistingFiles(
      listExistingFiles(BACKEND_DIR),
      'EXISTING BACKEND FILES (read-only, via read_backend_file)'
    );

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: fullPrompt },
  ];

  let emptyNudges = 0;

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    let completion;

    try {
      // NOTE: deliberately no `tools` param here — see file header.
      completion = await llama.chat.completions.create({
        model: LLAMA_MODEL,
        messages,
        temperature: 0.1,
      });
    } catch (err) {
      const message = err?.message || String(err);

      console.error(
        `[frontend-agent] Llama request failed (status=${err?.status ?? 'n/a'}):`,
        err?.error || message
      );

      if (
        message.includes('ECONNREFUSED') ||
        message.includes('fetch failed') ||
        message.includes('connect')
      ) {
        throw new Error(
          `Could not connect to local Llama at ${LLAMA_BASE_URL}.\n\nMake sure llama.cpp is running first:\n\n  llama-server -hf modularai/Llama-3.1-8B-Instruct-GGUF:Q4_K_M --port 8080 -c 16384\n\nOriginal error:\n${message}`
        );
      }

      throw err;
    }

    const choice = completion.choices?.[0];

    if (!choice || !choice.message) {
      throw new Error('Local Llama returned an invalid response.');
    }

    const content = choice.message.content || '';
    const call = extractToolCall(content);

    /* ---------- Model replied with prose instead of a call ---------- */
    if (!call) {
      if (++emptyNudges > MAX_EMPTY_NUDGES) {
        console.warn(
          '[frontend-agent] giving up after repeated non-tool-call responses'
        );

        return {
          summary: content || 'Frontend work ended without a done signal.',
          filesWritten,
        };
      }

      console.warn(
        `[frontend-agent] no tool call in response (nudge ${emptyNudges}/${MAX_EMPTY_NUDGES})`
      );

      messages.push({ role: 'assistant', content });

      messages.push({
        role: 'user',
        content:
          'That was not a tool call. Respond with ONLY one JSON tool call ' +
          'object and no other text.\n' +
          `Files written so far: ${
            filesWritten.join(', ') || 'none'
          }.\n` +
          'If files this subtask is responsible for are still missing, ' +
          'write them now with write_file. If everything for this subtask ' +
          'is genuinely complete, respond with exactly ' +
          '{"name": "done", "arguments": {}}.',
      });

      continue;
    }

    emptyNudges = 0;

    /* ---------- Explicit completion ---------- */
    if (call.name === 'done') {
      if (filesWritten.length === 0) {
        messages.push({
          role: 'assistant',
          content: compactAssistantTurn(call, content),
        });
        messages.push({
          role: 'user',
          content:
            'You signalled done but wrote zero files. Use write_file to ' +
            'implement the subtask now.',
        });
        continue;
      }

      console.log(
        `[frontend-agent] done — ${filesWritten.length} file(s) written`
      );

      return {
        summary: `Frontend work completed. Files: ${filesWritten.join(', ')}`,
        filesWritten,
      };
    }

    /* ---------- Execute ---------- */
    const tool = toolMap[call.name];
    let result;

    if (!tool) {
      result = { success: false, error: `Unknown tool: ${call.name}` };
    } else if (
      tool.isWrite &&
      isProtectedFrontendPath(call.arguments?.path)
    ) {
      result = {
        success: false,
        error:
          `"${call.arguments?.path}" is managed by the host application ` +
          'and cannot be modified. Write your component to its own file ' +
          "and import it from App.js instead.",
      };

      console.warn(
        `[frontend-agent] blocked write to protected path: ${call.arguments?.path}`
      );
    } else if (tool.isWrite) {
      const validation = validateWrite(
        call.arguments?.path,
        call.arguments?.content,
        'frontend'
      );

      if (!validation.valid) {
        result = { success: false, error: validation.error };

        console.warn(
          `[frontend-agent] rejected write to ${call.arguments?.path}: ${validation.error}`
        );
      } else {
        try {
          result = tool.execute(call.arguments || {});
        } catch (err) {
          result = { success: false, error: err.message };
        }

        if (result?.success !== false && result?.path) {
          filesWritten.push(result.path);
          console.log(`[frontend-agent] wrote: ${result.path}`);
        } else {
          console.warn(
            `[frontend-agent] write failed: ${
              result?.error || 'unknown error'
            }`
          );
        }
      }
    } else {
      try {
        result = tool.execute(call.arguments || {});
      } catch (err) {
        result = { success: false, error: err.message };
      }
    }

    messages.push({
      role: 'assistant',
      content: compactAssistantTurn(call, content),
    });

    messages.push({
      role: 'user',
      content:
        `Tool result for ${call.name}: ${JSON.stringify(result)}\n` +
        'Emit the next single JSON tool call, or {"name": "done", ' +
        '"arguments": {}} if every required file now exists.',
    });
  }

  return {
    summary: `Stopped after ${MAX_TOOL_LOOPS} tool-call rounds (safety cap reached).`,
    filesWritten,
  };
}

module.exports = { run };