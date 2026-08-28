#!/usr/bin/env node

/**
 * Explicit validator: catch HTTP-400 crash patterns on Dataverse calls.
 *
 * Fires after Write / Edit / MultiEdit on TS/TSX files. Reads the resulting
 * file content and blocks the write if either:
 *
 *   A1 — `$select` contains a virtual `*name` shadow column on a lookup or
 *        state field. Adding `cr3e9_projectidname`, `statename`,
 *        `statecodename`, or `statuscodename` to a `select: [...]` array
 *        returns HTTP 400 from the Dataverse Web API on every list read.
 *        The correct read is `_<lookup>_value` + the formatted-value
 *        annotation (use `lookupName(record, ...)` from `@/utils`).
 *
 *   A2 — `*Service.create({...})` or `*Service.update(..., {...})` includes
 *        a server-managed column. The Dataverse server owns these fields;
 *        emitting them in a write payload returns HTTP 400 on every save.
 *        Even when the generated TypeScript model marks them required,
 *        satisfy the type with `as any` at the call site — never emit junk
 *        like `ownerid: ''` or `statecode: 0` to silence the type checker.
 *
 * Both checks fire for any TS/TSX file under `app/` or `src/` — they are runtime
 * correctness checks, not stylistic ones, so they fire even when other
 * style hooks are deferred.
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
  // Only screens/components/services under the project — skip plugin files,
  // generated scaffolding helpers, and anything outside app/src trees.
  if (!/[\\/](?:app|src)[\\/]/.test(filePath)) return false;
  // Skip the generated layer itself — npx power-apps owns those files.
  if (/[\\/]src[\\/]generated[\\/]/.test(filePath)) return false;
  return true;
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

function stripComments(content) {
  let output = '';
  let state = 'code';
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (state === 'line') {
      if (current === '\n') {
        output += current;
        state = 'code';
      } else output += ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else output += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (state !== 'code') {
      output += current;
      if (current === '\\') {
        output += next || '';
        index += 1;
      } else if (current === state) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line';
    } else if (current === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block';
    } else {
      output += current;
      if (current === "'" || current === '"' || current === '`') state = current;
    }
  }
  return output;
}

function findMatchingParen(content, startIdx) {
  let depth = 0;
  let quote = null;
  for (let index = startIdx; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(content, startIdx, endIdx) {
  const argumentsList = [];
  let segmentStart = startIdx;
  let depth = 0;
  let quote = null;
  for (let index = startIdx; index < endIdx; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(' || character === '{' || character === '[') depth += 1;
    else if (character === ')' || character === '}' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      argumentsList.push({ start: segmentStart, text: content.slice(segmentStart, index).trim() });
      segmentStart = index + 1;
    }
  }
  argumentsList.push({ start: segmentStart, text: content.slice(segmentStart, endIdx).trim() });
  return argumentsList;
}

function findVariableObjectInitializer(source, variableName, beforeIndex) {
  const declaration = new RegExp(
    `\\b(?:const|let)\\s+${variableName}\\b`,
    'g',
  );
  let declarationMatch;
  let braceStart = -1;
  while ((declarationMatch = declaration.exec(source.slice(0, beforeIndex))) !== null) {
    let quote = null;
    let roundDepth = 0;
    let squareDepth = 0;
    let curlyDepth = 0;
    let angleDepth = 0;
    for (
      let index = declarationMatch.index + declarationMatch[0].length;
      index < beforeIndex;
      index += 1
    ) {
      const character = source[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '(') roundDepth += 1;
      else if (character === ')') roundDepth = Math.max(0, roundDepth - 1);
      else if (character === '[') squareDepth += 1;
      else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
      else if (character === '{') curlyDepth += 1;
      else if (character === '}') curlyDepth = Math.max(0, curlyDepth - 1);
      else if (character === '<') angleDepth += 1;
      else if (character === '>') angleDepth = Math.max(0, angleDepth - 1);
      else if (
        character === '='
        && roundDepth === 0
        && squareDepth === 0
        && curlyDepth === 0
        && angleDepth === 0
      ) {
        let valueStart = index + 1;
        while (/\s/.test(source[valueStart] || '')) valueStart += 1;
        if (source[valueStart] === '{') braceStart = valueStart;
        break;
      } else if (character === ';' && curlyDepth === 0 && angleDepth === 0) {
        break;
      }
    }
  }
  return braceStart;
}

function findPayloadObjects(content) {
  const source = stripComments(content);
  const payloads = [];
  const callRe = /\b[A-Za-z_$][\w$]*Service\.(create|update)\s*\(/g;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const openingParen = callRe.lastIndex - 1;
    const closingParen = findMatchingParen(source, openingParen);
    if (closingParen < 0) continue;
    const args = splitArguments(source, openingParen + 1, closingParen);
    const argument = args[match[1] === 'create' ? 0 : 1];
    if (!argument) continue;
    let braceStart = -1;
    const leadingWhitespace = source.slice(argument.start, closingParen)
      .search(/\S/);
    if (argument.text.startsWith('{') && leadingWhitespace >= 0) {
      braceStart = argument.start + leadingWhitespace;
    } else if (/^[A-Za-z_$][\w$]*$/.test(argument.text)) {
      braceStart = findVariableObjectInitializer(source, argument.text, match.index);
    }
    if (braceStart < 0) continue;
    const braceEnd = findMatchingBrace(source, braceStart);
    if (braceEnd < 0) continue;
    payloads.push({
      body: source.slice(braceStart + 1, braceEnd),
      line: source.slice(0, braceStart).split('\n').length,
      op: match[1],
    });
    callRe.lastIndex = closingParen + 1;
  }
  return payloads;
}

/**
 * Scan the content for `select: [ ... ]` arrays inside object literals and
 * collect any string entries whose unquoted value matches the A1 forbidden
 * suffix list. Returns an array of { line, column, snippet }.
 */
