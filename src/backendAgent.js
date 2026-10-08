/**
 * Backend Agent
 *
 * Local Qwen Coder running through llama.cpp.
 *
 *   Qwen (backend):    http://127.0.0.1:8081/v1
 *   Llama (frontend):  http://127.0.0.1:8080/v1
 *   Orchestrator:      Groq
 *
 * Fixes vs. the previous version:
 *
 * 1. Text-emitted tool calls are extracted with a brace-depth scanner
 *    instead of a non-greedy regex, so file content containing braces no
 *    longer truncates and silently drops the write.
 *
 * 2. When calls arrive as text, results are fed back as `role: "user"`
 *    messages instead of an invalid `role: "tool"` turn with no matching
 *    tool_calls on the preceding assistant message.
 *
 * 3. A write is only counted when the tool reports success AND a path.
 *
 * 4. The prompt now hands each subtask its own file under routes/ and
 *    sql/, mounted/applied automatically by the host-managed server.js
 *    and db.js (see scaffold.js). Agents no longer share — and therefore
 *    can no longer clobber — server.js.
 *
 * 5. The assistant's own turn is compacted before being re-added to the
 *    conversation: written file content is replaced with a short marker
 *    instead of being kept in full. Without this, every write is stored
 *    twice (once on disk, once in chat history) and a handful of files
 *    overflows a 4k-token context window, producing a mid-task 500.
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

const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL || 'http://127.0.0.1:8081/v1';

// IMPORTANT:
// Check `curl http://127.0.0.1:8081/v1/models`
// and use the exact model ID returned there.
const QWEN_MODEL =
  process.env.QWEN_MODEL || 'Qwen2.5-Coder-7B-Instruct';

const MAX_TOOL_LOOPS = 10;
const MAX_EMPTY_NUDGES = 3;
const BACKEND_PORT = 5050;

const TOOL_NAMES = ['write_file', 'read_file', 'read_frontend_file'];

/*
 * Host-managed files, enforced in CODE rather than only in the prompt.
 *
 * A 7B model will ignore a "do not write this file" instruction under
 * pressure often enough that relying on the prompt alone regresses to
 * the exact bug this guard fixes: the agent rewrites server.js as a
 * monolith, dropping every other subtask's routes and reintroducing the
 * overwrite problem the routes/ convention exists to prevent.
 */
const PROTECTED_BACKEND_PATHS = new Set([
  'server.js',
  'db.js',
  'package.json',
]);

