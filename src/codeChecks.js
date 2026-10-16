/**
 * Deterministic code checks used by genericAgent.js:
 *
 *  - syntaxError(): parses JS/JSX with @babel/parser so a broken file is
 *    rejected at write time (the model rewrites it immediately) instead of
 *    surviving until the build fails.
 *  - repairRelativeImports() / repairAllImports(): fixes relative imports
 *    that don't resolve when exactly ONE file with that name exists
 *    elsewhere in the project (e.g. './styles.css' -> '../styles.css').
 */

'use strict';

const fs = require('fs');
const path = require('path');

const JS_FILE = /\.(jsx?|mjs|cjs)$/i;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git']);
const RESOLVE_EXTS = ['', '.js', '.jsx', '.json', '.css'];

// import './x'   import X from './x'   require('./x')
const IMPORT_RE = /(\bfrom\s+|\bimport\s+|\brequire\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g;

/* ------------------------------------------------------------------ */
/* Syntax check                                                        */
/* ------------------------------------------------------------------ */

let parser = null;
let warnedNoParser = false;

function loadParser() {
  if (parser) return parser;

  const candidates = [
    '@babel/parser',
    // react-scripts installs this in the generated frontend
    path.resolve(__dirname, '../../frontend/node_modules/@babel/parser'),
  ];

  for (const candidate of candidates) {
    try {
      parser = require(candidate);
      return parser;
    } catch {
      // try the next location
    }
  }

  if (!warnedNoParser) {
    warnedNoParser = true;
    console.warn(
      '[codeChecks] @babel/parser not found — syntax pre-checks disabled. ' +
        'Run: npm i @babel/parser (in the orchestrator folder)'
    );
  }

  return null;
}

/**
 * Returns a short error string if the JS/JSX content has a syntax error,
 * otherwise null. Non-JS files (and a missing parser) always return null.
 */
function syntaxError(relPath, content) {
  if (!JS_FILE.test(String(relPath || ''))) return null;

  const babel = loadParser();
  if (!babel) return null;

  try {
    babel.parse(String(content || ''), {
      sourceType: 'unambiguous',
      plugins: ['jsx'],
    });
    return null;
  } catch (err) {
    const loc = err.loc ? ` (line ${err.loc.line}, column ${err.loc.column})` : '';
    const message = String(err.message || 'syntax error').replace(/\s*\(\d+:\d+\)\s*$/, '');
    return `${message}${loc}`;
  }
}

/* ------------------------------------------------------------------ */
/* Import repair                                                       */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(abs, out);
    } else {
      out.push(abs);
    }
  }

  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolvesToFile(fromDir, spec) {
  const base = path.resolve(fromDir, spec);

  for (const ext of RESOLVE_EXTS) {
    if (isFile(base + ext)) return true;
  }

  return isFile(path.join(base, 'index.js')) || isFile(path.join(base, 'index.jsx'));
}

function searchRootFor(ownDir, role) {
  const src = path.join(ownDir, 'src');
  return role === 'frontend' && fs.existsSync(src) ? src : ownDir;
}

function repairFile(absFile, allFiles) {
  let text;

  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch {
    return [];
  }

  const fromDir = path.dirname(absFile);
  const fixes = [];

  const next = text.replace(IMPORT_RE, (match, prefix, quote, spec) => {
    if (resolvesToFile(fromDir, spec)) return match;

    const wanted = path.basename(spec);
    const hasExt = /\.[a-z0-9]+$/i.test(wanted);

    const candidates = allFiles.filter((file) => {
      if (file === absFile) return false;

      const name = path.basename(file);

      if (hasExt) return name === wanted;

      return (
        /\.(jsx?|json)$/i.test(name) &&
        name.replace(/\.[^.]+$/, '') === wanted
      );
    });

    // Only fix when it is unambiguous.
    if (candidates.length !== 1) return match;

    let rel = path.relative(fromDir, candidates[0]).split(path.sep).join('/');

    if (!hasExt) rel = rel.replace(/\.jsx?$/i, '');
    if (!rel.startsWith('.')) rel = `./${rel}`;

    fixes.push(`${spec} -> ${rel}`);

    return `${prefix}${quote}${rel}${quote}`;
  });

  if (fixes.length > 0) {
    fs.writeFileSync(absFile, next);
  }

  return fixes;
}

/**
 * Repairs broken relative imports in ONE file (path relative to ownDir).
 * Returns a list of "old -> new" strings for what was changed.
 */
function repairRelativeImports(ownDir, relPath, role) {
  const root = path.resolve(ownDir);
  const abs = path.resolve(root, String(relPath || ''));

  if (!abs.startsWith(root + path.sep) || !JS_FILE.test(abs)) {
    return [];
  }

  const allFiles = walk(searchRootFor(ownDir, role));

  return repairFile(abs, allFiles);
}

/**
 * Repairs broken relative imports across every JS file in the project
 * (frontend/src for the frontend). Returns "file: old -> new" strings.
 */
function repairAllImports(ownDir, role) {
  const allFiles = walk(searchRootFor(ownDir, role));
  const results = [];

  for (const file of allFiles) {
    if (!JS_FILE.test(file)) continue;

    for (const fix of repairFile(file, allFiles)) {
      results.push(`${path.relative(ownDir, file)}: ${fix}`);
    }
  }

  return results;
}

module.exports = { syntaxError, repairRelativeImports, repairAllImports };