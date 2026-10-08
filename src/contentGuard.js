/**
 * Write-time content guard, shared by both agents.
 *
 * Two independent problems this catches before a bad write reaches disk:
 *
 * 1. Placeholder / empty content. A local model under context pressure
 *    can echo back a marker or summary string instead of real file
 *    content (e.g. it has previously written "<written to disk>" into
 *    App.js and a .sql file after seeing that exact string in its own
 *    compacted chat history).
 *
 * 2. Actual JS syntax errors, e.g. "missing ) after argument list". For
 *    backend files (plain CommonJS, no JSX) this is checked for real
 *    with `node --check`, which needs no extra dependency. Frontend
 *    files use JSX, which `node --check` cannot parse, so only the
 *    cheap placeholder/length heuristics apply there.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PLACEHOLDER_PATTERNS = [
  /^\s*<written to disk>\s*$/i,
  /^\s*written to disk\.?\s*$/i,
  /^\s*\[?omitted\]?\.?\s*$/i,
  /^\s*<[a-z0-9 _-]*>\s*$/i, // any single bare "<...>" placeholder line
];

function looksLikePlaceholder(content) {
  if (typeof content !== 'string') return true;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

function checkNodeSyntax(content) {
  const tmpFile = path.join(
    os.tmpdir(),
    `syntax-check-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  );

  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    execFileSync(process.execPath, ['--check', tmpFile], {
      stdio: 'pipe',
    });
    return { valid: true };
  } catch (err) {
    const raw = (
      err.stderr?.toString() ||
      err.message ||
      String(err)
    ).trim();

    // Keep just the useful first couple of lines (the actual error),
    // not the full stack.
    const message = raw.split('\n').slice(0, 3).join(' ').trim();

    return { valid: false, error: message || 'Unknown syntax error.' };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
}

/**
 * @param {string} relPath   the path the agent is trying to write
 * @param {string} content   the file content
 * @param {'backend'|'frontend'} kind
 * @returns {{ valid: boolean, error?: string }}
 */
function validateWrite(relPath, content, kind) {
  if (looksLikePlaceholder(content)) {
    return {
      valid: false,
      error:
        'The content you provided is empty or a placeholder, not real ' +
        'file content. Write the full, real implementation — never a ' +
        'summary, a marker, or a note saying a file "was written".',
    };
  }

  if (kind === 'backend' && /\.js$/i.test(String(relPath))) {
    const result = checkNodeSyntax(content);

    if (!result.valid) {
      return {
        valid: false,
        error: `Syntax error in the file you tried to write: ${result.error}`,
      };
    }
  }

  return { valid: true };
}

module.exports = { validateWrite, looksLikePlaceholder };