const fs = require('fs');
const path = require('path');

const { ensureProjectDatabase } = require('./projectDb');
const { pickAgent, listRegisteredAgents, markCooldown } = require('./agentRegistry');
const contributions = require('./contributions');
const llmProvider = require('./groqProvider');
const taskStore = require('./taskStore');
const persistence = require('./persistance');
const referenceStore = require('./referenceStore');
const { analyzeReferences } = require('./referenceAnalyzer');
const { analyzeMarkdown } = require('./specAnalyzer');
const { estimateComplexity } = require('./complexity');
const { runSmokeTests } = require('./smokeTest');
const { runBrowserE2E } = require('./browserE2E');
const { installMissingDependencies } = require('./dependencyFixer');
const { fixUploadFieldNames } = require('./uploadContractFixer');
const { installUiKit, withGuides, checkStack } = require('./projectGuides');

const { scaffoldProject } = require('./scaffold');

const {
  startGeneratedApp,
  killTracked,
  readLogTail,
  checkHttp,
  FRONTEND_PORT,
} = require('./appRunner');

const { BACKEND_PORT } = require('./backendAgent');
const { checkFrontendCompleteness } = require('./completenessCheck');
const { validateProject } = require('./projectValidator');
const { getStackOptions, normalizeTechStack } = require('./techStack');

const MAX_FIXUP_ROUNDS = Number(process.env.MAX_FIXUP_ROUNDS || 3);

// Small local models are fine for UI pieces but unreliable at schema + API
// work, so backend subtasks are never routed below the "medium" tier.
// Set BACKEND_MIN_MEDIUM=false in .env to let local models take them.
const BACKEND_MIN_MEDIUM = process.env.BACKEND_MIN_MEDIUM !== 'false';

const BACKEND_DIR = path.resolve(__dirname, '../../backend');
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

/*
 * ---------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------
 */

function normalizeDependsOn(task) {
  if (!task || !Array.isArray(task.subtasks)) {
    return task;
  }

  const subtasks = task.subtasks;
  const byId = new Map();
  const byAgent = new Map();

  subtasks.forEach((subtask, index) => {
    normalizeSubtaskRouting(subtask);

    byId.set(String(subtask.id), subtask);

    const domain = subtask.domain || subtask.agent;

    if (domain) {
      byAgent.set(String(domain).toLowerCase().trim(), subtask);
    }

    // Backwards compatibility for older task records.
    if (subtask.agent) {
      byAgent.set(String(subtask.agent).toLowerCase().trim(), subtask);
    }

    // Also support planner references such as "0", "1", "2".
    byId.set(String(index), subtask);
  });

  for (const subtask of subtasks) {
    const dependencies = Array.isArray(subtask.dependsOn)
      ? subtask.dependsOn
      : Array.isArray(subtask.dependencies)
        ? subtask.dependencies
        : [];

    const resolved = [];

    for (const dependency of dependencies) {
      if (dependency === null || dependency === undefined) {
        continue;
      }

      const raw = String(dependency).trim();

      // Direct subtask ID / planner index.
      if (byId.has(raw)) {
        const dependencyTask = byId.get(raw);

        if (
          dependencyTask &&
          dependencyTask.id !== undefined &&
          dependencyTask.id !== null &&
          dependencyTask.id !== subtask.id
        ) {
          resolved.push(dependencyTask.id);
        }

        continue;
      }

      // Backwards compatibility for dependencies expressed
      // as backend/frontend agent names.
      const agentMatch = byAgent.get(raw.toLowerCase());

      if (agentMatch && agentMatch.id !== subtask.id) {
        resolved.push(agentMatch.id);
        continue;
      }

      console.warn(
        `[orchestrator] ignoring unresolved dependency "${raw}" for subtask ${subtask.id}`
      );
    }

    subtask.dependsOn = [...new Set(resolved)];
  }

  return task;
}

function inferSubtaskDomain(subtask) {
  const explicit = subtask?.domain ?? subtask?.agent;
  const normalized = explicit ? String(explicit).toLowerCase().trim() : '';

  if (normalized === 'backend' || normalized === 'backendagent') {
    return 'backend';
  }

  if (normalized === 'frontend' || normalized === 'frontendagent') {
    return 'frontend';
  }

  const text = String(
    `${subtask?.title || ''} ${subtask?.description || ''}`
  ).toLowerCase();

  const backendScore = [
    'backend', 'api', 'endpoint', 'server', 'database', 'postgres',
    'mongodb', 'sql', 'express', 'node', 'route', 'authentication',
    'auth', 'jwt', 'middleware', 'schema', 'model', 'migration',
  ].reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);

  const frontendScore = [
    'frontend', 'ui', 'ux', 'react', 'vue', 'angular', 'vite',
    'component', 'page', 'screen', 'css', 'tailwind', 'browser',
    'form', 'dashboard', 'navbar', 'button', 'responsive',
  ].reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);

  // Project setup/integration tasks are allowed to go to either side;
  // use backend as the routing domain so the existing scheduler can
  // still apply its backend capability floor. The selected model itself
  // remains a general-purpose coding agent.
  return frontendScore > backendScore ? 'frontend' : 'backend';
}

function normalizeSubtaskRouting(subtask) {
  if (!subtask || typeof subtask !== 'object') {
    return subtask;
  }

  const domain = inferSubtaskDomain(subtask);

  subtask.domain = domain;

  // Keep `agent` populated for existing dashboard/taskStore code.
  // This is a logical domain, NOT the concrete model/provider.
  subtask.agent = domain;

  if (!Array.isArray(subtask.dependsOn) && Array.isArray(subtask.dependencies)) {
    subtask.dependsOn = [...subtask.dependencies];
  }

  if (!Array.isArray(subtask.dependsOn)) {
    subtask.dependsOn = [];
  }

  return subtask;
}

