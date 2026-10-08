# Orchestrator (v1 MVP)

Lives inside the project as a sibling of `frontend/` and `backend/`:

```
project/
├── frontend/
├── backend/
└── orchestrator/   ← you are here
```

Both `frontend/` and `backend/` are currently empty — that's expected for
this stage. Once the File Watcher is added (next step), it'll watch
`../frontend` and `../backend` relative to this folder and report changes
back to the orchestrator automatically.

The "brain" of the multi-agent pipeline. Takes a user requirement, breaks it
into subtasks assigned to specific agents (frontend/backend for now), and
tracks their status in a shared task graph.

This version does **not** yet dispatch to real agents, watch files, or run
security/test checks — it's the foundation those layers get built on top of.

## Architecture decisions

- **LLM provider is swappable** (`src/llmProvider.js`). Right now it's a mock
  that does naive keyword-based splitting. When you have a Gemini/Groq/Claude
  API key, write a new provider file with the same `planTask(requirement)`
  function signature and swap the import in `orchestrator.js` — nothing else
  changes.
- **Task store is the "Shared Context Store"** (`src/taskStore.js`). In-memory
  for now (resets on restart). Swap for a JSON file, Redis, or a real DB later
  without changing the API shape.
- **Orchestrator logic is separated from the HTTP layer** — `orchestrator.js`
  has no Express code in it, so the same logic could be reused by a CLI, a
  file watcher, or a different transport later.

## Run it

```bash
npm install
node src/server.js
```

Server runs on `http://localhost:3000`.

When all build subtasks complete, the orchestrator runs `npm install` in both
generated project folders, starts the selected Node API on port 5050 and the
selected frontend app on port 3001, waits for both to accept HTTP requests,
then redirects the orchestrator page to the running app. Set
`GENERATED_FRONTEND_PORT` if port 3001 is already in use.

## API

### `POST /api/tasks`
First call `POST /api/stack-options` after a requirement is entered. Present
those supported options to the user, then submit the chosen stack with the
requirement. The orchestrator saves it on the task and supplies it to both the
planner and build agents.

Frontend choices are React, Vue, and Angular. Backend choices are Node.js +
Express and Node.js + Fastify. Database choices are Firebase Firestore,
PostgreSQL, MongoDB, SQLite, and an in-memory store.

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"requirement":"Build a todo list app with login","techStack":{"frontend":"react","backend":"express","database":"postgresql"}}'
```

### `POST /api/stack-options`

Returns the valid frontend, backend, and database selections (plus a default)
for the task-intake screen. A task cannot be built without an explicit valid
`techStack` selection.

### `GET /api/tasks`
List all tasks.

### `GET /api/tasks/:id`
Get one task's full graph.

### `PATCH /api/tasks/:id/subtasks/:subtaskId`
Update a subtask's status. This is the hook real agents (or a file watcher)
will call to report progress once they exist.

```bash
curl -X PATCH http://localhost:3000/api/tasks/<id>/subtasks/<subtaskId> \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

Valid statuses: `pending`, `in_progress`, `blocked`, `done`.
The parent task's overall status rolls up automatically (`planning` →
`in_progress` → `done`).

## Next steps (not built yet)

1. Replace the mock LLM provider with a real one (Gemini/Groq/Claude)
2. Add a file watcher that calls the PATCH endpoint automatically on file changes
3. Add real Frontend/Backend agents that actually write files (via a
   `write_file` tool, as discussed) instead of just being tracked as subtasks
4. Add Security/Test Agent stages that gate a subtask from being marked `done`
