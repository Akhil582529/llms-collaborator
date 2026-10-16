/**
 * Spec analyzer — turns an uploaded Markdown project document into the
 * same kind of "reference" the image analyzer produces:
 *
 *   {
 *     source: 'markdown',
 *     fileName, projectName,
 *     forPlanner,   // condensed full spec for the planner
 *     forFrontend,  // design / pages / palette for frontend agents
 *     forBackend,   // entities / rules / roles / API hints for backend agents
 *     colorLines,   // every line of the doc that contains a hex code (verbatim)
 *     stackHint     // { frontend, backend, database } or null (only if the doc states it)
 *   }
 *
 * Design notes:
 *  - Hex colors are extracted with a regex, NOT by the model, so the
 *    palette is always exact.
 *  - The model only produces structured JSON; the three text blocks are
 *    assembled in code so their size is bounded (agents re-send their
 *    context on every tool loop, so the raw document must never go to them).
 *  - If the model call fails, we fall back to a truncated copy of the
 *    document so the upload never fails.
 */

'use strict';

const Groq = require('groq-sdk');
const { withGroqRetry } = require('./groqRetry');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const SPEC_MODEL = process.env.GROQ_SPEC_MODEL || 'qwen/qwen3.8-27b';

// Groq's free tier caps this model at ~7000 input tokens/min, so keep the
// document small enough to fit (about 3.5k tokens plus the prompt).
const MAX_DOC_CHARS = 14_000;
const MAX_PLANNER_CHARS = 7000;
const MAX_SIDE_CHARS = 4000;

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function truncateAtLine(text, maxChars) {
  const value = String(text || '');

  if (value.length <= maxChars) return value;

  const cut = value.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');

  return (lastNewline > maxChars * 0.6 ? cut.slice(0, lastNewline) : cut) + '\n[...truncated]';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function asString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

function stringList(value) {
  return asArray(value).map(asString).filter(Boolean);
}

function bulletSection(title, items) {
  const list = stringList(items);
  if (list.length === 0) return '';
  return `${title}:\n${list.map((item) => `- ${item}`).join('\n')}\n`;
}

/** Every line containing a hex color, verbatim, deduplicated. */
function extractColorLines(text) {
  const seen = new Set();
  const lines = [];

  for (const rawLine of String(text || '').split('\n')) {
    HEX_RE.lastIndex = 0;

    if (!HEX_RE.test(rawLine)) continue;

    const line = rawLine
      .trim()
      .replace(/^[-*>\s|]+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 160);

    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }

    if (lines.length >= 40) break;
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/* LLM extraction                                                      */
/* ------------------------------------------------------------------ */

const SPEC_SYSTEM_PROMPT = `You read a project specification document written in Markdown and
extract a faithful, condensed specification for a team of software-generating agents.

Rules:
- Use ONLY information stated in the document. Never invent features, pages,
  fields, endpoints or colors.
- Preserve the names, field names and wording used in the document.
- If the document marks something as out of scope, a later phase, future work,
  or optional, put it in "outOfScope" and NOT in "features".
- If the document does not say something, return an empty string, empty array
  or null for it.
- Keep every string to one short sentence.

Return ONLY valid JSON in exactly this shape:

{
  "projectName": "string",
  "summary": "string",
  "goals": ["string"],
  "features": [{ "name": "string", "description": "string" }],
  "outOfScope": ["string"],
  "userRoles": ["string"],
  "pages": [{ "name": "string", "purpose": "string", "elements": ["string"] }],
  "dataEntities": [{ "name": "string", "fields": ["string"], "notes": "string" }],
  "businessRules": ["string"],
  "apiHints": ["string"],
  "ui": {
    "style": "string",
    "typography": "string",
    "layout": "string",
    "tone": "string",
    "components": ["string"],
    "colorNotes": ["string"]
  },
  "constraints": ["string"],
  "stackHint": { "frontend": "string or null", "backend": "string or null", "database": "string or null" }
}`;

async function extractSpec(documentText) {
  const completion = await withGroqRetry(() =>
    groq.chat.completions.create({
      model: SPEC_MODEL,
      messages: [
        { role: 'system', content: SPEC_SYSTEM_PROMPT },
        { role: 'user', content: documentText },
      ],
      temperature: 0.1,
      max_completion_tokens: 4000,
      response_format: { type: 'json_object' },
    })
  );

  const raw = completion.choices[0]?.message?.content || '';
  const match = raw.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error('Spec extraction did not return a JSON object.');
  }

  const parsed = JSON.parse(match[0]);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Spec extraction did not return a JSON object.');
  }

  return parsed;
}