function normalizeAgentName(agent) {
  if (!agent) {
    return null;
  }

  const value = String(agent).toLowerCase().trim();

  if (value === 'backend' || value === 'backendagent') {
    return 'backend';
  }

  if (value === 'frontend' || value === 'frontendagent') {
    return 'frontend';
  }

  return value;
}

/**
 * `subtask.agent` is a DOMAIN tag — 'backend' or 'frontend' —
 * not a specific model.
 *
 * Which concrete agent executes a domain is decided per-subtask
 * by agentRegistry.pickAgent().
 */
function isBackendSubtask(subtask) {
  return normalizeAgentName(subtask.domain ?? subtask.agent) === 'backend';
}

function isFrontendSubtask(subtask) {
  return normalizeAgentName(subtask.domain ?? subtask.agent) === 'frontend';
}

/*
 * ---------------------------------------------------------
 * API contract source coverage
 * ---------------------------------------------------------
 */

function checkContractCoverage(apiContract = []) {
  if (!Array.isArray(apiContract) || apiContract.length === 0) {
    return { clean: true, missing: [] };
  }

  const routesDir = path.join(BACKEND_DIR, 'routes');
  const fileCache = new Map();

  function readRouteFile(basePathSegment) {
    if (fileCache.has(basePathSegment)) {
      return fileCache.get(basePathSegment);
    }

    const filePath = path.join(routesDir, `${basePathSegment}.js`);

    let content = null;

    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      content = null;
    }

    fileCache.set(basePathSegment, content);
    return content;
  }

  const missing = [];

  for (const endpoint of apiContract) {
    if (!endpoint?.method || !endpoint?.path) {
      continue;
    }

    const method = String(endpoint.method).toLowerCase();
    const fullPath = String(endpoint.path);

    const match = fullPath.match(/^\/api\/([^/]+)(\/.*)?$/);

    if (!match) {
      missing.push(`${endpoint.method.toUpperCase()} ${fullPath}`);
      continue;
    }

    const baseSegment = match[1];
    const mountRelative = match[2] || '/';

    const content = readRouteFile(baseSegment);

    if (content === null) {
      missing.push(`${endpoint.method.toUpperCase()} ${fullPath}`);
      continue;
    }

    const escapedRelative = mountRelative
      .replace(/:[^/]+/g, '__PARAM__')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/__PARAM__/g, '[^/\'"`]+');

    const pattern = new RegExp(
      `\\.${method}\\s*\\(\\s*['"\`]${escapedRelative}['"\`]`,
      'i'
    );

    if (!pattern.test(content)) {
      missing.push(`${endpoint.method.toUpperCase()} ${fullPath}`);
    }
  }

  return {
    clean: missing.length === 0,
    missing,
  };
}

/*
 * ---------------------------------------------------------
 * Usage + persistence helpers
 * ---------------------------------------------------------
 */

function usageOf(result) {
  const u = result?.usage || result?.tokenUsage || {};

  const promptTokens = u.promptTokens ?? u.prompt_tokens ?? 0;
  const completionTokens = u.completionTokens ?? u.completion_tokens ?? 0;

  const totalTokens =
    u.totalTokens ?? u.total_tokens ?? promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: Boolean(u.estimated),
  };
}

function recordAttempt(
  task,
  subtask,
  domain,
  agentChoice,
  attempt,
  startedAt,
  outcome,
  extra = {}
) {
  const durationMs = Date.now() - startedAt;

  try {
    if (typeof contributions.recordAttempt === 'function') {
      contributions.recordAttempt(task.id, agentChoice.id, agentChoice.displayName, {
        outcome,
        promptTokens: extra.promptTokens,
        completionTokens: extra.completionTokens,
        totalTokens: extra.totalTokens,
        estimated: extra.estimated,
        durationMs,
      });
    }
  } catch (error) {
    console.warn('[orchestrator] could not record attempt contribution:', error.message);
  }

  try {
    const pending = persistence.recordRun({
      projectId: task.id,
      subtaskId: subtask.id,
      subtaskDescription: subtask.description,
      domain,
      attempt: attempt + 1,
      agentId: agentChoice.id,
      agentName: agentChoice.displayName,
      outcome,
      durationMs,
      ...extra,
    });

    if (pending && typeof pending.catch === 'function') {
      pending.catch((error) =>
        console.warn('[orchestrator] could not persist run:', error.message)
      );
    }
  } catch (error) {
    console.warn('[orchestrator] could not persist run:', error.message);
  }
}

function refineCooldown(error) {
  const message = String(error?.message || '');

  const budget = message.match(/Limit (\d+), Used (\d+), Requested (\d+)/i);

  if (budget && /tokens per minute|\bTPM\b/i.test(message)) {
    const limit = Number(budget[1]);
    const requested = Number(budget[3]);

    if (requested <= limit) {
      const retry = message.match(/try again in ([\d.]+)\s*(ms|s)\b/i);

      const suggestedMs = retry
        ? Number(retry[1]) * (retry[2].toLowerCase() === 'ms' ? 1 : 1000)
        : 10_000;

      return {
        retryAfterMs: Math.max(5_000, Math.ceil(suggestedMs) + 5_000),
        reason: 'rate_limit',
      };
    }
  }

  return {
    retryAfterMs: error?.retryAfterMs,
    reason: error?.reason,
  };
}

function persistProject(taskId) {
  const task = taskStore.getTask(taskId);

  if (!task) {
    return;
  }

  try {
    persistence.finalizeProject(task, contributions.getContributionSummary(taskId));
  } catch (error) {
    console.error('[orchestrator] could not persist project:', error.message);
  }
}

/**
 * How many subtasks in this project each agent already has.
 */
function agentLoad(task, excludeSubtaskId) {
  const load = {};

  for (const subtask of task.subtasks || []) {
    if (subtask.id === excludeSubtaskId || !subtask.assignedAgentId) {
      continue;
    }

    if (subtask.status === 'done' || subtask.status === 'in_progress') {
      load[subtask.assignedAgentId] = (load[subtask.assignedAgentId] || 0) + 1;
    }
  }

  return load;
}

