const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');
const https = require('https');

const FRONTEND_PORT = Number(
  process.env.GENERATED_FRONTEND_PORT || 3001
);

const REQUEST_TIMEOUT_MS = 8000;
const BUILD_TIMEOUT_MS = 120000;

function requestHttp(
  url,
  {
    method = 'GET',
    headers = {},
  } = {},
  body = null
) {
  return new Promise((resolve) => {
    let urlObject;

    try {
      urlObject = new URL(url);
    } catch (error) {
      resolve({
        ok: false,
        status: 0,
        error: `Invalid URL: ${error.message}`,
      });

      return;
    }

    const client =
      urlObject.protocol === 'https:'
        ? https
        : http;

    const request = client.request(
      {
        hostname: urlObject.hostname,
        port: urlObject.port || undefined,
        path:
          urlObject.pathname +
          urlObject.search,

        method,

        headers: {
          Accept: 'application/json,text/html,*/*',
          ...(body
            ? {
                'Content-Type':
                  'application/json',
              }
            : {}),
          ...headers,
        },

        timeout: REQUEST_TIMEOUT_MS,
      },

      (response) => {
        let data = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          let parsed = data;

          const contentType =
            response.headers['content-type'] || '';

          if (
            contentType.includes(
              'application/json'
            )
          ) {
            try {
              parsed = JSON.parse(data);
            } catch {
              // Leave as raw string.
            }
          } else {
            /*
             * Some APIs incorrectly omit JSON content type.
             * Try JSON anyway.
             */
            try {
              parsed = JSON.parse(data);
            } catch {
              // HTML/text is fine.
            }
          }

          resolve({
            ok:
              response.statusCode >= 200 &&
              response.statusCode < 300,

            status:
              response.statusCode || 0,

            headers: response.headers,

            data: parsed,

            raw: data,
          });
        });
      }
    );

    request.on('error', (error) => {
      resolve({
        ok: false,
        status: 0,
        error: error.message,
        data: null,
        raw: '',
      });
    });

    request.on('timeout', () => {
      request.destroy();

      resolve({
        ok: false,
        status: 0,
        error: 'Request timed out.',
        data: null,
        raw: '',
      });
    });

    if (body) {
      request.write(
        JSON.stringify(body)
      );
    }

    request.end();
  });
}

function validatePackageJson(
  projectDir,
  label,
  {
    requireStart = true,
  } = {}
) {
  const issues = [];

  const packagePath = path.join(
    projectDir,
    'package.json'
  );

  if (!fs.existsSync(packagePath)) {
    issues.push(
      `${label}/package.json is missing.`
    );

    return {
      issues,
      packageJson: null,
    };
  }

  let packageJson;

  try {
    packageJson = JSON.parse(
      fs.readFileSync(
        packagePath,
        'utf8'
      )
    );
  } catch (error) {
    issues.push(
      `${label}/package.json contains invalid JSON: ${error.message}`
    );

    return {
      issues,
      packageJson: null,
    };
  }

  if (
    !packageJson.scripts ||
    typeof packageJson.scripts !== 'object'
  ) {
    issues.push(
      `${label}/package.json has no scripts section.`
    );
  }

  if (
    requireStart &&
    typeof packageJson.scripts?.start !==
      'string'
  ) {
    issues.push(
      `${label}/package.json must define a start script.`
    );
  }

  return {
    issues,
    packageJson,
  };
}

function validateBackendFiles(
  backendDir
) {
  const result = validatePackageJson(
    backendDir,
    'backend'
  );

  const issues = [
    ...result.issues,
  ];

  const serverPath = path.join(
    backendDir,
    'server.js'
  );

  if (!fs.existsSync(serverPath)) {
    issues.push(
      'backend/server.js is missing.'
    );
  }

  return issues;
}

