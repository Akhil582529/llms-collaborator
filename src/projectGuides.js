'use strict';

/*
 * Host-side quality levers that do not depend on which model is picked:
 *
 *  1. UI kit: a ready-made stylesheet (cards, buttons, inputs, toasts,
 *     modal, skeletons, dark mode, responsive grid) written into the
 *     generated frontend and imported from the host-managed src/index.js,
 *     so even a small model produces a styled page.
 *  2. Guides: short rules appended to every generation subtask so agents
 *     build a finished-looking, interactive UI and connect to the backend
 *     through the same field names and response shapes.
 *  3. Stack check: logs what the scaffold actually wrote next to what you
 *     chose, so a stack that is only partly supported shows up in the log.
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* 1. UI kit                                                           */
/* ------------------------------------------------------------------ */

const UI_KIT_CSS = `/* ui-kit.css — host-managed design system. Extend in styles.css. */
:root {
  --bg: #f6f7fb; --surface: #ffffff; --text: #1c2030; --muted: #667085;
  --border: #e4e7ee; --primary: #4f46e5; --primary-hover: #4338ca;
  --danger: #dc2626; --success: #16a34a; --warning: #d97706;
  --radius: 12px; --shadow: 0 1px 2px rgba(16,24,40,.06), 0 6px 20px rgba(16,24,40,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1220; --surface: #181c2e; --text: #eef0f8; --muted: #9aa3b8;
    --border: #272c44; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 20px rgba(0,0,0,.35);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5;
}
h1, h2, h3 { line-height: 1.25; margin: 0 0 .5rem; }
h1 { font-size: 1.9rem; } h2 { font-size: 1.35rem; }
p { margin: 0 0 .75rem; } a { color: var(--primary); }
.container { max-width: 960px; margin: 0 auto; padding: 2rem 1.25rem; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.subtitle { color: var(--muted); }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow); padding: 1.25rem; transition: transform .15s ease, box-shadow .15s ease;
}
.card.hoverable:hover { transform: translateY(-2px); }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.stack { display: flex; flex-direction: column; gap: .75rem; }
.row, .toolbar { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  padding: .55rem 1rem; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer;
  transition: background .15s ease, transform .1s ease, box-shadow .15s ease, opacity .15s ease;
}
.btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow); }
.btn:active:not(:disabled) { transform: translateY(0); }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn-ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn-ghost:hover:not(:disabled) { background: var(--border); box-shadow: none; }
.label { display: block; font-weight: 600; font-size: .9rem; margin-bottom: .3rem; }
.input, select.input, textarea.input {
  width: 100%; padding: .6rem .8rem; font: inherit; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
textarea.input { min-height: 110px; resize: vertical; }
.input:focus, .btn:focus-visible { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79,70,229,.25); }
.input.invalid { border-color: var(--danger); }
.field-error { color: var(--danger); font-size: .85rem; margin-top: .25rem; }
.badge {
  display: inline-block; padding: .15rem .6rem; border-radius: 999px; font-size: .78rem; font-weight: 600;
  background: var(--border); color: var(--text);
}
.badge-primary { background: rgba(79,70,229,.15); color: var(--primary); }
.badge-success { background: rgba(22,163,74,.15); color: var(--success); }
.badge-danger { background: rgba(220,38,38,.15); color: var(--danger); }
.badge-warning { background: rgba(217,119,6,.15); color: var(--warning); }
.spinner {
  width: 1.1rem; height: 1.1rem; border-radius: 50%; display: inline-block;
  border: 2px solid var(--border); border-top-color: var(--primary); animation: kit-spin .7s linear infinite;
}
@keyframes kit-spin { to { transform: rotate(360deg); } }
.skeleton {
  border-radius: 8px; min-height: 1rem; background: linear-gradient(90deg, var(--border) 25%, transparent 50%, var(--border) 75%);
  background-size: 200% 100%; animation: kit-shimmer 1.2s infinite;
}
@keyframes kit-shimmer { to { background-position: -200% 0; } }
.empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; border: 2px dashed var(--border); border-radius: var(--radius); }
.alert { padding: .75rem 1rem; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
.alert-error { border-color: var(--danger); color: var(--danger); }
.alert-success { border-color: var(--success); color: var(--success); }
.toast-region { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; z-index: 50; }
.toast {
  background: var(--text); color: var(--bg); padding: .7rem 1rem; border-radius: 10px; box-shadow: var(--shadow);
  animation: kit-in .2s ease;
}
.toast.success { background: var(--success); color: #fff; } .toast.error { background: var(--danger); color: #fff; }
@keyframes kit-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(10,12,24,.55); display: flex; align-items: center;
  justify-content: center; padding: 1rem; z-index: 40; animation: kit-fade .15s ease;
}
.modal { background: var(--surface); border-radius: var(--radius); padding: 1.5rem; max-width: 440px; width: 100%; box-shadow: var(--shadow); animation: kit-in .2s ease; }
@keyframes kit-fade { from { opacity: 0; } to { opacity: 1; } }
.dropzone {
  border: 2px dashed var(--border); border-radius: var(--radius); padding: 2rem 1rem; text-align: center;
  color: var(--muted); cursor: pointer; transition: border-color .15s ease, background .15s ease;
}
.dropzone:hover, .dropzone.active { border-color: var(--primary); background: rgba(79,70,229,.06); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid var(--border); }
@media (max-width: 600px) { .container { padding: 1.25rem .9rem; } h1 { font-size: 1.5rem; } }
`;

