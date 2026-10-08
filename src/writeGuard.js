/**
 * Shared guard so the file watcher can tell the difference between "an
 * agent just wrote this file" and "a human just edited this file" — both
 * fire the same chokidar 'change'/'add' event, but only the second should
 * ever re-trigger an agent.
 */

const RECENT_WRITE_WINDOW_MS = 2000;
const recentWrites = new Map(); // absPath -> timestamp

function markWritten(absPath) {
  recentWrites.set(absPath, Date.now());
}

function wasJustWrittenByAgent(absPath) {
  const ts = recentWrites.get(absPath);
  if (!ts) return false;
  const isRecent = Date.now() - ts < RECENT_WRITE_WINDOW_MS;
  if (!isRecent) recentWrites.delete(absPath);
  return isRecent;
}

module.exports = { markWritten, wasJustWrittenByAgent };