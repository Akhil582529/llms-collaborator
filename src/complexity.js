/**
 * Cheap, deterministic subtask complexity scoring.
 *
 * Complexity is about the amount of reasoning/work required by the subtask,
 * NOT whether the task is frontend or backend.
 *
 * Agents are general-purpose coding agents. A selected agent may modify
 * frontend, backend, database, configuration, tests, or any combination
 * required by the subtask.
 *
 * Returns:
 *   'small'  -> simple implementation
 *   'medium' -> moderate implementation
 *   'large'  -> complex / cross-file / architectural work
 */

'use strict';

const VALID = ['small', 'medium', 'large'];

/**
 * Heavy concepts usually requiring multiple files, deeper reasoning,
 * or interaction between multiple parts of the application.
 */
const HEAVY = [
  'auth',
  'authentication',
  'authorization',
  'login',
  'register',
  'jwt',
  'token',
  'session',

  'upload',
  'multer',
  'file',
  'files',
  'image',
  'ocr',

  'compare',
  'comparison',
  'analy',
  'analysis',
  'forg',
  'tamper',
  'verif',
  'verification',

  'websocket',
  'socket',

  'payment',
  'transaction',

  'migration',
  'schema',
  'database',

  'crud',
  'pagination',

  'middleware',

  'routing',
  'router',

  'dashboard',

  'integration',
  'integrate',

  'api',

  'deployment',

  'testing',
  'test',

  'state management',
  'global state',
];

/**
 * Normal implementation concepts.
 */
const MEDIUM = [
  'form',
  'list',
  'fetch',
  'table',
  'component',
  'page',
  'route',
  'endpoint',
  'validate',
  'validation',
  'display',
  'modal',
  'filter',
  'search',
  'notification',
  'error handling',
  'loading',
  'state',
];

/**
 * Validation/repair tasks require reading existing code and reasoning
 * about what is already implemented.
 */
const REPAIR_MARKERS = [
  'automated project validation failed',
  'failed structural validation',
  'validation failed',
  'fix the failing',
  'fix the bug',
  'debug',
  'repair',
];

/**
 * Count keyword occurrences.
 */
function countHits(text, words) {
  return words.reduce(
    (count, word) => count + (text.includes(word) ? 1 : 0),
    0
  );
}

/**
 * Estimate how difficult a subtask is.
 *
 * IMPORTANT:
 * There is intentionally NO:
 *
 *   subtask.agent === 'frontend'
 *   subtask.agent === 'backend'
 *
 * logic here.
 *
 * Any agent can work on any part of the project.
 */
function estimateComplexity(subtask) {
  // If planner explicitly provides complexity, respect it.
  const planned = String(subtask?.complexity || '').toLowerCase();

  if (VALID.includes(planned)) {
    return planned;
  }

  const text = String(
    subtask?.description ||
    subtask?.title ||
    ''
  ).toLowerCase();

  // Repairs/debugging are always at least medium and usually large.
  if (REPAIR_MARKERS.some((marker) => text.includes(marker))) {
    return 'large';
  }

  let score = 0;

  // Description size.
  if (text.length > 250) score += 1;
  if (text.length > 450) score += 2;
  if (text.length > 700) score += 2;

  // Heavy engineering concepts.
  score += countHits(text, HEAVY) * 2;

  // Normal implementation concepts.
  score += countHits(text, MEDIUM);

  // Multiple requirements indicate broader work.
  const commas = (text.match(/,/g) || []).length;
  const ands = (text.match(/\band\b/g) || []).length;

  if (commas >= 3) score += 1;
  if (commas >= 6) score += 2;

  if (ands >= 2) score += 1;
  if (ands >= 4) score += 2;

  // Explicit full-stack / cross-stack language.
  const isCrossStack =
    /frontend.*backend/i.test(text) ||
    /backend.*frontend/i.test(text) ||
    /front.?end.*back.?end/i.test(text) ||
    /back.?end.*front.?end/i.test(text) ||
    /full.?stack/i.test(text) ||
    /end.?to.?end/i.test(text) ||
    /complete feature/i.test(text);

  if (isCrossStack) {
    score += 3;
  }

  if (score <= 2) return 'small';
  if (score <= 6) return 'medium';

  return 'large';
}

module.exports = {
  estimateComplexity,
};