/**
 * Activity Log
 *
 * Stores recent orchestrator events and notifies live subscribers.
 */

const MAX_ENTRIES = 200;

const entries = [];
const subscribers = new Set();

function log(event) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...event,
  };

  entries.push(entry);

  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  // Push the event to all currently connected UI clients.
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch {
      subscribers.delete(subscriber);
    }
  }

  return entry;
}

function getAll() {
  return [...entries];
}

function subscribe(callback) {
  subscribers.add(callback);

  return () => {
    subscribers.delete(callback);
  };
}

module.exports = {
  log,
  getAll,
  subscribe,
};