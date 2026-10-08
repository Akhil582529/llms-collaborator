/**
 * Supported build stacks.
 *
 * Keep this catalogue explicit: the intake UI, API validation, planner, and
 * coding agents all use the same source of truth. Adding a new option here is
 * therefore deliberate rather than an unsupported suggestion from an LLM.
 */
const STACK_OPTIONS = {
  frontend: [
    { id: 'react', label: 'React', description: 'Component-based web UI built with React.' },
    { id: 'vue', label: 'Vue', description: 'Progressive web UI built with Vue 3 and Vite.' },
    { id: 'angular', label: 'Angular', description: 'TypeScript web application built with Angular.' },
  ],
  backend: [
    { id: 'express', label: 'Node.js + Express', description: 'REST API built with Express.' },
    { id: 'fastify', label: 'Node.js + Fastify', description: 'High-performance REST API built with Fastify.' },
  ],
  database: [
    { id: 'firebase', label: 'Firebase Firestore', description: 'Managed cloud document database.' },
    { id: 'postgresql', label: 'PostgreSQL', description: 'Relational database, accessed with the pg driver.' },
    { id: 'mongodb', label: 'MongoDB', description: 'Document database, accessed with Mongoose.' },
    { id: 'sqlite', label: 'SQLite', description: 'Local file-based relational database; good for a self-contained app.' },
    { id: 'memory', label: 'In-memory', description: 'No external database; data resets when the server restarts.' },
  ],
};

const DEFAULT_STACK = {
  frontend: 'react',
  backend: 'express',
  database: 'sqlite',
};

function findOption(category, id) {
  return STACK_OPTIONS[category].find((option) => option.id === id);
}

function normalizeTechStack(stack) {
  if (!stack || typeof stack !== 'object' || Array.isArray(stack)) {
    throw new Error('techStack is required. Choose a frontend, backend, and database before building.');
  }

  const normalized = {};
  for (const category of Object.keys(STACK_OPTIONS)) {
    const value = typeof stack[category] === 'string'
      ? stack[category].trim().toLowerCase()
      : '';
    const option = findOption(category, value);
    if (!option) {
      throw new Error(`Unsupported ${category} stack: "${stack[category] || 'none'}".`);
    }
    normalized[category] = option.id;
  }
  return normalized;
}

function getStackOptions(requirement = '') {
  return {
    requirement,
    options: STACK_OPTIONS,
    recommended: DEFAULT_STACK,
  };
}

function describeTechStack(stack) {
  const normalized = normalizeTechStack(stack);
  return Object.entries(normalized)
    .map(([category, id]) => `${category}: ${findOption(category, id).label}`)
    .join(', ');
}

module.exports = {
  STACK_OPTIONS,
  DEFAULT_STACK,
  getStackOptions,
  normalizeTechStack,
  describeTechStack,
};
