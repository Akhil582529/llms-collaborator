const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');

const LOGS_DIR = path.resolve(__dirname, '../../logs');
const PID_FILE = path.join(LOGS_DIR, 'running-pids.json');

const FRONTEND_PORT = Number(process.env.GENERATED_FRONTEND_PORT || 3001);
const STARTUP_TIMEOUT_MS = Number(process.env.GENERATED_STARTUP_TIMEOUT_MS || 30000);
const POLL_INTERVAL_MS = 500;

const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ */
/* Basics                                                              */
/* ------------------------------------------------------------------ */

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Spawned servers are detached, so each one leads its own process group.
 * `npm start` forks react-scripts (and webpack) as children; killing only
 * the npm PID leaves those children alive and holding the port. Signalling
 * the whole group (negative PID) takes the entire tree down.
 */
function isGroupAlive(pid) {
  if (!pid) return false;
  if (IS_WINDOWS) return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    if (IS_WINDOWS) process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already stopped.
    }
  }
}

/** Gracefully stop a process tree, escalating to SIGKILL after 2s. */
function killPid(pid) {
  if (!isGroupAlive(pid)) return;

  signalGroup(pid, 'SIGTERM');

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isGroupAlive(pid)) {
    sleepSync(100);
  }

  if (isGroupAlive(pid)) {
    signalGroup(pid, 'SIGKILL');
  }
}

/**
 * Safety net: kill whatever is LISTENing on a port, even if it was started
 * by an earlier orchestrator run that never recorded its PID (e.g. after a
 * Ctrl+C or crash). Without this, a leftover dev server makes the new
 * react-scripts exit with "Something is already running on port 3001", and
 * waitForHttp can end up validating the OLD backend running OLD code.
 */
function freePort(port) {
  if (!port || IS_WINDOWS) return;

  let output = '';

  try {
    output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return; // nothing listening (lsof exits 1) or lsof not installed
  }

  let killedAny = false;

  for (const raw of output.split('\n')) {
    const pid = Number(raw.trim());

    if (!pid || pid === process.pid) continue;

    try {
      process.kill(pid, 'SIGKILL');
      killedAny = true;
      console.warn(`[appRunner] freed port ${port} (killed leftover pid ${pid})`);
    } catch {
      // Already gone.
    }
  }

  if (killedAny) sleepSync(300);
}

/* ------------------------------------------------------------------ */
/* PID tracking                                                        */
/* ------------------------------------------------------------------ */

function readPidFile() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writePidFile(data) {
  ensureLogsDir();
  fs.writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
}

function killTracked() {
  const tracked = readPidFile();

  signalGroup(tracked.backend, 'SIGTERM');
  signalGroup(tracked.frontend, 'SIGTERM');

  const deadline = Date.now() + 3000;
  while (
    Date.now() < deadline &&
    (isGroupAlive(tracked.backend) || isGroupAlive(tracked.frontend))
  ) {
    sleepSync(100);
  }

  if (isGroupAlive(tracked.backend)) signalGroup(tracked.backend, 'SIGKILL');
  if (isGroupAlive(tracked.frontend)) signalGroup(tracked.frontend, 'SIGKILL');

  freePort(tracked.backendPort);
  freePort(tracked.frontendPort);

  writePidFile({});
}

/* ------------------------------------------------------------------ */
/* HTTP readiness                                                      */
/* ------------------------------------------------------------------ */

function checkHttp(url) {
  return new Promise((resolve) => {
    let request;

    try {
      request = http.get(
        url,
        {
          timeout: 3000,
          headers: { Accept: 'text/html,application/json,*/*' },
        },
        (response) => {
          // Consume the response so the socket can close cleanly.
          response.resume();

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 500,
            status: response.statusCode,
            headers: response.headers,
          });
        }
      );
    } catch (error) {
      resolve({ ok: false, status: 0, error: error.message });
      return;
    }

    request.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error.message });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: 0, error: 'Request timed out.' });
    });
  });
}

async function waitForHttp(
  url,
  { timeoutMs = STARTUP_TIMEOUT_MS, pid = null, processName = 'server' } = {}
) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    if (pid && !isProcessAlive(pid)) {
      return {
        ok: false,
        error: `${processName} process exited before becoming ready.`,
      };
    }

    const result = await checkHttp(url);

    if (result.ok) return result;

    lastError = result.error || `HTTP ${result.status}`;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    error: `${processName} did not become available at ${url} within ${timeoutMs}ms. Last error: ${lastError}`,
  };
}

/* ------------------------------------------------------------------ */
/* npm + process helpers                                               */
/* ------------------------------------------------------------------ */

