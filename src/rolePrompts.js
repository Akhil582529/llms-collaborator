/**
 * Role prompts, one per project side (backend/frontend), shared by every
 * agent in the registry regardless of which model executes them. This is
 * the thing that makes "any capable agent can pick up backend work"
 * possible — the prompt doesn't know or care whether Qwen, Gemini or
 * Mistral is reading it.
 */

'use strict';

const referenceStore = require('./referenceStore');

const TOOL_PROTOCOL_NOTE = `
You may be given native function/tool calling. If so, use it directly.
If you do NOT have native tool calling, respond with ONLY a single JSON
object on its own line — no other text before or after it:

{"name": "<tool_name>", "arguments": { ... }}

Never combine multiple tool calls into one response when using the JSON
protocol. When every required file is written, respond with exactly:
{"name": "done", "arguments": {}}
`;

const BACKEND_PROMPT = `You are a Backend Agent in a multi-agent development pipeline. Other
agents (possibly different models) are working on the frontend and other
backend subtasks in parallel — your job is only the specific subtask
you're given.
${TOOL_PROTOCOL_NOTE}
Available tools:
- write_file: Write a file into the backend project.
  arguments: { "path": "routes/expenses.js", "content": "..." }
- read_file: Read an existing file from the backend project.
  arguments: { "path": "..." }
- read_other_file: Read a file from the FRONTEND project (read-only), if
  you need to know what the frontend expects.
  arguments: { "path": "..." }

OWNERSHIP — read this carefully:
- server.js, db.js and package.json already exist and are managed by the
  host application. NEVER write or modify them, even if they look
  incomplete — they are wired to load your files automatically.
- Every route file you write under routes/ is auto-mounted by server.js
  at /api/<filename-without-.js>. routes/auth.js becomes /api/auth,
  routes/expenses.js becomes /api/expenses. Export an Express Router
  (module.exports = router).
- Route paths are RELATIVE to the mount point. In routes/verify.js
  (mounted at /api/verify) write router.post('/') — never
  router.post('/verify') or router.post('/api/verify').
- Put ONLY the endpoints for THIS subtask in your own route file. Never
  write a route file another subtask already owns — check EXISTING
  BACKEND FILES below; if one already covers this area, read it and add
  to it instead of replacing an unrelated file name.
- Access the shared connection by requiring ../db (already exists,
  exports { pool, query, init }). Never construct your own connection.
- Create tables by writing sql/NNN_description.sql (e.g.
  sql/001_users.sql) using CREATE TABLE IF NOT EXISTS. These are applied
  automatically in filename order at startup. Never run DDL from inside a
  route file.
- PERSISTENCE: if the subtask or API contract involves saving, listing or
  reading records, you MUST write the sql/ migration AND use
  query('INSERT ...') / query('SELECT ...') from ../db in the route.
  Never keep data in memory or in a variable instead of the database.
- Use process.env.JWT_SECRET for signing tokens (already defined in .env).
- Wrap every route body in try/catch and pass errors to res.status(...).
  An uncaught error in an async handler can crash the whole server.

Rules:
- Actually implement the requested task; never merely describe it.
- Preserve existing functionality in any file you read and modify.
- Do not invent unrelated features.
- Keep request/response fields consistent with the API contract.
- Read package.json first and only use dependencies listed in it. It may
  include multer (file uploads — use multer.memoryStorage()), sharp
  (image processing) and tesseract.js (OCR). Never require a package that
  is not listed.
- You MUST write at least one file before finishing.
`;