function validateFrontendFiles(
  frontendDir,
  techStack = null
) {
  const result = validatePackageJson(
    frontendDir,
    'frontend'
  );

  const issues = [
    ...result.issues,
  ];

  const srcPackage = path.join(
    frontendDir,
    'src',
    'package.json'
  );

  if (fs.existsSync(srcPackage)) {
    issues.push(
      'frontend/src/package.json must not exist. package.json belongs at frontend/package.json.'
    );
  }

  const frontend =
    techStack?.frontend;

  if (frontend === 'react') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'index.js'
        )
      )
    ) {
      issues.push(
        'React frontend requires frontend/src/index.js.'
      );
    }

    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'public',
          'index.html'
        )
      )
    ) {
      issues.push(
        'React frontend requires frontend/public/index.html.'
      );
    }
  } else if (frontend === 'vue') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'main.js'
        )
      )
    ) {
      issues.push(
        'Vue frontend requires frontend/src/main.js.'
      );
    }

    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'index.html'
        )
      )
    ) {
      issues.push(
        'Vue frontend requires frontend/index.html.'
      );
    }
  } else if (frontend === 'angular') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'main.ts'
        )
      )
    ) {
      issues.push(
        'Angular frontend requires frontend/src/main.ts.'
      );
    }
  } else {
    const entries = [
      'src/index.js',
      'src/main.js',
      'src/main.ts',
    ];

    if (
      !entries.some((entry) =>
        fs.existsSync(
          path.join(frontendDir, entry)
        )
      )
    ) {
      issues.push(
        'Frontend has no recognised entry file.'
      );
    }
  }

  return issues;
}

function collectSourceFiles(
  directory
) {
  const files = [];

  if (!fs.existsSync(directory)) {
    return files;
  }

  function walk(current) {
    let entries;

    try {
      entries = fs.readdirSync(
        current,
        {
          withFileTypes: true,
        }
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }

      const fullPath = path.join(
        current,
        entry.name
      );

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (
        /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(
          entry.name
        )
      ) {
        files.push(fullPath);
      }
    }
  }

  walk(directory);

  return files;
}

function runNodeSyntaxCheck(
  filePath,
  label
) {
  try {
    execFileSync(
      process.execPath,
      ['--check', filePath],
      {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      }
    );

    return [];
  } catch (error) {
    const output =
      error.stderr ||
      error.stdout ||
      error.message;

    return [
      `${label} has a JavaScript syntax error:\n${String(
        output
      ).trim()}`,
    ];
  }
}

function validateBackendSyntax(
  backendDir
) {
  const issues = [];

  const files =
    collectSourceFiles(backendDir);

  for (const file of files) {
    /*
     * TypeScript cannot be passed to
     * node --check reliably.
     */
    if (
      /\.(ts|tsx)$/.test(file)
    ) {
      continue;
    }

    const relative =
      path.relative(
        backendDir,
        file
      );

    issues.push(
      ...runNodeSyntaxCheck(
        file,
        `backend/${relative}`
      )
    );
  }

  return issues;
}

function normalizeRoute(
  routePath
) {
  if (!routePath) {
    return '';
  }

  return routePath
    .replace(
      /:[^/]+/g,
      ':param'
    )
    .replace(
      /\{[^}]+\}/g,
      ':param'
    )
    .replace(
      /\/+/g,
      '/'
    )
    .replace(
      /\/$/,
      ''
    );
}

function routeMatches(
  registered,
  expected
) {
  const a = normalizeRoute(
    registered
  );

  const b = normalizeRoute(
    expected
  );

  if (!a || !b) {
    return false;
  }

  return (
    a === b ||
    a.endsWith(b) ||
    b.endsWith(a)
  );
}

