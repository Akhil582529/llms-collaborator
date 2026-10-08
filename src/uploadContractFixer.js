'use strict';

/*
 * Reconciles multipart field names between the generated backend (multer)
 * and frontend (FormData.append). The two agents invent their own names
 * unless the API contract pins them down, and a mismatch makes multer
 * reject the upload with "Unexpected field".
 *
 * Handles:
 *   upload.fields([{ name: 'a' }, { name: 'b' }])  -> rename by position
 *   upload.single('file')                          -> rename the one file field
 *   upload.array('images', n)                      -> every file under one name
 */

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['node_modules', 'build'].includes(entry.name)) {
        walk(path.join(dir, entry.name), out);
      }
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }

  return out;
}

// Field-name lists the backend's multer routes accept. A list created by
// .array() carries multi = true.
function backendUploadFields(backendDir) {
  const lists = [];
  const routesDir = path.join(backendDir, 'routes');

  if (!fs.existsSync(routesDir)) return lists;

  for (const file of fs.readdirSync(routesDir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(routesDir, file), 'utf8');

    for (const match of text.matchAll(/\.fields\(\s*\[([\s\S]*?)\]\s*\)/g)) {
      const names = [...match[1].matchAll(/name:\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1]
      );

      if (names.length) lists.push(names);
    }

    for (const match of text.matchAll(/\.(single|array)\(\s*['"]([^'"]+)['"]/g)) {
      const entry = [match[2]];
      entry.multi = match[1] === 'array';
      lists.push(entry);
    }
  }

  return lists;
}

function fixUploadFieldNames({ backendDir, frontendDir }) {
  const lists = backendUploadFields(backendDir);

  if (lists.length === 0) return [];

  const known = new Set(lists.flat());
  const multi = lists.find((list) => list.multi);
  const fixes = [];

  for (const file of walk(path.join(frontendDir, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');

    const used = [...text.matchAll(/\.append\(\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1]
    );

    if (used.length === 0 || used.every((name) => known.has(name))) continue;

    // upload.array('images', n): every file must go under the same name.
    if (multi && used.length > 1 && !used.some((name) => known.has(name))) {
      const renamed = text.replace(
        /(\.append\(\s*['"])([^'"]+)(['"]\s*,\s*)(\w+)/g,
        (all, open, name, comma, value) =>
          /file|image|doc|upload/i.test(value) && !known.has(name)
            ? open + multi[0] + comma + value
            : all
      );

      if (renamed !== text) {
        fs.writeFileSync(file, renamed);
        fixes.push(`${path.basename(file)}: all file fields -> ${multi[0]}`);
      }

      continue;
    }

    if (new Set(used).size !== used.length) continue;

    // Only act when the counts line up, so text fields aren't renamed by
    // mistake.
    const target = lists.find((list) => list.length === used.length);

    if (!target) continue;

    const map = new Map(used.map((name, i) => [name, target[i]]));

    const next = text.replace(
      /(\.append\(\s*['"])([^'"]+)(['"])/g,
      (all, open, name, close) =>
        map.has(name) ? open + map.get(name) + close : all
    );

    if (next !== text) {
      fs.writeFileSync(file, next);

      fixes.push(
        `${path.basename(file)}: ${[...map]
          .map(([from, to]) => `${from}->${to}`)
          .join(', ')}`
      );
    }
  }

  if (fixes.length) {
    console.log('[contract-fix] renamed upload fields:', fixes.join(' | '));
  }

  return fixes;
}

module.exports = { fixUploadFieldNames };