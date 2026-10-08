'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { builtinModules } = require('module');

const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git', 'public', 'coverage']);
const VALID_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function packageNameOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) {
    return null;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return VALID_NAME.test(name) ? name : null;
}

function findUsedPackages(scanDir) {
  const used = new Set();
  for (const file of walk(scanDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const name = packageNameOf(m[1]);
      if (name) used.add(name);
    }
  }
  return used;
}

function fixDir(label, dir, scanDir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { label, installed: [] };

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  const missing = [...findUsedPackages(scanDir)].filter((n) => !declared.has(n));
  if (missing.length === 0) return { label, installed: [] };

  console.log(`[deps] ${label}: installing missing package(s): ${missing.join(', ')}`);

  try {
    execFileSync(
      'npm',
      ['install', '--save', '--no-audit', '--no-fund', ...missing],
      { cwd: dir, stdio: 'pipe', timeout: 5 * 60 * 1000 }
    );
    return { label, installed: missing };
  } catch (error) {
    console.error(`[deps] ${label}: npm install failed:`, error.message);
    return { label, installed: [], error: error.message };
  }
}

function installMissingDependencies({ backendDir, frontendDir }) {
  return [
    fixDir('backend', backendDir, backendDir),
    fixDir('frontend', frontendDir, path.join(frontendDir, 'src')),
  ];
}

module.exports = { installMissingDependencies };