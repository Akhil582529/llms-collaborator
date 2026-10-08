/**
 * PostgreSQL persistence for the orchestrator's own history: which
 * projects it has built, which models built them, what each model
 * contributed, and what every attempt cost in tokens.
 *
 * This is the ORCHESTRATOR's database, separate from whatever database
 * the projects it generates use. Configure it with:
 *
 *   ORCHESTRATOR_DATABASE_URL=postgresql://user@localhost:5432/llms_collaborator
 *
 * Design rules:
 *  - Persistence is optional. With no URL configured, or if Postgres is
 *    down, the orchestrator runs exactly as before and simply doesn't
 *    save history. Nothing in here is allowed to throw into a caller.
 *  - Writes are serialized through one promise queue, so a project row
 *    always exists before its runs are inserted and rows land in the
 *    order things happened. Callers don't await them.
 *  - Tables are created automatically on startup (CREATE IF NOT EXISTS).
 *
 * Three tables:
 *   projects        one row per generated project (name, status, totals)
 *   project_agents  one row per model per project (share %, tokens)
 *   subtask_runs    one row per ATTEMPT (the raw data that lets you
 *                   compare models across every project)
 */

'use strict';

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.ORCHESTRATOR_DATABASE_URL;

let pool = null;
let enabled = false;
let queue = Promise.resolve();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  requirement              TEXT NOT NULL,
  tech_stack               JSONB,
  status                   TEXT NOT NULL,
  validation_status        TEXT,
  created_at               TIMESTAMPTZ NOT NULL,
  finished_at              TIMESTAMPTZ,
  duration_ms              BIGINT NOT NULL DEFAULT 0,
  active_ms                BIGINT NOT NULL DEFAULT 0,
  total_subtasks           INT    NOT NULL DEFAULT 0,
  completed_subtasks       INT    NOT NULL DEFAULT 0,
  models_used              INT    NOT NULL DEFAULT 0,
  models_attempted         INT    NOT NULL DEFAULT 0,
  total_prompt_tokens      BIGINT NOT NULL DEFAULT 0,
  total_completion_tokens  BIGINT NOT NULL DEFAULT 0,
  total_tokens             BIGINT NOT NULL DEFAULT 0,
  wasted_tokens            BIGINT NOT NULL DEFAULT 0,
  total_lines              INT    NOT NULL DEFAULT 0,
  total_files              INT    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_agents (
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  display_name        TEXT,
  percentage          NUMERIC(5,1) NOT NULL DEFAULT 0,
  subtasks_completed  INT    NOT NULL DEFAULT 0,
  files_written       INT    NOT NULL DEFAULT 0,
  lines_added         INT    NOT NULL DEFAULT 0,
  attempts            INT    NOT NULL DEFAULT 0,
  failed_attempts     INT    NOT NULL DEFAULT 0,
  prompt_tokens       BIGINT NOT NULL DEFAULT 0,
  completion_tokens   BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,
  productive_tokens   BIGINT NOT NULL DEFAULT 0,
  wasted_tokens       BIGINT NOT NULL DEFAULT 0,
  active_ms           BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS subtask_runs (
  id                   BIGSERIAL PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subtask_id           TEXT NOT NULL,
  subtask_description  TEXT,
  domain               TEXT,
  attempt_number       INT  NOT NULL,
  agent_id             TEXT NOT NULL,
  agent_display_name   TEXT,
  outcome              TEXT NOT NULL,
  reason               TEXT,
  prompt_tokens        INT  NOT NULL DEFAULT 0,
  completion_tokens    INT  NOT NULL DEFAULT 0,
  total_tokens         INT  NOT NULL DEFAULT 0,
  tokens_estimated     BOOLEAN NOT NULL DEFAULT FALSE,
  files_written        INT  NOT NULL DEFAULT 0,
  lines_added          INT  NOT NULL DEFAULT 0,
  duration_ms          INT  NOT NULL DEFAULT 0,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subtask_runs_project ON subtask_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_subtask_runs_agent   ON subtask_runs(agent_id);
`;

async function initInternal() {
  if (!CONNECTION_STRING) {
    console.log(
      '[persistence] ORCHESTRATOR_DATABASE_URL not set — project history will not be saved.'
    );
    return false;
  }

  try {
    pool = new Pool({ connectionString: CONNECTION_STRING });

    // Without this, an idle client erroring (e.g. Postgres restarted)
    // is an unhandled 'error' event and takes the whole process down.
    pool.on('error', (err) => {
      console.error('[persistence] idle client error:', err.message);
    });

    await pool.query(SCHEMA);

    enabled = true;
    console.log(
      '[persistence] connected — project history is being saved to PostgreSQL.'
    );
    return true;
  } catch (err) {
    console.error(
      '[persistence] could not initialize PostgreSQL — history will not be saved:',
      err.message
    );

    enabled = false;

    if (pool) {
      pool.end().catch(() => {});
      pool = null;
    }

    return false;
  }
}

// Starts on require. server.js loads dotenv before requiring the
// orchestrator, so the env var is already populated by this point.
const ready = initInternal();

function isEnabled() {
  return enabled;
}

/**
 * Serialized, non-throwing write. Callers do not need to await it.
 */
function enqueue(label, fn) {
  queue = queue.then(async () => {
    await ready;
    if (!enabled) return null;

    try {
      return await fn();
    } catch (err) {
      console.error(`[persistence] ${label} failed:`, err.message);
      return null;
    }
  });

  return queue;
}

const EMPTY_TOTALS = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  wastedTokens: 0,
  activeMs: 0,
  linesAdded: 0,
  filesWritten: 0,
};

/**
 * Copies just the fields we need out of the live task right now, so a
 * queued write reflects the task as it was when it was requested, not
 * as it happens to be whenever the queue reaches it.
 */
function snapshotTask(task) {
  return {
    id: task.id,
    name: task.name || task.requirement || 'Untitled project',
    requirement: task.requirement || '',
    techStack: task.techStack || null,
    status: task.status || 'unknown',
    validationStatus: task.validationStatus || null,
    createdAt: task.createdAt || new Date().toISOString(),
    totalSubtasks: (task.subtasks || []).length,
    completedSubtasks: (task.subtasks || []).filter(
      (s) => s.status === 'done'
    ).length,
  };
}

async function writeProjectRow(db, snap, summary, finished) {
  const agents = summary?.agents || [];
  const totals = { ...EMPTY_TOTALS, ...(summary?.totals || {}) };

  const durationMs = finished
    ? Math.max(Date.now() - new Date(snap.createdAt).getTime(), 0)
    : 0;

  await db.query(
    `INSERT INTO projects (
       id, name, requirement, tech_stack, status, validation_status,
       created_at, finished_at, duration_ms, active_ms,
       total_subtasks, completed_subtasks, models_used, models_attempted,
       total_prompt_tokens, total_completion_tokens, total_tokens,
       wasted_tokens, total_lines, total_files
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13, $14,
       $15, $16, $17,
       $18, $19, $20
     )
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       validation_status = EXCLUDED.validation_status,
       finished_at = EXCLUDED.finished_at,
       duration_ms = EXCLUDED.duration_ms,
       active_ms = EXCLUDED.active_ms,
       total_subtasks = EXCLUDED.total_subtasks,
       completed_subtasks = EXCLUDED.completed_subtasks,
       models_used = EXCLUDED.models_used,
       models_attempted = EXCLUDED.models_attempted,
       total_prompt_tokens = EXCLUDED.total_prompt_tokens,
       total_completion_tokens = EXCLUDED.total_completion_tokens,
       total_tokens = EXCLUDED.total_tokens,
       wasted_tokens = EXCLUDED.wasted_tokens,
       total_lines = EXCLUDED.total_lines,
       total_files = EXCLUDED.total_files`,
    [
      snap.id,
      snap.name,
      snap.requirement,
      snap.techStack ? JSON.stringify(snap.techStack) : null,
      snap.status,
      snap.validationStatus,
      snap.createdAt,
      finished ? new Date().toISOString() : null,
      durationMs,
      totals.activeMs,
      snap.totalSubtasks,
      snap.completedSubtasks,
      agents.filter((a) => a.subtasksCompleted > 0).length,
      agents.length,
      totals.promptTokens,
      totals.completionTokens,
      totals.totalTokens,
      totals.wastedTokens,
      totals.linesAdded,
      totals.filesWritten,
    ]
  );
}

/**
 * Registers a project as soon as it is planned, so it shows up in the
 * history immediately (status in_progress) and so later run rows have a
 * parent row to reference.
 */
function saveProjectStart(task) {
  const snap = snapshotTask(task);

  return enqueue('saveProjectStart', () =>
    writeProjectRow(pool, snap, null, false)
  );
}

/**
 * Writes the project's final (or latest, after a retry) totals and
 * replaces its per-model breakdown. Idempotent: safe to call again
 * after each retry, and it always reflects the full in-memory totals.
 */
function finalizeProject(task, summary) {
  const snap = snapshotTask(task);
  const agents = (summary?.agents || []).map((a) => ({ ...a }));
  const frozenSummary = { agents, totals: { ...(summary?.totals || {}) } };

  return enqueue('finalizeProject', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await writeProjectRow(client, snap, frozenSummary, true);

      await client.query('DELETE FROM project_agents WHERE project_id = $1', [
        snap.id,
      ]);

      for (const a of agents) {
        await client.query(
          `INSERT INTO project_agents (
             project_id, agent_id, display_name, percentage,
             subtasks_completed, files_written, lines_added,
             attempts, failed_attempts,
             prompt_tokens, completion_tokens, total_tokens,
             productive_tokens, wasted_tokens, active_ms
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            snap.id,
            a.agentId,
            a.displayName,
            a.percentage || 0,
            a.subtasksCompleted || 0,
            a.filesWritten || 0,
            a.linesAdded || 0,
            a.attempts || 0,
            a.failedAttempts || 0,
            a.promptTokens || 0,
            a.completionTokens || 0,
            a.totalTokens || 0,
            a.productiveTokens || 0,
            a.wastedTokens || 0,
            a.activeMs || 0,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Records one attempt by one agent at one subtask — the raw data behind
 * every cross-project model comparison.
 */
function recordRun(run) {
  const row = { ...run };

  return enqueue('recordRun', () =>
    pool.query(
      `INSERT INTO subtask_runs (
         project_id, subtask_id, subtask_description, domain,
         attempt_number, agent_id, agent_display_name,
         outcome, reason,
         prompt_tokens, completion_tokens, total_tokens, tokens_estimated,
         files_written, lines_added, duration_ms, error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        row.projectId,
        row.subtaskId,
        row.subtaskDescription || null,
        row.domain || null,
        row.attempt || 1,
        row.agentId,
        row.agentName || null,
        row.outcome,
        row.reason || null,
        row.promptTokens || 0,
        row.completionTokens || 0,
        row.totalTokens || 0,
        Boolean(row.estimated),
        row.filesWritten || 0,
        row.linesAdded || 0,
        Math.round(row.durationMs || 0),
        row.error || null,
      ]
    )
  );
}

/* ------------------------------------------------------------------ */
/* Reads. Not queued — they don't need ordering and callers await them. */
/* ------------------------------------------------------------------ */

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    requirement: row.requirement,
    techStack: row.tech_stack,
    status: row.status,
    validationStatus: row.validation_status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    durationMs: num(row.duration_ms),
    activeMs: num(row.active_ms),
    totalSubtasks: num(row.total_subtasks),
    completedSubtasks: num(row.completed_subtasks),
    modelsUsed: num(row.models_used),
    modelsAttempted: num(row.models_attempted),
    promptTokens: num(row.total_prompt_tokens),
    completionTokens: num(row.total_completion_tokens),
    totalTokens: num(row.total_tokens),
    wastedTokens: num(row.wasted_tokens),
    totalLines: num(row.total_lines),
    totalFiles: num(row.total_files),
  };
}

function mapAgent(row) {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    percentage: num(row.percentage),
    subtasksCompleted: num(row.subtasks_completed),
    filesWritten: num(row.files_written),
    linesAdded: num(row.lines_added),
    attempts: num(row.attempts),
    failedAttempts: num(row.failed_attempts),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    productiveTokens: num(row.productive_tokens),
    wastedTokens: num(row.wasted_tokens),
    activeMs: num(row.active_ms),
  };
}

function mapRun(row) {
  return {
    id: num(row.id),
    subtaskId: row.subtask_id,
    subtaskDescription: row.subtask_description,
    domain: row.domain,
    attempt: num(row.attempt_number),
    agentId: row.agent_id,
    agentName: row.agent_display_name,
    outcome: row.outcome,
    reason: row.reason,
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    estimated: row.tokens_estimated,
    filesWritten: num(row.files_written),
    linesAdded: num(row.lines_added),
    durationMs: num(row.duration_ms),
    error: row.error,
    at: row.created_at,
  };
}

async function listProjects(limit = 50) {
  await ready;
  if (!enabled) return { enabled: false, projects: [] };

  const { rows } = await pool.query(
    `SELECT * FROM projects ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );

  const projects = rows.map(mapProject);

  if (projects.length > 0) {
    const agentRows = await pool.query(
      `SELECT * FROM project_agents
       WHERE project_id = ANY($1)
       ORDER BY percentage DESC, total_tokens DESC`,
      [projects.map((p) => p.id)]
    );

    const byProject = new Map();

    for (const row of agentRows.rows) {
      if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
      byProject.get(row.project_id).push(mapAgent(row));
    }

    for (const p of projects) {
      p.agents = byProject.get(p.id) || [];
    }
  }

  return { enabled: true, projects };
}

async function getProject(id) {
  await ready;
  if (!enabled) return { enabled: false, project: null };

  const projectRes = await pool.query('SELECT * FROM projects WHERE id = $1', [
    id,
  ]);

  if (projectRes.rows.length === 0) return { enabled: true, project: null };

  const [agentRes, runRes] = await Promise.all([
    pool.query(
      `SELECT * FROM project_agents WHERE project_id = $1
       ORDER BY percentage DESC, total_tokens DESC`,
      [id]
    ),
    pool.query(
      `SELECT * FROM subtask_runs WHERE project_id = $1 ORDER BY id ASC`,
      [id]
    ),
  ]);

  return {
    enabled: true,
    project: {
      ...mapProject(projectRes.rows[0]),
      agents: agentRes.rows.map(mapAgent),
      runs: runRes.rows.map(mapRun),
    },
  };
}

/**
 * Cross-project comparison of every model that has ever run.
 *
 * successRate deliberately ignores 'unavailable' attempts (rate limits,
 * unpaid accounts, provider outages): those say something about the
 * account, not the model. It is successes / (successes + zero-file
 * completions + errors) — i.e. how often the model got a fair shot at a
 * subtask and delivered.
 *
 * tokensPerLine is productive tokens / lines written by successful
 * attempts — the fairest single "how efficient is it" number.
 */
async function getModelStats() {
  await ready;
  if (!enabled) return { enabled: false, models: [] };

  const { rows } = await pool.query(`
    SELECT
      agent_id,
      MAX(agent_display_name)                                   AS display_name,
      COUNT(*)                                                  AS attempts,
      COUNT(*) FILTER (WHERE outcome = 'success')               AS successes,
      COUNT(*) FILTER (WHERE outcome = 'zero_files')            AS zero_files,
      COUNT(*) FILTER (WHERE outcome = 'error')                 AS errors,
      COUNT(*) FILTER (WHERE outcome = 'unavailable')           AS unavailable,
      COALESCE(SUM(total_tokens), 0)                            AS total_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE outcome = 'success'), 0)  AS productive_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE outcome <> 'success'), 0) AS wasted_tokens,
      COALESCE(SUM(lines_added)  FILTER (WHERE outcome = 'success'), 0)  AS lines_added,
      COUNT(DISTINCT project_id)                                AS projects,
      AVG(total_tokens) FILTER (WHERE outcome = 'success')      AS avg_tokens_per_success,
      AVG(duration_ms)  FILTER (WHERE outcome = 'success')      AS avg_duration_ms
    FROM subtask_runs
    GROUP BY agent_id
  `);

  const models = rows.map((r) => {
    const successes = num(r.successes);
    const zeroFiles = num(r.zero_files);
    const errors = num(r.errors);
    const fairAttempts = successes + zeroFiles + errors;
    const productive = num(r.productive_tokens);
    const lines = num(r.lines_added);

    return {
      agentId: r.agent_id,
      displayName: r.display_name,
      projects: num(r.projects),
      attempts: num(r.attempts),
      successes,
      zeroFiles,
      errors,
      unavailable: num(r.unavailable),
      successRate:
        fairAttempts > 0
          ? Math.round((successes / fairAttempts) * 1000) / 10
          : null,
      totalTokens: num(r.total_tokens),
      productiveTokens: productive,
      wastedTokens: num(r.wasted_tokens),
      linesAdded: lines,
      tokensPerLine: lines > 0 ? Math.round((productive / lines) * 10) / 10 : null,
      avgTokensPerSuccess:
        r.avg_tokens_per_success === null
          ? null
          : Math.round(num(r.avg_tokens_per_success)),
      avgDurationMs:
        r.avg_duration_ms === null ? null : Math.round(num(r.avg_duration_ms)),
    };
  });

  // Most reliable first; among equals, cheapest per line first. Models
  // with no data for a metric sort after ones that have it.
  models.sort((a, b) => {
    const ar = a.successRate ?? -1;
    const br = b.successRate ?? -1;
    if (br !== ar) return br - ar;

    const at = a.tokensPerLine ?? Infinity;
    const bt = b.tokensPerLine ?? Infinity;
    return at - bt;
  });

  return { enabled: true, models };
}

module.exports = {
  ready,
  isEnabled,
  saveProjectStart,
  finalizeProject,
  recordRun,
  listProjects,
  getProject,
  getModelStats,
};