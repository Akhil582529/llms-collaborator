/**
 * End-to-end smoke tests for a generated project.
 *
 * projectValidator.js only checks that the servers respond and that the
 * frontend builds. That can pass (or fail on a generic "HTTP 404") while
 * the app itself does nothing when a user clicks the button. This module
 * actually USES the app:
 *
 *  1. Every API contract endpoint is called for real. File-upload
 *     endpoints get a real multipart upload of generated test images.
 *  2. For endpoints that take two files (compare/verify style), it also
 *     uploads two IDENTICAL images and checks the response differs from
 *     the "different images" response. Identical output means the
 *     comparison logic is a stub.
 *  3. The same upload is repeated THROUGH the frontend dev server, which
 *     proves the proxy from frontend to backend works.
 *  4. Frontend source is scanned to confirm something actually calls each
 *     contract endpoint (and builds a FormData for uploads).
 *
 * Returns { clean, issues: string[], checks: [{ name, status, detail }] }.
 * Issue strings are worded so orchestrator.classifyIssues() routes them
 * to the right repair agent and include the real response body / backend
 * log so the repair agent can see the actual error.
 *
 * Needs no extra dependencies: PNG files and multipart bodies are built
 * by hand.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const REQUEST_TIMEOUT_MS = 120_000; // OCR/image work can be slow on first run

/* ------------------------------------------------------------------ */
/* Test image generation (minimal PNG encoder)                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;

  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));

  return Buffer.concat([length, typeAndData, crc]);
}

function makePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none

    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;

      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// A crude "ID document": header band, photo box, three text lines. The
// forged variant has a different photo colour and a shortened text line.
function documentPng(forged) {
  return makePng(300, 120, (x, y) => {
    if (y < 24) return [40, 70, 140];

    if (x > 20 && x < 70 && y > 40 && y < 100) {
      return forged ? [200, 60, 60] : [90, 130, 90];
    }

    if (x > 90 && x < 280 && y > 44 && y < 52) return [30, 30, 30];
    if (x > 90 && x < 240 && y > 64 && y < 72) return [30, 30, 30];
    if (x > 90 && x < (forged ? 200 : 260) && y > 84 && y < 92) return [30, 30, 30];

    return [248, 248, 244];
  });
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

function multipart(files) {
  const boundary = '----smoketest' + Date.now().toString(16);
  const parts = [];

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`
      ),
      file.data,
      Buffer.from('\r\n')
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function request({
  port,
  method = 'GET',
  pathname,
  headers = {},
  body = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        timeout: timeoutMs,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': body.length } : {}),
        },
      },
      (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');

          let json = null;

          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }

          resolve({ status: res.statusCode, text, json });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (error) => resolve({ status: 0, text: '', error: error.message }));

    if (body) req.write(body);
    req.end();
  });
}

function clip(value, max = 500) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tail(filePath, maxChars = 1500) {
  if (!filePath) return '';

  try {
    return fs.readFileSync(filePath, 'utf8').slice(-maxChars);
  } catch {
    return '';
  }
}

// Drops ids/timestamps so two responses can be compared for real content.
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);

  if (value && typeof value === 'object') {
    const out = {};

    for (const [key, v] of Object.entries(value)) {
      if (/^(id|[a-z]+Id|[a-z]+_id|timestamp|createdAt|updatedAt|created_at|updated_at)$/.test(key)) {
        continue;
      }

      out[key] = stripVolatile(v);
    }

    return out;
  }

  return value;
}

/* ------------------------------------------------------------------ */
/* Contract / source inspection                                         */
/* ------------------------------------------------------------------ */

function readRouteSource(backendDir, endpoint) {
  const match = String(endpoint.path).match(/^\/api\/([^/]+)/);

  if (!match) return '';

  try {
    return fs.readFileSync(
      path.join(backendDir, 'routes', `${match[1]}.js`),
      'utf8'
    );
  } catch {
    return '';
  }
}

