/**
 * Tracks, per task, how much each agent contributed AND what it cost:
 *
 *   - contribution: files / lines written and subtasks completed
 *     (drives the "who built how much of this project" percentages)
 *   - cost: prompt / completion / total tokens, split into PRODUCTIVE
 *     tokens (spent on attempts that produced files) and WASTED tokens
 *     (spent on attempts that errored, were rate-limited, or finished
 *     without writing anything)
 *
 * Splitting productive from wasted is the point: total tokens alone
 * rewards a model that fails fast and punishes one that works hard and
 * ships. tokensPerLine (productive tokens / lines written) is the fairer
 * "how efficient is this model" number to compare across models.
 *
 * In-memory, same as the task store. Permanent history lives in
 * persistence.js (PostgreSQL); this module only serves the live task.
 */

'use strict';

const contributionsByTask = new Map();

function ensureTask(taskId) {
  if (!contributionsByTask.has(taskId)) {
    contributionsByTask.set(taskId, new Map());
  }
  return contributionsByTask.get(taskId);
}

function newAgentRecord(agentId, displayName) {
  return {
    agentId,
    displayName,

    // contribution
    filesWritten: 0,
    linesAdded: 0,
    subtasksCompleted: 0,

    // attempts
    attempts: 0,
    failedAttempts: 0,
    unavailableAttempts: 0,
    estimatedAttempts: 0,

    // cost
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    productiveTokens: 0,
    wastedTokens: 0,
    activeMs: 0,
  };
}

function ensureAgent(taskId, agentId, displayName) {
  const task = ensureTask(taskId);

  if (!task.has(agentId)) {
    task.set(agentId, newAgentRecord(agentId, displayName));
  }

  const record = task.get(agentId);
  if (displayName) record.displayName = displayName;

  return record;
}

/**
 * Call once per completed subtask (success only) — feeds the
 * contribution percentages. Token cost is recorded separately, per
 * attempt, by recordAttempt.
 */
function recordContribution(taskId, agentId, displayName, stats = {}) {
  const record = ensureAgent(taskId, agentId, displayName);

  record.filesWritten += stats.filesWritten || 0;
  record.linesAdded += stats.linesAdded || 0;
  record.subtasksCompleted += 1;
}

/**
 * Call once per attempt, whatever its outcome. `attempt` carries
 * { outcome, promptTokens, completionTokens, totalTokens, estimated,
 *   durationMs }.
 *
 * outcome === 'success'     -> tokens count as productive
 * anything else             -> tokens count as wasted
 * outcome === 'unavailable' -> also counted separately, since a
 *   rate-limited or unpaid account says little about model quality
 */
function recordAttempt(taskId, agentId, displayName, attempt = {}) {
  const record = ensureAgent(taskId, agentId, displayName);

  const total = attempt.totalTokens || 0;

  record.attempts += 1;
  record.promptTokens += attempt.promptTokens || 0;
  record.completionTokens += attempt.completionTokens || 0;
  record.totalTokens += total;
  record.activeMs += attempt.durationMs || 0;

  if (attempt.estimated) record.estimatedAttempts += 1;

  if (attempt.outcome === 'success') {
    record.productiveTokens += total;
  } else {
    record.wastedTokens += total;
    record.failedAttempts += 1;

    if (attempt.outcome === 'unavailable') {
      record.unavailableAttempts += 1;
    }
  }
}

/**
 * Per-agent stats plus each agent's percentage share of the project (by
 * lines added, falling back to files if no lines were recorded), sorted
 * by contribution then by tokens spent. Agents that only ever failed
 * still appear, at 0%, so wasted spend is visible.
 */
function getContributionSummary(taskId) {
  const task = contributionsByTask.get(taskId);

  const emptyTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    productiveTokens: 0,
    wastedTokens: 0,
    attempts: 0,
    failedAttempts: 0,
    activeMs: 0,
    linesAdded: 0,
    filesWritten: 0,
  };

  if (!task || task.size === 0) {
    return {
      taskId,
      agents: [],
      totalLines: 0,
      totalFiles: 0,
      metric: 'linesAdded',
      totals: emptyTotals,
    };
  }

  const agents = Array.from(task.values());

  const totals = agents.reduce(
    (sum, a) => ({
      promptTokens: sum.promptTokens + a.promptTokens,
      completionTokens: sum.completionTokens + a.completionTokens,
      totalTokens: sum.totalTokens + a.totalTokens,
      productiveTokens: sum.productiveTokens + a.productiveTokens,
      wastedTokens: sum.wastedTokens + a.wastedTokens,
      attempts: sum.attempts + a.attempts,
      failedAttempts: sum.failedAttempts + a.failedAttempts,
      activeMs: sum.activeMs + a.activeMs,
      linesAdded: sum.linesAdded + a.linesAdded,
      filesWritten: sum.filesWritten + a.filesWritten,
    }),
    emptyTotals
  );

  const useLines = totals.linesAdded > 0;
  const denominator = useLines ? totals.linesAdded : totals.filesWritten;

  const withPercentages = agents
    .map((a) => ({
      ...a,
      percentage:
        denominator > 0
          ? Math.round(
              ((useLines ? a.linesAdded : a.filesWritten) / denominator) *
                1000
            ) / 10
          : 0,
      tokensPerLine:
        a.linesAdded > 0
          ? Math.round((a.productiveTokens / a.linesAdded) * 10) / 10
          : null,
    }))
    .sort(
      (a, b) =>
        b.percentage - a.percentage || b.totalTokens - a.totalTokens
    );

  return {
    taskId,
    agents: withPercentages,
    totalLines: totals.linesAdded,
    totalFiles: totals.filesWritten,
    metric: useLines ? 'linesAdded' : 'filesWritten',
    totals,
  };
}

function resetTask(taskId) {
  contributionsByTask.delete(taskId);
}

module.exports = {
  recordContribution,
  recordAttempt,
  getContributionSummary,
  resetTask,
};