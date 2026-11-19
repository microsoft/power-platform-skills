#!/usr/bin/env node

/**
 * Explicit validator: enforce cursor-list contracts for heavy Dataverse screens.
 *
 * The source of truth is native-app-plan.md. If a written app screen maps to a
 * per-screen spec whose Pagination field is `cursor`, it must not use the
 * bounded list helpers (`useListData`, `useSearchFilter`) and must wire an
 * actual cursor/infinite-list path.
 */

const fs = require('fs');
const path = require('path');
const { findMatchingBrace, findMatchingDelimiter, topLevelKeys } = require('./validate-dataverse-payload');

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (!/\.(tsx|ts)$/i.test(filePath)) return false;

  const norm = filePath.replace(/\\/g, '/');
  if (!/\/app\//.test(norm)) return false;
  if (/\/node_modules\//.test(norm)) return false;
  if (/\/src\/generated\//.test(norm)) return false;
  if (/\/shared\/samples\//.test(norm)) return false;
  if (/\/\.expo\//.test(norm) || /\/dist\//.test(norm) || /\/build\//.test(norm)) return false;
  return true;
}

function getContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((e) => (e && typeof e.new_string === 'string' ? e.new_string : '')).join('\n');
  }
  const filePath = toolInput.file_path || toolInput.filePath;
  if (typeof filePath === 'string' && fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

function findProjectRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 14; depth += 1) {
    if (fs.existsSync(path.join(dir, 'native-app-plan.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function findScreenSpec(planText, filePath, projectRoot) {
  const relPath = normalizePath(path.relative(projectRoot, filePath));
  const absPath = normalizePath(path.resolve(filePath));
  const candidates = [absPath, relPath, `./${relPath}`];

  let matchIndex = -1;
  for (const candidate of candidates) {
    matchIndex = normalizePath(planText).indexOf(candidate);
    if (matchIndex >= 0) break;
  }
  if (matchIndex < 0) return null;

  const startMarkers = ['\n### ', '\n#### '];
  let start = -1;
  for (const marker of startMarkers) {
    const idx = planText.lastIndexOf(marker, matchIndex);
    if (idx > start) start = idx;
  }
  if (start < 0) start = 0;

  const nextMajor = planText.indexOf('\n### ', matchIndex + 1);
  const nextMinor = planText.indexOf('\n#### ', matchIndex + 1);
  const ends = [nextMajor, nextMinor].filter((idx) => idx > matchIndex);
  const end = ends.length > 0 ? Math.min(...ends) : planText.length;

  return planText.slice(start, end);
}

function isCursorSpec(spec) {
  if (!spec) return false;
  return /\bPagination\b[\s\S]{0,140}\bcursor\b/i.test(spec);
}

function skipTrivia(content, start) {
  return start + /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*/.exec(content.slice(start))[0].length;
}

function findCalls(content, pattern) {
  const calls = [];
  for (const match of content.matchAll(pattern)) {
    let open = skipTrivia(content, match.index + match[0].length);
    if (content[open] === '<') {
      // `getAll<{ id: string; related?: Pick<Row, 'name'> }>(...)` and multiline
      // types need balanced delimiters, not a regex that stops at ';' or '\n'.
      const typeEnd = findMatchingDelimiter(content, open, '<', '>');
      if (typeEnd < 0) continue;
      open = skipTrivia(content, typeEnd + 1);
    }
    if (content[open] !== '(') continue;
    const end = findMatchingDelimiter(content, open, '(', ')');
    if (end >= 0) calls.push({ name: match[1], start: match.index, open, end });
  }
  return calls;
}

function returnedPageCalls(content, owner, calls) {
  // Only infer a page source from code, not `return page` inside comments,
  // query text, or labels. Keep offsets aligned with the original call spans.
  const code = content.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    (text) => text.replace(/[^\r\n]/g, ' '),
  );
  const body = code.slice(owner.open + 1, owner.end);
  const returnedNames = new Set([...body.matchAll(
    /\breturn\s*(?:\(\s*)*(?:await\s+)?(?:([A-Za-z_$][\w$]*)|\{\s*\.\.\.\s*([A-Za-z_$][\w$]*))/g,
  )].map((match) => match[1] || match[2]));
  return new Set(calls.filter((call) => {
    if (call.start <= owner.open || call.end >= owner.end) return false;
    const before = code.slice(owner.open + 1, call.start);
    if (/(?:\breturn|=>)\s*(?:\(\s*)*(?:await\s+)?$/.test(before)) return true;
    const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)*(?:await\s+)?$/.exec(before);
    return binding && returnedNames.has(binding[1]);
  }));
}

function findCursorViolations(content) {
  const violations = [];

  if (/\buseListData\s*\(/.test(content) || /import\s*\{[^}]*\buseListData\b[^}]*\}\s*from\s*['"]@\/hooks['"]/.test(content)) {
    violations.push('Cursor-paginated screens must not use `useListData`; it loads one bounded page. Use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook.');
  }

  if (/\buseSearchFilter\s*\(/.test(content) || /import\s*\{[^}]*\buseSearchFilter\b[^}]*\}\s*from\s*['"]@\/hooks['"]/.test(content)) {
    violations.push('Cursor-paginated screens must not use `useSearchFilter`; it filters only loaded rows. Push search into the service `filter` option.');
  }

  const cursorHooks = findCalls(content, /\b(useCursorListData|useInfiniteQuery)\b/g);
  if (cursorHooks.length === 0) {
    violations.push('Cursor-paginated screens must use `useCursorListData` or React Query `useInfiniteQuery`.');
  }

  if (/<FlatList\b/.test(content) && !/\bonEndReached\s*=/.test(content)) {
    violations.push('Cursor-paginated FlatList must wire `onEndReached` to load the next page.');
  }

  const serviceCalls = findCalls(content, /\b\w+Service\.(getAll|getSavedQuery)\b/g);
  const pageSources = new Map(cursorHooks.map((hook) => [
    hook, returnedPageCalls(content, hook, serviceCalls),
  ]));
  for (const call of serviceCalls) {
    const owner = cursorHooks.find((hook) => call.start > hook.open && call.end < hook.end);
    // Auxiliary lookups/totals outside a cursor hook do not inherit its paging
    // contract. Named external loaders remain the owning workflow's responsibility.
    if (!owner) continue;
    const argumentsText = content.slice(call.open + 1, call.end);
    if (call.name === 'getSavedQuery') {
      if (!/\bmaxPageSize\s*:/.test(argumentsText) || !/\bnextLink\b/.test(argumentsText)) {
        violations.push('Saved-query pages must pass maxPageSize and the complete returned nextLink to getSavedQuery.');
      }
      const hookOptions = content.slice(owner.open + 1, owner.end);
      if (owner.name === 'useCursorListData' && !/\bcursorMode\s*:\s*['"]nextLink['"]/.test(hookOptions)) {
        violations.push('Saved queries require useCursorListData cursorMode: "nextLink"; the default skip-token mode loses the saved-query continuation.');
      }
      continue;
    }
    const start = skipTrivia(content, call.open + 1);
    if (content[start] !== '{') continue;
    const end = findMatchingBrace(content, start);
    if (end < 0) continue;
    const options = content.slice(start + 1, end);
    const keys = topLevelKeys(options);
    const hasAggregation = keys.includes('apply');
    // `return { ...contactPage, data: merge(contactPage.data, counts.data) }`
    // retains contactPage's cursor. A bounded counts/lookup read in the same
    // loader must not receive that cursor. Keep checking unknown return flows.
    const returnedCalls = pageSources.get(owner);
    if (returnedCalls.size > 0 && !returnedCalls.has(call)
      && (hasAggregation || keys.includes('top'))) continue;
    if (!hasAggregation && !/\bselect\s*:/.test(options)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must include `select` so heavy lists do not fetch every column.');
    }
    if (!hasAggregation && !/\borderBy\s*:/.test(options)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must include deterministic `orderBy`, including a unique key.');
    }
    if (!/\bmaxPageSize\s*:/.test(options)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must use SDK `maxPageSize` for page size. `top` alone is a capped first page, not server paging.');
    }
    if (!/\b(skipToken|skiptoken|pageParam)\b/.test(options)) {
      violations.push('Cursor-paginated Dataverse reads must carry the SDK cursor (`skipToken`) or a React Query next-page path. `top: 50` alone is only a cap.');
    }
    if (/\bskip\s*:/.test(options) && !/\bskipToken\b/.test(options)) {
      violations.push('Cursor-paginated Dataverse reads must not use SDK `skip`; use returned `skipToken` for the next page.');
    }
  }

  return violations;
}

function buildBlockMessage(filePath, violations) {
  const rel = path.relative(process.cwd(), filePath) || filePath;
  const lines = [
    `[mobile-app] A screen marked Pagination: cursor is using a bounded Dataverse list pattern. The write was blocked so Claude can generate the cursor path instead.`,
    '',
    `For Claude: BLOCKED: Dataverse heavy-list violations in ${rel}`,
    '',
  ];
  for (const violation of violations) lines.push(`  - ${violation}`);
  lines.push('');
  lines.push('Required fix: use `useCursorListData`/`useInfiniteQuery` and FlatList `onEndReached`. Ordinary OData uses maxPageSize, skipToken, server-side filter, deterministic orderBy, and select. Saved queries use cursorMode: "nextLink" and complete links, with selection/order owned by the view. If the generated service has no required support, return BLOCKED instead of using a bounded list.');
  return lines.join('\n');
}

if (require.main === module) {
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
    if (!isWriteTool(toolName)) process.exit(0);

    const filePath = toolInput.file_path || toolInput.filePath;
    if (!isWatchedFile(filePath)) process.exit(0);

    const projectRoot = findProjectRoot(filePath);
    if (!projectRoot) process.exit(0);

    let planText = '';
    try {
      planText = fs.readFileSync(path.join(projectRoot, 'native-app-plan.md'), 'utf8');
    } catch {
      process.exit(0);
    }

    const spec = findScreenSpec(planText, filePath, projectRoot);
    if (!isCursorSpec(spec)) process.exit(0);

    const content = getContent(toolName, toolInput);
    if (!content) process.exit(0);

    const violations = findCursorViolations(content);
    if (violations.length === 0) process.exit(0);

    process.stderr.write(buildBlockMessage(filePath, violations) + '\n');
    process.exit(2);
  });
}

module.exports = {
  findCursorViolations,
  findProjectRoot,
  findScreenSpec,
  isCursorSpec,
};