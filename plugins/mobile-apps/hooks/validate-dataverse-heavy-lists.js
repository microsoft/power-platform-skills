#!/usr/bin/env node

/**
 * PostToolUse hook: enforce cursor-list contracts for heavy Dataverse screens.
 *
 * The source of truth is native-app-plan.md. If a written app screen maps to a
 * per-screen spec whose Pagination field is `cursor`, it must not use the
 * bounded list helpers (`useListData`, `useSearchFilter`) and must wire an
 * actual cursor/infinite-list path.
 */

const fs = require('fs');
const path = require('path');

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

function findCursorViolations(content) {
  const violations = [];

  if (/\buseListData\s*\(/.test(content) || /import\s*\{[^}]*\buseListData\b[^}]*\}\s*from\s*['"]@\/hooks['"]/.test(content)) {
    violations.push('Cursor-paginated screens must not use `useListData`; it loads one bounded page. Use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook.');
  }

  if (/\buseSearchFilter\s*\(/.test(content) || /import\s*\{[^}]*\buseSearchFilter\b[^}]*\}\s*from\s*['"]@\/hooks['"]/.test(content)) {
    violations.push('Cursor-paginated screens must not use `useSearchFilter`; it filters only loaded rows. Push search into the service `filter` option.');
  }

  if (!/\b(useCursorListData|useInfiniteQuery)\s*\(/.test(content)) {
    violations.push('Cursor-paginated screens must use `useCursorListData` or React Query `useInfiniteQuery`.');
  }

  if (/<FlatList\b/.test(content) && !/\bonEndReached\s*=/.test(content)) {
    violations.push('Cursor-paginated FlatList must wire `onEndReached` to load the next page.');
  }

  const hasServiceGetAll = /\b\w+Service\.getAll\s*\(/.test(content);
  if (hasServiceGetAll) {
    if (!/\bselect\s*:/.test(content)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must include `select` so heavy lists do not fetch every column.');
    }
    if (!/\borderBy\s*:/.test(content)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must include deterministic `orderBy`, including a unique key.');
    }
    if (!/\bmaxPageSize\s*:/.test(content)) {
      violations.push('Cursor-paginated Dataverse `getAll` calls must use SDK `maxPageSize` for page size. `top` alone is a capped first page, not server paging.');
    }
    if (!/\b(skipToken|skiptoken|nextLink|pageParam|fetchNextPage|loadMore)\b/.test(content)) {
      violations.push('Cursor-paginated Dataverse reads must carry the SDK cursor (`skipToken`) or a React Query next-page path. `top: 50` alone is only a cap.');
    }
    if (/\bskip\s*:/.test(content) && !/\bskipToken\s*:/.test(content)) {
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
  lines.push('Required fix: use `useCursorListData`/`useInfiniteQuery`, SDK `maxPageSize`, `skipToken`, server-side `filter`, deterministic `orderBy`, `select`, and FlatList `onEndReached`. If the generated service has no cursor support, return BLOCKED instead of falling back to `useListData`.');
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