function findForbiddenSelectColumns(content) {
  const violations = [];
  const re = /\bselect\s*:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const arrayBody = m[1];
    const stringRe = /['"]([^'"]+)['"]/g;
    let s;
    while ((s = stringRe.exec(arrayBody)) !== null) {
      const col = s[1];
      if (SELECT_FORBIDDEN_SUFFIX_RE.test(col)) {
        const upto = content.slice(0, m.index + m[0].indexOf(s[0])); // approx
        const line = upto.split('\n').length;
        violations.push({ line, column: col });
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
  for (const payload of findPayloadObjects(content)) {
    const keys = topLevelKeys(payload.body);
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (SERVER_MANAGED_COLUMNS.has(lower)) {
        violations.push({ line: payload.line, op: payload.op, key });
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
    if (depth === 0 && lookForKey && (ch === '"' || ch === "'")) {
      const quote = ch;
      let end = i + 1;
      while (end < body.length) {
        if (body[end] === '\\') end += 2;
        else if (body[end] === quote) break;
        else end += 1;
      }
      let colon = end + 1;
      while (/\s/.test(body[colon] || '')) colon += 1;
      if (body[colon] === ':') {
        keys.push(body.slice(i + 1, end));
        lookForKey = false;
        i = colon + 1;
        continue;
      }
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

function findRawLookupPayload(content) {
  const violations = [];
  for (const payload of findPayloadObjects(content)) {
    for (const key of topLevelKeys(payload.body)) {
      if (/^_[A-Za-z0-9_]+_value$/i.test(key)) {
        violations.push({
          line: payload.line,
          op: payload.op,
          key,
        });
      }
    }
  }
  return violations;
}

function buildBlockMessage(filePath, selectViolations, payloadViolations, lookupViolations) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const lines = [];
  lines.push(
    `[mobile-app] A Dataverse call uses a pattern that returns HTTP 400 at runtime. The write was blocked; Claude will switch to the supported pattern and retry — no action needed from you.`
  );
  lines.push('');
  lines.push(`For Claude: BLOCKED: Dataverse payload violations in ${rel}`);
  lines.push('');

  if (selectViolations.length > 0) {
    lines.push('A1 — Forbidden virtual `*name` columns in `$select`:');
    for (const v of selectViolations) {
      lines.push(`  - line ${v.line}: "${v.column}"`);
    }
    lines.push('');
    lines.push(
      '  Virtual `*idname` / `statename` / `statecodename` / `statuscodename` columns are NOT queryable on custom entities. The Dataverse Web API rejects the entire request with HTTP 400.'
    );
    lines.push('');
    lines.push('  Required fix:');
    lines.push(
      '    1. Remove the `*name` entries from the `select` array. Add `_<lookup>_value` instead.'
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

  if (lookupViolations.length > 0) {
    lines.push('A3 — Read-only lookup value fields in write payload:');
    for (const violation of lookupViolations) {
      lines.push(`  - line ${violation.line}: ${violation.op}({ ${violation.key}: ... })`);
    }
    lines.push('');
    lines.push('  `_<lookup>_value` is a read projection, not a writable lookup column. Raw GUID assignment does not create the relationship.');
    lines.push('');
    lines.push('  Required fix: use the exact navigation property and entity set:');
    lines.push("    '<navigationProperty>@odata.bind': '/<entitySet>(<guid>)'");
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

  const selectViolations = findForbiddenSelectColumns(content);
  const payloadViolations = findServerManagedCreatePayload(content);
  const lookupViolations = findRawLookupPayload(content);

  if (
    selectViolations.length === 0
    && payloadViolations.length === 0
    && lookupViolations.length === 0
  ) {
    process.exit(0);
  }

  process.stderr.write(buildBlockMessage(
    filePath,
    selectViolations,
    payloadViolations,
    lookupViolations,
  ) + '\n');
  process.exit(2);
});

// Exported for tests / cross-module reuse.
module.exports = {
  findForbiddenSelectColumns,
  findRawLookupPayload,
  findServerManagedCreatePayload,
  topLevelKeys,
  SERVER_MANAGED_COLUMNS,
  SELECT_FORBIDDEN_SUFFIX_RE,
};
