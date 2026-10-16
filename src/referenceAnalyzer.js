'use strict';

/**
 * Reference analyzer — turns uploaded reference material into the three
 * text blocks the pipeline uses:
 *
 *   forPlanner   -> planTask(...)           (task graph)
 *   forFrontend  -> rolePrompts.formatReference('frontend')
 *   forBackend   -> rolePrompts.formatReference('backend')
 *
 * Inputs (all optional, any combination):
 *   - images: up to 3 png/jpg/webp data URLs (vision model, via Groq)
 *   - spec:   { name, text } an uploaded .md project document
 *             (analyzed by specAnalyzer.js)
 *
 * When both are given the DOCUMENT is the source of truth for scope,
 * features, data and color codes; images only contribute layout / look.
 */

const Groq = require('groq-sdk');
const { withGroqRetry } = require('./groqRetry');
const { analyzeMarkdown } = require('./specAnalyzer');

// Check Groq's models page for the current vision model; override via .env
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const MAX_IMAGES = 3; // Groq's limit for this model
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // Groq caps base64 images around 4MB
const MAX_SPEC_CHARS = 200 * 1024; // matches the UI's 200KB limit
const DATA_URL_HEAD = /^data:image\/(png|jpe?g|webp);base64,/;

const MAX_PLANNER_CHARS = 9000;
const MAX_SIDE_CHARS = 6000;

let groqClient = null;

function getGroq() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not set — it is needed to analyze reference images. ' +
        'Add it to .env, or upload a .md spec without images.'
    );
  }

  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  return groqClient;
}

const INSTRUCTIONS = `You analyze reference screenshots/mockups for a code-generation pipeline.
Describe ONLY what is visible. If something is unclear, omit it — never invent.
Estimate colors as hex values. Respond with ONLY valid JSON, no fences:
{
  "summary": "one sentence",
  "pages": [{ "name": "Dashboard", "sections": ["top navbar with logo and search", "left sidebar nav"] }],
  "layout": "overall layout in one sentence",
  "palette": { "background": "#...", "surface": "#...", "primary": "#...", "accent": "#...", "text": "#...", "muted": "#..." },
  "typography": "font style/weights/sizes",
  "style": "corners, shadows, spacing, borders",
  "components": ["buttons, cards, tables, modals..."],
  "features": ["user-facing functionality visible or clearly implied"],
  "dataEntities": [{ "name": "Expense", "fields": ["amount", "category", "date"] }]
}`;

const clip = (t, n) => (t.length > n ? t.slice(0, n) + '\n...(truncated)' : t);

const list = (a) =>
  Array.isArray(a)
    ? a.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')
    : '';

const section = (title, body) => (body ? `${title}:\n${body}` : '');