const KIT_FILE = 'ui-kit.css';

// Writes src/ui-kit.css and makes the host-managed src/index.js import it
// (as its first line, so the project's own styles.css can still override).
function installUiKit(frontendDir) {
  const srcDir = path.join(frontendDir, 'src');

  if (!fs.existsSync(srcDir)) {
    throw new Error('frontend/src does not exist; scaffold has not run');
  }

  fs.writeFileSync(path.join(srcDir, KIT_FILE), UI_KIT_CSS);

  const indexPath = path.join(srcDir, 'index.js');

  if (!fs.existsSync(indexPath)) {
    return { written: true, imported: false };
  }

  const index = fs.readFileSync(indexPath, 'utf8');

  if (index.includes(KIT_FILE)) {
    return { written: true, imported: true };
  }

  fs.writeFileSync(indexPath, `import './${KIT_FILE}';\n${index}`);

  return { written: true, imported: true };
}

/* ------------------------------------------------------------------ */
/* 2. Guides appended to generation subtasks                           */
/* ------------------------------------------------------------------ */

const FRONTEND_GUIDE = `

UI QUALITY REQUIREMENTS (the page must look and feel like a finished product, not a plain HTML form):
- A shared stylesheet src/ui-kit.css is already loaded. Use its classes: .container, .header, .subtitle, .card (.hoverable), .grid, .stack, .row/.toolbar, .btn (.btn-primary, .btn-danger, .btn-ghost), .label, .input, .field-error, .badge (.badge-primary/-success/-danger/-warning), .spinner, .skeleton, .empty, .alert (.alert-error/.alert-success), .toast-region + .toast (.success/.error), .modal-backdrop + .modal, .dropzone, .table. Put anything the kit lacks in src/styles.css; never remove the kit's classes.
- Every screen needs a header with a title and subtitle, a loading state while fetching (.spinner or .skeleton), an empty state (.empty) with a hint, a readable error message (.alert-error), and buttons disabled while a request is in flight.
- Make it interactive: validate forms inline, update the list immediately after add/delete without a page reload, confirm destructive actions in a .modal, show a .toast after success or failure, submit on Enter, and keep visible focus styles.
- The layout must work at 375px wide, with hover/transition effects on buttons and cards.

DATA CONNECTION RULES:
- Call the backend only through the helpers in src/api.js (read it first). Use the exact endpoint paths and field names from the API contract.
- Before using a response, read the backend route file (read_other_file routes/<name>.js) and use exactly the fields it returns. Keep list state an array: setItems(Array.isArray(data) ? data : []).
- When a component receives props, read that component's file first and pass exactly the prop names it declares.`;

const BACKEND_GUIDE = `

API CONVENTIONS:
- Use the exact paths, JSON field names and response shapes from the API contract. Unless the contract says otherwise: list endpoints return a bare JSON array, single-item endpoints return a bare JSON object, create returns the created object with status 201, and errors return {"error": "<message>"} with a 4xx/5xx status.
- Put the SQL for every table you use in sql/NNN_name.sql (applied at startup). Never query a table you did not create.
- Wrap each handler in try/catch and call console.error(error) with the full error before responding 500.
- Validate required fields and return 400 with a helpful {"error": ...} instead of crashing.`;

