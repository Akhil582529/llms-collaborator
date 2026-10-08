'use strict';
const Groq = require('groq-sdk');
const { withGroqRetry } = require('./groqRetry');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Check Groq's models page for the current vision model; override via .env
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const MAX_IMAGES = 3; // Groq's limit for this model
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // Groq caps base64 images around 4MB
const DATA_URL_HEAD = /^data:image\/(png|jpe?g|webp);base64,/;

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
const list = (a) => (Array.isArray(a) ? a.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '');

function pagesText(s) {
  return (s.pages || [])
    .map((p) => `- ${p.name}: ${(p.sections || []).join('; ')}`)
    .join('\n');
}

function toFrontend(s) {
  const palette = s.palette && typeof s.palette === 'object'
    ? Object.entries(s.palette).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '';
  return clip([
    `Summary: ${s.summary || ''}`,
    `Layout: ${s.layout || ''}`,
    `Pages/sections:\n${pagesText(s)}`,
    `Palette:\n${palette}`,
    `Typography: ${s.typography || ''}`,
    `Style: ${s.style || ''}`,
    `Components:\n${list(s.components)}`,
    `Features:\n${list(s.features)}`,
  ].join('\n\n'), 2000); // kept short: your frontend agent is a local 8B model
}

function toBackend(s) {
  const entities = (s.dataEntities || [])
    .map((e) => `- ${e.name}: ${(e.fields || []).join(', ')}`).join('\n');
  return clip(`Features:\n${list(s.features)}\n\nData entities:\n${entities}`, 1200);
}

function toPlanner(s) {
  return clip(`Summary: ${s.summary || ''}\nPages/sections:\n${pagesText(s)}\nFeatures:\n${list(s.features)}`, 1500);
}

async function analyzeReferences(images, requirement) {
  if (!Array.isArray(images) || images.length === 0) return null;
  if (images.length > MAX_IMAGES) throw new Error(`Max ${MAX_IMAGES} reference images.`);
  for (const img of images) {
    if (typeof img !== 'string' || !DATA_URL_HEAD.test(img)) {
      throw new Error('Reference images must be png/jpg/webp data URLs.');
    }
    if (img.length > MAX_IMAGE_CHARS) throw new Error('A reference image is too large (max ~4MB).');
  }

  const content = [
    { type: 'text', text: `${INSTRUCTIONS}\n\nProject requirement: ${requirement}\nAnalyze the attached reference image(s).` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];

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
  let spec;
  try {
    spec = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    throw new Error(`Vision model returned unparseable analysis: ${raw.slice(0, 200)}`);
  }

  return {
    forPlanner: toPlanner(spec),
    forFrontend: toFrontend(spec),
    forBackend: toBackend(spec),
    raw: spec,
  };
}

module.exports = { analyzeReferences };