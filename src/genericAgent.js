/**
 * One agent runner, used by every entry in the registry. Previously this
 * logic was duplicated (and drifting) between backendAgent.js and
 * frontendAgent.js. Now a "backend agent" and a "frontend agent" are just
 * this same loop called with a different `role` and a different model
 * client — which is what makes it possible for Gemini, Mistral, Qwen or
 * Llama to interchangeably pick up either kind of subtask.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  createWriteFileTool,
  createReadFileTool,
  listExistingFiles,
} = require('./tools');

const { parseTextToolCalls } = require('./jsonToolCalls');
const { validateWrite } = require('./contentGuard');
const { getRolePrompt, formatContext } = require('./rolePrompts');
const {
  syntaxError,
  repairRelativeImports,
  repairAllImports,
} = require('./codeChecks');

const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

const MAX_TOOL_LOOPS = 12;
const MAX_EMPTY_NUDGES = 3;

const TOOL_NAMES = ['write_file', 'read_file', 'read_other_file', 'done'];

const PROTECTED_PATHS = {
  backend: new Set(['server.js', 'db.js', 'package.json']),
  frontend: new Set([
    'package.json',
    'public/index.html',
    'src/index.js',
    'src/api.js',
  ]),
};

// Installed or generated folders. Agents must never write into these:
// a faked package under node_modules hides a missing dependency, and
// build output is regenerated on every validation round.
const GENERATED_DIR_PATTERN = /(^|\/)(node_modules|build|dist|\.git)(\/|$)/;

// A small model that "elides" instead of writing the whole file leaves a
// literal "..." (or a "rest of the file" comment) that breaks the build
// and, worse, overwrites a file an earlier subtask wrote correctly.
const PLACEHOLDER_PATTERNS = [
  /^\s*(\.\.\.|…)\s*$/m, // a line that is only "..."
  /(\/\/|\/\*|\{\/\*|#)\s*\.\.\.\s*(rest|existing|unchanged|same|previous|omitted|remaining|other)/i,
  /\(\s*(already written|unchanged|omitted|same as before|rest of (the )?file)[^)]*\)/i,
  /\b(rest of (the )?(file|code|component) (here|unchanged|remains)|code (remains|stays) (the )?(same|unchanged))\b/i,
];

const CODE_FILE = /\.(jsx?|tsx?|css|json|sql)$/i;

function placeholderReason(relPath, content) {
  const rel = String(relPath || '').toLowerCase();

  if (!CODE_FILE.test(rel)) {
    return null;
  }

  const text = String(content || '');

  if (/\.(jsx?|tsx?)$/.test(rel) && text.trim().length < 15) {
    return 'is almost empty, so it is not a real file';
  }

  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'contains a "..." placeholder instead of real code';
  }

  return null;
}

// Refuses a write that would replace most of an existing file with a
// fraction of its size (a truncated or elided rewrite).
function shrinkReason(ownDir, relPath, content) {
  try {
    const root = path.resolve(ownDir);
    const abs = path.resolve(root, String(relPath || ''));

    if (!abs.startsWith(root + path.sep)) {
      return null;
    }

    const existing = fs.readFileSync(abs, 'utf8');
    const next = String(content || '');

    if (existing.length > 400 && next.length < existing.length * 0.35) {
      return `would replace an existing ${existing.length}-character file with only ${next.length} characters`;
    }
  } catch {
    // The file does not exist yet, so there is nothing to protect.
  }

  return null;
}

function normalizeRelPath(p) {
  return String(p || '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function isProtected(role, relPath) {
  return PROTECTED_PATHS[role].has(normalizeRelPath(relPath));
}

function isGeneratedPath(relPath) {
  return GENERATED_DIR_PATTERN.test(normalizeRelPath(relPath));
}

function normalizeNativeToolCall(call) {
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
 * Plain-text stand-in for a completed call, so full file content isn't
 * kept twice in the running conversation. Deliberately NOT JSON shaped —
 * see backendAgent.js history / contentGuard.js for why a JSON-shaped
 * placeholder gets echoed back into real files by a fatigued model.
 */
function describeCall(name, args, fallbackText) {
  if (!name) return fallbackText || '';
  if (name === 'write_file') return `Wrote ${args?.path || 'a file'}.`;
  if (name === 'read_file' || name === 'read_other_file') {
    return `Read ${args?.path || 'a file'}.`;
  }
  return `Called ${name}.`;
}