// Repair prompts already carry precise errors; extra rules would only
// dilute them.
const REPAIR_PREFIX = /^(AUTOMATED PROJECT VALIDATION FAILED|The generated frontend failed)/;

// src/api.js is host-managed, so an agent that imports a helper it does
// not export (for example `patch`) cannot fix it by editing api.js and
// the build fails every round. Tell agents what it really provides.
function apiExports(frontendDir) {
  try {
    const text = fs.readFileSync(path.join(frontendDir, 'src', 'api.js'), 'utf8');
    const names = new Set();

    for (const match of text.matchAll(
      /export\s+(?:async\s+)?(?:const|let|var|function)\s+(\w+)/g
    )) {
      names.add(match[1]);
    }

    for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop();

        if (name) names.add(name);
      }
    }

    return { names: [...names], hasDefault: /export\s+default\b/.test(text) };
  } catch {
    return null;
  }
}

function apiNote(frontendDir) {
  const info = frontendDir ? apiExports(frontendDir) : null;

  if (!info || (info.names.length === 0 && !info.hasDefault)) {
    return '';
  }

  const parts = [];

  if (info.names.length) parts.push(`the named exports ${info.names.join(', ')}`);
  if (info.hasDefault) parts.push('a default export');

  return (
    `\n- src/api.js is host-managed and you CANNOT edit it. It provides ${parts.join(' and ')}. ` +
    'Import only those. For an HTTP method it does not provide (for example PATCH), ' +
    "call fetch('/api/...', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) directly."
  );
}

function withGuides(description, domain, frontendDir) {
  const text = String(description || '');

  if (REPAIR_PREFIX.test(text)) {
    return text;
  }

  if (domain === 'frontend') return text + FRONTEND_GUIDE + apiNote(frontendDir);
  if (domain === 'backend') return text + BACKEND_GUIDE;

  return text;
}

/* ------------------------------------------------------------------ */
/* 3. Stack check                                                      */
/* ------------------------------------------------------------------ */

const EXPECTED_DEPS = {
  backend: {
    express: ['express'],
    fastify: ['fastify'],
    koa: ['koa'],
    nestjs: ['@nestjs/core'],
  },
  database: {
    postgresql: ['pg'],
    postgres: ['pg'],
    sqlite: ['sqlite3', 'better-sqlite3', 'sqlite'],
    mysql: ['mysql2', 'mysql'],
    mongodb: ['mongoose', 'mongodb'],
  },
  frontend: {
    react: ['react'],
    vue: ['vue'],
    angular: ['@angular/core'],
    svelte: ['svelte'],
  },
};

function readDeps(dir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    );

    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return null;
  }
}

// Returns log lines comparing the chosen stack with what was scaffolded.
function checkStack(techStack, backendDir, frontendDir) {
  const chosen = techStack || {};
  const backendDeps = readDeps(backendDir);
  const frontendDeps = readDeps(frontendDir);

  const lines = [
    `[stack-check] chosen: backend=${chosen.backend || '?'}, database=${chosen.database || '?'}, frontend=${chosen.frontend || '?'}`,
  ];

  const verdict = (label, value, deps, expectedMap) => {
    if (!value) return;

    if (!deps) {
      lines.push(`[stack-check] ${label}: could not read package.json`);
      return;
    }

    const expected = expectedMap[String(value).toLowerCase()];

    if (!expected) {
      lines.push(
        `[stack-check] ${label}="${value}": no rule for this choice (cannot confirm it is honored)`
      );
      return;
    }

    const found = expected.filter((dep) => deps.includes(dep));

    lines.push(
      found.length
        ? `[stack-check] ${label}=${value}: OK (${found.join(', ')} in package.json)`
        : `[stack-check] ${label}=${value}: MISMATCH — none of ${expected.join(', ')} in package.json`
    );
  };

  verdict('backend', chosen.backend, backendDeps, EXPECTED_DEPS.backend);
  verdict('database', chosen.database, backendDeps, EXPECTED_DEPS.database);
  verdict('frontend', chosen.frontend, frontendDeps, EXPECTED_DEPS.frontend);

  return lines;
}

module.exports = {
  installUiKit,
  withGuides,
  checkStack,
  UI_KIT_CSS,
  FRONTEND_GUIDE,
  BACKEND_GUIDE,
};