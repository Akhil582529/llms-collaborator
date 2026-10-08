/**
 * Groq Provider — real LLM-backed task planner.
 *
 * Responsibilities:
 * 1. planTask — decompose a NEW project requirement into subtasks + API contract.
 * 2. planChangeRequest — plan a MODIFICATION to an already-generated project.
 * 3. suggestTechStack — legacy informational helper.
 */

const Groq = require('groq-sdk');
const { withGroqRetry } = require('./groqRetry');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/*
|--------------------------------------------------------------------------
| NEW PROJECT PLANNER
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| "domain" is ONLY a scheduling hint.
|
| Agents are still GENERAL-PURPOSE SOFTWARE ENGINEERS.
|
| domain:
|   frontend -> primarily frontend work
|   backend  -> primarily backend work
|
| The domain does NOT select a specific model.
| agentRegistry.js does that later.
|
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

The final response MUST be valid JSON.

Return ONLY the JSON object.

Expected shape:

{
  "subtasks": [
    {
      "id": "s1",
      "title": "Initialize backend",
      "description": "Create the Node.js/Express backend...",
      "domain": "backend",
      "dependencies": [],
      "complexity": "medium"
    },
    {
      "id": "s2",
      "title": "Create frontend",
      "description": "Create the React frontend...",
      "domain": "frontend",
      "dependencies": [],
      "complexity": "medium"
    }
  ],
  "apiContract": []
}
`;


/*
|--------------------------------------------------------------------------
| CHANGE REQUEST PLANNER
|--------------------------------------------------------------------------
|
| Change requests must follow the SAME contract as new projects.
|
*/

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
|--------------------------------------------------------------------------
| VALIDATION
|--------------------------------------------------------------------------
|
| Never allow malformed planner output into the orchestrator.
|
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
      subtask.title ||
      subtask.description ||
      `Subtask ${index + 1}`
    ).trim();

    const description = String(
      subtask.description ||
      subtask.title ||
      ''
    ).trim();

    const domain = String(subtask.domain || '').trim().toLowerCase();

    const complexity = String(
      subtask.complexity || 'medium'
    ).trim().toLowerCase();

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

    return {
      id,
      title,
      description,
      domain,
      dependencies,
      complexity,
    };
  });
}


/*
|--------------------------------------------------------------------------
| INTEGRATION SUBTASK
|--------------------------------------------------------------------------
|
| This now uses "domain" instead of the old "agent" field.
|
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
      /integrat|wire|app\.js|routing/i.test(
        `${s.title} ${s.description}`
      )
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

    dependencies: frontendIndices.map(
      (i) => subtasks[i].id
    ),

    complexity: 'medium',
  });

  return subtasks;
}


/*
|--------------------------------------------------------------------------
| GROQ CALL
|--------------------------------------------------------------------------
*/

async function callPlanner(systemPrompt, userContent) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to your .env file.'
    );
  }

  const completion = await withGroqRetry(() =>
    groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',

      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],

      temperature: 0.2,

      response_format: {
        type: 'json_object',
      },
    })
  );

  const raw = completion.choices[0]?.message?.content;

  if (!raw) {
    throw new Error('Groq returned an empty planner response.');
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Groq returned invalid JSON: ${raw}`
    );
  }

  if (!Array.isArray(parsed.subtasks)) {
    throw new Error(
      `Groq response missing "subtasks" array: ${raw}`
    );
  }

  /*
   * IMPORTANT:
   *
   * Validate BEFORE the planner result reaches the orchestrator.
   *
   * This prevents corrupted tasks like:
   *
   * agent="undefined"
   *
   * from entering the task store.
   */
  const subtasks = normalizeAndValidateSubtasks(
    parsed.subtasks
  );

  return {
    subtasks,

    apiContract: Array.isArray(parsed.apiContract)
      ? parsed.apiContract
      : [],
  };
}


/*
|--------------------------------------------------------------------------
| NEW PROJECT
|--------------------------------------------------------------------------
*/

async function planTask(
  requirement,
  techStack,
  referenceSpec
) {
  const selectedStack = techStack || '';

  const referenceBlock = referenceSpec
    ? `

REFERENCE DESIGN (extracted from a user-uploaded image — plan subtasks that reproduce it):

${referenceSpec}

Frontend subtask descriptions must name the specific pages/sections from the reference.

Only add apiContract endpoints for features visible in the reference
or stated in the requirement.
`
    : '';

  const result = await callPlanner(
    PLAN_SYSTEM_PROMPT,
    requirement + selectedStack + referenceBlock
  );

  result.subtasks = ensureIntegrationSubtask(
    result.subtasks,
    techStack
  );

  return result;
}


/*
|--------------------------------------------------------------------------
| CHANGE REQUEST
|--------------------------------------------------------------------------
*/

async function planChangeRequest(description) {
  return callPlanner(
    CHANGE_SYSTEM_PROMPT,
    description
  );
}


/*
|--------------------------------------------------------------------------
| TECH STACK SUGGESTION
|--------------------------------------------------------------------------
*/

async function suggestTechStack(requirement) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to your .env file.'
    );
  }

  const completion = await withGroqRetry(() =>
    groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',

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

        {
          role: 'user',
          content: requirement,
        },
      ],

      temperature: 0.3,

      response_format: {
        type: 'json_object',
      },
    })
  );

  const raw = completion.choices[0]?.message?.content;

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Groq returned invalid JSON: ${raw}`
    );
  }

  return Array.isArray(parsed.options)
    ? parsed.options
    : [];
}


module.exports = {
  planTask,
  planChangeRequest,
  suggestTechStack,
};