function normalizeRelPath(p) {
  return String(p || '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function isProtectedBackendPath(p) {
  return PROTECTED_BACKEND_PATHS.has(normalizeRelPath(p));
}

const SYSTEM_PROMPT = `You are the Backend Agent in a multi-agent development pipeline.

You are running locally using Qwen Coder.

Your job is to IMPLEMENT the requested backend task.

You have these tools:

1. read_file
   Reads an existing backend file.

2. read_frontend_file
   Reads an existing frontend file.

3. write_file
   Writes a file into the backend project.

IMPORTANT:

When you need to create or modify a file, you MUST request the
write_file tool.

The host application will execute the tool and save the file.

Never merely describe the implementation.

If your runtime does not support native function calling, emit the call as a
single JSON object on its own line, in this exact shape:

{"name": "write_file", "arguments": {"path": "routes/expenses.js", "content": "..."}}

Before modifying an existing file:
- call read_file first.

If you need to know what the frontend expects:
- call read_frontend_file.

File paths must be relative to the backend project.

Correct:
routes/auth.js
sql/002_expenses.sql
models/User.js

Incorrect:
backend/routes/auth.js
/Users/user/project/backend/routes/auth.js

OWNERSHIP — read this carefully:

- server.js, db.js and package.json already exist and are managed by the
  host application. NEVER write or modify them, even if they look
  incomplete — they are wired to load your files automatically.
- Every route file you write under routes/ is auto-mounted by server.js at
  /api/<filename-without-.js>. routes/auth.js becomes /api/auth,
  routes/expenses.js becomes /api/expenses. Export an Express Router
  (module.exports = router) or fastify plugin as appropriate.
- Put ONLY the endpoints for THIS subtask in your own route file. Never
  write a route file that another subtask already owns (check EXISTING
  BACKEND FILES below) — if one already covers this area, read it and add
  to it, don't replace unrelated file names.
- Access the shared connection by requiring ../db (it already exists and
  exports { pool, query, init }). Never construct your own connection.
- Create tables by writing sql/NNN_description.sql (e.g.
  sql/001_users.sql). These are applied automatically in filename order at
  startup. Never run DDL from inside a route file.
- Use process.env.JWT_SECRET for signing tokens (already defined in .env).

Rules:

- Actually implement the requested task.
- Preserve existing functionality in any file you read and modify.
- Do not invent unrelated features.
- ALWAYS use write_file for files you create or modify.
- ALWAYS ensure your route file's dependencies (e.g. jsonwebtoken,
  bcryptjs) are ones already listed in package.json; do not assume new
  packages are installed.
- Keep request fields and response fields consistent with the API contract so
  the frontend can use every implemented endpoint without a data-shape mismatch.
- You MUST write at least one file.
- Do not claim a file was written unless the write_file operation succeeds.

After the work is complete, give a short plain-text summary.
`;

function formatApiContract(apiContract) {
  if (!apiContract || apiContract.length === 0) {
    return '';
  }

  const lines = apiContract
    .map(
      (entry) =>
        `- ${entry.method} ${entry.path} — ${entry.description}`
    )
    .join('\n');

  return `

API CONTRACT:

Implement EXACTLY these endpoints.
Do not add unrelated endpoints.

${lines}
`;
}

function formatTechStack(techStack) {
  if (!techStack) return '';

  const backendInstructions = {
    express: `The server (server.js, host-managed) is Express. It auto-mounts every file in routes/. Just export a Router from your file.`,
    fastify: `The server (server.js, host-managed) is Fastify. It auto-mounts every file in routes/ as a plugin.`,
  };

  const databaseInstructions = {
    firebase:
      'Use Firebase Firestore and the firebase-admin SDK; read connection credentials from environment variables.',
    postgresql:
      'Use PostgreSQL via the shared pool from ../db (already configured from DATABASE_URL). Define schema in sql/NNN_*.sql files.',
    mongodb:
      'Use MongoDB with Mongoose; read MONGODB_URI from environment variables.',
    sqlite:
      'Use SQLite with a database file stored in the backend project; include the SQLite dependency.',
    memory:
      'Use an in-memory data store only; clearly keep it scoped to the running server process.',
  };

  return `\n\nSELECTED TECHNOLOGY STACK (must be followed):\n- Frontend: ${techStack.frontend}\n- Backend: ${techStack.backend}\n- Database: ${techStack.database}\n${backendInstructions[techStack.backend] || ''}\n${databaseInstructions[techStack.database] || ''}`;
}

function formatExistingFiles(files, label) {
  if (!files || files.length === 0) {
    return `

${label}: none yet.`;
  }

  return `

${label}:
${files.map((file) => `- ${file}`).join('\n')}`;
}

/**
 * Normalizes a native OpenAI tool call into { name, arguments }.
 */
function normalizeNativeCall(call) {
  const name = call.function?.name;
  const raw = call.function?.arguments;

  let args = {};

  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      args = {};
    }
  } else if (raw && typeof raw === 'object') {
    args = raw;
  }

  return { id: call.id, name, arguments: args };
}

/**
 * Plain-text stand-in for an assistant turn that wrote a file. Deliberately
 * NOT JSON shaped like a tool call — showing the model a message such as
 * {"name":"write_file","arguments":{"content":"<written to disk>"}} taught
 * it that a marker string is valid file content, and it later wrote that
 * exact literal text into real files. Plain prose can't be echoed back as
 * a "content" value.
 */