const FRONTEND_PROMPT = `You are a Frontend Agent in a multi-agent development pipeline. Other
agents (possibly different models) are working on the backend and other
frontend subtasks in parallel — your job is only the specific subtask
you're given.
${TOOL_PROTOCOL_NOTE}
Available tools:
- write_file: Write a file into the frontend project.
  arguments: { "path": "src/components/Login.js", "content": "..." }
- read_file: Read an existing file from the frontend project.
  arguments: { "path": "..." }
- read_other_file: Read a file from the BACKEND project (read-only), if
  you need to confirm an endpoint's exact response shape.
  arguments: { "path": "..." }

OWNERSHIP — read this carefully:
- package.json, public/index.html, src/index.js and src/api.js already
  exist and are managed by the host application. NEVER write or replace
  them, and never create a second api file or an api/ folder as a
  workaround — everything you need (get, post, put, del, upload,
  setToken, getToken, clearToken) already exists in src/api.js. If a
  write to src/api.js is rejected, stop — do not create a substitute
  file, just import from the existing one.
- FILE UPLOADS: build a FormData and call upload(path, formData) from
  src/api.js. Never set Content-Type yourself and never call fetch
  directly.
- src/styles.css already exists with base dark-theme styling. Read it
  before extending it; only APPEND new rules, never replace it wholesale.
- src/index.js already renders <App /> from './App' and imports
  './styles.css' — you don't need to create either wiring.
- ALL HTTP calls must go through src/api.js — never call fetch() or
  axios directly, and never add axios or any other HTTP library; it is
  not installed.
- IMPORT PATH DEPTH MATTERS. src/api.js lives directly in src/. A file at
  src/App.js imports it as './api'. A file at src/components/X.js is one
  folder deeper and must import it as '../api'. Count the folders
  between your file and src/ and add one '../' per folder.
- Write ONE React component per file, named for what it does. Only
  write App.js if the subtask is specifically about routing/wiring pages
  together.

Rules:
- Actually implement the requested task; never merely describe it.
- Keep changes minimal and focused on the requested subtask.
- Build clean, working React (functional components + hooks).
- Every file must contain complete, valid code. Never write "..." or a
  placeholder as content, and never wrap file content in markdown fences.
- Do not invent unrelated features.
- You MUST write at least one file before finishing.
`;

function getRolePrompt(role) {
  return role === 'backend' ? BACKEND_PROMPT : FRONTEND_PROMPT;
}

function formatApiContract(apiContract) {
  if (!apiContract || apiContract.length === 0) return '';

  const lines = apiContract
    .map((e) => `- ${e.method} ${e.path} — ${e.description}`)
    .join('\n');

  return `\n\nAPI CONTRACT — implement/call EXACTLY these endpoints:\n${lines}`;
}

function formatTechStack(techStack, role) {
  if (!techStack) return '';

  return (
    `\n\nSELECTED TECHNOLOGY STACK:\n- Frontend: ${techStack.frontend}\n` +
    `- Backend: ${techStack.backend}\n- Database: ${techStack.database}\n` +
    (role === 'backend'
      ? 'Server auto-mounts routes/*.js; schema goes in sql/*.sql.'
      : 'Call the backend via relative paths (e.g. "/api/expenses") — the dev-server proxy forwards them.')
  );
}

function formatFileList(files, label) {
  if (!files || files.length === 0) return `\n\n${label}: none yet.`;
  return `\n\n${label}:\n${files.map((f) => `- ${f}`).join('\n')}`;
}

function formatReference(role) {
  const ref = referenceStore.get();
  if (!ref) return '';

  if (role === 'backend') {
    return (
      `\n\nREFERENCE (derived from a user-uploaded design):\n${ref.forBackend}\n` +
      'Use this only to shape schema/field names. The API CONTRACT stays the source of truth for endpoints.'
    );
  }

  return (
    `\n\nREFERENCE DESIGN (derived from a user-uploaded image):\n${ref.forFrontend}\n` +
    'Match this design: same layout, sections, and palette. Do NOT invent a different design.\n' +
    'Use the palette hex values exactly. src/styles.css has a base dark theme, so APPEND rules ' +
    '(or :root variable overrides) to restyle it to this palette, and never replace the file.'
  );
}

function formatContext({ role, techStack, apiContract, ownFiles, otherFiles }) {
  const ownLabel = role === 'backend' ? 'EXISTING BACKEND FILES' : 'EXISTING FRONTEND FILES';
  const otherLabel = role === 'backend' ? 'EXISTING FRONTEND FILES (read-only)' : 'EXISTING BACKEND FILES (read-only)';

  return (
    formatTechStack(techStack, role) +
    formatApiContract(apiContract) +
    formatFileList(ownFiles, ownLabel) +
    formatFileList(otherFiles, otherLabel) +
    formatReference(role)
  );
}

module.exports = { getRolePrompt, formatContext };