/**
 * Planner provider — LLM-backed task planner.
 *
 * Responsibilities:
 * 1. planTask — decompose a NEW project requirement into subtasks + API contract.
 * 2. planChangeRequest — plan a MODIFICATION to an already-generated project.
 * 3. suggestTechStack — legacy informational helper.
 *
 * Provider-agnostic: uses CHAINS.planner from llmClient.js
 * (Mistral first, Groq as fallback by default).
 */

const { chat, extractJson, CHAINS } = require('./llmClient');

/*
| "domain" is ONLY a scheduling hint.
| Agents are still GENERAL-PURPOSE SOFTWARE ENGINEERS.
| The domain does NOT select a specific model — agentRegistry.js does that later.
*/

const PLAN_SYSTEM_PROMPT = `
You are the project planning agent for a multi-agent software engineering system.

Your job is to convert a user's software requirement into a sequence of
implementation subtasks that coding agents can execute.

IMPORTANT ARCHITECTURE RULE:

All coding agents are GENERAL-PURPOSE SOFTWARE ENGINEERS.

There are NO frontend-only agents and NO backend-only agents.

A single coding agent may modify:
- frontend files
- backend files
- database files
- configuration files
- tests
- documentation
- any combination of these

The "domain" field is ONLY a scheduling hint used by the orchestrator.
It does NOT assign a specific model or restrict what the coding agent can edit.

HOST-PROVIDED INFRASTRUCTURE (already done before any subtask runs):

The host application has ALREADY created and configured:
- the backend server entry point (server.js), the database connection (db.js),
  package.json, CORS and JSON body parsing
- the frontend app shell (package.json, public/index.html, src/index.js,
  base styles, and an API helper at src/api.js)
- installation of the npm packages that the code imports

Therefore:
- NEVER create subtasks for project initialization, creating the React/Express
  app, installing packages, configuring CORS/JSON parsing, or writing a server
  entry point.
- Backend work is limited to SQL migrations (sql/*.sql) and API route files
  (routes/*.js, auto-mounted at /api/<filename>).
- Frontend work is limited to components/pages under src/, their own
  stylesheets, and wiring them together in src/App.js.
- Whenever the requirement involves saving or reading data, persist it in the
  SELECTED database, never in memory.
- Do NOT plan test-writing subtasks unless the requirement explicitly asks
  for tests.

Every subtask MUST contain:

{
  "id": "unique-short-id",
  "title": "short task title",
  "description": "precise implementation instructions",
  "domain": "frontend|backend",
  "dependencies": ["ids of prerequisite subtasks"],
  "complexity": "small|medium|large"
}

DOMAIN RULES:

Use:

"backend"

when the primary work involves:
- Node.js
- Express
- APIs
- database
- persistence
- authentication backend
- server configuration
- backend tests
- backend services

Use:

"frontend"

when the primary work involves:
- React
- UI components
- pages
- forms
- browser-side state
- Axios/frontend API integration
- CSS
- frontend tests

If a subtask genuinely involves both frontend and backend,
choose the domain representing the PRIMARY implementation work.

Do NOT include an "agent" field.

Do NOT assign specific models.

The scheduler will independently select the coding agent based on:
- task complexity
- capability
- fairness
- load
- availability
- previous contribution

SUBTASK DESIGN RULES:

1. Break the project into meaningful implementation units.

2. Prefer feature-oriented subtasks when appropriate.

3. A subtask may involve both frontend and backend when a feature genuinely
   requires both.

4. Every subtask must be independently understandable by a coding agent.

5. Clearly mention expected behavior and relevant project files.

6. Define dependencies accurately.

7. Use:
   - small for straightforward changes
   - medium for moderate features
   - large for complex features, multi-file changes, debugging,
     architecture, authentication, integrations, or end-to-end features.

8. Do not assign models.

9. Do not assign a specific coding agent.

10. Do not omit the domain field.

11. Every domain MUST be exactly one of:
    "frontend"
    "backend"

12. Every complexity MUST be exactly one of:
    "small"
    "medium"
    "large"

13. Dependencies must contain subtask IDs, not array indices.

14. Return a complete executable plan, not a high-level summary.

15. Avoid creating unnecessarily tiny subtasks.

apiContract entries, if you include any, must be objects shaped
{ "method": "GET", "path": "/api/<resource>", "description": "what it does" }
with paths under /api/. Only list endpoints the subtasks actually implement.

The final response MUST be valid JSON.

Return ONLY the JSON object.

Expected shape:

{
  "subtasks": [
    {
      "id": "s1",
      "title": "Create expenses API",
      "description": "Create the SQL migration and the routes/expenses.js router...",
      "domain": "backend",
      "dependencies": [],
      "complexity": "medium"
    },
    {
      "id": "s2",
      "title": "Create expense form component",
      "description": "Create the React ExpenseForm component...",
      "domain": "frontend",
      "dependencies": [],
      "complexity": "medium"
    }
  ],
  "apiContract": []
}
`;

