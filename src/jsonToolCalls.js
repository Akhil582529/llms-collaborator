/**
 * Shared helpers for parsing tool calls that a local model emitted as
 * plain text instead of as real OpenAI-style `tool_calls`.
 *
 * The important part is `findJsonObjects`: it scans with brace depth and
 * string/escape awareness, so a file body containing `{`, `}` or escaped
 * quotes does NOT truncate the object. A non-greedy regex cannot do this
 * and will silently drop almost every write_file call whose content is
 * real source code.
 */

'use strict';

/**
 * Some local models emit invalid escapes like `\ ` inside JSON strings.
 * Strip a backslash that precedes whitespace before retrying the parse.
 */
function repairCommonJsonEscapeErrors(text) {
  return text.replace(/\\(\s)/g, '$1');
}

/**
 * Returns every top-level balanced `{...}` substring in `text`, in order.
 */
function findJsonObjects(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const objects = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (ch === '\\') {
        escapeNext = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;

        if (depth === 0) {
          objects.push(text.slice(i, j + 1));
          i = j; // continue scanning after this object
          break;
        }
      }
    }
  }

  return objects;
}

function parseJsonLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(repairCommonJsonEscapeErrors(raw));
    } catch {
      return null;
    }
  }
}

/**
 * Extracts every `{ "name": ..., "arguments": {...} }` tool call in the
 * text whose name is in `allowedNames`.
 *
 * Returns: [{ name, arguments }]
 */
function parseTextToolCalls(content, allowedNames) {
  const allowed = new Set(allowedNames);
  const calls = [];

  for (const raw of findJsonObjects(content)) {
    const parsed = parseJsonLoose(raw);

    if (!parsed || typeof parsed.name !== 'string') {
      continue;
    }

    if (!allowed.has(parsed.name)) {
      continue;
    }

    calls.push({
      name: parsed.name,
      arguments: parsed.arguments || parsed.parameters || {},
    });
  }

  return calls;
}

/**
 * Convenience wrapper for the single-call-per-response protocol.
 */
function parseFirstTextToolCall(content, allowedNames) {
  const calls = parseTextToolCalls(content, allowedNames);
  return calls.length > 0 ? calls[0] : null;
}

module.exports = {
  findJsonObjects,
  parseJsonLoose,
  parseTextToolCalls,
  parseFirstTextToolCall,
  repairCommonJsonEscapeErrors,
};