require('dotenv').config();
const express = require('express');
const path = require('path');
const orchestrator = require('./orchestrator');
const fileWatcher = require('./fileWatcher');
const activityLog = require('./activityLog');
const persistence = require('./persistance');
const { killTracked } = require('./appRunner');

const app = express();
app.use(express.json({ limit: '15mb' })); // reference images arrive as base64 JSON
app.use(express.static(path.join(__dirname, '../public'))); // serves public/index.html at GET /

// Stop the generated app's processes when the orchestrator exits, so
// ports 3001/5050 aren't left held by orphaned dev servers.
['SIGINT', 'SIGTERM'].forEach((sig) =>
  process.on(sig, () => {
    killTracked();
    process.exit(0);
  })
);

// POST /api/stack-options  { requirement: "a todo app" }
// The required intake step: returns every stack this pipeline can genuinely
// build, plus a sensible default. A selection is sent back with POST /tasks.
app.post('/api/stack-options', (req, res) => {
  try {
    const { requirement } = req.body;
    const options = orchestrator.getSupportedTechStacks(requirement);
    res.json(options);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Legacy alias for clients that used the old informational endpoint. It now
// returns the same actionable, supported choices as the intake flow.
app.post('/api/suggest-stack', (req, res) => {
  try {
    res.json(orchestrator.suggestTechStack(req.body.requirement));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tasks  { requirement, techStack, images? }
// Kicks off the orchestrator: analyzes reference images (if any), plans
// subtasks, stores the task graph.
app.post('/api/tasks', async (req, res) => {
  try {
    const { requirement, techStack, images } = req.body;
    const task = await orchestrator.submitRequirement(requirement, {
      techStack,
      images,
    });
    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/tasks
app.get('/api/tasks', (req, res) => {
  res.json(orchestrator.listTasks());
});

// GET /api/tasks/:id
app.get('/api/tasks/:id', (req, res) => {
  const task = orchestrator.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

// PATCH /api/tasks/:id/subtasks/:subtaskId  { status: "in_progress" }
// Hook for agents (or the file watcher) to report progress.
app.patch('/api/tasks/:id/subtasks/:subtaskId', (req, res) => {
  try {
    const { status } = req.body;
    const task = orchestrator.updateSubtaskStatus(
      req.params.id,
      req.params.subtaskId,
      status
    );
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tasks/:id/subtasks/:subtaskId/run
// Dispatches ONE subtask to an agent, which writes real files. Status flips
// to in_progress -> done (or failed/blocked) based on what really happened.
// runSubtask needs the subtask OBJECT, so look it up here.
app.post('/api/tasks/:id/subtasks/:subtaskId/run', async (req, res) => {
  try {
    const task = orchestrator.getTask(req.params.id);
    const subtask = task?.subtasks.find((s) => s.id === req.params.subtaskId);

    if (!subtask) {
      return res.status(404).json({ error: 'subtask not found' });
    }

    res.json(await orchestrator.runSubtask(req.params.id, subtask));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/tasks/:id/subtasks/:subtaskId/retry
// Retries one failed/blocked subtask and then continues the full pipeline
// (dependent subtasks, validation, repairs).
app.post('/api/tasks/:id/subtasks/:subtaskId/retry', async (req, res) => {
  try {
    res.json(
      await orchestrator.retrySubtask(req.params.id, req.params.subtaskId)
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/change-request  { taskId, description: "add a dark mode toggle" }
// Modifies the already-generated project instead of building a new one.
app.post('/api/change-request', async (req, res) => {
  try {
    const { taskId, description } = req.body;
    const task = await orchestrator.submitChangeRequest(taskId, description);
    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// GET /api/activity
// The reactive feed — what the File Watcher has noticed changing on disk.
app.get('/api/activity', (req, res) => {
  res.json(activityLog.getAll());
});

// GET /api/activity/stream
// Server-Sent Events stream used by the live dashboard.
app.get('/api/activity/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  // Send existing activity immediately.
  for (const entry of activityLog.getAll()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsubscribe = activityLog.subscribe((entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      unsubscribe();
    }
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// POST /api/tasks/:id/retry-blocked
// Retries every blocked subtask whose dependencies are already done.
app.post('/api/tasks/:id/retry-blocked', async (req, res) => {
  try {
    const result = await orchestrator.retryBlockedSubtasks(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tasks/:taskId/contributions', (req, res) => {
  res.json(orchestrator.getContributionSummary(req.params.taskId));
});

app.get('/api/agents', (req, res) => {
  res.json(orchestrator.listRegisteredAgents());
});

/* ------------------------------------------------------------------ */
/* Project history (PostgreSQL, see persistance.js)                    */
/* ------------------------------------------------------------------ */

// GET /api/history?limit=50 — every project the orchestrator has built
app.get('/api/history', async (req, res) => {
  try {
    res.json(await persistence.listProjects(Number(req.query.limit) || 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/:id — one project with per-model breakdown and every attempt
app.get('/api/history/:id', async (req, res) => {
  try {
    const data = await persistence.getProject(req.params.id);

    if (!data.project) {
      return res.status(404).json({ error: 'project not found' });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/model-stats — cross-project comparison of every model
app.get('/api/model-stats', async (req, res) => {
  try {
    res.json(await persistence.getModelStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Orchestrator running on http://localhost:${PORT}`);
  fileWatcher.start();
});

