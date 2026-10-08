const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const activityLog = require('./activityLog');
const taskStore = require('./taskStore');
const agents = require('./agents');
const writeGuard = require('./writeGuard');

const DEBOUNCE_MS = 800;

const WATCH_TARGETS = [
  { dir: path.resolve(__dirname, '../../frontend'), agent: 'frontend' },
  { dir: path.resolve(__dirname, '../../backend'), agent: 'backend' },
];

const pendingTimers = new Map();

function scheduleEvent(agentName, absPath, dir, eventType) {
  if (pendingTimers.has(absPath)) {
    clearTimeout(pendingTimers.get(absPath));
  }

  const timer = setTimeout(() => {
    const relPath = path.relative(dir, absPath);
    activityLog.log({ agent: agentName, filePath: relPath, eventType });
    console.log(`[file watcher] ${agentName}: ${eventType} -> ${relPath}`);
    pendingTimers.delete(absPath);

    // Only 'change' events on existing files can mean "human adjusted this
    // subtask's output" — 'created'/'deleted' don't map to a "fix this up"
    // instruction the same way, so we leave those as log-only for now.
    if (eventType === 'modified') {
      maybeRerunAgent(agentName, absPath, dir);
    }
  }, DEBOUNCE_MS);

  pendingTimers.set(absPath, timer);
}

async function maybeRerunAgent(agentName, absPath, dir) {
  if (writeGuard.wasJustWrittenByAgent(absPath)) {
    return; // this change came from the agent's own write_file call — ignore
  }

  const found = taskStore.findSubtaskByFile(absPath);
  if (!found) return; // file isn't tracked to any subtask yet — nothing to reconcile

  const { task, subtask } = found;
  console.log(`[file watcher] human edit detected — re-running ${agentName} agent for subtask ${subtask.id}`);

  let currentContent;
  try {
    currentContent = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    console.warn(`[file watcher] could not read ${absPath}: ${err.message}`);
    return;
  }

  const relPath = path.relative(dir, absPath);
  const followUp = `${subtask.description}

NOTE: the file "${relPath}" was just edited externally. Its current content is:

${currentContent}

Adjust the implementation to stay consistent with this change and the API contract, without breaking the other endpoints.`;

  const agentRunner = agents[agentName];
  try {
    const result = await agentRunner(followUp, task.apiContract);
    taskStore.addSubtaskFiles(task.id, subtask.id, result.filesWritten);
  } catch (err) {
    console.error(`[file watcher] agent re-run failed for subtask ${subtask.id}: ${err.message}`);
  }
}

function start() {
  WATCH_TARGETS.forEach(({ dir, agent }) => {
    const watcher = chokidar.watch(dir, {
      ignored: /(^|[\/\\])\..|node_modules/,
      ignoreInitial: true,
      persistent: true,
    });

    watcher
      .on('add', (filePath) => scheduleEvent(agent, path.resolve(filePath), dir, 'created'))
      .on('change', (filePath) => scheduleEvent(agent, path.resolve(filePath), dir, 'modified'))
      .on('unlink', (filePath) => scheduleEvent(agent, path.resolve(filePath), dir, 'deleted'));
      

    console.log(`[file watcher] watching ${agent}/ at ${dir}`);
  });
}

module.exports = { start };