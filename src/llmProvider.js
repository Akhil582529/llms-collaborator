/**
 * LLM Provider — swappable interface.
 *
 * The Orchestrator only ever calls `planTask(requirement)`. It doesn't know
 * or care whether that's a mock, Gemini, Groq, or Claude under the hood.
 * When you get an API key, write a new provider file (e.g. geminiProvider.js)
 * that exports the same `planTask` function shape, and swap the import in
 * orchestrator.js. Nothing else changes.
 *
 * Expected return shape of planTask:
 * {
 *   subtasks: [
 *     { agent: 'frontend' | 'backend', description: string, dependsOn: string[] }
 *   ]
 * }
 */

// --- MOCK PROVIDER ---
// Very naive keyword-based "planner" so the orchestrator has something real
// to route without needing an API key yet. Replace this function body with
// an actual LLM call later — keep the signature identical.
async function planTask(requirement) {
  const text = requirement.toLowerCase();

  const subtasks = [];

  // crude heuristic split — this is ONLY a placeholder for the real LLM call
  if (text.includes('ui') || text.includes('frontend') || text.includes('page') || text.includes('app') || true) {
    subtasks.push({
      agent: 'frontend',
      description: `Build the UI for: ${requirement}`,
      dependsOn: [],
    });
  }

  if (text.includes('api') || text.includes('backend') || text.includes('database') || text.includes('server') || true) {
    subtasks.push({
      agent: 'backend',
      description: `Build the API/data layer for: ${requirement}`,
      dependsOn: [],
    });
  }

  // simulate network latency like a real LLM call would have
  await new Promise((resolve) => setTimeout(resolve, 300));

  return { subtasks };
}

module.exports = { planTask };
