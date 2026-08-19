#!/usr/bin/env node

/**
 * Explicit validator: catch HTTP-400 crash patterns on Dataverse calls.
 *
 * Fires after Write / Edit / MultiEdit on TS/TSX files. Reads the resulting
 * file content and blocks the write if either:
 *
 *   A1 — `$select` contains either a virtual `*name` shadow column or a lookup
 *        navigation property. Adding `cr3e9_projectidname`, `statename`, or
 *        the lookup logical name `cr3e9_projectid` returns HTTP 400 or omits
 *        the lookup GUID. The correct read is `_<lookup>_value` plus the
 *        formatted-value annotation (use `lookupName(record, ...)`).
 *
 *   A2 — `*Service.create({...})` or `*Service.update(..., {...})` includes
 *        a server-managed column. The Dataverse server owns these fields;
 *        emitting them in a write payload returns HTTP 400 on every save.
 *        Even when the generated TypeScript model marks them required,
 *        satisfy the type with `as any` at the call site — never emit junk
 *        like `ownerid: ''` or `statecode: 0` to silence the type checker.
 *
 * Both checks fire for any TS/TSX file under `app/` or non-generated `src/`.
 * They are runtime correctness checks, not stylistic ones, so they fire even
 * when other style hooks are deferred.
 *
 * Exit codes:
 *   0 = pass (no violations, or not a write tool, or not a watched file)
 *   2 = block + show stderr to the model (Claude Code convention)
 */

const fs = require('fs');
const path = require('path');

// A1 — exact suffixes on `$select` entries that always 400. Conservative:
// only the documented anti-patterns. The leading `\w*` allows the bare
// shadow column (`statename`) AND the prefixed variant (`cr3e9_projectidname`,
// `cr3e9_taskstatusname`).
const SELECT_FORBIDDEN_SUFFIX_RE = /^\w*(?:idname|statename|statusname|statecodename|statuscodename)$/;

// A2 — server-managed columns that must never appear in a create/update
// payload. The server sets every one of these; including them returns 400.
const SERVER_MANAGED_COLUMNS = new Set([
  'ownerid',
  'owneridtype',
  'statecode',
  'statuscode',
  'importsequencenumber',
  'overriddencreatedon',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
  'versionnumber',
  'createdon',
  'modifiedon',
  'createdby',
  'modifiedby',
]);

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!/\.(tsx|ts)$/i.test(filePath)) return false;
  // Dataverse calls live in both Expo routes and shared source helpers.
  if (!/[\\/](?:app|src)[\\/]/.test(filePath)) return false;
  // Skip the generated layer itself — npx power-apps owns those files.
  if (/[\\/]src[\\/]generated[\\/]/.test(filePath)) return false;
  return true;
}

function isLookupType(type) {
  return typeof type === 'string' && /lookup/i.test(type);
}

/**
 * Resolve lookup logical names from the real Dataverse manifest. A lookup's
 * logical name is a navigation property for writes/expands, not a scalar
 * `$select` column. Reads must request `_<logicalName>_value`.
 */