/*
 * ---------------------------------------------------------
 * Requirement submission
 * ---------------------------------------------------------
 */

let activeTaskId = null;

function assertNoActiveGeneration() {
  if (!activeTaskId) {
    return;
  }

  const activeTask = taskStore.getTask(activeTaskId);

  if (!activeTask) {
    activeTaskId = null;
    return;
  }

  throw new Error(
    `A project is already being generated (task ${activeTaskId}, ` +
      `status=${activeTask.status}). Wait for it to finish before ` +
      'starting another — concurrent generations write to the same ' +
      'backend/frontend folders and will corrupt each other.'
  );
}

function releaseActiveGeneration(taskId) {
  if (activeTaskId === taskId) {
    activeTaskId = null;
  }
}

/**
 * Combines a markdown spec and image analysis into one reference. The
 * document is the source of truth for scope, features and colors; the image
 * only adds layout/visual detail.
 */
function mergeReferences(specRef, imageRef) {
  if (specRef && imageRef) {
    return {
      source: 'markdown+image',
      projectName: specRef.projectName,
      colorLines: specRef.colorLines,
      stackHint: specRef.stackHint,
      forPlanner:
        specRef.forPlanner +
        '\n\nVISUAL REFERENCE (from an uploaded image; the document above wins on scope and features):\n' +
        imageRef.forPlanner,
      forFrontend:
        specRef.forFrontend +
        '\n\nVISUAL REFERENCE (from an uploaded image: use it for layout and look. If its colors differ from the COLOR CODES above, use the document hex values):\n' +
        imageRef.forFrontend,
      forBackend: specRef.forBackend,
    };
  }

  if (specRef) return specRef;

  return imageRef ? { ...imageRef, source: 'image' } : null;
}

/**
 * options:
 *   techStack  { frontend, backend, database }
 *   images     array of image data URLs (optional)
 *   spec       { name, text } uploaded .md project document (optional)
 *
 * The requirement text is optional when a spec is attached.
 */
async function submitRequirement(requirement, options = {}) {
  assertNoActiveGeneration();

  const specText = String(options.spec?.text || '').trim();
  const hasImages = Array.isArray(options.images) && options.images.length > 0;

  if (!String(requirement || '').trim() && !specText) {
    throw new Error('Describe the project or attach a specification (.md) file.');
  }

  let specRef = null;
  let imageRef = null;

  if (specText) {
    specRef = await analyzeMarkdown(specText, options.spec.name || 'spec.md');
  }

  if (hasImages) {
    imageRef = await analyzeReferences(
      options.images,
      String(requirement || '').trim() ||
        specRef?.projectName ||
        'see the uploaded specification'
    );
  }

  const reference = mergeReferences(specRef, imageRef);

  if (reference) {
    referenceStore.set(reference);
  } else {
    referenceStore.clear();
  }

  // The text box is optional when a spec is attached.
  if (!String(requirement || '').trim()) {
    requirement = specRef?.projectName
      ? `Build the project described in the uploaded specification: ${specRef.projectName}`
      : 'Build the project described in the uploaded specification document.';
  }

  const plan = await llmProvider.planTask(
    requirement,
    options.techStack,
    reference?.forPlanner
  );

  /*
   * IMPORTANT:
   *
   * New planner output:
   *
   * { id, title, description, dependencies, complexity }
   *
   * It intentionally does NOT select a concrete model.
   *
   * We normalize the logical domain here so the existing task system
   * and scheduler remain compatible.
   */
  const plannedSubtasks = (plan.subtasks || []).map(normalizeSubtaskRouting);

  const task = taskStore.createTask({
    requirement,
    subtasks: plannedSubtasks,
    techStack: options.techStack,
    apiContract: plan.apiContract || [],
  });

  activeTaskId = task.id;

  persistence.saveProjectStart(task);

  normalizeDependsOn(task);

  let databaseUrl;

  if (options.techStack?.database === 'postgresql') {
    try {
      databaseUrl = await ensureProjectDatabase(task.id);
    } catch (error) {
      console.error('[orchestrator] could not create project database:', error.message);
    }
  }

  try {
    scaffoldProject({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
      techStack: options.techStack,
      requirement,
      databaseUrl,
    });
  } catch (error) {
    console.error('[orchestrator] scaffolding failed:', error.message);
  }

  try {
    installUiKit(FRONTEND_DIR);

    for (const line of checkStack(options.techStack, BACKEND_DIR, FRONTEND_DIR)) {
      console.log(line);
    }
  } catch (error) {
    console.error('[orchestrator] ui kit / stack check failed:', error.message);
  }

  console.log(
    '[orchestrator] planned subtasks:',
    task.subtasks.map((subtask) => ({
      id: subtask.id,
      domain: subtask.domain,
      agent: subtask.agent,
      dependsOn: subtask.dependsOn,
      description: subtask.description,
    }))
  );

  setImmediate(() => {
    runAndStart(task.id)
      .catch((error) => {
        console.error(`[orchestrator] Task ${task.id} failed:`, error);

        taskStore.updateTask(task.id, {
          status: 'failed',
          error: error.message,
        });

        persistProject(task.id);
      })
      .finally(() => {
        releaseActiveGeneration(task.id);
      });
  });

  return task;
}

function getTask(taskId) {
  return taskStore.getTask(taskId);
}

function listTasks() {
  return taskStore.listTasks();
}

function updateSubtaskStatus(taskId, subtaskId, status, extra = {}) {
  return taskStore.updateSubtaskStatus(taskId, subtaskId, status, extra);
}

function suggestTechStack(requirement) {
  return getStackOptions(requirement);
}

function getSupportedTechStacks(requirement) {
  return getStackOptions(requirement);
}