function detectUploadFields(source) {
  const names = [];

  if (!source) return names;

  for (const m of source.matchAll(/\.fields\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const n of m[1].matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
      names.push(n[1]);
    }
  }

  for (const m of source.matchAll(/\.(?:single|array)\(\s*['"]([^'"]+)['"]/g)) {
    names.push(m[1]);
  }

  return [...new Set(names)];
}

function isUploadEndpoint(endpoint, source) {
  const method = String(endpoint.method).toUpperCase();

  if (method !== 'POST' && method !== 'PUT') return false;

  return (
    /multer|\.single\(|\.fields\(|\.array\(|req\.files?\b/.test(source || '') ||
    /upload|multipart/i.test(endpoint.description || '')
  );
}

function fallbackFieldNames(endpoint) {
  const text = `${endpoint.description || ''} ${endpoint.path || ''}`;

  return /original/i.test(text) && /candidate/i.test(text)
    ? ['original', 'candidate']
    : ['file'];
}

function listSourceFiles(dir) {
  const files = [];

  function walk(current) {
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'build') continue;

      const full = path.join(current, entry.name);

      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) files.push(full);
    }
  }

  walk(dir);

  return files;
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

async function testEndpoint(ctx, endpoint) {
  const method = String(endpoint.method).toUpperCase();
  const label = `${method} ${endpoint.path}`;
  const hasParam = /:[^/]+/.test(endpoint.path);
  const concretePath = String(endpoint.path).replace(/:[^/]+/g, '1');
  const source = readRouteSource(ctx.backendDir, endpoint);

  const fail = (message, response) => {
    const logs = response && response.status >= 500 ? tail(ctx.backendLogPath) : '';

    ctx.issues.push(
      `Backend endpoint ${label} failed a real request: ${message}` +
        (response && response.text ? ` Response: ${clip(response.text)}` : '') +
        (logs ? ` Backend log tail: ${clip(logs, 1500)}` : '')
    );

    ctx.checks.push({ name: label, status: 'fail', detail: message });
  };

  const pass = (detail) =>
    ctx.checks.push({ name: label, status: 'pass', detail });

  /* ---- file uploads ---- */

  if (isUploadEndpoint(endpoint, source)) {
    const detected = detectUploadFields(source);
    const fields = detected.length > 0 ? detected : fallbackFieldNames(endpoint);

    const original = documentPng(false);
    const forged = documentPng(true);

    const buildFiles = (second) =>
      fields.map((field, index) => ({
        field,
        filename: `${field}.png`,
        type: 'image/png',
        data: index === 0 ? original : second,
      }));

    const send = (port, files) => {
      const { body, contentType } = multipart(files);

      return request({
        port,
        method,
        pathname: concretePath,
        headers: { 'Content-Type': contentType },
        body,
      });
    };

    const different = await send(ctx.backendPort, buildFiles(forged));

    if (different.status === 0) {
      return fail(`no response (${different.error}).`, different);
    }

    if (different.status === 401 || different.status === 403) {
      return ctx.checks.push({
        name: label,
        status: 'skipped',
        detail: 'requires authentication',
      });
    }

    if (different.status < 200 || different.status >= 300) {
      return fail(
        `upload with fields [${fields.join(', ')}] returned HTTP ${different.status}.`,
        different
      );
    }

    if (!different.json || typeof different.json !== 'object') {
      return fail('upload succeeded but the response is not a JSON object.', different);
    }

    // Two-file endpoints: identical inputs must not give the same output
    // as different inputs, otherwise the "comparison" is a stub.
    if (fields.length >= 2) {
      const identical = await send(ctx.backendPort, buildFiles(original));

      if (
        identical.status >= 200 &&
        identical.status < 300 &&
        identical.json &&
        JSON.stringify(stripVolatile(identical.json)) ===
          JSON.stringify(stripVolatile(different.json))
      ) {
        return fail(
          'it returns exactly the same result for two identical images and for two different images, so the comparison logic is a stub or ignores the uploaded files.',
          different
        );
      }
    }

    // Same upload through the frontend dev server (proxy check).
    if (!ctx.proxyChecked) {
      ctx.proxyChecked = true;

      const proxied = await send(ctx.frontendPort, buildFiles(forged));

      if (proxied.status === 0) {
        ctx.issues.push(
          `Frontend dev server is not reachable on port ${ctx.frontendPort}, so uploads from the UI cannot reach the backend (${proxied.error}).`
        );
        ctx.checks.push({ name: `${label} via frontend proxy`, status: 'fail', detail: proxied.error });
      } else if (proxied.status < 200 || proxied.status >= 300) {
        ctx.issues.push(
          `Frontend proxy does not forward ${label} to the backend: direct call returned HTTP ${different.status} but the same call through the frontend dev server returned HTTP ${proxied.status}. Response: ${clip(proxied.text, 300)}`
        );
        ctx.checks.push({ name: `${label} via frontend proxy`, status: 'fail', detail: `HTTP ${proxied.status}` });
      } else {
        ctx.checks.push({ name: `${label} via frontend proxy`, status: 'pass', detail: `HTTP ${proxied.status}` });
      }
    }

    return pass(`real upload accepted (fields: ${fields.join(', ')})`);
  }

  /* ---- everything else ---- */

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  const response = await request({
    port: ctx.backendPort,
    method,
    pathname: concretePath,
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    body: hasBody ? Buffer.from('{}') : null,
  });

  if (response.status === 0) {
    return fail(`no response (${response.error}).`, response);
  }

  if (response.status >= 500) {
    return fail(`returned HTTP ${response.status}.`, response);
  }

  // A missing resource (404) is fine for /:id routes; for fixed paths it
  // means the route was never registered.
  if (response.status === 404 && !hasParam) {
    return fail(
      'returned HTTP 404, so the route is not registered at that path (routes/<name>.js is mounted at /api/<name>; paths inside the file are relative to that).',
      response
    );
  }

  return pass(`HTTP ${response.status}`);
}

function checkFrontendWiring(ctx) {
  const srcDir = path.join(ctx.frontendDir, 'src');
  const files = listSourceFiles(srcDir).map((file) => ({
    file,
    text: fs.readFileSync(file, 'utf8'),
  }));

  if (files.length === 0) {
    ctx.issues.push('Frontend has no source files under src/, so there is no UI to test.');
    return;
  }

  for (const endpoint of ctx.apiContract) {
    if (!endpoint?.path || !endpoint?.method) continue;

    const method = String(endpoint.method).toUpperCase();
    const label = `${method} ${endpoint.path}`;
    const prefix = String(endpoint.path).split('/:')[0];

    const callers = files.filter(
      (f) => f.text.includes(prefix) && !f.file.endsWith(`${path.sep}api.js`)
    );

    if (callers.length === 0) {
      ctx.issues.push(
        `Frontend never calls ${label}: no file under frontend/src contains "${prefix}", so using the UI does nothing.`
      );
      ctx.checks.push({ name: `frontend calls ${label}`, status: 'fail', detail: 'no caller found' });
      continue;
    }

    const source = readRouteSource(ctx.backendDir, endpoint);

    if (isUploadEndpoint(endpoint, source) && !callers.some((f) => /FormData/.test(f.text))) {
      ctx.issues.push(
        `Frontend code that calls ${label} (${path.basename(callers[0].file)}) does not build a FormData body, so no file is actually uploaded. Use FormData with upload() from src/api.js.`
      );
      ctx.checks.push({ name: `frontend uploads ${label}`, status: 'fail', detail: 'no FormData' });
      continue;
    }

    ctx.checks.push({
      name: `frontend calls ${label}`,
      status: 'pass',
      detail: path.basename(callers[0].file),
    });
  }
}

async function runSmokeTests({
  backendDir,
  frontendDir,
  backendPort,
  frontendPort,
  apiContract = [],
  backendLogPath = null,
}) {
  const ctx = {
    backendDir,
    frontendDir,
    backendPort,
    frontendPort,
    apiContract: Array.isArray(apiContract) ? apiContract : [],
    backendLogPath,
    issues: [],
    checks: [],
    proxyChecked: false,
  };

  // If the backend isn't up at all, the project validator already
  // reports that; don't pile duplicate noise on top.
  const health = await request({ port: backendPort, pathname: '/api/health', timeoutMs: 5000 });

  if (health.status !== 200) {
    return {
      clean: true,
      skipped: true,
      issues: [],
      checks: [
        {
          name: 'smoke tests',
          status: 'skipped',
          detail: `backend not healthy on port ${backendPort} (HTTP ${health.status})`,
        },
      ],
    };
  }

  for (const endpoint of ctx.apiContract) {
    if (!endpoint?.method || !endpoint?.path) continue;

    try {
      await testEndpoint(ctx, endpoint);
    } catch (error) {
      ctx.issues.push(
        `Smoke test for ${endpoint.method} ${endpoint.path} crashed: ${error.message}`
      );
    }
  }

  checkFrontendWiring(ctx);

  return {
    clean: ctx.issues.length === 0,
    skipped: false,
    issues: ctx.issues,
    checks: ctx.checks,
  };
}

module.exports = { runSmokeTests };