function loadLookupColumns(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.datamodel-manifest.json'),
    path.join(projectRoot, 'docs', 'plan-artifacts', '.datamodel-manifest.json'),
  ];
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) return new Set();

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const lookups = new Set();
    for (const table of Array.isArray(manifest.tables) ? manifest.tables : []) {
      for (const column of Array.isArray(table.columns) ? table.columns : []) {
        if (isLookupType(column.type) && typeof column.logicalName === 'string') {
          lookups.add(column.logicalName.toLowerCase());
        }
      }
    }
    return lookups;
  } catch {
    // Manifest validity is enforced separately. A malformed manifest must not
    // make this write hook crash and hide its existing syntax checks.
    return new Set();
  }
}

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function extractContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') {
    return toolInput.content;
  }
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') {
    return toolInput.new_string;
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  const fp = toolInput.file_path || toolInput.filePath;
  if (typeof fp === 'string' && fs.existsSync(fp)) {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Walk forward from `startIdx` (which points at the `{` opening an object
 * literal) and return the index of the matching `}`. Tracks nested braces,
 * single/double/back-tick string literals, and line/block comments. Returns
 * -1 if unbalanced.
 */
function findMatchingBrace(content, startIdx) {
  let depth = 0;
  let i = startIdx;
  let inString = null; // '"' | "'" | '`' | null
  let inLineComment = false;
  let inBlockComment = false;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Scan the content for `select: [ ... ]` arrays inside object literals and
 * collect any string entries whose unquoted value matches the A1 forbidden
 * suffix list. Returns an array of { line, column, snippet }.
 */
function findForbiddenSelectColumns(content, lookupColumns = new Set()) {
  const violations = [];
  const re = /\bselect\s*:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const arrayBody = m[1];
    const stringRe = /['"]([^'"]+)['"]/g;
    let s;
    while ((s = stringRe.exec(arrayBody)) !== null) {
      const col = s[1];
      const isShadow = SELECT_FORBIDDEN_SUFFIX_RE.test(col);
      const isLookupNavigation = lookupColumns.has(col.toLowerCase());
      if (isShadow || isLookupNavigation) {
        const upto = content.slice(0, m.index + m[0].indexOf(s[0])); // approx
        const line = upto.split('\n').length;
        violations.push({
          line,
          column: col,
          kind: isLookupNavigation ? 'lookup-navigation' : 'virtual-shadow',
        });
      }
    }
  }
  return violations;
}

/**
 * Scan the content for `<Anything>Service.create({...})` and
 * `<Anything>Service.update(<id>, {...})` calls and look for forbidden
 * top-level keys in the payload object. Returns an array of
 * { line, op, key }.
 */
function findServerManagedCreatePayload(content) {
  const violations = [];
  // Match `.create(` or `.update(` — capture the operation name.
  const callRe = /\.(create|update)\s*\(/g;
  let m;
  while ((m = callRe.exec(content)) !== null) {
    const op = m[1];
    // Walk forward from after the `(` to find the first `{` at depth 0
    // (inside the call's own paren scope).
    let i = m.index + m[0].length;
    let parenDepth = 1;
    let braceStart = -1;
    let inString = null;
    while (i < content.length && parenDepth > 0) {
      const ch = content[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        i++;
        continue;
      }
      if (ch === '(') parenDepth++;
      else if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0) break;
      } else if (ch === '{' && parenDepth === 1) {
        braceStart = i;
        break;
      }
      i++;
    }
    if (braceStart === -1) continue;
    const braceEnd = findMatchingBrace(content, braceStart);
    if (braceEnd === -1) continue;
    const payload = content.slice(braceStart + 1, braceEnd);
    // Find top-level keys: must not be inside a nested brace. Use a depth-
    // aware scan.
    const keys = topLevelKeys(payload);
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (SERVER_MANAGED_COLUMNS.has(lower)) {
        const line = content.slice(0, braceStart).split('\n').length;
        violations.push({ line, op, key });
      }
    }
  }
  return violations;
}

/**
 * Extract top-level identifier keys from an object-literal body. Skips
 * nested braces, strings, comments, and `[computed]: ...` or
 * `'string-key': ...` forms — those are never the forbidden columns
 * (forbidden columns are always bare identifiers in well-formed code).
 */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let inString = null;
  let i = 0;
  let pendingKeyStart = 0;
  let lookForKey = true;

  while (i < body.length) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      lookForKey = false;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth !== 0) {
      i++;
      continue;
    }
    if (ch === ',') {
      lookForKey = true;
      pendingKeyStart = i + 1;
      i++;
      continue;
    }
    if (lookForKey && ch === ':') {
      // Identifier just before `:` — slice from pendingKeyStart.
      const segment = body.slice(pendingKeyStart, i).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
        keys.push(segment);
      }
      lookForKey = false;
      i++;
      continue;
    }
    i++;
  }
  return keys;
}