function npmCommand() {
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

function npmInstall(directory, logName) {
  ensureLogsDir();

  const logPath = path.join(LOGS_DIR, logName);

  try {
    execFileSync(npmCommand(), ['install'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 180000,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true' },
    });

    fs.writeFileSync(
      logPath,
      `npm install completed successfully for ${directory}\n`
    );

    return { ok: true, logPath };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .join('\n');

    fs.writeFileSync(logPath, output);

    throw new Error(`npm install failed in ${directory}.\n\n${output}`);
  }
}

function spawnServer({ cwd, command, args, logName, env = {} }) {
  ensureLogsDir();

  const logPath = path.join(LOGS_DIR, logName);

  // 'w' (not 'a'): each run starts with a clean log, so a stale
  // "already running" / compile error from an earlier run can't be
  // mistaken for the current one.
  const logFd = fs.openSync(logPath, 'w');

  const child = spawn(command, args, {
    cwd,
    detached: true, // own process group, so the whole tree can be killed
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...env },
  });

  child.unref();

  return { pid: child.pid, logPath };
}

function readLogTail(logPath, maxChars = 12000) {
  if (!logPath || !fs.existsSync(logPath)) return '';

  try {
    return fs.readFileSync(logPath, 'utf8').slice(-maxChars);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Start the generated app                                             */
/* ------------------------------------------------------------------ */

async function startGeneratedApp({ backendDir, frontendDir, backendPort }) {
  ensureLogsDir();

  // 1. Stop the previous generated app (whole process trees), then make
  //    sure both ports are really free even if an earlier run left
  //    untracked processes behind.
  killTracked();
  freePort(backendPort);
  freePort(FRONTEND_PORT);

  // 2. Backend
  npmInstall(backendDir, 'backend-install.log');

  const backend = spawnServer({
    cwd: backendDir,
    command: process.execPath,
    args: [path.join(backendDir, 'server.js')],
    logName: 'backend-runtime.log',
    env: { PORT: String(backendPort) },
  });

  // Record the PID immediately so a crash/Ctrl+C mid-startup can't orphan it.
  writePidFile({ backend: backend.pid, backendPort });

  const backendUrl = `http://localhost:${backendPort}`;

  const backendReady = await waitForHttp(backendUrl, {
    pid: backend.pid,
    processName: 'Backend',
  });

  if (!backendReady.ok) {
    const log = readLogTail(backend.logPath);

    killPid(backend.pid);
    freePort(backendPort);
    writePidFile({});

    throw new Error(
      [
        'Generated backend failed to start.',
        backendReady.error,
        '',
        'Backend log:',
        log,
      ].join('\n')
    );
  }

  // 3. Frontend
  npmInstall(frontendDir, 'frontend-install.log');

  const frontend = spawnServer({
    cwd: frontendDir,
    command: npmCommand(),
    args: ['start', '--', '--port', String(FRONTEND_PORT)],
    logName: 'frontend-runtime.log',
    env: {
      BROWSER: 'none',
      PORT: String(FRONTEND_PORT),
      HOST: '0.0.0.0',
      CI: 'false',
    },
  });

  writePidFile({
    backend: backend.pid,
    backendPort,
    frontend: frontend.pid,
    frontendPort: FRONTEND_PORT,
  });

  const frontendUrl = `http://localhost:${FRONTEND_PORT}`;

  const frontendReady = await waitForHttp(frontendUrl, {
    pid: frontend.pid,
    processName: 'Frontend',
  });

  if (!frontendReady.ok) {
    const log = readLogTail(frontend.logPath);

    killPid(frontend.pid);
    killPid(backend.pid);
    freePort(FRONTEND_PORT);
    freePort(backendPort);
    writePidFile({});

    throw new Error(
      [
        'Generated frontend failed to start.',
        frontendReady.error,
        '',
        'Frontend log:',
        log,
      ].join('\n')
    );
  }

  // 4. Runtime descriptor.
  //    `ready: true` matters: the dashboard (public/index.html) treats a
  //    missing `ready` as "Frontend failed to start" and never auto-opens
  //    the app, even when the server is running fine.
  return {
    backend: {
      pid: backend.pid,
      port: backendPort,
      url: backendUrl,
      logPath: backend.logPath,
      ready: true,
    },

    frontend: {
      pid: frontend.pid,
      port: FRONTEND_PORT,
      url: frontendUrl,
      logPath: frontend.logPath,
      ready: true,
    },

    startedAt: new Date().toISOString(),
  };
}

module.exports = {
  startGeneratedApp,
  killTracked,
  freePort,
  checkHttp,
  waitForHttp,
  readLogTail,
  FRONTEND_PORT,
};