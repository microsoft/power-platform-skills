#!/usr/bin/env node

// Validates that Server Logic files were created correctly for a Power Pages code site.
// Checks both the .js code file and the .serverlogic.yml metadata file.
// Runs as a Stop hook to verify the skill produced valid output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot, UUID_REGEX } = require('../../../scripts/lib/validation-helpers');

const ALLOWED_FUNCTIONS = ['get', 'post', 'put', 'patch', 'del'];
const BROWSER_APIS = ['XMLHttpRequest', 'document\\.', 'window\\.', 'setTimeout', 'setInterval', 'navigator\\.'];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) approve(); // Not a Power Pages project, skip

  // Server logic files live inside .powerpages-site/server-logic/
  const serverLogicDir = path.join(projectRoot, '.powerpages-site', 'server-logic');
  if (!fs.existsSync(serverLogicDir)) approve(); // No server-logic folder, not a server logic session

  const logicDirs = findServerLogicDirs(serverLogicDir);
  if (logicDirs.length === 0) approve(); // No server logic subdirectories, skip

  const errors = [];

  for (const logicDir of logicDirs) {
    const dirName = path.basename(logicDir);
    const jsFile = path.join(logicDir, `${dirName}.js`);
    const ymlFile = path.join(logicDir, `${dirName}.serverlogic.yml`);

    // Validate .js file exists
    if (!fs.existsSync(jsFile)) {
      errors.push(`${dirName}: missing .js file (expected ${dirName}.js)`);
      continue;
    }

    // Validate .serverlogic.yml exists
    if (!fs.existsSync(ymlFile)) {
      errors.push(`${dirName}: missing metadata file (expected ${dirName}.serverlogic.yml)`);
    } else {
      // Validate YAML contents
      const ymlContent = fs.readFileSync(ymlFile, 'utf8');

      // Check id field exists and is a valid UUID
      const idMatch = ymlContent.match(/^id:\s*(.+)$/m);
      if (!idMatch) {
        errors.push(`${dirName}.serverlogic.yml: missing 'id' field — PAC CLI requires a GUID`);
      } else if (!UUID_REGEX.test(idMatch[1].trim())) {
        errors.push(`${dirName}.serverlogic.yml: 'id' is not a valid UUID: ${idMatch[1].trim()}`);
      }

      // Check adx_serverlogic_adx_webrole is present and non-empty
      if (!ymlContent.includes('adx_serverlogic_adx_webrole:')) {
        errors.push(`${dirName}.serverlogic.yml: missing 'adx_serverlogic_adx_webrole' field — at least one web role is required`);
      } else {
        const roleMatches = ymlContent.match(/^\s+-\s+\S+/gm);
        if (!roleMatches || roleMatches.length === 0) {
          errors.push(`${dirName}.serverlogic.yml: 'adx_serverlogic_adx_webrole' array is empty — at least one web role GUID is required`);
        }
      }

      // Check name field matches directory name
      const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
      if (nameMatch && nameMatch[1].trim() !== dirName) {
        errors.push(`${dirName}.serverlogic.yml: 'name' field '${nameMatch[1].trim()}' does not match folder name '${dirName}'`);
      }
    }

    // Validate .js file contents
    const content = fs.readFileSync(jsFile, 'utf8');

    // Check: file has at least one allowed top-level function
    const foundFunctions = ALLOWED_FUNCTIONS.filter(fn => {
      const regex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'm');
      return regex.test(content);
    });

    if (foundFunctions.length === 0) {
      errors.push(`${dirName}.js: no allowed top-level functions found (expected: get, post, put, patch, or del)`);
      continue;
    }

    // Check: each function has try/catch
    for (const fn of foundFunctions) {
      const fnRegex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`, 'g');
      const match = fnRegex.exec(content);
      if (match) {
        const afterFn = content.substring(match.index + match[0].length, match.index + match[0].length + 100);
        if (!afterFn.includes('try')) {
          errors.push(`${dirName}.js: function '${fn}' is missing try/catch error handling`);
        }
      }
    }

    // Check: functions return strings
    if (!/return\s/.test(content)) {
      errors.push(`${dirName}.js: no return statements found — every function must return a string`);
    }

    // Check: Server.Logger is used
    if (!content.includes('Server.Logger')) {
      errors.push(`${dirName}.js: missing Server.Logger calls — every function should log for diagnostics`);
    }

    // Check: no require/import statements
    if (/\brequire\s*\(/.test(content) || /\bimport\s+/.test(content)) {
      errors.push(`${dirName}.js: contains require() or import — no external dependencies allowed`);
    }

    // Check: no browser APIs
    for (const api of BROWSER_APIS) {
      const regex = new RegExp(`\\b${api}`, 'g');
      if (regex.test(content)) {
        errors.push(`${dirName}.js: contains browser API '${api.replace('\\.', '')}' — not available in server logic runtime`);
      }
    }

    // Check: no console.log
    if (/\bconsole\s*\./.test(content)) {
      errors.push(`${dirName}.js: contains console.log — use Server.Logger instead`);
    }

    // Check: no 'function delete()'
    if (/(?:async\s+)?function\s+delete\s*\(/m.test(content)) {
      errors.push(`${dirName}.js: uses 'function delete()' — 'delete' is a reserved word, use 'del' instead`);
    }
  }

  if (errors.length > 0) {
    block('Server Logic validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

function findServerLogicDirs(dir) {
  const dirs = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        dirs.push(path.join(dir, entry.name));
      }
    }
  } catch {}
  return dirs;
}