function compactAssistantTurn(call, fallbackText) {
  if (!call || !call.name) {
    return fallbackText || '';
  }

  if (call.name === 'write_file') {
    return `Wrote ${call.arguments?.path || 'a file'}.`;
  }

  if (call.name === 'read_file' || call.name === 'read_frontend_file') {
    return `Read ${call.arguments?.path || 'a file'}.`;
  }

  return `Called ${call.name}.`;
}

function executeToolCalls(toolCalls, toolMap, filesWritten) {
  const results = [];

  for (const call of toolCalls) {
    const tool = toolMap[call.name];

    let result;

    if (!tool) {
      result = {
        success: false,
        error: `Unknown tool: ${call.name}`,
      };
    } else if (
      tool.isWrite &&
      isProtectedBackendPath(call.arguments?.path)
    ) {
      result = {
        success: false,
        error:
          `"${call.arguments?.path}" is managed by the host application ` +
          'and cannot be modified. Put your endpoints in their own file ' +
          'under routes/, and schema in sql/NNN_name.sql.',
      };

      console.warn(
        `[backend-agent] blocked write to protected path: ${call.arguments?.path}`
      );
    } else if (tool.isWrite) {
      const validation = validateWrite(
        call.arguments?.path,
        call.arguments?.content,
        'backend'
      );

      if (!validation.valid) {
        result = { success: false, error: validation.error };

        console.warn(
          `[backend-agent] rejected write to ${call.arguments?.path}: ${validation.error}`
        );
      } else {
        try {
          result = tool.execute(call.arguments || {});
        } catch (err) {
          result = { success: false, error: err.message };
        }

        if (result?.success !== false && result?.path) {
          filesWritten.push(result.path);
          console.log(`[backend-agent] wrote: ${result.path}`);
        } else {
          console.warn(
            `[backend-agent] write failed: ${
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

      if (
        tool.isWrite &&
        result?.success !== false &&
        result?.path
      ) {
        filesWritten.push(result.path);
        console.log(`[backend-agent] wrote: ${result.path}`);
      } else if (tool.isWrite) {
        console.warn(
          `[backend-agent] write failed: ${
            result?.error || 'unknown error'
          }`
        );
      }
    }

    results.push({ call, result });
  }

  return results;
}

async function run(subtaskDescription, apiContract = [], techStack = null) {
  const qwen = new OpenAI({
    apiKey: 'local-qwen',
    baseURL: QWEN_BASE_URL,
  });

  const writeFileTool = createWriteFileTool(BACKEND_DIR);

  const readOwnTool = createReadFileTool(
    BACKEND_DIR,
    'read_file',
    'Read a file from the backend project. Path is relative to backend.'
  );

  const readFrontendTool = createReadFileTool(
    FRONTEND_DIR,
    'read_frontend_file',
    'Read a file from the frontend project. This is read-only. Path is relative to frontend.'
  );

  const filesWritten = [];

  const toolMap = {
    [writeFileTool.definition.function.name]: {
      execute: writeFileTool.execute,
      isWrite: true,
    },
    [readOwnTool.definition.function.name]: {
      execute: readOwnTool.execute,
      isWrite: false,
    },
    [readFrontendTool.definition.function.name]: {
      execute: readFrontendTool.execute,
      isWrite: false,
    },
  };

  const fullPrompt =
    subtaskDescription +
    formatTechStack(techStack) +
    formatApiContract(apiContract) +
    formatExistingFiles(
      listExistingFiles(BACKEND_DIR),
      'EXISTING BACKEND FILES'
    ) +
    formatExistingFiles(
      listExistingFiles(FRONTEND_DIR),
      'EXISTING FRONTEND FILES'
    );

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: fullPrompt },
  ];

  let emptyNudges = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    console.log(
      `[backend-agent] Qwen tool loop ${loop + 1}/${MAX_TOOL_LOOPS}`
    );

    let completion;

    try {
      completion = await qwen.chat.completions.create({
        model: QWEN_MODEL,
        messages,
        tools: [
          writeFileTool.definition,
          readOwnTool.definition,
          readFrontendTool.definition,
        ],
        temperature: 0.1,
      });
    } catch (err) {
      const message = err?.message || String(err);

      console.error(
        `[backend-agent] Qwen request failed (status=${err?.status ?? 'n/a'}):`,
        err?.error || message
      );

      if (
        message.includes('ECONNREFUSED') ||
        message.includes('fetch failed') ||
        message.includes('connect')
      ) {
        throw new Error(
          `Could not connect to local Qwen at ${QWEN_BASE_URL}.\n\n` +
            `Start llama.cpp first, then verify the model ID with:\n\n` +
            `  curl ${QWEN_BASE_URL}/models\n\nOriginal error:\n${message}`
        );
      }

      throw err;
    }

    const message = completion.choices?.[0]?.message;

    if (!message) {
      throw new Error('Qwen returned no message.');
    }

    // Preferred path: real OpenAI-style tool_calls.
    let calls = (message.tool_calls || []).map(normalizeNativeCall);
    let fromText = false;

    // Fallback path: the model printed the call as plain text.
    if (calls.length === 0) {
      const textCalls = parseTextToolCalls(
        message.content,
        TOOL_NAMES
      );

      if (textCalls.length > 0) {
        console.log(
          `[backend-agent] detected ${textCalls.length} tool call(s) emitted as text`
        );
        calls = textCalls;
        fromText = true;
      }
    }

    /* ---------- No tool calls at all ---------- */
    if (calls.length === 0) {
      if (filesWritten.length > 0) {
        return {
          summary:
            message.content || 'Backend implementation completed.',
          filesWritten,
        };
      }

      if (++emptyNudges > MAX_EMPTY_NUDGES) {
        return {
          summary:
            'Backend agent produced no tool calls and wrote no files.',
          filesWritten,
        };
      }

      messages.push({
        role: 'assistant',
        content: message.content || '',
      });

      messages.push({
        role: 'user',
        content:
          'You have not written any files yet. ' +
          'Use the write_file tool NOW to implement the task. ' +
          'If native function calling is unavailable, output a single JSON object ' +
          'of the form {"name": "write_file", "arguments": {"path": "...", "content": "..."}} ' +
          'and nothing else. Remember: write your endpoints to routes/<name>.js, ' +
          'never to server.js or db.js.',
      });

      continue;
    }

    emptyNudges = 0;

    /* ---------- Execute ---------- */
    const results = executeToolCalls(calls, toolMap, filesWritten);

    if (fromText) {
      // No native tool_calls exist on this turn, so a `role: "tool"`
      // reply would be invalid. Compact the write content out of the
      // stored turn so it isn't kept twice, then reply as a user turn.
      messages.push({
        role: 'assistant',
        content: calls
          .map((c) => compactAssistantTurn(c, message.content))
          .join('\n'),
      });

      for (const { call, result } of results) {
        messages.push({
          role: 'user',
          content:
            `Tool result for ${call.name}: ${JSON.stringify(result)}\n` +
            'Continue with the next tool call, or reply with a plain-text ' +
            'summary if the task is fully implemented.',
        });
      }
    } else {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: (message.tool_calls || []).map((tc) => ({
          ...tc,
          function: {
            ...tc.function,
            arguments: compactAssistantTurn(
              normalizeNativeCall(tc),
              '{}'
            ),
          },
        })),
      });

      for (const { call, result } of results) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
  }

  return {
    summary: `Stopped after ${MAX_TOOL_LOOPS} tool-call rounds.`,
    filesWritten,
  };
}

module.exports = {
  run,
  BACKEND_PORT,
};