async function runGenericAgent({
  role,
  client,
  agentId,
  subtaskDescription,
  apiContract,
  techStack,
}) {
  const ownDir = role === 'backend' ? BACKEND_DIR : FRONTEND_DIR;
  const otherDir = role === 'backend' ? FRONTEND_DIR : BACKEND_DIR;
  const otherLabel = role === 'backend' ? 'frontend' : 'backend';

  const writeFileTool = createWriteFileTool(ownDir);
  const readOwnTool = createReadFileTool(
    ownDir,
    'read_file',
    `Read a file from your own ${role} project.`
  );
  const readOtherTool = createReadFileTool(
    otherDir,
    'read_other_file',
    `Read a file from the ${otherLabel} project (read-only).`
  );

  const toolMap = {
    write_file: { execute: writeFileTool.execute, isWrite: true },
    read_file: { execute: readOwnTool.execute, isWrite: false },
    read_other_file: { execute: readOtherTool.execute, isWrite: false },
  };

  const toolDefs = [
    writeFileTool.definition,
    readOwnTool.definition,
    readOtherTool.definition,
  ];

  const filesWritten = [];
  let linesAdded = 0;

  const fullPrompt =
    subtaskDescription +
    formatContext({
      role,
      techStack,
      apiContract,
      ownFiles: listExistingFiles(ownDir),
      otherFiles: listExistingFiles(otherDir),
    });

  const messages = [
    { role: 'system', content: getRolePrompt(role) },
    { role: 'user', content: fullPrompt },
  ];

  // Token usage summed across every model call this run makes. Returned
  // on success and attached to thrown errors, so failed attempts still
  // report what they spent.
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  /**
   * Every successful return goes through here. Before handing control
   * back, sweep the whole project for relative imports that don't resolve
   * (e.g. './styles.css' written from src/components/ when the file lives
   * in src/) and fix the unambiguous ones. This also repairs files written
   * by EARLIER subtasks, so validation repair rounds actually converge.
   */
  function finish(summary) {
    try {
      for (const fix of repairAllImports(ownDir, role)) {
        console.log(`[${agentId}] auto-fixed import in ${fix}`);
      }
    } catch (err) {
      console.warn(`[${agentId}] import sweep failed: ${err.message}`);
    }

    return { summary, filesWritten, linesAdded, agentId, usage };
  }

  let emptyNudges = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    let message;

    try {
      message = await client.chat(messages, {
        tools: toolDefs,
        temperature: 0.1,
      });
    } catch (err) {
      const wrapped = new Error(
        `[${agentId}] request failed: ${err?.message || err}`
      );

      wrapped.usage = { ...usage };

      if (err?.isRateLimit) {
        wrapped.isRateLimit = true;
        wrapped.retryAfterMs = err.retryAfterMs;
        wrapped.reason = err.reason;
      }

      throw wrapped;
    }

    if (!message) {
      const empty = new Error(`[${agentId}] returned no message.`);
      empty.usage = { ...usage };
      throw empty;
    }

    if (message.usage) {
      usage.promptTokens += message.usage.promptTokens || 0;
      usage.completionTokens += message.usage.completionTokens || 0;
      usage.totalTokens += message.usage.totalTokens || 0;
    }

    let calls = [];
    let fromText = false;

    if (
      client.supportsNativeTools &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      calls = message.tool_calls.map(normalizeNativeToolCall);
    } else {
      const textCalls = parseTextToolCalls(message.content, TOOL_NAMES);

      if (textCalls.length > 0) {
        calls = textCalls;
        fromText = true;
      }
    }

    /* ---------- No calls: finished, or needs a nudge ---------- */
    if (calls.length === 0) {
      // Hosted models with reliable native tool calling stopping on
      // their own, having already written files, is a real finish.
      if (client.supportsNativeTools && filesWritten.length > 0) {
        return finish(message.content || 'Work completed.');
      }

      if (++emptyNudges > MAX_EMPTY_NUDGES) {
        return finish(
          message.content || `${agentId} produced no usable tool calls.`
        );
      }

      messages.push({ role: 'assistant', content: message.content || '' });
      messages.push({
        role: 'user',
        content:
          'You have not written any files yet, or have not signalled ' +
          'completion. Use write_file to implement the task, or respond ' +
          'with exactly {"name": "done", "arguments": {}} if everything ' +
          'required is already written.',
      });

      continue;
    }

    emptyNudges = 0;

    /* ---------- "done" sentinel ---------- */
    const doneCall = calls.find((c) => c.name === 'done');

    if (doneCall) {
      if (filesWritten.length === 0) {
        messages.push({
          role: 'assistant',
          content: 'Signalled done with zero files written.',
        });
        messages.push({
          role: 'user',
          content:
            'You signalled done but wrote zero files. Use write_file now.',
        });
        continue;
      }

      return finish(`Completed. Files: ${filesWritten.join(', ')}`);
    }

    /* ---------- Execute ---------- */
    const results = [];

    for (const call of calls) {
      const tool = toolMap[call.name];
      let result;

      if (!tool) {
        result = { success: false, error: `Unknown tool: ${call.name}` };
      } else if (tool.isWrite && isGeneratedPath(call.arguments?.path)) {
        result = {
          success: false,
          error:
            `"${call.arguments?.path}" is an installed or generated folder. ` +
            'Write only your own source files (src/, routes/, sql/). ' +
            'Packages you import are installed automatically.',
        };

        console.warn(
          `[${agentId}] blocked write to generated folder: ${call.arguments?.path}`
        );
      } else if (tool.isWrite && isProtected(role, call.arguments?.path)) {
        result = {
          success: false,
          error:
            `"${call.arguments?.path}" is managed by the host ` +
            'application and cannot be modified.',
        };

        console.warn(
          `[${agentId}] blocked write to protected path: ${call.arguments?.path}`
        );
      } else if (tool.isWrite) {
        const degenerate =
          placeholderReason(call.arguments?.path, call.arguments?.content) ||
          shrinkReason(ownDir, call.arguments?.path, call.arguments?.content);

        // Reject JS/JSX that doesn't even parse, so the model rewrites it
        // right now instead of the build failing later.
        const syntax = degenerate
          ? null
          : syntaxError(call.arguments?.path, call.arguments?.content);

        let validation;

        if (degenerate) {
          validation = {
            valid: false,
            error:
              `Write rejected: "${call.arguments?.path}" ${degenerate}. ` +
              'Write the COMPLETE file with every line of real code; ' +
              'never use "..." or comments like "rest of the file".',
          };
        } else if (syntax) {
          validation = {
            valid: false,
            error:
              `Write rejected: "${call.arguments?.path}" has a syntax error: ${syntax}. ` +
              'Rewrite the COMPLETE file with valid syntax — check for ' +
              'unbalanced braces/parentheses, unfinished statements and ' +
              'truncated output.',
          };
        } else {
          validation = validateWrite(
            call.arguments?.path,
            call.arguments?.content,
            role
          );
        }

        if (!validation.valid) {
          result = { success: false, error: validation.error };

          console.warn(
            `[${agentId}] rejected write to ${call.arguments?.path}: ${validation.error}`
          );
        } else {
          try {
            result = tool.execute(call.arguments || {});
          } catch (err) {
            result = { success: false, error: err.message };
          }

          if (result?.success !== false && result?.path) {
            filesWritten.push(result.path);
            linesAdded += String(call.arguments?.content || '')
              .split('\n').length;

            console.log(`[${agentId}] wrote: ${result.path}`);

            // Fix imports in the file we just wrote (e.g. './styles.css'
            // -> '../styles.css') while the model is still working.
            try {
              for (const fix of repairRelativeImports(ownDir, result.path, role)) {
                console.log(`[${agentId}] auto-fixed import in ${result.path}: ${fix}`);
              }
            } catch (err) {
              console.warn(`[${agentId}] import repair failed for ${result.path}: ${err.message}`);
            }
          } else {
            console.warn(
              `[${agentId}] write failed: ${result?.error || 'unknown error'}`
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

      results.push({ call, result });
    }

    /* ---------- Replay into history ---------- */
    if (fromText) {
      messages.push({
        role: 'assistant',
        content: calls
          .map((c) => describeCall(c.name, c.arguments, message.content))
          .join('\n'),
      });

      for (const { call, result } of results) {
        messages.push({
          role: 'user',
          content:
            `Tool result for ${call.name}: ${JSON.stringify(result)}\n` +
            'Continue with the next call, or respond with ' +
            '{"name":"done","arguments":{}} if finished.',
        });
      }
    } else {
      // Replay native tool_calls UNMODIFIED. A previous version rewrote
      // write_file's arguments to {content: "(already written)"} to save
      // context — but that plants a valid-looking JSON write_file call
      // in the model's own history with a placeholder as the "content"
      // value, and models with native tool calling apparently pattern-
      // match that shape closely enough to reproduce the literal
      // placeholder text into later, unrelated files. Hosted providers
      // (the only ones that actually reach this branch, since local
      // models fall through to the text-JSON path below) have context
      // windows in the 128k-262k range, so there's no real need to trim
      // this history the way the local-model text path does.
      messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls,
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

  return finish(`Stopped after ${MAX_TOOL_LOOPS} tool-call rounds.`);
}

module.exports = { runGenericAgent, placeholderReason, shrinkReason };