function buildBlockMessage(filePath, selectViolations, payloadViolations) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const lines = [];
  lines.push(
    `[mobile-app] A Dataverse call uses a pattern that returns HTTP 400 at runtime. The write was blocked; Claude will switch to the supported pattern and retry — no action needed from you.`
  );
  lines.push('');
  lines.push(`For Claude: BLOCKED: Dataverse payload violations in ${rel}`);
  lines.push('');

  if (selectViolations.length > 0) {
    lines.push('A1 — Forbidden lookup/navigation or virtual columns in `$select`:');
    for (const v of selectViolations) {
      lines.push(`  - line ${v.line}: "${v.column}"`);
    }
    lines.push('');
    lines.push(
      '  Lookup navigation properties and virtual `*idname` / `statename` / `statecodename` / `statuscodename` columns are not scalar `$select` fields. Dataverse rejects the request or omits the required lookup GUID.'
    );
    lines.push('');
    lines.push('  Required fix:');
    lines.push(
      '    1. Remove lookup logical names and `*name` entries from the `select` array. Add the exact generated `_<lookup>_value` read property instead.'
    );
    lines.push(
      "    2. Read the display label with `lookupName(record, '<lookupLogicalName>')` from `@/utils`."
    );
    lines.push(
      "    3. For state/status/choice labels, use `formattedValue(record, '<columnLogicalName>')` from `@/utils`."
    );
    lines.push('');
  }

  if (payloadViolations.length > 0) {
    lines.push('A2 — Server-managed columns in create/update payload:');
    for (const v of payloadViolations) {
      lines.push(`  - line ${v.line}: ${v.op}({ ${v.key}: ... })`);
    }
    lines.push('');
    lines.push(
      '  These columns are owned by the Dataverse server. Including any of them in a create or update payload returns HTTP 400 on every save.'
    );
    lines.push('');
    lines.push('  Required fix:');
    lines.push('    1. Remove the offending key(s) from the payload object literal entirely.');
    lines.push(
      '    2. If the generated TypeScript model marks them required, append `as any` to the payload object: `await Service.create({ ... } as any)`.'
    );
    lines.push(
      "    3. Never emit junk values like `ownerid: ''` or `statecode: 0` to satisfy the type checker."
    );
    lines.push(
      '    4. To set state/status, use the `SetState`/`SetStatus` action — not an inline column write. To assign ownership, use the `Assign` action.'
    );
    lines.push('');
  }

  lines.push(
    'Re-issue the Write/Edit with the payload corrected. Both patterns are documented in `agents/screen-builder.md` and `skills/add-dataverse/references/dataverse-reference.md`.'
  );
  return lines.join('\n');
}

let inputData = '';
process.stdin.on('data', (chunk) => {
  inputData += chunk;
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(inputData || '{}');
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || input.toolName;
  const toolInput = input.tool_input || input.toolInput || {};

  if (!isWriteTool(toolName)) {
    process.exit(0);
  }

  const filePath = toolInput.file_path || toolInput.filePath;
  if (!isWatchedFile(filePath)) {
    process.exit(0);
  }

  const content = extractContent(toolName, toolInput);
  if (!content) {
    process.exit(0);
  }

  const projectRoot = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const selectViolations = findForbiddenSelectColumns(content, loadLookupColumns(projectRoot));
  const payloadViolations = findServerManagedCreatePayload(content);

  if (selectViolations.length === 0 && payloadViolations.length === 0) {
    process.exit(0);
  }

  process.stderr.write(buildBlockMessage(filePath, selectViolations, payloadViolations) + '\n');
  process.exit(2);
});

// Exported for tests / cross-module reuse.
module.exports = {
  findForbiddenSelectColumns,
  findServerManagedCreatePayload,
  isWatchedFile,
  loadLookupColumns,
  topLevelKeys,
  SERVER_MANAGED_COLUMNS,
  SELECT_FORBIDDEN_SUFFIX_RE,
};
