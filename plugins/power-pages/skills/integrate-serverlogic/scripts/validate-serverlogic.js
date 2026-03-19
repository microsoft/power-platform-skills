#!/usr/bin/env node

// Validates that a Server Logic .js file was created correctly for a Power Pages code site.
// Runs as a Stop hook to verify the skill produced valid output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot } = require('../../../scripts/lib/validation-helpers');

const ALLOWED_FUNCTIONS = ['get', 'post', 'put', 'patch', 'del'];
const BROWSER_APIS = ['XMLHttpRequest', 'document\\.', 'window\\.', 'setTimeout', 'setInterval', 'navigator\\.'];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  const serverLogicsDir = path.join(projectRoot, 'server-logics');
  if (!fs.existsSync(serverLogicsDir)) approve(); // No server-logics folder, not a server logic session

  const jsFiles = findServerLogicFiles(serverLogicsDir);
  if (jsFiles.length === 0) approve(); // No .js files found, skip

  const errors = [];

  for (const filePath of jsFiles) {
    const fileName = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    // Check: file has at least one allowed top-level function
    const foundFunctions = ALLOWED_FUNCTIONS.filter(fn => {
      const regex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'm');
      return regex.test(content);
    });

    if (foundFunctions.length === 0) {
      errors.push(`${fileName}: no allowed top-level functions found (expected: get, post, put, patch, or del)`);
      continue; // Skip further checks for this file
    }

    // Check: each function has try/catch
    for (const fn of foundFunctions) {
      const fnRegex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`, 'g');
      const match = fnRegex.exec(content);
      if (match) {
        // Look for 'try {' within the next ~50 chars after function opening
        const afterFn = content.substring(match.index + match[0].length, match.index + match[0].length + 100);
        if (!afterFn.includes('try')) {
          errors.push(`${fileName}: function '${fn}' is missing try/catch error handling`);
        }
      }
    }

    // Check: functions return strings (look for JSON.stringify or return "..." patterns)
    const hasReturn = /return\s/.test(content);
    if (!hasReturn) {
      errors.push(`${fileName}: no return statements found — every function must return a string`);
    }

    // Check: Server.Logger is used
    if (!content.includes('Server.Logger')) {
      errors.push(`${fileName}: missing Server.Logger calls — every function should log for diagnostics`);
    }

    // Check: no require/import statements
    if (/\brequire\s*\(/.test(content) || /\bimport\s+/.test(content)) {
      errors.push(`${fileName}: contains require() or import — no external dependencies allowed`);
    }

    // Check: no browser APIs
    for (const api of BROWSER_APIS) {
      const regex = new RegExp(`\\b${api}`, 'g');
      if (regex.test(content)) {
        errors.push(`${fileName}: contains browser API '${api.replace('\\.', '')}' — not available in server logic runtime`);
      }
    }

    // Check: no console.log (common mistake)
    if (/\bconsole\s*\./.test(content)) {
      errors.push(`${fileName}: contains console.log — use Server.Logger instead`);
    }

    // Check: no disallowed top-level functions (especially 'delete')
    const deleteRegex = /(?:async\s+)?function\s+delete\s*\(/m;
    if (deleteRegex.test(content)) {
      errors.push(`${fileName}: uses 'function delete()' — 'delete' is a reserved word, use 'del' instead`);
    }
  }

  if (errors.length > 0) {
    block('Server Logic validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

function findServerLogicFiles(dir) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('.')) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch {}
  return files;
}