function routeExistsInSource(
  source,
  method,
  routePath
) {
  const normalizedMethod =
    String(method || '')
      .toLowerCase();

  /*
   * Express/Fastify style:
   *
   * app.get('/api/items')
   * router.post('/items')
   * fastify.get('/items')
   */
  const directPattern =
    new RegExp(
      `\\.${normalizedMethod}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
      'gi'
    );

  let match;

  while (
    (match =
      directPattern.exec(source)) !==
    null
  ) {
    if (
      routeMatches(
        match[1],
        routePath
      )
    ) {
      return true;
    }
  }

  /*
   * Some code uses:
   *
   * router.route('/items').get(...)
   */
  const routePattern =
    new RegExp(
      `\\.route\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
      'gi'
    );

  while (
    (match =
      routePattern.exec(source)) !==
    null
  ) {
    if (
      routeMatches(
        match[1],
        routePath
      ) &&
      source
        .slice(
          match.index,
          match.index + 500
        )
        .toLowerCase()
        .includes(
          `.${normalizedMethod}`
        )
    ) {
      return true;
    }
  }

  return false;
}

function readAllBackendSource(
  backendDir
) {
  return collectSourceFiles(
    backendDir
  )
    .map((file) => {
      try {
        return {
          file,
          source: fs.readFileSync(
            file,
            'utf8'
          ),
        };
      } catch {
        return {
          file,
          source: '',
        };
      }
    });
}

function validateApiContract(
  backendDir,
  apiContract = []
) {
  const issues = [];

  if (
    !Array.isArray(apiContract) ||
    apiContract.length === 0
  ) {
    return issues;
  }

  const sources =
    readAllBackendSource(
      backendDir
    );

  const combined =
    sources
      .map((item) => item.source)
      .join('\n');

  for (const endpoint of apiContract) {
    if (
      !endpoint?.method ||
      !endpoint?.path
    ) {
      continue;
    }

    const exists =
      routeExistsInSource(
        combined,
        endpoint.method,
        endpoint.path
      );

    if (!exists) {
      issues.push(
        `API contract endpoint is missing from backend source: ${String(
          endpoint.method
        ).toUpperCase()} ${endpoint.path}`
      );
    }
  }

  return issues;
}

function findFrontendErrorText(
  raw
) {
  if (
    typeof raw !== 'string'
  ) {
    return null;
  }

  const markers = [
    'Failed to compile',
    'Module not found',
    'Module build failed',
    'SyntaxError',
    'TypeError:',
    'ReferenceError:',
    'Cannot find module',
    'Cannot resolve',
    'Unexpected token',
    'Build failed',
    'Failed to resolve import',
  ];

  for (const marker of markers) {
    if (
      raw
        .toLowerCase()
        .includes(
          marker.toLowerCase()
        )
    ) {
      return marker;
    }
  }

  return null;
}

function validateFrontendResponse(
  response
) {
  const issues = [];

  if (!response.ok) {
    issues.push(
      `Frontend HTTP check failed with status ${response.status}${
        response.error
          ? `: ${response.error}`
          : ''
      }.`
    );

    return issues;
  }

  const errorMarker =
    findFrontendErrorText(
      response.raw
    );

  if (errorMarker) {
    issues.push(
      `Frontend appears to have a compile/runtime error: ${errorMarker}.`
    );
  }

  return issues;
}

function validateResponseShape(
  data,
  endpoint
) {
  const issues = [];

  if (
    !endpoint ||
    !endpoint.response
  ) {
    return issues;
  }

  const expected =
    endpoint.response;

  let expectedFields = [];

  if (
    Array.isArray(expected)
  ) {
    expectedFields = expected;
  } else if (
    Array.isArray(
      expected.fields
    )
  ) {
    expectedFields =
      expected.fields;
  } else if (
    typeof expected === 'object'
  ) {
    expectedFields =
      Object.keys(expected);
  }

  if (
    !expectedFields.length
  ) {
    return issues;
  }

  const actual =
    Array.isArray(data)
      ? data[0]
      : data;

  if (
    actual === null ||
    typeof actual !== 'object'
  ) {
    issues.push(
      `Response for ${endpoint.method} ${endpoint.path} is not an object/array that matches the declared response fields.`
    );

    return issues;
  }

  for (const field of expectedFields) {
    if (
      typeof field !== 'string'
    ) {
      continue;
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        actual,
        field
      )
    ) {
      issues.push(
        `Response field mismatch for ${endpoint.method} ${endpoint.path}: expected field "${field}" was not returned.`
      );
    }
  }

  return issues;
}