function pagesText(s) {
  return (s.pages || [])
    .map((p) => `- ${p.name}: ${(p.sections || []).join('; ')}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Image analysis blocks                                               */
/* ------------------------------------------------------------------ */

function toFrontend(s, { includePalette = true } = {}) {
  const palette =
    s.palette && typeof s.palette === 'object'
      ? Object.entries(s.palette).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '';

  return clip(
    [
      s.summary ? `Summary: ${s.summary}` : '',
      s.layout ? `Layout: ${s.layout}` : '',
      section('Pages/sections', pagesText(s)),
      includePalette ? section('Palette', palette) : '',
      s.typography ? `Typography: ${s.typography}` : '',
      s.style ? `Style: ${s.style}` : '',
      section('Components', list(s.components)),
      section('Features', list(s.features)),
    ]
      .filter(Boolean)
      .join('\n\n'),
    2500
  );
}

function toBackend(s) {
  const entities = (s.dataEntities || [])
    .map((e) => `- ${e.name}: ${(e.fields || []).join(', ')}`)
    .join('\n');

  return clip(
    [section('Features', list(s.features)), section('Data entities', entities)]
      .filter(Boolean)
      .join('\n\n'),
    1200
  );
}

function toPlanner(s) {
  return clip(
    [
      s.summary ? `Summary: ${s.summary}` : '',
      section('Pages/sections', pagesText(s)),
      section('Features', list(s.features)),
    ]
      .filter(Boolean)
      .join('\n'),
    1500
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validateImages(images) {
  if (images.length > MAX_IMAGES) {
    throw new Error(`Max ${MAX_IMAGES} reference images.`);
  }

  for (const img of images) {
    if (typeof img !== 'string' || !DATA_URL_HEAD.test(img)) {
      throw new Error('Reference images must be png/jpg/webp data URLs.');
    }

    if (img.length > MAX_IMAGE_CHARS) {
      throw new Error('A reference image is too large (max ~4MB).');
    }
  }
}

function validateSpec(spec) {
  if (typeof spec.text !== 'string') {
    throw new Error('The spec must be { name, text } with the markdown contents as text.');
  }

  if (spec.name && !/\.(md|markdown)$/i.test(String(spec.name))) {
    throw new Error('The spec file must be a .md or .markdown file.');
  }

  if (spec.text.length > MAX_SPEC_CHARS) {
    throw new Error(`The spec file is too large (max ${MAX_SPEC_CHARS / 1024}KB).`);
  }
}

/* ------------------------------------------------------------------ */
/* Vision call                                                         */
/* ------------------------------------------------------------------ */

async function analyzeImages(images, requirement) {
  const content = [
    {
      type: 'text',
      text: `${INSTRUCTIONS}\n\nProject requirement: ${requirement}\nAnalyze the attached reference image(s).`,
    },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];

  const groq = getGroq();

  const completion = await withGroqRetry(() =>
    groq.chat.completions.create({
      model: VISION_MODEL,
      messages: [{ role: 'user', content }],
      temperature: 0.1,
      max_completion_tokens: 4000,
      response_format: { type: 'json_object' },
    })
  );

  const raw = completion.choices[0]?.message?.content || '';

  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    throw new Error(`Vision model returned unparseable analysis: ${raw.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Merging document + images                                           */
/* ------------------------------------------------------------------ */

function buildReference(doc, imageSpec) {
  // Document only
  if (doc && !imageSpec) {
    return {
      sources: ['markdown'],
      projectName: doc.projectName || '',
      stackHint: doc.stackHint || null,
      colorLines: doc.colorLines || [],
      forPlanner: doc.forPlanner,
      forFrontend: doc.forFrontend,
      forBackend: doc.forBackend,
      raw: { document: doc },
    };
  }

  // Images only (the original behaviour)
  if (!doc && imageSpec) {
    return {
      sources: ['images'],
      projectName: '',
      stackHint: null,
      colorLines: [],
      forPlanner: toPlanner(imageSpec),
      forFrontend: toFrontend(imageSpec),
      forBackend: toBackend(imageSpec),
      raw: imageSpec,
    };
  }

  // Both: the document wins on scope / features / data / colors.
  const hasDocColors = (doc.colorLines || []).length > 0;

  return {
    sources: ['markdown', 'images'],
    projectName: doc.projectName || '',
    stackHint: doc.stackHint || null,
    colorLines: doc.colorLines || [],
    forPlanner: clip(
      `${doc.forPlanner}\n\n` +
        'VISUAL REFERENCE FROM IMAGES (layout and look only — the document above ' +
        `wins on scope, features and colors):\n${toPlanner(imageSpec)}`,
      MAX_PLANNER_CHARS
    ),
    forFrontend: clip(
      `${doc.forFrontend}\n\n` +
        'VISUAL REFERENCE FROM IMAGES (match this layout and look' +
        (hasDocColors
          ? '; use the color codes from the document above, NOT colors estimated from the images'
          : '') +
        `):\n${toFrontend(imageSpec, { includePalette: !hasDocColors })}`,
      MAX_SIDE_CHARS
    ),
    forBackend: clip(
      `${doc.forBackend}\n\nSeen in the reference images:\n${toBackend(imageSpec)}`,
      MAX_SIDE_CHARS
    ),
    raw: { document: doc, images: imageSpec },
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {string[]} [images] data URLs
 * @param {string} [requirement] the text typed in the requirement box (may be empty)
 * @param {{ name?: string, text: string }} [spec] uploaded .md document
 * @returns {Promise<null | { sources, projectName, stackHint, colorLines,
 *           forPlanner, forFrontend, forBackend, raw }>}
 */
async function analyzeReferences(images, requirement, spec) {
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasSpec =
    spec && typeof spec === 'object' && typeof spec.text === 'string' && spec.text.trim() !== '';

  if (!hasImages && !hasSpec) return null;

  // Validate everything up front so bad input fails fast with a clear message.
  if (hasImages) validateImages(images);
  if (hasSpec) validateSpec(spec);

  const imagePrompt =
    String(requirement || '').trim() ||
    'See the attached project specification document.';

  const [doc, imageSpec] = await Promise.all([
    hasSpec ? analyzeMarkdown(spec.text, spec.name || 'spec.md') : null,
    hasImages
      ? analyzeImages(images, imagePrompt).catch((err) => {
          // A flaky vision call shouldn't discard a perfectly good spec.
          if (hasSpec) {
            console.warn(`[referenceAnalyzer] image analysis failed, using the spec only: ${err.message}`);
            return null;
          }

          throw err;
        })
      : null,
  ]);

  return buildReference(doc, imageSpec);
}

/**
 * If the requirement box was left empty (spec-only upload), produce a short
 * requirement sentence so the rest of the pipeline always has one.
 */
function fallbackRequirement(requirement, reference) {
  const text = String(requirement || '').trim();

  if (text) return text;

  if (reference?.projectName) {
    return `Build the project "${reference.projectName}" exactly as described in the attached specification document.`;
  }

  return 'Build the project exactly as described in the attached specification document.';
}

module.exports = { analyzeReferences, fallbackRequirement };