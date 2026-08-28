#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const SERVICE_METHOD_RE = /\b([A-Za-z_$][\w$]*)Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\s*\(/g;

function startsRegexLiteral(output) {
  const trimmed = output.trimEnd();
  if (!trimmed) return true;
  const previous = trimmed.at(-1);
  if (/[\(\[\{:,;=!?&|+\-*%^~<>]/.test(previous)) return true;
  return /\b(?:return|case|throw|typeof|instanceof|in|of|delete|void|new)$/.test(trimmed);
}

function stripComments(content) {
  let output = '';
  let state = 'code';
  let regexCharacterClass = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        output += current;
        state = 'code';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += current === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'regex') {
      output += current;
      if (current === '\\') {
        output += next || '';
        index += 1;
      } else if (current === '[') {
        regexCharacterClass = true;
      } else if (current === ']') {
        regexCharacterClass = false;
      } else if (current === '/' && !regexCharacterClass) {
        state = 'code';
      }
      continue;
    }
    if (state !== 'code') {
      output += current;
      if (current === '\\') {
        output += next || '';
        index += 1;
      } else if (
        (state === 'single-quote' && current === "'")
        || (state === 'double-quote' && current === '"')
        || (state === 'template' && current === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      output += current;
      if (current === "'") state = 'single-quote';
      else if (current === '"') state = 'double-quote';
      else if (current === '`') state = 'template';
      else if (current === '/' && startsRegexLiteral(output.slice(0, -1))) {
        state = 'regex';
        regexCharacterClass = false;
      }
    }
  }
  return output;
}

function isWriteTool(toolName) {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function isWatchedFile(filePath) {
  if (typeof filePath !== 'string' || !/\.(?:ts|tsx)$/i.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (!/\/(?:app|src)\//.test(normalized)) return false;
  return !/\/(?:node_modules|src\/generated|shared\/samples|\.expo|dist|build)\//.test(normalized);
}

function extractContent(toolName, toolInput) {
  if (toolName === 'Write' && typeof toolInput.content === 'string') return toolInput.content;
  if (toolName === 'Edit' && typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((edit) => (edit && typeof edit.new_string === 'string' ? edit.new_string : ''))
      .join('\n');
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findClosingBrace(source, openingIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function braceDepthAt(source, targetIndex) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < targetIndex; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    }
  }
  return depth;
}

function hasTerminatingFailureGuard(
  source,
  resultName,
  beforeIndex = source.length,
  requiredDepth = 0,
) {
  const escaped = escapeRegExp(resultName);
  const guard = new RegExp(`\\bif\\s*\\(\\s*!\\s*${escaped}\\.success\\s*\\)\\s*`, 'g');
  let match;
  while ((match = guard.exec(source)) !== null && match.index < beforeIndex) {
    if (braceDepthAt(source, match.index) !== requiredDepth) continue;
    const statementStart = guard.lastIndex;
    if (source[statementStart] === '{') {
      const statementEnd = findClosingBrace(source, statementStart);
      const body = statementEnd >= 0
        ? source.slice(statementStart + 1, statementEnd).trim()
        : '';
      if (
        statementEnd >= 0
        && statementEnd < beforeIndex
        && /(?:^|[;}])\s*(?:throw\b[^;]*;|return\b[^;]*;?)\s*$/.test(body)
      ) {
        return true;
      }
    } else if (/^(?:throw|return)\b[^;]*;/.test(source.slice(statementStart))) {
      return true;
    }
  }
  return false;
}

function findUncheckedServiceResults(content) {
  const source = stripComments(content);
  const violations = [];
  const assigned = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[A-Za-z_$][\w$]*Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\s*\(/g;
  const coveredRanges = [];
  let match;
  while ((match = assigned.exec(source)) !== null) {
    const resultName = match[1];
    coveredRanges.push([match.index, assigned.lastIndex]);
    const escaped = escapeRegExp(resultName);
    const remainder = source.slice(assigned.lastIndex);
    const successIndex = remainder.search(new RegExp(`\\b${escaped}\\.success\\b`));
    const dataIndex = remainder.search(new RegExp(`\\b${escaped}\\.data\\b`));
    const guardBoundary = dataIndex >= 0 ? dataIndex : remainder.length;
    if (successIndex < 0 || dataIndex >= 0 && dataIndex < successIndex
      || !hasTerminatingFailureGuard(
        remainder,
        resultName,
        guardBoundary,
        0,
      )) {
      violations.push(`Check \`${resultName}.success\` before reading data from ${match[2]}().`);
    }
  }

  SERVICE_METHOD_RE.lastIndex = 0;
  while ((match = SERVICE_METHOD_RE.exec(source)) !== null) {
    const prefix = source.slice(Math.max(0, match.index - 100), match.index);
    if (!/\bawait\s*$/.test(prefix)) continue;
    const covered = coveredRanges.some(([start, end]) => match.index >= start && match.index <= end);
    if (!covered) {
      violations.push(`Assign and validate the non-throwing result from ${match[1]}Service.${match[2]}().`);
    }
  }
  const queryFn = /\bqueryFn\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(*\s*([A-Za-z_$][\w$]*)Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\s*\(/g;
  while ((match = queryFn.exec(source)) !== null) {
    violations.push(`React Query must receive checked data, not the raw result from ${match[1]}Service.${match[2]}().`);
  }
  const queryFnReference = /\bqueryFn\s*:\s*([A-Za-z_$][\w$]*)Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\b/g;
  while ((match = queryFnReference.exec(source)) !== null) {
    violations.push(`React Query must receive checked data, not the raw result from ${match[1]}Service.${match[2]}().`);
  }
  const queryFnBlock = /\bqueryFn\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  while ((match = queryFnBlock.exec(source)) !== null) {
    const openingIndex = queryFnBlock.lastIndex - 1;
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex < 0) continue;
    const body = source.slice(openingIndex + 1, closingIndex);
    const rawReturn = /\breturn\s+\(*\s*(?:await\s+)?([A-Za-z_$][\w$]*)Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\s*\(/.exec(body);
    if (rawReturn) {
      violations.push(`React Query must receive checked data, not the raw result from ${rawReturn[1]}Service.${rawReturn[2]}().`);
    }
    queryFnBlock.lastIndex = closingIndex + 1;
  }
  const promiseResult = /\b([A-Za-z_$][\w$]*)Service\.(getAll|get|create|update|deleteFileOrImage|delete|upload|download\w*)\s*\([^;]*?\)\s*\.then\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*/g;
  while ((match = promiseResult.exec(source)) !== null) {
    const callbackStart = promiseResult.lastIndex;
    let body;
    let callbackEnd;
    if (source[callbackStart] === '{') {
      callbackEnd = findClosingBrace(source, callbackStart);
      if (callbackEnd < 0) continue;
      body = source.slice(callbackStart + 1, callbackEnd);
    } else {
      callbackEnd = source.indexOf(')', callbackStart);
      if (callbackEnd < 0) continue;
      body = source.slice(callbackStart, callbackEnd);
    }
    const dataIndex = body.search(new RegExp(`\\b${escapeRegExp(match[3])}\\.data\\b`));
    if (
      dataIndex >= 0
      && (
        source[callbackStart] !== '{'
        || !hasTerminatingFailureGuard(body, match[3], dataIndex)
      )
    ) {
      violations.push(`Check \`${match[3]}.success\` before reading data from ${match[2]}().`);
    }
    promiseResult.lastIndex = callbackEnd + 1;
  }
  return [...new Set(violations)];
}

function findEditQueryViolations(content) {
  const violations = [];
  const routeRe = /router\.(?:push|navigate|replace)\s*\(\s*([`'"])([^`'"]+)\1\s*\)/g;
  let match;
  while ((match = routeRe.exec(content)) !== null) {
    const route = match[2];
    if (!/\/(?:new|form)(?:\?|$)/.test(route)) continue;
    if (/[?&](?:id|recordId)=/.test(route) && !/[?&]editId=/.test(route)) {
      violations.push(`Use \`editId\` for create-or-edit route queries: ${route}`);
    }
  }
  return violations;
}

function findODataBindCasingViolations(content) {
  const violations = [];
  const bindRe = /@([A-Za-z]+)\.([A-Za-z]+)/g;
  let match;
  while ((match = bindRe.exec(content)) !== null) {
    if (`@${match[1]}.${match[2]}`.toLowerCase() !== '@odata.bind') continue;
    if (match[0] !== '@odata.bind') {
      violations.push(`Use the exact Dataverse annotation suffix \`@odata.bind\`, not \`${match[0]}\`.`);
    }
  }
  return violations;
}

function findDynamicRouteIdViolations(filePath, content) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const routeMatch = normalized.match(/\/\[([^\]]+)\](?:\/index)?\.tsx$/);
  if (!routeMatch) return [];
  const source = stripComments(content);
  const recordCall = /\b[A-Za-z_$][\w$]*Service\.(get|update|deleteFileOrImage|delete|upload|download\w*)\s*\(/g;
  const recordCalls = [...source.matchAll(recordCall)].map((call) => {
    const argumentStart = call.index + call[0].length;
    const argument = /^\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/.exec(source.slice(argumentStart));
    return { argument: argument?.[1] || null };
  });
  if (recordCalls.length === 0) return [];
  const hasNormalizerImport = /import\s*\{[^}]*\bnormalizeDataverseGuid\b[^}]*\}\s*from\s*['"]@\/utils['"]/.test(content);
  const routeName = escapeRegExp(routeMatch[1]);
  const routeExpression = `(?:[A-Za-z_$][\\w$]*\\.)?${routeName}`;
  const scalarSelection = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*Array\\.isArray\\(\\s*(${routeExpression})\\s*\\)`
      + '\\s*\\?\\s*\\2\\s*\\[\\s*0\\s*\\]\\s*:\\s*\\2',
  ).exec(source);
  if (!hasNormalizerImport || !scalarSelection) {
    return ['Dynamic Dataverse routes must select a scalar route parameter and normalize it before record operations.'];
  }
  const normalizedAssignment = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*normalizeDataverseGuid\\(\\s*${escapeRegExp(scalarSelection[1])}\\s*\\)`,
  ).exec(source);
  if (!normalizedAssignment || recordCalls.some((call) => call.argument !== normalizedAssignment[1])) {
    return ['Dynamic Dataverse record operations must receive the normalized scalar route ID.'];
  }
  return [];
}

function findViolations(filePath, content) {
  return [
    ...findUncheckedServiceResults(content),
    ...findEditQueryViolations(content),
    ...findODataBindCasingViolations(content),
    ...findDynamicRouteIdViolations(filePath, content),
  ];
}

function main() {
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
    const filePath = toolInput.file_path || toolInput.filePath;
    if (!isWriteTool(toolName) || !isWatchedFile(filePath)) process.exit(0);
    const content = extractContent(toolName, toolInput);
    const violations = content ? findViolations(filePath, content) : [];
    if (violations.length === 0) process.exit(0);
    process.stderr.write([
      '[mobile-app] Generated-code idiom validation failed. Write blocked.',
      '',
      `For Claude: BLOCKED: mobile code idioms failed in ${filePath}`,
      ...violations.map((violation) => `  - ${violation}`),
      '',
      'Use checked generated-service results, `?editId=` for edit mode, exact `@odata.bind` casing, and normalized Dataverse route IDs.',
      '',
    ].join('\n'));
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = {
  findDynamicRouteIdViolations,
  findEditQueryViolations,
  findODataBindCasingViolations,
  findUncheckedServiceResults,
  findViolations,
  isWatchedFile,
  stripComments,
};
