const { randomUUID } = require('crypto');

const tasks = new Map();

function now() {
  return new Date().toISOString();
}

function createTask({
  requirement,
  subtasks = [],
  techStack = null,
  apiContract = [],
}) {
  const id = randomUUID();

  const task = {
    id,
    requirement,
    status: 'planning',

    // Generation state and validation state are deliberately separate.
    // "done" means LLM subtasks finished.
    // "passed" means the generated application was actually validated.
    validationStatus: 'pending',

    createdAt: now(),
    updatedAt: now(),

    techStack,
    apiContract,

    subtasks: subtasks.map((subtask) => ({
      ...subtask,
      id: subtask.id || randomUUID(),
      status: 'pending',
      filesWritten: [],
      attempts: 0,
    })),

    completenessReport: null,
    validationReport: null,
    runtime: null,
  };

  tasks.set(id, task);

  return task;
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

function listTasks() {
  return Array.from(tasks.values());
}

function updateTask(taskId, patch) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  Object.assign(task, patch);
  task.updatedAt = now();

  return task;
}

function updateSubtaskStatus(taskId, subtaskId, status, extra = {}) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  const subtask = task.subtasks.find(
    (item) => item.id === subtaskId
  );

  if (!subtask) {
    return null;
  }

  subtask.status = status;

  Object.assign(subtask, extra);

  if (status === 'in_progress') {
    subtask.attempts = (subtask.attempts || 0) + 1;
  }

  task.updatedAt = now();

  /*
   * IMPORTANT:
   *
   * Do not automatically treat all subtasks being done as
   * a fully completed project.
   *
   * Validation is a separate phase.
   */
  const allDone =
    task.subtasks.length > 0 &&
    task.subtasks.every(
      (item) => item.status === 'done'
    );

  const anyInProgress =
    task.subtasks.some(
      (item) => item.status === 'in_progress'
    );

  const anyFailed =
    task.subtasks.some(
      (item) => item.status === 'failed'
    );

  const anyBlocked =
    task.subtasks.some(
      (item) => item.status === 'blocked'
    );

  if (anyInProgress) {
    task.status = 'in_progress';
  } else if (anyFailed) {
    task.status = 'failed';
  } else if (anyBlocked && !allDone) {
    task.status = 'blocked';
  } else if (allDone) {
    /*
     * Generation is complete.
     *
     * The orchestrator will later move this into:
     * validating → done
     * or
     * validating → failed
     */
    task.status = 'done';
  }

  return task;
}

function addSubtaskFiles(taskId, subtaskId, files = []) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  const subtask = task.subtasks.find(
    (item) => item.id === subtaskId
  );

  if (!subtask) {
    return null;
  }

  subtask.filesWritten = Array.from(
    new Set([
      ...(subtask.filesWritten || []),
      ...files,
    ])
  );

  task.updatedAt = now();

  return task;
}

function addSubtask(taskId, subtask) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  const newSubtask = {
    ...subtask,
    id: subtask.id || randomUUID(),
    status: subtask.status || 'pending',
    filesWritten: subtask.filesWritten || [],
    attempts: subtask.attempts || 0,
  };

  task.subtasks.push(newSubtask);

  /*
   * A new repair/validation subtask means generation is active again.
   */
  if (
    task.status === 'done' ||
    task.status === 'failed' ||
    task.status === 'blocked'
  ) {
    task.status = 'in_progress';
  }

  task.updatedAt = now();

  return newSubtask;
}

function setCompletenessReport(taskId, report) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  task.completenessReport = report;
  task.updatedAt = now();

  return task;
}

function setValidationReport(taskId, report) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  task.validationReport = report;

  task.validationStatus = report?.clean
    ? 'passed'
    : 'failed';

  task.updatedAt = now();

  return task;
}

function setValidationStatus(taskId, status) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  task.validationStatus = status;
  task.updatedAt = now();

  /*
   * Only successful validation can make the entire task complete.
   */
  if (status === 'passed') {
    task.status = 'done';
  } else if (
    status === 'validating' ||
    status === 'repairing'
  ) {
    task.status = 'in_progress';
  } else if (status === 'failed') {
    task.status = 'failed';
  }

  return task;
}

function setRuntime(taskId, runtime) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  task.runtime = runtime;
  task.updatedAt = now();

  return task;
}

function findSubtaskByFile(taskId, filePath) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  return (
    task.subtasks.find((subtask) =>
      (subtask.filesWritten || []).includes(filePath)
    ) || null
  );
}

function resetSubtask(taskId, subtaskId) {
  const task = tasks.get(taskId);

  if (!task) {
    return null;
  }

  const subtask = task.subtasks.find(
    (item) => item.id === subtaskId
  );

  if (!subtask) {
    return null;
  }

  subtask.status = 'pending';
  subtask.lastError = null;

  task.updatedAt = now();

  return subtask;
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateSubtaskStatus,
  addSubtaskFiles,
  addSubtask,
  setCompletenessReport,
  setValidationReport,
  setValidationStatus,
  setRuntime,
  findSubtaskByFile,
  resetSubtask,
};