/* ------------------------------------------------------------------ */
/* Assembling the three blocks                                         */
/* ------------------------------------------------------------------ */

function featureLines(spec) {
  return asArray(spec.features)
    .map((f) => {
      if (typeof f === 'string') return f;
      const name = asString(f?.name);
      const description = asString(f?.description);
      return [name, description].filter(Boolean).join(' — ');
    })
    .filter(Boolean);
}

function pageLines(spec) {
  return asArray(spec.pages)
    .map((p) => {
      if (typeof p === 'string') return p;
      const name = asString(p?.name);
      const purpose = asString(p?.purpose);
      const elements = stringList(p?.elements);
      let line = [name, purpose].filter(Boolean).join(' — ');
      if (elements.length > 0) line += ` [${elements.join(', ')}]`;
      return line;
    })
    .filter(Boolean);
}

function entityLines(spec) {
  return asArray(spec.dataEntities)
    .map((e) => {
      if (typeof e === 'string') return e;
      const name = asString(e?.name);
      const fields = stringList(e?.fields);
      const notes = asString(e?.notes);
      let line = name;
      if (fields.length > 0) line += `: ${fields.join(', ')}`;
      if (notes) line += ` (${notes})`;
      return line;
    })
    .filter(Boolean);
}

function uiBlock(spec) {
  const ui = spec.ui && typeof spec.ui === 'object' ? spec.ui : {};

  const lines = [];

  if (asString(ui.style)) lines.push(`Style: ${asString(ui.style)}`);
  if (asString(ui.typography)) lines.push(`Typography: ${asString(ui.typography)}`);
  if (asString(ui.layout)) lines.push(`Layout: ${asString(ui.layout)}`);
  if (asString(ui.tone)) lines.push(`Tone: ${asString(ui.tone)}`);

  const components = stringList(ui.components);
  if (components.length > 0) lines.push(`Components: ${components.join(', ')}`);

  const colorNotes = stringList(ui.colorNotes);
  if (colorNotes.length > 0) lines.push(`Color notes: ${colorNotes.join('; ')}`);

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function colorBlock(colorLines) {
  if (!colorLines || colorLines.length === 0) return '';

  return (
    'COLOR CODES (verbatim from the document — use these hex values exactly):\n' +
    colorLines.map((line) => `- ${line}`).join('\n') +
    '\n'
  );
}

function buildBlocks(spec, colorLines) {
  const projectName = asString(spec.projectName);
  const summary = asString(spec.summary);
  const features = featureLines(spec);
  const pages = pageLines(spec);
  const entities = entityLines(spec);

  const outOfScope = bulletSection(
    'OUT OF SCOPE (do NOT build or plan any of this)',
    spec.outOfScope
  );

  const forPlanner = truncateAtLine(
    [
      'PROJECT SPECIFICATION (from the uploaded document — this is the source of truth):',
      projectName ? `Project: ${projectName}` : '',
      summary ? `Summary: ${summary}` : '',
      bulletSection('Goals', spec.goals),
      bulletSection('IN-SCOPE FEATURES (plan subtasks for these)', features),
      outOfScope,
      bulletSection('User roles', spec.userRoles),
      bulletSection('Pages / screens', pages),
      bulletSection('Data entities', entities),
      bulletSection('Business rules', spec.businessRules),
      bulletSection('API hints', spec.apiHints),
      bulletSection('Constraints', spec.constraints),
      uiBlock(spec) ? `Design:\n${uiBlock(spec)}` : '',
      colorBlock(colorLines),
      'Plan subtasks that implement EVERY in-scope feature and page above, using the ' +
        'names and fields given. Do not add features the document does not mention.',
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_PLANNER_CHARS
  );

  const forFrontend = truncateAtLine(
    [
      projectName ? `Project: ${projectName}` : '',
      summary ? `Summary: ${summary}` : '',
      bulletSection('Pages / screens to build', pages),
      bulletSection('Features', features),
      bulletSection('User roles', spec.userRoles),
      uiBlock(spec) ? `Design guidelines:\n${uiBlock(spec)}` : '',
      colorBlock(colorLines),
      outOfScope,
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_SIDE_CHARS
  );

  const forBackend = truncateAtLine(
    [
      projectName ? `Project: ${projectName}` : '',
      summary ? `Summary: ${summary}` : '',
      bulletSection('Data entities (use these names and fields)', entities),
      bulletSection('Business rules', spec.businessRules),
      bulletSection('User roles', spec.userRoles),
      bulletSection('API hints', spec.apiHints),
      bulletSection('Features', features),
      bulletSection('Constraints', spec.constraints),
      outOfScope,
    ]
      .filter(Boolean)
      .join('\n'),
    MAX_SIDE_CHARS
  );

  return { forPlanner, forFrontend, forBackend };
}

function normalizeStackHint(hint) {
  if (!hint || typeof hint !== 'object') return null;

  const clean = (value) => {
    const text = asString(value);
    return text && text.toLowerCase() !== 'null' ? text : null;
  };

  const result = {
    frontend: clean(hint.frontend),
    backend: clean(hint.backend),
    database: clean(hint.database),
  };

  return result.frontend || result.backend || result.database ? result : null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {string} markdownText raw contents of the uploaded .md file
 * @param {string} [fileName]
 */
async function analyzeMarkdown(markdownText, fileName = 'spec.md') {
  const text = String(markdownText || '').trim();

  if (!text) {
    throw new Error('The uploaded markdown file is empty.');
  }

  const documentText = text.length > MAX_DOC_CHARS
    ? text.slice(0, MAX_DOC_CHARS) + '\n\n[document truncated]'
    : text;

  // Always extracted deterministically from the FULL document.
  const colorLines = extractColorLines(text);

  try {
    const spec = await extractSpec(documentText);
    const blocks = buildBlocks(spec, colorLines);

    return {
      source: 'markdown',
      fileName,
      projectName: asString(spec.projectName),
      ...blocks,
      colorLines,
      stackHint: normalizeStackHint(spec.stackHint),
    };
  } catch (err) {
    console.warn(
      `[specAnalyzer] extraction failed (${String(err.message).split('\n')[0]}) — falling back to the raw document.`
    );

    const rawBlock = truncateAtLine(documentText, MAX_SIDE_CHARS);

    return {
      source: 'markdown',
      fileName,
      projectName: '',
      forPlanner:
        'PROJECT SPECIFICATION (raw uploaded document — treat as the source of truth, ' +
        'implement every in-scope feature, skip anything marked out of scope):\n' +
        truncateAtLine(documentText, MAX_PLANNER_CHARS) +
        (colorLines.length > 0 ? '\n\n' + colorBlock(colorLines) : ''),
      forFrontend: rawBlock + (colorLines.length > 0 ? '\n\n' + colorBlock(colorLines) : ''),
      forBackend: rawBlock,
      colorLines,
      stackHint: null,
    };
  }
}

module.exports = { analyzeMarkdown, extractColorLines };