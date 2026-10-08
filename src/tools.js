/**
 * Tools available to agents — this is the layer that turns an LLM's text
 * output into real, actual file writes. Without this, an "agent" is just
 * a chat response you'd have to copy-paste yourself.
 *
 * SAFETY: every tool here is scoped to a single base directory. An agent
 * can never write outside its assigned folder.
 */

const fs = require('fs');
const path = require('path');

function createWriteFileTool(baseDir) {
  const resolvedBase = path.resolve(baseDir);

  const definition = {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Path is relative to the agent\'s project folder. Creates parent directories automatically. Overwrites if the file already exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path, e.g. "routes/todos.js". Never use ".." or an absolute path.' },
          content: { type: 'string', description: 'The full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  };

  function execute({ path: relativePath, content }) {
    const targetPath = path.resolve(resolvedBase, relativePath);
    if (!targetPath.startsWith(resolvedBase + path.sep) && targetPath !== resolvedBase) {
      throw new Error(`Refused to write outside the allowed folder. Attempted: "${relativePath}"`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    return { success: true, path: relativePath, bytesWritten: Buffer.byteLength(content, 'utf8') };
  }

  return { definition, execute };
}

function listExistingFiles(baseDir) {
  const resolvedBase = path.resolve(baseDir);
  if (!fs.existsSync(resolvedBase)) return [];

  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(path.relative(resolvedBase, fullPath));
      }
    }
  }
   walk(resolvedBase);

  const MAX_FILES_LISTED = 60;
  if (results.length > MAX_FILES_LISTED) {
    return results.slice(0, MAX_FILES_LISTED).concat(`[...and ${results.length - MAX_FILES_LISTED} more files not shown]`);
  }
  return results;
}

function createReadFileTool(baseDir, toolName = 'read_file', description = null) {
  const resolvedBase = path.resolve(baseDir);

  const definition = {
    type: 'function',
    function: {
      name: toolName,
      description: description || 'Read the current content of an existing file, so you can build on it instead of guessing or overwriting blindly. Path is relative to the project folder.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path to read, e.g. "src/api.js".',
          },
        },
        required: ['path'],
      },
    },
  };

    const MAX_CONTENT_CHARS = 4000; // ~1000 tokens — caps how much a single read can cost

  function execute({ path: relativePath }) {
    const targetPath = path.resolve(resolvedBase, relativePath);
    if (!targetPath.startsWith(resolvedBase + path.sep) && targetPath !== resolvedBase) {
      throw new Error(`Refused to read outside the allowed folder. Attempted: "${relativePath}"`);
    }
    try {
      const fullContent = fs.readFileSync(targetPath, 'utf8');
      const truncated = fullContent.length > MAX_CONTENT_CHARS;
      const content = truncated
        ? fullContent.slice(0, MAX_CONTENT_CHARS) + '\n\n[...truncated — file is longer than shown]'
        : fullContent;
      return { success: true, path: relativePath, content, truncated };
    } catch (err) {
      return { success: false, path: relativePath, error: 'File not found' };
    }
  }

  return { definition, execute, toolName };
}

module.exports = { createWriteFileTool, createReadFileTool, listExistingFiles };