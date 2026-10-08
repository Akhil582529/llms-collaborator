/**
 * Deterministic project scaffolding.
 *
 * Call this once per task, AFTER the tech stack is chosen and BEFORE any
 * agent runs. It writes every file that agents keep getting wrong:
 * package.json, entry points, CSS, the API client, the DB pool.
 *
 * The critical design choice: backend/server.js auto-mounts every file in
 * backend/routes/, so no two backend subtasks ever write the same file.
 * That removes the overwrite problem instead of prompting around it.
 *
 * Existing files are never clobbered (except when force = true), so this is
 * safe to call again on a change request.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_PORT = 5050;

function writeIfAbsent(dir, relPath, content, force = false) {
  const full = path.join(dir, relPath);

  if (!force && fs.existsSync(full)) {
    return null;
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');

  return relPath;
}

/* ------------------------------------------------------------------ */
/* Backend                                                             */
/* ------------------------------------------------------------------ */

const DB_DEPENDENCIES = {
  postgresql: { pg: '^8.11.3' },
  mongodb: { mongoose: '^8.0.0' },
  sqlite: { 'better-sqlite3': '^9.2.2' },
  firebase: { 'firebase-admin': '^12.0.0' },
  memory: {},
};

function backendPackageJson(techStack, requirement = '') {
  const needsUploads = /upload|multipart|attach|\bfiles?\b/i.test(requirement);
  const needsImaging = /image|photo|scan|ocr|tamper|document|verif/i.test(
    requirement
  );

  const base =
    techStack.backend === 'fastify'
      ? { fastify: '^4.25.0', '@fastify/cors': '^8.5.0' }
      : { express: '^4.18.2', cors: '^2.8.5' };

  return JSON.stringify(
    {
      name: 'generated-backend',
      version: '1.0.0',
      private: true,
      main: 'server.js',
      scripts: {
        start: 'node server.js',
      },
      dependencies: {
        ...base,
        ...(DB_DEPENDENCIES[techStack.database] || {}),
        dotenv: '^16.3.1',
        jsonwebtoken: '^9.0.2',
        bcryptjs: '^2.4.3',
        ...(needsUploads ? { multer: '^1.4.5-lts.1' } : {}),
        ...(needsImaging
          ? { sharp: '^0.33.2', 'tesseract.js': '^5.0.4' }
          : {}),
      },
    },
    null,
    2
  );
}

const EXPRESS_SERVER = `/**
 * Managed by the orchestrator. Agents must NOT edit this file.
 *
 * Every file in ./routes is mounted automatically at /api/<filename>.
 * routes/auth.js  ->  /api/auth
 * routes/expenses.js -> /api/expenses
 *
 * A route file may export either an Express Router directly, or
 * { basePath, router } to override the mount path.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const routesDir = path.join(__dirname, 'routes');

if (fs.existsSync(routesDir)) {
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.js')) continue;

    let mod;

    try {
      mod = require(path.join(routesDir, file));
    } catch (err) {
      console.error('[server] failed to load route ' + file + ':', err.message);
      continue;
    }

    const router = mod && mod.router ? mod.router : mod;
    const basePath =
      (mod && mod.basePath) || '/api/' + file.replace(/\\.js$/, '');

    if (typeof router !== 'function') {
      console.error('[server] ' + file + ' did not export a router');
      continue;
    }

    app.use(basePath, router);
    console.log('[server] mounted ' + basePath + ' from routes/' + file);
  }
}

app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || ${BACKEND_PORT};

async function start() {
  try {
    const db = require('./db');
    if (db && typeof db.init === 'function') {
      await db.init();
      console.log('[server] database ready');
    }
  } catch (err) {
    console.error('[server] database init failed:', err.message);
  }

  app.listen(PORT, () => {
    console.log('[server] listening on http://localhost:' + PORT);
  });
}

start();
`;

const PG_DB = `/**
 * Managed by the orchestrator. Agents must NOT edit this file.
 *
 * Exposes a shared pg Pool and runs every .sql file in ./sql (sorted by
 * filename) at startup. Agents create schema by writing sql/001_name.sql,
 * never by running DDL inline.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function init() {
  try {
    await pool.query('SELECT 1');
    console.log('[db] connected');
  } catch (err) {
    console.error(
      '[db] CONNECTION FAILED: ' + err.message +
        ' (check DATABASE_URL in backend/.env)'
    );
    throw err;
  }

  const sqlDir = path.join(__dirname, 'sql');

  if (!fs.existsSync(sqlDir)) return;

  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');

    try {
      await pool.query(sql);
      console.log('[db] applied ' + file);
    } catch (err) {
      console.error('[db] failed on ' + file + ':', err.message);
    }
  }
}

module.exports = { pool, query: (t, p) => pool.query(t, p), init };
`;

/**
 * The real DATABASE_URL comes from, in order:
 *  1. databaseUrl: the per-project database made by projectDb.js
 *  2. GENERATED_DATABASE_URL in the orchestrator's .env
 *  3. a local default using your OS username (no password), database "app"
 * No project name is baked in any more (this used to be ".../expenses").
 */