const CHANGE_SYSTEM_PROMPT = `
You are a planning assistant handling a CHANGE REQUEST to an
ALREADY-EXISTING generated software project.

The coding agents can already read and modify the existing project files.

All coding agents are GENERAL-PURPOSE SOFTWARE ENGINEERS.

The "domain" field is ONLY a scheduling hint.
It does NOT assign a specific model and does not restrict the agent.

For every subtask return:

{
  "id": "unique-short-id",
  "title": "short task title",
  "description": "precise implementation instructions",
  "domain": "frontend|backend",
  "dependencies": ["ids of prerequisite subtasks"],
  "complexity": "small|medium|large"
}

DOMAIN RULES:

Use "backend" for primarily server/API/database work.

Use "frontend" for primarily React/UI/browser-side work.

If a change genuinely requires both, select the domain representing
the PRIMARY implementation work.

Do NOT include an "agent" field.

Do NOT assign a specific model.

The scheduler will select the actual coding agent.

Rules:

- Keep the number of subtasks as small as reasonably possible.
- Most simple change requests should contain exactly ONE subtask.
- Split into multiple subtasks only when there is a genuine dependency.
- Dependencies must contain subtask IDs.
- complexity must be small, medium, or large.
- domain must be frontend or backend.
- apiContract must be empty unless the change adds/modifies an HTTP endpoint.
- If an HTTP endpoint changes, include only the NEW or CHANGED endpoint.

Return ONLY valid JSON.

Expected shape:

{
  "subtasks": [
    {
      "id": "s1",
      "title": "Update task API",
      "description": "...",
      "domain": "backend",
      "dependencies": [],
      "complexity": "medium"
    }
  ],
  "apiContract": []
}
`;

/*
| VALIDATION — never allow malformed planner output into the orchestrator.
*/

const VALID_DOMAINS = new Set(['frontend', 'backend']);
const VALID_COMPLEXITIES = new Set(['small', 'medium', 'large']);

function normalizeAndValidateSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) {
    throw new Error('Planner did not return a valid subtasks array.');
  }

  return subtasks.map((subtask, index) => {
    if (!subtask || typeof subtask !== 'object') {
      throw new Error(`Planner returned invalid subtask at index ${index}.`);
    }

    const id = String(subtask.id || `s${index + 1}`).trim();

    const title = String(
      subtask.title || subtask.description || `Subtask ${index + 1}`
    ).trim();

    const description = String(
      subtask.description || subtask.title || ''
    ).trim();

    const domain = String(subtask.domain || '').trim().toLowerCase();

    const complexity = String(subtask.complexity || 'medium').trim().toLowerCase();

    const dependencies = Array.isArray(subtask.dependencies)
      ? subtask.dependencies.map(String)
      : Array.isArray(subtask.dependsOn)
        ? subtask.dependsOn.map(String)
        : [];

    if (!VALID_DOMAINS.has(domain)) {
      throw new Error(
        `Planner returned invalid domain for ${id}: "${subtask.domain}". ` +
        `Expected "frontend" or "backend".`
      );
    }

    if (!VALID_COMPLEXITIES.has(complexity)) {
      throw new Error(
        `Planner returned invalid complexity for ${id}: "${subtask.complexity}". ` +
        `Expected small, medium, or large.`
      );
    }

    return { id, title, description, domain, dependencies, complexity };
  });
}

/*
| INTEGRATION SUBTASK — uses "domain" instead of the old "agent" field.
*/

function ensureIntegrationSubtask(subtasks, techStack) {
  const frontendIndices = subtasks
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.domain === 'frontend')
    .map((x) => x.i);

  if (frontendIndices.length < 2) {
    return subtasks;
  }

  const alreadyHasIntegration = subtasks.some(
    (s) =>
      s.domain === 'frontend' &&
      /integrat|wire|app\.js|routing/i.test(`${s.title} ${s.description}`)
  );

  if (alreadyHasIntegration) {
    return subtasks;
  }

  const integrationByFrontend = {
    react:
      'Wire all existing React pages/components together in App.js with react-router-dom routing',
    vue:
      'Wire all existing Vue pages/components together through App.vue and Vue Router',
    angular:
      'Wire all existing Angular components together through the root component and Angular Router',
  };

  subtasks.push({
    id: `integration-${Date.now()}`,
    title: 'Integrate frontend components',
    description:
      integrationByFrontend[techStack?.frontend] ||
      'Wire all existing frontend pages/components together using the selected framework router',
    domain: 'frontend',
    dependencies: frontendIndices.map((i) => subtasks[i].id),
    complexity: 'medium',
  });

  return subtasks;
}

