#!/usr/bin/env node

// Validates that Server Logic files were created correctly for a Power Pages code site.
// Checks both the .js code file and the .serverlogic.yml metadata file.
// Runs via the centralized PostToolUse hook to verify the skill produced valid output.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot, UUID_REGEX } = require('../../../scripts/lib/validation-helpers');

const ALLOWED_FUNCTIONS = ['get', 'post', 'put', 'patch', 'del'];
const BROWSER_APIS = ['XMLHttpRequest', 'document\\.', 'window\\.', 'setTimeout', 'setInterval', 'navigator\\.', 'fetch'];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve(); // Not a Power Pages project, skip

  // Server logic files live inside .powerpages-site/server-logic/
  const serverLogicDir = path.join(projectRoot, '.powerpages-site', 'server-logic');
  if (!fs.existsSync(serverLogicDir)) return approve(); // No server-logic folder, not a server logic session

  const logicDirs = findServerLogicDirs(serverLogicDir);
  if (logicDirs.length === 0) return approve(); // No server logic subdirectories, skip

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

      // Check id field exists and is a valid UUID (strip surrounding quotes if present)
      const idMatch = ymlContent.match(/^id:\s*(.+)$/m);
      if (!idMatch) {
        errors.push(`${dirName}.serverlogic.yml: missing 'id' field — PAC CLI requires a GUID`);
      } else {
        const idValue = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (!UUID_REGEX.test(idValue)) {
          errors.push(`${dirName}.serverlogic.yml: 'id' is not a valid UUID: ${idValue}`);
        }
      }

      // Check adx_serverlogic_adx_webrole is present and non-empty, and validate GUIDs
      const webRoleHeaderMatch = /^adx_serverlogic_adx_webrole:\s*$/m.exec(ymlContent);
      if (!webRoleHeaderMatch) {
        errors.push(`${dirName}.serverlogic.yml: missing 'adx_serverlogic_adx_webrole' field — at least one web role is required`);
      } else {
        const sectionStart = webRoleHeaderMatch.index + webRoleHeaderMatch[0].length;
        const rest = ymlContent.slice(sectionStart);
        const nextKeyMatch = rest.match(/^[A-Za-z0-9_]+:\s*/m);
        const sectionEnd = nextKeyMatch ? sectionStart + nextKeyMatch.index : ymlContent.length;
        const webRoleSection = ymlContent.slice(sectionStart, sectionEnd);

        const roleItemRegex = /^\s*-\s+([^\s#]+)/gm;
        let match;
        let hasItems = false;

        while ((match = roleItemRegex.exec(webRoleSection)) !== null) {
          hasItems = true;
          const roleValue = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (!UUID_REGEX.test(roleValue)) {
            errors.push(`${dirName}.serverlogic.yml: web role value '${roleValue}' under 'adx_serverlogic_adx_webrole' is not a valid UUID`);
          }
        }

        if (!hasItems) {
          errors.push(`${dirName}.serverlogic.yml: 'adx_serverlogic_adx_webrole' array is empty — at least one web role GUID is required`);
        }
      }

      // Check name field exists and matches directory name (strip surrounding quotes if present)
      const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
      if (!nameMatch) {
        errors.push(`${dirName}.serverlogic.yml: missing 'name' field — it must be present and match the folder name '${dirName}'`);
      } else {
        const nameValue = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (nameValue !== dirName) {
          errors.push(`${dirName}.serverlogic.yml: 'name' field '${nameValue}' does not match folder name '${dirName}'`);
        }
      }
    }

    // Validate .js file contents
    const content = fs.readFileSync(jsFile, 'utf8');

    // Check: file has at least one allowed top-level function (anchored to start of line)
    const foundFunctions = ALLOWED_FUNCTIONS.filter(fn => {
      const regex = new RegExp(`^(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'm');
      return regex.test(content);
    });

    if (foundFunctions.length === 0) {
      errors.push(`${dirName}.js: no allowed top-level functions found (expected: get, post, put, patch, or del)`);
      continue;
    }

    // Check: CommonJS exports are not allowed (runtime forbids module.exports/exports usage)
    if (/(?:^|\n)\s*(?:module\.exports|exports)\.[a-zA-Z0-9_]+\s*=/m.test(content)) {
      errors.push(`${dirName}.js: module.exports/exports assignments are not allowed; define top-level get/post/put/patch/del functions instead`);
      continue;
    }

    // Check: no disallowed top-level functions outside the allowlist (uses brace-depth scan to ignore nested functions)
    const allTopLevel = findTopLevelFunctions(content);
    const disallowedFunctions = new Set(allTopLevel.filter(name => !ALLOWED_FUNCTIONS.includes(name)));
    if (disallowedFunctions.size > 0) {
      errors.push(`${dirName}.js: only get, post, put, patch, and del functions are allowed; found additional top-level functions: ${Array.from(disallowedFunctions).join(', ')}`);
      continue;
    }

    // Check: each function has try/catch (scan until next top-level function or end of file)
    // Check: async functions must contain await (unnecessary async causes runtime errors with synchronous Dataverse calls)
    for (const fn of foundFunctions) {
      const fnRegex = new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`, 'g');
      const match = fnRegex.exec(content);
      if (match) {
        const isAsync = !!match[1];
        const bodyStart = match.index + match[0].length;
        const nextFnMatch = content.slice(bodyStart).match(/\n(?:async\s+)?function\s+[a-zA-Z]/);
        const bodyEnd = nextFnMatch ? bodyStart + nextFnMatch.index : content.length;
        const fnBody = content.slice(bodyStart, bodyEnd);
        if (!/\btry\s*\{/.test(fnBody)) {
          errors.push(`${dirName}.js: function '${fn}' is missing try/catch error handling`);
        } else if (!/\bcatch\s*[({]/.test(fnBody)) {
          errors.push(`${dirName}.js: function '${fn}' has try but is missing a catch block`);
        }
        if (isAsync && !/\bawait\b/.test(fnBody)) {
          errors.push(`${dirName}.js: function '${fn}' is marked async but contains no await — remove async to avoid runtime errors (Dataverse calls are synchronous, only HttpClient requires async/await)`);
        }
      }
    }

    // Check: each function returns a string-compatible value and uses Server.Logger
    for (const fn of foundFunctions) {
      const fnRegex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`, 'g');
      const match = fnRegex.exec(content);
      if (match) {
        const bodyStart = match.index + match[0].length;
        const nextFnMatch = content.slice(bodyStart).match(/\n(?:async\s+)?function\s+[a-zA-Z]/);
        const bodyEnd = nextFnMatch ? bodyStart + nextFnMatch.index : content.length;
        const fnBody = content.slice(bodyStart, bodyEnd);
        if (!/\breturn\b/.test(fnBody)) {
          errors.push(`${dirName}.js: function '${fn}' has no return statement — every function must return a string`);
        } else {
          // Verify at least one return is string-compatible (string literal, JSON.stringify, String(), or template literal)
          const returnRegex = /\breturn\s+([^;]+)/g;
          let returnMatch;
          let hasStringReturn = false;
          while ((returnMatch = returnRegex.exec(fnBody)) !== null) {
            const expr = (returnMatch[1] || '').trim();
            if (/^['"`]/.test(expr) || /^JSON\.stringify\s*\(/.test(expr) || /^String\s*\(/.test(expr)) {
              hasStringReturn = true;
              break;
            }
          }
          if (!hasStringReturn) {
            errors.push(`${dirName}.js: function '${fn}' must return a string (use a string literal, JSON.stringify(...), or String(...))`);
          }
        }
        if (!/Server\.Logger/.test(fnBody)) {
          errors.push(`${dirName}.js: function '${fn}' is missing Server.Logger calls — every function should log for diagnostics`);
        }
      }
    }

    // Strip comments and string literals so disallowed-token checks don't false-positive
    // on occurrences inside documentation comments or string values.
    const strippedContent = stripCommentsAndStrings(content);

    // Check: no require/import statements
    if (/\brequire\s*\(/.test(strippedContent) || /\bimport\s+/.test(strippedContent)) {
      errors.push(`${dirName}.js: contains require() or import — no external dependencies allowed`);
    }

    // Check: no browser APIs
    for (const api of BROWSER_APIS) {
      const regex = new RegExp(`\\b${api}`, 'g');
      if (regex.test(strippedContent)) {
        errors.push(`${dirName}.js: contains browser API '${api.replace('\\.', '')}' — not available in server logic runtime`);
      }
    }

    // Check: no console usage
    if (/\bconsole\s*\./.test(strippedContent)) {
      errors.push(`${dirName}.js: contains console.* — use Server.Logger instead`);
    }

    // Check: no 'function delete()'
    if (/(?:async\s+)?function\s+delete\s*\(/m.test(strippedContent)) {
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
  } catch (err) {
    throw new Error(`Failed to read server logic directory '${dir}': ${err.message}`);
  }
  return dirs;
}

/**
 * Replace all comments and string literals with whitespace so that regex
 * checks for disallowed tokens don't match inside non-code contexts.
 */
function stripCommentsAndStrings(src) {
  let result = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Line comment
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { result += ' '; i++; }
      continue;
    }
    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      result += ' '; i++;
      result += ' '; i++;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) { result += ' '; i++; }
      if (i < src.length) { result += ' '; i++; }
      if (i < src.length) { result += ' '; i++; }
      continue;
    }
    // String literal
    if (ch === '\'' || ch === '"' || ch === '`') {
      result += ' '; i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') { result += ' '; i++; }
        result += ' '; i++;
      }
      if (i < src.length) { result += ' '; i++; }
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Find all top-level function names using brace-depth tracking.
 * Skips string literals and comments so nested functions are not reported.
 */
function findTopLevelFunctions(content) {
  const names = [];
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    // Skip line comments
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    // Skip block comments
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Skip string literals
    if (ch === '\'' || ch === '"' || ch === '`') {
      i++;
      while (i < content.length && content[i] !== ch) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    // At depth 0, check for function declarations
    if (depth === 0) {
      const rest = content.slice(i);
      const m = rest.match(/^(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/);
      if (m) {
        names.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return names;
}