function envFile(databaseUrl) {
  const url =
    databaseUrl ||
    process.env.GENERATED_DATABASE_URL ||
    `postgresql://${process.env.USER || 'postgres'}@localhost:5432/app`;

  return (
    `DATABASE_URL=${url}\n` +
    `JWT_SECRET=dev-secret-change-me\n` +
    `PORT=${BACKEND_PORT}\n`
  );
}

/* ------------------------------------------------------------------ */
/* Frontend                                                            */
/* ------------------------------------------------------------------ */

function reactPackageJson(needsCharts) {
  return JSON.stringify(
    {
      name: 'generated-frontend',
      version: '1.0.0',
      private: true,
      proxy: `http://localhost:${BACKEND_PORT}`,
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'react-router-dom': '^6.21.0',
        'react-scripts': '5.0.1',
        ...(needsCharts ? { recharts: '^2.10.3' } : {}),
      },
      scripts: {
        start: 'react-scripts start',
        build: 'react-scripts build',
      },
      browserslist: {
        production: ['>0.2%', 'not dead'],
        development: ['last 1 chrome version'],
      },
    },
    null,
    2
  );
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const INDEX_JS = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

const STYLES_CSS = `:root {
  --bg: #0f1115;
  --panel: #171a21;
  --border: #262b36;
  --text: #e8eaed;
  --muted: #9aa3b2;
  --accent: #4f8cff;
  --danger: #ff5c5c;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.5;
}

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 32px 20px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

h1, h2, h3 { margin: 0 0 16px; font-weight: 600; }

nav {
  display: flex;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}

nav a {
  color: var(--muted);
  text-decoration: none;
  font-weight: 500;
}

nav a:hover, nav a.active { color: var(--text); }

input, select, textarea {
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: #0f1216;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
}

input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

button {
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

button:hover { filter: brightness(1.1); }
button.secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
button.danger { background: var(--danger); }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .04em; }

.row { display: flex; gap: 12px; align-items: center; }
.error { color: var(--danger); margin-bottom: 12px; }
.muted { color: var(--muted); }

form { max-width: 420px; }
`;

const API_JS = `/**
 * Managed by the orchestrator. Agents must NOT rewrite this file — import
 * from it. Every request goes through here so auth token handling and
 * error shape stay consistent across pages.
 *
 * Exports: get, post, put, del, upload, setToken, getToken, clearToken.
 * upload(path, formData) sends multipart/form-data (file uploads).
 */

const TOKEN_KEY = 'auth_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function request(pathname, { method = 'GET', body } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;

  // For FormData the browser sets the multipart boundary itself, so
  // Content-Type must NOT be set manually.
  const headers = isForm ? {} : { 'Content-Type': 'application/json' };
  const token = getToken();

  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    throw new Error((data && data.error) || 'Request failed: ' + res.status);
  }

  return data;
}

export const get = (p) => request(p);
export const post = (p, body) => request(p, { method: 'POST', body });
export const put = (p, body) => request(p, { method: 'PUT', body });
export const del = (p) => request(p, { method: 'DELETE' });
export const upload = (p, formData) =>
  request(p, { method: 'POST', body: formData });
`;

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function scaffoldProject({
  backendDir,
  frontendDir,
  techStack,
  requirement = '',
  databaseUrl,
}) {
  const written = [];
  const stack = techStack || {
    frontend: 'react',
    backend: 'express',
    database: 'postgresql',
  };

  /* Backend — package.json, server.js and db.js are force-written because
     they are host-managed contracts, not agent output. */
  written.push(
    writeIfAbsent(
      backendDir,
      'package.json',
      backendPackageJson(stack, requirement),
      true
    )
  );

  if (stack.backend !== 'fastify') {
    written.push(
      writeIfAbsent(backendDir, 'server.js', EXPRESS_SERVER, true)
    );
  }

  if (stack.database === 'postgresql') {
    written.push(writeIfAbsent(backendDir, 'db.js', PG_DB, true));
    written.push(
      writeIfAbsent(backendDir, '.env.example', envFile(databaseUrl))
    );
    // Force-written so a new project always gets ITS database URL, not a
    // stale one left over from the previous project.
    written.push(
      writeIfAbsent(backendDir, '.env', envFile(databaseUrl), true)
    );
  }

  fs.mkdirSync(path.join(backendDir, 'routes'), { recursive: true });
  fs.mkdirSync(path.join(backendDir, 'sql'), { recursive: true });

  /* Frontend */
  if (stack.frontend === 'react') {
    const needsCharts = /chart|graph|dashboard|analytic/i.test(requirement);

    written.push(
      writeIfAbsent(
        frontendDir,
        'package.json',
        reactPackageJson(needsCharts),
        true
      )
    );
    written.push(
      writeIfAbsent(frontendDir, 'public/index.html', INDEX_HTML, true)
    );
    written.push(writeIfAbsent(frontendDir, 'src/index.js', INDEX_JS, true));
    written.push(writeIfAbsent(frontendDir, 'src/styles.css', STYLES_CSS));
    written.push(writeIfAbsent(frontendDir, 'src/api.js', API_JS, true));
  }

  const files = written.filter(Boolean);

  console.log(
    `[scaffold] wrote ${files.length} managed file(s): ${files.join(', ')}`
  );

  return files;
}

module.exports = { scaffoldProject, BACKEND_PORT };