async function submitChangeRequest(taskId, changeRequest, options = {}) {
  assertNoActiveGeneration();

  const task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const plan = await llmProvider.planChangeRequest(changeRequest);

  for (const subtask of plan.subtasks || []) {
    taskStore.addSubtask(taskId, normalizeSubtaskRouting(subtask));
  }

  normalizeDependsOn(taskStore.getTask(taskId));

  taskStore.setValidationStatus(taskId, 'pending');

  if (options.run !== false) {
    activeTaskId = taskId;

    try {
      return await runAndStart(taskId);
    } finally {
      releaseActiveGeneration(taskId);
    }
  }

  return taskStore.getTask(taskId);
}

/*
 * ---------------------------------------------------------
 * Subtask execution
 * ---------------------------------------------------------
 */

const MAX_AGENT_ATTEMPTS = 8;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

/**
 * Runs one subtask.
 *
 * The planner chooses the logical domain.
 * The registry chooses the actual model.
 *
 * planner -> backend/frontend -> agentRegistry -> qwen / llama / mistral / ...
 */
async function dispatchSubtaskToAgent(subtask, task) {
  normalizeSubtaskRouting(subtask);

  const domain = subtask.domain;

  if (domain !== 'backend' && domain !== 'frontend') {
    throw new Error(
      `Subtask ${subtask.id} has no valid logical domain ` +
        `(domain="${subtask.domain}", agent="${subtask.agent}").`
    );
  }

  let triedAgentIds = [...(subtask.triedAgentIds || [])];

  let lastError;
  let hasResetOnce = false;

  const baseComplexity = estimateComplexity(subtask);

  const complexity =
    BACKEND_MIN_MEDIUM && domain === 'backend' && baseComplexity === 'small'
      ? 'medium'
      : baseComplexity;

  for (let attempt = 0; attempt < MAX_AGENT_ATTEMPTS; attempt++) {
    let agentChoice;

    const load = agentLoad(task, subtask.id);

    try {
      agentChoice = pickAgent(domain, {
        excludeIds: triedAgentIds,
        complexity,
        load,
      });
    } catch (error) {
      if (!hasResetOnce && triedAgentIds.length > 0) {
        console.warn(
          `[orchestrator] every agent for "${domain}" ` +
            `already tried on subtask ${subtask.id} ` +
            `(${triedAgentIds.join(', ')}); ` +
            'giving the pool a fresh cycle'
        );

        triedAgentIds = [];
        hasResetOnce = true;

        try {
          agentChoice = pickAgent(domain, {
            excludeIds: [],
            complexity,
            load,
          });
        } catch (innerError) {
          throw lastError || innerError;
        }
      } else {
        throw lastError || error;
      }
    }

    if (agentChoice.coolingDownMs > 0) {
      const waitMs = Math.min(agentChoice.coolingDownMs, MAX_RATE_LIMIT_WAIT_MS);

      console.warn(
        `[orchestrator] ${agentChoice.id} still cooling down — ` +
          `waiting ${Math.round(waitMs / 1000)}s before retrying subtask ${subtask.id}`
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    triedAgentIds.push(agentChoice.id);

    console.log(
      `[orchestrator] dispatching subtask ` +
        `${subtask.id} (${complexity}) to ` +
        `${agentChoice.id} [t${agentChoice.tier}]` +
        (attempt > 0
          ? ` (attempt ${attempt + 1}, after ${triedAgentIds.slice(0, -1).join(', ')})`
          : '')
    );

    taskStore.updateSubtaskStatus(task.id, subtask.id, 'in_progress', {
      assignedAgentId: agentChoice.id,
      assignedAgentDisplayName: agentChoice.displayName,
      triedAgentIds: [...triedAgentIds],
      routedComplexity: complexity,
    });

    const attemptStartedAt = Date.now();

    try {
      const result = await agentChoice.run(
        withGuides(subtask.description, domain, FRONTEND_DIR),
        task.apiContract,
        task.techStack
      );

      const usage = usageOf(result);

      const wroteNothing =
        !result ||
        !Array.isArray(result.filesWritten) ||
        result.filesWritten.length === 0;

      if (wroteNothing) {
        lastError = new Error(
          `${agentChoice.id} completed without writing any files.` +
            (result?.summary ? ` Summary: ${result.summary}` : '')
        );

        console.warn(
          `[orchestrator] ${agentChoice.id} wrote zero files ` +
            `on subtask ${subtask.id}; trying a different agent for "${domain}"`
        );

        recordAttempt(
          task,
          subtask,
          domain,
          agentChoice,
          attempt,
          attemptStartedAt,
          'zero_files',
          {
            ...usage,
            reason: 'completed without writing any files',
          }
        );

        continue;
      }

      recordAttempt(
        task,
        subtask,
        domain,
        agentChoice,
        attempt,
        attemptStartedAt,
        'success',
        {
          ...usage,
          filesWritten: result.filesWritten.length,
          linesAdded: result.linesAdded || 0,
        }
      );

      return { agentChoice, result };
    } catch (error) {
      lastError = error;

      const unavailable = Boolean(error?.isRateLimit);

      recordAttempt(
        task,
        subtask,
        domain,
        agentChoice,
        attempt,
        attemptStartedAt,
        unavailable ? 'unavailable' : 'error',
        {
          ...usageOf(error),
          reason: error?.reason,
          error: error.message,
        }
      );

      if (unavailable) {
        const cooldown = refineCooldown(error);

        markCooldown(agentChoice.id, cooldown.retryAfterMs, cooldown.reason);

        console.warn(
          `[orchestrator] ${agentChoice.id} unavailable ` +
            `(${error.reason || 'unknown'}) on subtask ` +
            `${subtask.id}: ` +
            `${String(error.message).slice(0, 300)}; ` +
            `trying a different agent for "${domain}"`
        );

        continue;
      }

      throw error;
    }
  }

  throw (
    lastError ||
    new Error(
      `No agent for domain "${domain}" succeeded ` +
        `on subtask ${subtask.id} across ` +
        `${MAX_AGENT_ATTEMPTS} attempts.`
    )
  );
}

async function runSubtask(taskId, subtask) {
  const task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  try {
    const { agentChoice, result } = await dispatchSubtaskToAgent(subtask, task);

    const filesWritten = Array.isArray(result?.filesWritten)
      ? result.filesWritten
      : [];

    if (filesWritten.length === 0) {
      taskStore.updateSubtaskStatus(taskId, subtask.id, 'blocked', {
        lastError: 'Agent completed without writing any files.',
        summary: result?.summary || '',
      });

      return {
        success: false,
        filesWritten: [],
        error: 'Agent wrote zero files.',
      };
    }

    taskStore.addSubtaskFiles(taskId, subtask.id, filesWritten);

    if (isBackendSubtask(subtask)) {
      const coverage = checkContractCoverage(task.apiContract);

      if (!coverage.clean) {
        console.warn(
          '[orchestrator] backend subtask completed but ' +
            'some API contract endpoints are not visible in source:',
          coverage.missing
        );
      }
    }

    taskStore.updateSubtaskStatus(taskId, subtask.id, 'done', {
      summary: result?.summary || '',
      lastError: null,
      assignedAgentId: agentChoice.id,
      assignedAgentDisplayName: agentChoice.displayName,
    });

    contributions.recordContribution(
      taskId,
      agentChoice.id,
      agentChoice.displayName,
      {
        filesWritten: filesWritten.length,
        linesAdded: result?.linesAdded || 0,
      }
    );

    return {
      success: true,
      filesWritten,
      summary: result?.summary || '',
      agentId: agentChoice.id,
      agentDisplayName: agentChoice.displayName,
    };
  } catch (error) {
    taskStore.updateSubtaskStatus(taskId, subtask.id, 'failed', {
      lastError: error.message,
    });

    throw error;
  }
}

/*
 * ---------------------------------------------------------
 * Dependency-aware task execution
 * ---------------------------------------------------------
 */

async function runTask(taskId) {
  let task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const completed = new Set(
    task.subtasks
      .filter((subtask) => subtask.status === 'done')
      .map((subtask) => subtask.id)
  );

  let safetyCounter = 0;

  while (true) {
    task = taskStore.getTask(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const pending = task.subtasks.filter((subtask) => subtask.status === 'pending');

    if (pending.length === 0) {
      break;
    }

    safetyCounter++;

    if (safetyCounter > task.subtasks.length + 10) {
      console.error(`[orchestrator] safety limit reached for task ${taskId}`);

      for (const subtask of pending) {
        taskStore.updateSubtaskStatus(taskId, subtask.id, 'blocked', {
          lastError:
            'Task execution stopped because the dependency graph could not be resolved.',
        });
      }

      break;
    }

    const dependencySatisfied = (subtask, dependency) => {
      if (completed.has(dependency)) {
        return true;
      }

      if (!isFrontendSubtask(subtask)) {
        return false;
      }

      const dependencyTask = task.subtasks.find(
        (candidate) => candidate.id === dependency
      );

      return Boolean(
        dependencyTask &&
          isBackendSubtask(dependencyTask) &&
          ['failed', 'blocked'].includes(dependencyTask.status)
      );
    };

    const ready = pending.filter((subtask) => {
      const dependencies = Array.isArray(subtask.dependsOn) ? subtask.dependsOn : [];

      return dependencies.every((dependency) =>
        dependencySatisfied(subtask, dependency)
      );
    });

    console.log(
      '[orchestrator] dependency check:',
      pending.map((subtask) => ({
        id: subtask.id,
        domain: subtask.domain || subtask.agent,
        agent: subtask.agent,
        status: subtask.status,
        dependsOn: subtask.dependsOn || [],
        dependenciesSatisfied: (subtask.dependsOn || []).every((dependency) =>
          completed.has(dependency)
        ),
      }))
    );

    if (ready.length === 0) {
      console.error('[orchestrator] no runnable subtasks remain.');

      const failedDependency = pending.some((subtask) =>
        (subtask.dependsOn || []).some((dependency) => {
          const dependencyTask = task.subtasks.find(
            (candidate) => candidate.id === dependency
          );

          return (
            dependencyTask &&
            ['failed', 'blocked'].includes(dependencyTask.status)
          );
        })
      );

      for (const subtask of pending) {
        taskStore.updateSubtaskStatus(taskId, subtask.id, 'blocked', {
          lastError: failedDependency
            ? 'A required dependency failed or was blocked.'
            : 'No runnable dependency path exists. Check the generated task dependency graph.',
        });
      }

      break;
    }

    for (const subtask of ready) {
      const unmet = (subtask.dependsOn || []).filter(
        (dependency) => !completed.has(dependency)
      );

      if (unmet.length > 0) {
        console.warn(
          `[orchestrator] building subtask ${subtask.id} ` +
            `without its failed backend dependency ` +
            `(${unmet.join(', ')}); ` +
            `it will follow the API contract only`
        );
      }

      console.log(
        `[orchestrator] running subtask ${subtask.id} ` +
          `(${subtask.domain || subtask.agent || 'unknown domain'})`
      );

      try {
        const result = await runSubtask(taskId, subtask);

        if (!result || result.success !== true) {
          console.error(
            `[orchestrator] subtask ${subtask.id} ` +
              `did not complete successfully; continuing with other runnable subtasks.`
          );

          continue;
        }

        completed.add(subtask.id);

        console.log(`[orchestrator] subtask ${subtask.id} completed successfully`);
      } catch (error) {
        console.error(`[orchestrator] subtask ${subtask.id} failed:`, error.message);

        continue;
      }
    }
  }

  const finalTask = taskStore.getTask(taskId);

  console.log(`[orchestrator] generation finished with status=${finalTask?.status}`);

  return finalTask;
}

/*
 * ---------------------------------------------------------
 * Frontend structural repair
 * ---------------------------------------------------------
 */

async function verifyAndFixFrontend(taskId) {
  const task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const frontendWasRequested = task.subtasks.some((subtask) =>
    isFrontendSubtask(subtask)
  );

  if (!frontendWasRequested) {
    return { clean: true, issues: [] };
  }

  for (let round = 0; round < MAX_FIXUP_ROUNDS; round++) {
    const report = checkFrontendCompleteness(FRONTEND_DIR, task.techStack);

    taskStore.setCompletenessReport(taskId, report);

    if (report.clean) {
      return report;
    }

    if (round === MAX_FIXUP_ROUNDS - 1) {
      return report;
    }

    const description = [
      'The generated frontend failed structural validation.',
      '',
      'Inspect the existing frontend and backend before changing anything.',
      '',
      'VALIDATION ERRORS:',
      ...report.issues.map((issue) => `- ${issue}`),
      '',
      'Fix the actual underlying problem.',
      'Do not merely describe the fix.',
      'Actually write the corrected files.',
      'Do not rewrite unrelated components.',
    ].join('\n');

    taskStore.addSubtask(taskId, {
      domain: 'frontend',
      agent: 'frontend',
      description,
      dependsOn: [],
    });

    await runTask(taskId);
  }

  return taskStore.getTask(taskId).completenessReport;
}

/*
 * ---------------------------------------------------------
 * Issue routing for automatic repair
 * ---------------------------------------------------------
 */

const BACKEND_INDICATORS = [
  'backend',
  'endpoint',
  'database',
  'server',
  'sequelize',
  'mongoose',
  'postgres',
  'mongodb',
  'sqlite',
  'sql',
  'route',
  'http 500',
  'http 404',
  'http 0',
  'socket hang up',
  'connection refused',
  'econnrefused',
  'missing from backend source',
];

const FRONTEND_INDICATORS = [
  'frontend',
  'react',
  'vue',
  'angular',
  'vite',
  'webpack',
  'compile',
  'module not found',
  'build failed',
  'failed to resolve import',
  'cannot resolve',
  'jsx',
  'tsx',
  'css',
  'is not declared in package.json',
];

function classifyIssues(report) {
  const issues = report?.issues || [];

  const backend = [];
  const frontend = [];
  const ambiguous = [];

  for (const issue of issues) {
    const text = String(issue).toLowerCase();

    if (/^browser e2e:/.test(text) && !/returned http \d{3}/.test(text)) {
      frontend.push(issue);
      continue;
    }

    const isIntegration =
      text.includes('response field mismatch') ||
      text.includes('expected field') ||
      text.includes('frontend expects');

    if (isIntegration) {
      frontend.push(issue);
      continue;
    }

    const backendHit = BACKEND_INDICATORS.some((marker) => text.includes(marker));
    const frontendHit = FRONTEND_INDICATORS.some((marker) => text.includes(marker));

    if (backendHit && !frontendHit) {
      backend.push(issue);
    } else if (frontendHit && !backendHit) {
      frontend.push(issue);
    } else if (backendHit && frontendHit) {
      backend.push(issue);
      frontend.push(issue);
    } else {
      ambiguous.push(issue);
    }
  }

  if (ambiguous.length > 0) {
    if (backend.length === 0 && frontend.length === 0) {
      backend.push(...ambiguous);
    } else if (backend.length > 0) {
      backend.push(...ambiguous);
    } else {
      frontend.push(...ambiguous);
    }
  }

  return { backend, frontend };
}

/*
 * ---------------------------------------------------------
 * Build repair prompt
 * ---------------------------------------------------------
 */

function createRepairDescription(issues, task) {
  issues = issues || [];

  return [
    'AUTOMATED PROJECT VALIDATION FAILED.',
    '',
    'You are the repair agent.',
    '',
    'You MUST inspect the existing project before changing anything.',
    '',
    'Do not guess.',
    'Do not merely explain the problem.',
    'Actually modify the required files.',
    'Preserve working functionality.',
    'Do not rewrite unrelated files.',
    '',
    'VALIDATION ERRORS ASSIGNED TO YOU:',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'API CONTRACT:',
    JSON.stringify(task.apiContract || [], null, 2),
    '',
    'SELECTED TECH STACK:',
    JSON.stringify(task.techStack || {}, null, 2),
    '',
    'IMPORTANT:',
    'If this is an integration issue, inspect BOTH frontend and backend before fixing it.',
    'If a response field is wrong, make the frontend and backend agree on one field name.',
    'If an endpoint is missing, implement the endpoint required by the API contract.',
    'If the frontend does not compile, fix the actual compilation/import/dependency problem.',
    'If the backend starts but an API request returns 500 or the server crashes, inspect the backend route, model, database and request/response fields.',
    'If an issue quotes a real response or backend log, fix exactly that error.',
    'The host manages src/api.js, src/index.js, public/index.html, server.js, db.js and package.json: you CANNOT edit them, and writes to them are rejected.',
    'If an import from ../api fails ("is not exported"), change YOUR component to use only what src/api.js actually exports (read_file it), or call fetch("/api/...") directly.',
    'Packages you import are installed automatically; never try to edit package.json.',
    'If an issue reports a runtime error in the browser, read the component named in the error and the component that renders it, and make the props they pass and expect agree.',
  ].join('\n');
}

/*
 * ---------------------------------------------------------
 * Host-side fixes
 * ---------------------------------------------------------
 */

function ensureDependencies() {
  try {
    installMissingDependencies({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
    });
  } catch (error) {
    console.error('[orchestrator] dependency check failed:', error.message);
  }

  try {
    fixUploadFieldNames({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
    });
  } catch (error) {
    console.error('[orchestrator] upload contract fix failed:', error.message);
  }
}

/*
 * ---------------------------------------------------------
 * Serve generated frontend
 * ---------------------------------------------------------
 */

async function serveGeneratedFrontend(taskId) {
  const task = taskStore.getTask(taskId);

  const hasFrontend = (task?.subtasks || []).some(
    (subtask) => isFrontendSubtask(subtask) && subtask.status === 'done'
  );

  if (!hasFrontend) {
    return;
  }

  ensureDependencies();

  try {
    const runtime = await startGeneratedApp({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
      backendPort: BACKEND_PORT,
    });

    taskStore.setRuntime(taskId, runtime);

    console.log(
      `[orchestrator] generation was incomplete, but the generated frontend is running at http://localhost:${FRONTEND_PORT}`
    );
  } catch (error) {
    console.error('[orchestrator] could not start the generated frontend:', error.message);
  }
}

/*
 * ---------------------------------------------------------
 * Real end-to-end checks
 * ---------------------------------------------------------
 */

async function augmentWithSmokeTests(taskId, report) {
  const task = taskStore.getTask(taskId);

  let issues = [...(report.issues || [])];

  const health = await checkHttp(`http://127.0.0.1:${BACKEND_PORT}/api/health`);

  if (health.ok && health.status === 200) {
    issues = issues.filter(
      (issue) =>
        !/backend is not responding correctly[^\n]*http 404/i.test(String(issue))
    );
  }

  let smoke;

  try {
    smoke = await runSmokeTests({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
      backendPort: BACKEND_PORT,
      frontendPort: FRONTEND_PORT,
      apiContract: task.apiContract,
      backendLogPath: task.runtime?.backend?.logPath || null,
    });
  } catch (error) {
    smoke = {
      issues: [`Smoke test harness failed: ${error.message}`],
      checks: [],
    };
  }

  console.log(
    `[smoke-test] ${smoke.issues.length} issue(s) from ${smoke.checks.length} check(s)`
  );

  for (const check of smoke.checks) {
    console.log(
      `  [${check.status}] ${check.name}` + `${check.detail ? ` — ${check.detail}` : ''}`
    );
  }

  const stillMissing = new Set(checkContractCoverage(task.apiContract).missing);

  const passedLive = smoke.checks
    .filter((check) => check.status === 'pass')
    .map((check) => String(check.name));

  issues = issues.filter((issue) => {
    const match = String(issue).match(
      /API contract endpoint is missing from backend source:\s*([A-Za-z]+)\s+(\S+)/i
    );

    if (!match) {
      return true;
    }

    const key = `${match[1].toUpperCase()} ${match[2]}`;

    return (
      stillMissing.has(key) && !passedLive.some((name) => name.startsWith(key))
    );
  });

  issues.push(...smoke.issues);

  let e2e;

  try {
    e2e = await runBrowserE2E({
      frontendPort: FRONTEND_PORT,
      backendLogPath: task.runtime?.backend?.logPath || null,
      readLogTail,
    });
  } catch (error) {
    e2e = {
      issues: [],
      skipped: `browser check crashed: ${error.message}`,
    };
  }

  if (e2e.skipped) {
    console.warn(`[e2e] skipped: ${e2e.skipped}`);
  }

  console.log(`[e2e] ${e2e.issues.length} issue(s)`);

  issues.push(...e2e.issues);

  return {
    ...report,
    issues,
    clean: issues.length === 0,
    smoke: smoke.checks,
  };
}

/*
 * ---------------------------------------------------------
 * Full project validation + repair
 * ---------------------------------------------------------
 */

async function verifyAndFixProject(taskId) {
  let task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  ensureDependencies();

  try {
    const runtime = await startGeneratedApp({
      backendDir: BACKEND_DIR,
      frontendDir: FRONTEND_DIR,
      backendPort: BACKEND_PORT,
    });

    taskStore.setRuntime(taskId, runtime);
  } catch (error) {
    console.error('[project-validation] initial startup failed:', error.message);
  }

  for (let round = 0; round < MAX_FIXUP_ROUNDS; round++) {
    console.log(`[project-validation] round ${round + 1}/${MAX_FIXUP_ROUNDS}`);

    taskStore.setValidationStatus(taskId, 'validating');

    task = taskStore.getTask(taskId);

    let report;

    try {
      report = await validateProject({
        backendDir: BACKEND_DIR,
        frontendDir: FRONTEND_DIR,
        backendPort: BACKEND_PORT,
        frontendPort: FRONTEND_PORT,
        apiContract: task.apiContract,
        techStack: task.techStack,
        runBuild: true,
      });
    } catch (error) {
      report = {
        clean: false,
        issues: [`Validator itself failed: ${error.message}`],
        runtime: {
          clean: false,
          issues: [error.message],
          checks: [],
        },
      };
    }

    report = await augmentWithSmokeTests(taskId, report);

    taskStore.setValidationReport(taskId, report);

    if (report.clean) {
      taskStore.setValidationStatus(taskId, 'passed');

      console.log('[project-validation] project passed all validation checks.');

      return report;
    }

    console.warn(`[project-validation] found ${report.issues.length} issue(s)`);

    for (const issue of report.issues) {
      console.warn(`  - ${issue}`);
    }

    if (round === MAX_FIXUP_ROUNDS - 1) {
      taskStore.setValidationStatus(taskId, 'failed');

      console.warn('[project-validation] maximum repair rounds reached.');

      return report;
    }

    const { backend: backendIssues, frontend: frontendIssues } =
      classifyIssues(report);

    console.log(
      `[project-validation] routing ${backendIssues.length} issue(s) to backend, ${frontendIssues.length} to frontend`
    );

    taskStore.setValidationStatus(taskId, 'repairing');

    const repairSubtasks = [];

    if (backendIssues.length > 0) {
      repairSubtasks.push(
        taskStore.addSubtask(taskId, {
          domain: 'backend',
          agent: 'backend',
          description: createRepairDescription(backendIssues, task),
          dependsOn: [],
        })
      );
    }

    if (frontendIssues.length > 0) {
      repairSubtasks.push(
        taskStore.addSubtask(taskId, {
          domain: 'frontend',
          agent: 'frontend',
          description: createRepairDescription(frontendIssues, task),
          dependsOn: [],
        })
      );
    }

    if (repairSubtasks.length === 0) {
      taskStore.setValidationStatus(taskId, 'failed');

      return {
        clean: false,
        issues: [
          ...report.issues,
          'Could not route any validation issue to a repair agent.',
        ],
        runtime: report.runtime,
      };
    }

    await runTask(taskId);

    const updatedTask = taskStore.getTask(taskId);

    const repairResults = repairSubtasks.map((repairSubtask) =>
      updatedTask.subtasks.find((subtask) => subtask.id === repairSubtask.id)
    );

    const anySucceeded = repairResults.some(
      (result) => result && result.status === 'done'
    );

    if (!anySucceeded) {
      taskStore.setValidationStatus(taskId, 'failed');

      return {
        clean: false,
        issues: [
          ...report.issues,
          'Automatic repair agents failed to complete their repair subtasks.',
        ],
        runtime: report.runtime,
      };
    }

    console.log('[project-validation] restarting generated application after repair...');

    ensureDependencies();

    try {
      const runtime = await startGeneratedApp({
        backendDir: BACKEND_DIR,
        frontendDir: FRONTEND_DIR,
        backendPort: BACKEND_PORT,
      });

      taskStore.setRuntime(taskId, runtime);
    } catch (error) {
      const startupReport = {
        clean: false,
        issues: [
          ...report.issues,
          `Application failed to restart after repair: ${error.message}`,
        ],
        runtime: {
          clean: false,
          issues: [`Application failed to restart after repair: ${error.message}`],
          checks: [],
        },
      };

      const runtimeTask = taskStore.getTask(taskId);

      const logPaths = [
        runtimeTask?.runtime?.backend?.logPath,
        runtimeTask?.runtime?.frontend?.logPath,
      ].filter(Boolean);

      const logs = logPaths
        .map((logPath) => `\n--- ${logPath} ---\n${readLogTail(logPath, 8000)}`)
        .join('\n');

      startupReport.issues.push(`Runtime logs:${logs}`);

      taskStore.setValidationReport(taskId, startupReport);
    }
  }

  const finalTask = taskStore.getTask(taskId);

  return (
    finalTask.validationReport || {
      clean: false,
      issues: ['Project validation did not complete.'],
    }
  );
}

/*
 * ---------------------------------------------------------
 * Complete pipeline
 * ---------------------------------------------------------
 */

async function runAndStartInner(taskId) {
  console.log('[orchestrator] running generation subtasks...');

  const task = await runTask(taskId);

  if (task.status === 'blocked' || task.status === 'failed') {
    console.log(
      `[orchestrator] generation did not finish successfully. status=${task.status}`
    );

    await serveGeneratedFrontend(taskId);

    return task;
  }

  await verifyAndFixFrontend(taskId);

  let latestTask = taskStore.getTask(taskId);

  if (latestTask.status !== 'done') {
    return latestTask;
  }

  await verifyAndFixProject(taskId);

  latestTask = taskStore.getTask(taskId);

  return latestTask;
}

async function runAndStart(taskId) {
  try {
    return await runAndStartInner(taskId);
  } finally {
    persistProject(taskId);
  }
}

/*
 * ---------------------------------------------------------
 * Retry blocked subtasks
 * ---------------------------------------------------------
 */

async function retryBlockedSubtasks(taskId) {
  assertNoActiveGeneration();

  const task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  for (const subtask of task.subtasks) {
    if (subtask.status === 'blocked') {
      taskStore.updateSubtaskStatus(taskId, subtask.id, 'pending', {
        lastError: null,
      });
    }
  }

  activeTaskId = taskId;

  try {
    return await runAndStart(taskId);
  } finally {
    releaseActiveGeneration(taskId);
  }
}

/*
 * ---------------------------------------------------------
 * Retry a single subtask
 * ---------------------------------------------------------
 */

async function retrySubtask(taskId, subtaskId) {
  assertNoActiveGeneration();

  const task = taskStore.getTask(taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const subtask = task.subtasks.find((candidate) => candidate.id === subtaskId);

  if (!subtask) {
    throw new Error(`Subtask not found: ${subtaskId}`);
  }

  if (!['failed', 'blocked'].includes(subtask.status)) {
    throw new Error(
      `Subtask ${subtaskId} is "${subtask.status}"; only failed or blocked subtasks can be retried.`
    );
  }

  taskStore.updateSubtaskStatus(taskId, subtaskId, 'pending', {
    lastError: null,
  });

  for (const other of task.subtasks) {
    if (other.id === subtaskId) {
      continue;
    }

    const dependsOnThis = (other.dependsOn || []).includes(subtaskId);

    if (dependsOnThis && other.status === 'blocked') {
      taskStore.updateSubtaskStatus(taskId, other.id, 'pending', {
        lastError: null,
      });
    }
  }

  activeTaskId = taskId;

  try {
    return await runAndStart(taskId);
  } finally {
    releaseActiveGeneration(taskId);
  }
}

/*
 * ---------------------------------------------------------
 * Exports
 * ---------------------------------------------------------
 */

module.exports = {
  submitRequirement,
  submitChangeRequest,

  runTask,
  runAndStart,
  runSubtask,
  retryBlockedSubtasks,
  retrySubtask,

  getTask,
  listTasks,
  updateSubtaskStatus,

  getSupportedTechStacks,
  suggestTechStack,

  getContributionSummary: contributions.getContributionSummary,

  listRegisteredAgents,
};