function validateDependencyFiles(
  projectDir,
  label
) {
  const issues = [];

  const packagePath =
    path.join(
      projectDir,
      'package.json'
    );

  if (
    !fs.existsSync(packagePath)
  ) {
    return issues;
  }

  let packageJson;

  try {
    packageJson =
      JSON.parse(
        fs.readFileSync(
          packagePath,
          'utf8'
        )
      );
  } catch {
    return issues;
  }

  const dependencyNames =
    new Set([
      ...Object.keys(
        packageJson.dependencies ||
          {}
      ),
      ...Object.keys(
        packageJson.devDependencies ||
          {}
      ),
    ]);

  /*
   * These are Node built-ins and
   * should not be listed as npm deps.
   */
  const builtins =
    new Set([
      'fs',
      'path',
      'http',
      'https',
      'url',
      'crypto',
      'os',
      'util',
      'events',
      'stream',
      'buffer',
      'child_process',
      'assert',
      'process',
    ]);

  const files =
    collectSourceFiles(
      projectDir
    );

  const imports =
    new Set();

  for (const file of files) {
    let source;

    try {
      source =
        fs.readFileSync(
          file,
          'utf8'
        );
    } catch {
      continue;
    }

    const requireRegex =
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let match;

    while (
      (match =
        requireRegex.exec(source))
    ) {
      imports.add(
        match[1]
      );
    }

    const importRegex =
      /from\s+['"]([^'"]+)['"]/g;

    while (
      (match =
        importRegex.exec(source))
    ) {
      imports.add(
        match[1]
      );
    }
  }

  for (const imported of imports) {
    if (
      !imported ||
      imported.startsWith('.') ||
      imported.startsWith('/') ||
      imported.startsWith('node:')
    ) {
      continue;
    }

    const rootPackage =
      imported.startsWith('@')
        ? imported
            .split('/')
            .slice(0, 2)
            .join('/')
        : imported.split('/')[0];

    if (
      builtins.has(rootPackage)
    ) {
      continue;
    }

    if (
      !dependencyNames.has(
        rootPackage
      )
    ) {
      issues.push(
        `${label} imports "${rootPackage}" but it is not declared in package.json.`
      );
    }
  }

  return issues;
}

function runFrontendBuild(
  frontendDir
) {
  const issues = [];

  const packagePath =
    path.join(
      frontendDir,
      'package.json'
    );

  if (
    !fs.existsSync(packagePath)
  ) {
    return issues;
  }

  let packageJson;

  try {
    packageJson =
      JSON.parse(
        fs.readFileSync(
          packagePath,
          'utf8'
        )
      );
  } catch {
    return issues;
  }

  const scripts =
    packageJson.scripts || {};

  /*
   * Prefer an explicit build
   * script.
   */
  if (
    typeof scripts.build !==
    'string'
  ) {
    return issues;
  }

  try {
    execFileSync(
      process.platform === 'win32'
        ? 'npm.cmd'
        : 'npm',
      ['run', 'build'],
      {
        cwd: frontendDir,
        encoding: 'utf8',
        timeout:
          BUILD_TIMEOUT_MS,
        stdio: 'pipe',
        env: {
          ...process.env,
          CI: 'true',
        },
      }
    );
  } catch (error) {
    const output =
      [
        error.stdout,
        error.stderr,
        error.message,
      ]
        .filter(Boolean)
        .join('\n')
        .slice(-12000);

    issues.push(
      `Frontend build failed:\n${output}`
    );
  }

  return issues;
}