/*
| STACK + REFERENCE FORMATTING
*/

function formatTechStack(techStack) {
  if (!techStack) return '';

  if (typeof techStack === 'string') {
    return `\n\nSELECTED TECH STACK: ${techStack}`;
  }

  const parts = [];

  if (techStack.frontend) parts.push(`Frontend: ${techStack.frontend}`);
  if (techStack.backend) parts.push(`Backend: ${techStack.backend}`);
  if (techStack.database) parts.push(`Database: ${techStack.database}`);

  if (parts.length === 0) return '';

  return (
    '\n\nSELECTED TECH STACK (already chosen by the user — plan for exactly this):\n' +
    parts.map((part) => `- ${part}`).join('\n')
  );
}

function formatReferenceBlock(referenceSpec) {
  if (!referenceSpec) return '';

  return `

REFERENCE MATERIAL (from files the user uploaded — a project specification document and/or design images):

${referenceSpec}

How to use it:
- Plan subtasks that implement EVERY in-scope feature and page it describes, using its exact names for pages, entities and fields.
- Do NOT plan anything it marks as out of scope, optional, or future work.
- Frontend subtask descriptions must name the specific pages/sections from the reference, and must say to use its color codes where it gives them.
- Backend subtask descriptions must name the data entities and fields from the reference.
- Only add apiContract endpoints for features that are in scope or visible in the reference.
- Keep the plan compact: aim for 6-14 subtasks, each covering a coherent feature or page.
`;
}

/*
| PLANNER CALL (fallback chain: Mistral -> Groq by default)
|
| validate() runs inside the chain, so if one model returns bad JSON or an
| invalid plan, the next model in the chain gets a shot instead of failing
| the whole run.
*/

async function callPlanner(systemPrompt, userContent) {
  const { result } = await chat({
    chain: CHAINS.planner,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    json: true,
    maxTokens: 8000,
    validate: (raw) => {
      const parsed = extractJson(raw);

      if (!Array.isArray(parsed.subtasks)) {
        throw new Error('Planner response missing "subtasks" array.');
      }

      return {
        // Validate BEFORE the plan reaches the orchestrator so corrupted
        // tasks never enter the task store.
        subtasks: normalizeAndValidateSubtasks(parsed.subtasks),
        apiContract: Array.isArray(parsed.apiContract) ? parsed.apiContract : [],
      };
    },
  });

  return result;
}

/*
| NEW PROJECT
*/

async function planTask(requirement, techStack, referenceSpec) {
  const result = await callPlanner(
    PLAN_SYSTEM_PROMPT,
    String(requirement || '') +
      formatTechStack(techStack) +
      formatReferenceBlock(referenceSpec)
  );

  result.subtasks = ensureIntegrationSubtask(result.subtasks, techStack);

  return result;
}

/*
| CHANGE REQUEST
*/

async function planChangeRequest(description) {
  return callPlanner(CHANGE_SYSTEM_PROMPT, description);
}

/*
| TECH STACK SUGGESTION
*/

async function suggestTechStack(requirement) {
  const { result } = await chat({
    chain: CHAINS.planner,
    messages: [
      {
        role: 'system',
        content: `You suggest tech stack options for a software project idea.

Respond with ONLY valid JSON, no markdown fences:

{
  "options": [
    {
      "name": "...",
      "stack": "...",
      "pros": "...",
      "cons": "..."
    }
  ]
}

Give exactly 2-3 options.

Keep each field to one short sentence.

Note: this pipeline's agents currently build with React
(frontend) and Node/Express (backend) regardless of what's suggested here.
Mention this as a caveat in one option if relevant.
`,
      },
      { role: 'user', content: requirement },
    ],
    temperature: 0.3,
    json: true,
    validate: (raw) => {
      const parsed = extractJson(raw);
      return Array.isArray(parsed.options) ? parsed.options : [];
    },
  });

  return result;
}

module.exports = {
  planTask,
  planChangeRequest,
  suggestTechStack,
};