async function validateRuntime({
  backendPort,
  frontendPort = FRONTEND_PORT,
  apiContract = [],
}) {
  const issues = [];
  const checks = [];

  const backendUrl =
    `http://localhost:${backendPort}`;

  const frontendUrl =
    `http://localhost:${frontendPort}`;

  /*
   * Backend root/health check.
   */
  const backend =
    await requestHttp(
      backendUrl
    );

  checks.push({
    name: 'backend',
    url: backendUrl,
    method: 'GET',
    status: backend.status,
    ok: backend.ok,
  });

  if (!backend.ok) {
    issues.push(
      `Backend is not responding correctly at ${backendUrl}${
        backend.error
          ? `: ${backend.error}`
          : ` with HTTP ${backend.status}.`
      }`
    );
  }

  /*
   * Test every GET endpoint
   * from the API contract.
   *
   * GET is safe to smoke-test.
   */
  for (const endpoint of apiContract) {
    if (
      String(
        endpoint?.method || ''
      ).toUpperCase() !== 'GET'
    ) {
      continue;
    }

    if (!endpoint.path) {
      continue;
    }

    /*
     * Skip parameterised endpoints
     * because we don't know a safe
     * ID to supply.
     */
    if (
      endpoint.path.includes(':') ||
      endpoint.path.includes('{')
    ) {
      checks.push({
        name: `GET ${endpoint.path}`,
        skipped: true,
        reason:
          'Parameterized endpoint requires test data.',
      });

      continue;
    }

    const url =
      `${backendUrl}${endpoint.path}`;

    const response =
      await requestHttp(url);

    checks.push({
      name: `GET ${endpoint.path}`,
      url,
      method: 'GET',
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      issues.push(
        `GET ${endpoint.path} failed with HTTP ${response.status}${
          response.error
            ? `: ${response.error}`
            : ''
        }.`
      );

      if (
        response.raw
      ) {
        issues.push(
          `GET ${endpoint.path} response: ${response.raw.slice(
            0,
            2000
          )}`
        );
      }

      continue;
    }

    issues.push(
      ...validateResponseShape(
        response.data,
        endpoint
      )
    );
  }

  /*
   * Frontend check.
   */
  const frontend =
    await requestHttp(
      frontendUrl
    );

  checks.push({
    name: 'frontend',
    url: frontendUrl,
    method: 'GET',
    status: frontend.status,
    ok: frontend.ok,
  });

  issues.push(
    ...validateFrontendResponse(
      frontend
    )
  );

  return {
    clean: issues.length === 0,
    issues,
    checks,
  };
}

async function validateProject({
  backendDir,
  frontendDir,
  backendPort,
  frontendPort = FRONTEND_PORT,
  apiContract = [],
  techStack = null,
  runBuild = true,
}) {
  const issues = [];

  /*
   * Static checks.
   */
  issues.push(
    ...validateBackendFiles(
      backendDir
    )
  );

  issues.push(
    ...validateFrontendFiles(
      frontendDir,
      techStack
    )
  );

  issues.push(
    ...validateBackendSyntax(
      backendDir
    )
  );

  issues.push(
    ...validateDependencyFiles(
      backendDir,
      'backend'
    )
  );

  issues.push(
    ...validateDependencyFiles(
      frontendDir,
      'frontend'
    )
  );

  issues.push(
    ...validateApiContract(
      backendDir,
      apiContract
    )
  );

  /*
   * Build before runtime checks.
   */
  if (runBuild) {
    issues.push(
      ...runFrontendBuild(
        frontendDir
      )
    );
  }

  /*
   * Runtime checks.
   */
  const runtime =
    await validateRuntime({
      backendPort,
      frontendPort,
      apiContract,
    });

  issues.push(
    ...runtime.issues
  );

  return {
    clean: issues.length === 0,
    issues,
    runtime,
    static: {
      clean:
        issues.length === 0,
    },
  };
}

module.exports = {
  validateProject,
  validateRuntime,
  requestHttp,
};