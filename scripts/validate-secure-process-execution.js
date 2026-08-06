#!/usr/bin/env node

'use strict';

/**
 * Deterministic child_process policy for production Power Pages JavaScript.
 *
 * This repository intentionally has no root npm dependency graph, so CI cannot
 * assume an installed parser. The analyzer below uses a conservative JavaScript
 * tokenizer and balanced-token call reader instead:
 *
 * - CommonJS and ESM child_process imports are recognized, including aliases,
 *   namespace imports, direct require(...).method calls, simple reassignment,
 *   default-parameter aliases, and promisify(method) aliases.
 * - Comments, strings, regular expressions, multiline calls, and templates are
 *   tokenized so text that only looks like a process launch is ignored.
 * - exec/execSync commands must be one static string or static template literal.
 *   Concatenation, interpolation, variables, and other expressions fail closed.
 * - execFile/spawn families require a fixed executable string or process.execPath.
 *   Their options must omit shell, set shell:false, or resolve from a local const
 *   object. shell:true and unresolved option shapes fail closed.
 *
 * This is not a general JavaScript parser. Unsupported lexical syntax and
 * ambiguous child_process member/call shapes are findings rather than silently
 * skipped. That fail-closed boundary keeps future syntax changes reviewable
 * without adding a network dependency to CI.
 */

const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const POWER_PAGES_ROOT = 'plugins/power-pages';
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const PROCESS_METHODS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
]);
const SHELL_METHODS = new Set(['exec', 'execSync']);
const ARGV_METHODS = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync']);

// Production scope is intentionally narrower than "all JavaScript under the
// plugin". Skill templates are user application source, not plugin process
// execution code. Tests and generated/vendor trees are excluded by reviewed,
// named path segments instead of a broad substring or file-name suppression.
const SCAN_ROOTS = Object.freeze([
  `${POWER_PAGES_ROOT}/hooks`,
  `${POWER_PAGES_ROOT}/scripts`,
  `${POWER_PAGES_ROOT}/skills`,
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  'test',
  'tests',
  'fixture',
  'fixtures',
  'generated',
  'vendor',
  '_vendor',
  'node_modules',
]);

// The separate Playwright hardening PR #383 owns this legacy launcher. Matching
// uses the exact path, rule, callee, and whitespace-independent call tokens.
// Any call drift produces both the original finding and a stale-exception error.
const AUDITED_EXCEPTIONS = Object.freeze([
  Object.freeze({
    path: 'plugins/power-pages/scripts/launch-playwright-mcp.js',
    rule: 'shell-true',
    callee: 'spawn',
    call: "spawnFn ( 'npx' , buildMcpArgs ( browser ) , { stdio : 'inherit' , shell : true , } )",
    reason: 'Legacy Playwright launcher is removed by PR #383; delete this exception when that stacked change lands.',
  }),
]);

function decodeStringLiteral(raw) {
  if (typeof raw !== 'string' || raw.length < 2) return null;
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw[raw.length - 1] !== quote) return null;
  let value = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      value += char;
      continue;
    }
    i += 1;
    const escaped = raw[i];
    if (escaped === undefined) return null;
    const simple = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      0: '\0',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      value += simple[escaped];
    } else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(raw[i + 1] || '')) {
        octal += raw[i + 1];
        i += 1;
      }
      value += String.fromCodePoint(Number.parseInt(octal, 8));
    } else if (escaped === 'x') {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 2;
    } else if (escaped === 'u') {
      if (raw[i + 1] === '{') {
        const close = raw.indexOf('}', i + 2);
        if (close === -1) return null;
        const hex = raw.slice(i + 2, close);
        if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) return null;
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i = close;
      } else {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 4;
      }
    } else if (escaped === '\n') {
      // JavaScript line continuation contributes no character.
    } else {
      value += escaped;
    }
  }
  return value;
}

function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function advance() {
    const char = source[index++];
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return char;
  }

  function token(type, start, startLine, startColumn, extra = {}) {
    tokens.push({
      type,
      raw: source.slice(start, index),
      start,
      end: index,
      line: startLine,
      column: startColumn,
      ...extra,
    });
  }

  function fail(message) {
    const error = new SyntaxError(message);
    error.line = line;
    error.column = column;
    throw error;
  }

  function skipQuoted(quote) {
    advance();
    while (index < source.length) {
      const char = advance();
      if (char === '\\') {
        if (index < source.length) advance();
      } else if (char === quote) {
        return;
      } else if (char === '\n' && quote !== '`') {
        fail('unterminated string literal');
      }
    }
    fail(`unterminated ${quote === '`' ? 'template' : 'string'} literal`);
  }

  function skipLineComment() {
    advance();
    advance();
    while (index < source.length && source[index] !== '\n') advance();
  }

  function skipBlockComment() {
    advance();
    advance();
    while (index < source.length) {
      if (source[index] === '*' && source[index + 1] === '/') {
        advance();
        advance();
        return;
      }
      advance();
    }
    fail('unterminated block comment');
  }

  function skipTemplateInterpolation() {
    let depth = 1;
    let previousSignificant = null;
    while (index < source.length) {
      const char = source[index];
      if (char === "'" || char === '"') {
        skipQuoted(char);
        previousSignificant = 'value';
      } else if (char === '`') {
        skipTemplate();
        previousSignificant = 'value';
      } else if (char === '/' && source[index + 1] === '/') {
        skipLineComment();
      } else if (char === '/' && source[index + 1] === '*') {
        skipBlockComment();
      } else if (char === '/' &&
                 (previousSignificant === null || '([{:;,=!?&|'.includes(previousSignificant))) {
        // Template expressions commonly contain regex arguments, e.g.
        // `${value.replace(/\\/g, '\\\\')}`. Strings inside a regex are not
        // JavaScript strings, so consume the regex before looking for `}`.
        let inClass = false;
        advance();
        while (index < source.length) {
          const regexChar = advance();
          if (regexChar === '\\') {
            if (index < source.length) advance();
          } else if (regexChar === '[') {
            inClass = true;
          } else if (regexChar === ']') {
            inClass = false;
          } else if (regexChar === '/' && !inClass) {
            while (/[A-Za-z]/.test(source[index] || '')) advance();
            break;
          } else if (regexChar === '\n') {
            fail('unterminated regular expression in template interpolation');
          }
        }
        previousSignificant = 'value';
      } else {
        advance();
        if (char === '{') depth += 1;
        if (char === '}') {
          depth -= 1;
          if (depth === 0) return;
        }
        if (!/\s/.test(char)) previousSignificant = char;
      }
    }
    fail('unterminated template interpolation');
  }

  function skipTemplate() {
    let dynamic = false;
    advance();
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        advance();
        if (index < source.length) advance();
      } else if (char === '`') {
        advance();
        return dynamic;
      } else if (char === '$' && source[index + 1] === '{') {
        dynamic = true;
        advance();
        advance();
        skipTemplateInterpolation();
      } else {
        advance();
      }
    }
    fail('unterminated template literal');
  }

  function canStartRegex() {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === 'identifier' &&
        ['return', 'case', 'throw', 'yield', 'await', 'typeof', 'instanceof',
          'in', 'of', 'delete', 'void', 'new'].includes(previous.raw)) {
      return true;
    }
    if (previous.type === 'identifier' || previous.type === 'number' ||
        previous.type === 'string' || previous.type === 'template' ||
        previous.type === 'regex') {
      return false;
    }
    if (previous.raw === ')') {
      let depth = 1;
      for (let i = tokens.length - 2; i >= 0; i -= 1) {
        if (tokens[i].raw === ')') depth += 1;
        if (tokens[i].raw === '(') {
          depth -= 1;
          if (depth === 0) {
            return ['if', 'while', 'for', 'with', 'catch', 'switch'].includes(tokens[i - 1]?.raw);
          }
        }
      }
    }
    return ![')', ']', '}', '++', '--'].includes(previous.raw);
  }

  function scanRegex() {
    const start = index;
    const startLine = line;
    const startColumn = column;
    let inClass = false;
    advance();
    while (index < source.length) {
      const char = advance();
      if (char === '\\') {
        if (index < source.length) advance();
      } else if (char === '[') {
        inClass = true;
      } else if (char === ']') {
        inClass = false;
      } else if (char === '/' && !inClass) {
        while (/[A-Za-z]/.test(source[index] || '')) advance();
        token('regex', start, startLine, startColumn);
        return;
      } else if (char === '\n') {
        fail('unterminated regular expression literal');
      }
    }
    fail('unterminated regular expression literal');
  }

  if (source.startsWith('#!')) {
    while (index < source.length && source[index] !== '\n') advance();
  }

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      advance();
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      skipLineComment();
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      skipBlockComment();
      continue;
    }

    const start = index;
    const startLine = line;
    const startColumn = column;

    if (char === "'" || char === '"') {
      skipQuoted(char);
      token('string', start, startLine, startColumn);
      continue;
    }
    if (char === '`') {
      const dynamic = skipTemplate();
      token('template', start, startLine, startColumn, {
        dynamic,
      });
      continue;
    }
    if (char === '/' && canStartRegex()) {
      scanRegex();
      continue;
    }
    if (isIdentifierStart(char)) {
      advance();
      while (isIdentifierPart(source[index] || '')) advance();
      token('identifier', start, startLine, startColumn);
      continue;
    }
    if (/[0-9]/.test(char)) {
      advance();
      while (/[A-Za-z0-9_.]/.test(source[index] || '')) advance();
      token('number', start, startLine, startColumn);
      continue;
    }

    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (['===', '!==', '>>>', '**=', '&&=', '||=', '??=', '...'].includes(three)) {
      advance();
      advance();
      advance();
    } else if ([
      '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
      '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '&=', '|=', '^=',
    ].includes(two)) {
      advance();
      advance();
    } else if ('()[]{}.,;:+-*/%!?=<>|&^~'.includes(char)) {
      advance();
    } else {
      fail(`unsupported character ${JSON.stringify(char)}`);
    }
    token('punctuator', start, startLine, startColumn);
  }

  return tokens;
}

function matchingIndex(tokens, openIndex) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const open = tokens[openIndex]?.raw;
  const expected = pairs[open];
  if (!expected) return -1;
  const stack = [expected];
  for (let i = openIndex + 1; i < tokens.length; i += 1) {
    const raw = tokens[i].raw;
    if (pairs[raw]) {
      stack.push(pairs[raw]);
    } else if (raw === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(tokens, start, end, delimiter = ',') {
  const ranges = [];
  const stack = [];
  let rangeStart = start;
  const pairs = { '(': ')', '[': ']', '{': '}' };

  for (let i = start; i < end; i += 1) {
    const raw = tokens[i].raw;
    if (pairs[raw]) {
      stack.push(pairs[raw]);
    } else if (raw === stack[stack.length - 1]) {
      stack.pop();
    } else if (raw === delimiter && stack.length === 0) {
      ranges.push([rangeStart, i]);
      rangeStart = i + 1;
    }
  }
  ranges.push([rangeStart, end]);
  return ranges.filter(([from, to]) => from < to);
}

function isChildProcessRequire(tokens, requireIndex) {
  return tokens[requireIndex]?.raw === 'require' &&
    tokens[requireIndex + 1]?.raw === '(' &&
    tokens[requireIndex + 2]?.type === 'string' &&
    CHILD_PROCESS_MODULES.has(decodeStringLiteral(tokens[requireIndex + 2].raw)) &&
    tokens[requireIndex + 3]?.raw === ')';
}

function childProcessRequireExpression(tokens, start) {
  let index = start;
  let wrappers = 0;
  while (tokens[index]?.raw === '(') {
    wrappers += 1;
    index += 1;
  }
  if (!isChildProcessRequire(tokens, index)) return null;
  let end = index + 4;
  while (wrappers > 0 && tokens[end]?.raw === ')') {
    wrappers -= 1;
    end += 1;
  }
  return wrappers === 0 ? { requireIndex: index, end } : null;
}

function parseDestructuredMethods(tokens, openIndex, closeIndex, methodBindings) {
  for (const [start, end] of splitTopLevel(tokens, openIndex + 1, closeIndex)) {
    const property = tokens[start]?.raw;
    if (!PROCESS_METHODS.has(property)) continue;
    let alias = property;
    if (tokens[start + 1]?.raw === ':' && tokens[start + 2]?.type === 'identifier') {
      alias = tokens[start + 2].raw;
    } else if (tokens[start + 1]?.raw === 'as' && tokens[start + 2]?.type === 'identifier') {
      alias = tokens[start + 2].raw;
    }
    methodBindings.set(alias, property);
  }
}

function expressionEnd(tokens, start) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (let i = start; i < tokens.length; i += 1) {
    const raw = tokens[i].raw;
    if (pairs[raw]) {
      stack.push(pairs[raw]);
    } else if (raw === stack[stack.length - 1]) {
      stack.pop();
    } else if (stack.length === 0 && [')', ']', '}'].includes(raw)) {
      return i;
    } else if (stack.length === 0 && [',', ';'].includes(raw)) {
      return i;
    }
  }
  return tokens.length;
}

function discoverBindings(tokens) {
  const methodBindings = new Map();
  const namespaceBindings = new Set();
  const constBindings = new Map();

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].raw === 'import') {
      if (tokens[i + 1]?.raw === '{') {
        const close = matchingIndex(tokens, i + 1);
        if (close !== -1 && tokens[close + 1]?.raw === 'from' &&
            tokens[close + 2]?.type === 'string' &&
            CHILD_PROCESS_MODULES.has(decodeStringLiteral(tokens[close + 2].raw))) {
          parseDestructuredMethods(tokens, i + 1, close, methodBindings);
        }
      } else if (tokens[i + 1]?.raw === '*' && tokens[i + 2]?.raw === 'as' &&
                 tokens[i + 3]?.type === 'identifier' &&
                 tokens[i + 4]?.raw === 'from' &&
                 tokens[i + 5]?.type === 'string' &&
                 CHILD_PROCESS_MODULES.has(decodeStringLiteral(tokens[i + 5].raw))) {
        namespaceBindings.add(tokens[i + 3].raw);
      } else if (tokens[i + 1]?.type === 'identifier' &&
                 tokens[i + 2]?.raw === 'from' &&
                 tokens[i + 3]?.type === 'string' &&
                 CHILD_PROCESS_MODULES.has(decodeStringLiteral(tokens[i + 3].raw))) {
        namespaceBindings.add(tokens[i + 1].raw);
      }
    }

    const required = childProcessRequireExpression(tokens, i);
    if (!required) continue;
    const equalsIndex = i - 1;
    if (tokens[equalsIndex]?.raw !== '=') continue;

    if (tokens[equalsIndex - 1]?.type === 'identifier') {
      namespaceBindings.add(tokens[equalsIndex - 1].raw);
    } else if (tokens[equalsIndex - 1]?.raw === '}') {
      let open = equalsIndex - 1;
      let depth = 1;
      while (open > 0 && depth > 0) {
        open -= 1;
        if (tokens[open].raw === '}') depth += 1;
        if (tokens[open].raw === '{') depth -= 1;
      }
      if (depth === 0) parseDestructuredMethods(tokens, open, equalsIndex - 1, methodBindings);
    }
  }

  // const values are used only for local, single-expression resolution. A name
  // declared more than once is deliberately unresolved: without a full scope
  // tree, selecting one declaration could let a later/shadowed safe value mask
  // an earlier unsafe call.
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (tokens[i].raw !== 'const' || tokens[i + 1]?.type !== 'identifier' ||
        tokens[i + 2]?.raw !== '=') {
      continue;
    }
    const end = expressionEnd(tokens, i + 3);
    const name = tokens[i + 1].raw;
    constBindings.set(name, constBindings.has(name) ? null : [i + 3, end]);
  }

  const shadowedNames = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (['let', 'var'].includes(tokens[i].raw) && tokens[i + 1]?.type === 'identifier') {
      shadowedNames.add(tokens[i + 1].raw);
    }
    if (tokens[i].raw === 'function') {
      let open = i + 1;
      while (open < tokens.length && tokens[open].raw !== '(' &&
             tokens[open].raw !== '{' && tokens[open].raw !== ';') {
        open += 1;
      }
      const close = tokens[open]?.raw === '(' ? matchingIndex(tokens, open) : -1;
      if (close !== -1) {
        for (let j = open + 1; j < close; j += 1) {
          if (tokens[j].type === 'identifier') shadowedNames.add(tokens[j].raw);
        }
      }
    }
    if (tokens[i].raw === 'catch' && tokens[i + 1]?.raw === '(') {
      const close = matchingIndex(tokens, i + 1);
      for (let j = i + 2; close !== -1 && j < close; j += 1) {
        if (tokens[j].type === 'identifier') shadowedNames.add(tokens[j].raw);
      }
    }
    if (tokens[i].type === 'identifier' && tokens[i + 1]?.raw === '=>') {
      shadowedNames.add(tokens[i].raw);
    }
    if (tokens[i].raw === '(') {
      const close = matchingIndex(tokens, i);
      if (close !== -1 && tokens[close + 1]?.raw === '=>') {
        for (let j = i + 1; j < close; j += 1) {
          if (tokens[j].type === 'identifier') shadowedNames.add(tokens[j].raw);
        }
      }
    }
  }
  for (const name of shadowedNames) {
    if (constBindings.has(name)) constBindings.set(name, null);
  }

  // Resolve require(...).method assignments after namespace discovery.
  for (let i = 0; i < tokens.length - 6; i += 1) {
    const required = childProcessRequireExpression(tokens, i + 3);
    if (tokens[i].raw !== 'const' || tokens[i + 1]?.type !== 'identifier' ||
        tokens[i + 2]?.raw !== '=' || !required) {
      continue;
    }
    if (tokens[required.end]?.raw === '.' && PROCESS_METHODS.has(tokens[required.end + 1]?.raw)) {
      methodBindings.set(tokens[i + 1].raw, tokens[required.end + 1].raw);
    }
  }

  // Simple aliases appear in dependency-injection fallbacks, default parameters,
  // and promisify wrappers. Iterate because an alias may point at another alias.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < tokens.length - 2; i += 1) {
      if (tokens[i].type !== 'identifier' || tokens[i + 1]?.raw !== '=') continue;
      const end = expressionEnd(tokens, i + 2);
      const referenced = new Set();
      for (let j = i + 2; j < end; j += 1) {
        const method = methodBindings.get(tokens[j].raw);
        // A method identifier followed by `(` is a call result, not another
        // callable alias. Without this distinction, `stdout = execFileSync(...)`
        // would taint every later variable derived from stdout as a process API.
        if (method && tokens[j + 1]?.raw !== '(') referenced.add(method);
        if (namespaceBindings.has(tokens[j].raw) &&
            tokens[j + 1]?.raw === '.' &&
            PROCESS_METHODS.has(tokens[j + 2]?.raw) &&
            tokens[j + 3]?.raw !== '(') {
          referenced.add(tokens[j + 2].raw);
        }
      }
      if (referenced.size === 1 && !methodBindings.has(tokens[i].raw)) {
        methodBindings.set(tokens[i].raw, [...referenced][0]);
        changed = true;
      }
    }
  }

  return { methodBindings, namespaceBindings, constBindings };
}

function resolveRange(tokens, range, constBindings, seen = new Set()) {
  let [start, end] = range;
  while (start < end && tokens[start]?.raw === '(' && matchingIndex(tokens, start) === end - 1) {
    start += 1;
    end -= 1;
  }
  if (end - start === 1 && tokens[start]?.type === 'identifier') {
    const name = tokens[start].raw;
    if (seen.has(name)) return [start, end];
    const binding = constBindings.get(name);
    if (Array.isArray(binding)) {
      seen.add(name);
      return resolveRange(tokens, binding, constBindings, seen);
    }
  }
  return [start, end];
}

function canonicalCall(tokens, start, end) {
  return tokens.slice(start, end).map((item) => item.raw).join(' ');
}

function finding(filePath, call, rule, message, token = call.token) {
  return {
    path: filePath,
    line: token.line,
    column: token.column,
    rule,
    callee: call.method,
    call: call.canonical,
    message,
  };
}

function classifyShellCommand(tokens, range, constBindings) {
  const [start, end] = resolveRange(tokens, range, constBindings);
  if (end - start === 1 && tokens[start].type === 'string') return 'static';
  if (end - start === 1 && tokens[start].type === 'template') {
    return tokens[start].dynamic ? 'dynamic-template' : 'static';
  }
  if (tokens.slice(start, end).some((item) => item.raw === '+')) return 'concatenation';
  return 'nonconstant';
}

function isFixedExecutable(tokens, range, constBindings) {
  const [start, end] = resolveRange(tokens, range, constBindings);
  if (end - start === 1 && tokens[start].type === 'string') return true;
  return end - start === 3 &&
    tokens[start].raw === 'process' &&
    tokens[start + 1].raw === '.' &&
    tokens[start + 2].raw === 'execPath';
}

function shellProperty(tokens, range, constBindings) {
  const [start, end] = resolveRange(tokens, range, constBindings);
  if (tokens[start]?.raw !== '{' || matchingIndex(tokens, start) !== end - 1) {
    return 'ambiguous';
  }

  let shell = 'absent';
  for (const [propertyStart, propertyEnd] of splitTopLevel(tokens, start + 1, end - 1)) {
    if (tokens[propertyStart]?.raw === '...') return 'ambiguous';

    let key = null;
    let colonIndex = propertyStart + 1;
    const first = tokens[propertyStart];
    if (first?.type === 'identifier') {
      key = first.raw;
    } else if (first?.type === 'string') {
      key = decodeStringLiteral(first.raw);
    } else if (first?.raw === '[') {
      const close = matchingIndex(tokens, propertyStart);
      if (close === propertyStart + 2 && tokens[propertyStart + 1]?.type === 'string') {
        key = decodeStringLiteral(tokens[propertyStart + 1].raw);
        colonIndex = close + 1;
      } else {
        // A computed key could evaluate to "shell".
        return 'ambiguous';
      }
    }

    if (['get', 'set', 'async'].includes(key) && tokens[propertyStart + 1]?.type === 'identifier') {
      key = tokens[propertyStart + 1].raw;
      colonIndex = propertyStart + 2;
    }

    if (key !== 'shell') {
      continue;
    }
    if (tokens[colonIndex]?.raw !== ':') return 'ambiguous';
    const value = resolveRange(tokens, [colonIndex + 1, propertyEnd], constBindings);
    if (value[1] - value[0] === 1 && tokens[value[0]].raw === 'true') {
      shell = 'true';
      continue;
    }
    if (value[1] - value[0] === 1 && tokens[value[0]].raw === 'false') {
      shell = 'false';
      continue;
    }
    return 'ambiguous';
  }
  return shell;
}

function findCalls(tokens, bindings) {
  const calls = [];
  const { methodBindings, namespaceBindings } = bindings;

  for (let i = 0; i < tokens.length; i += 1) {
    let method = null;
    let openIndex = -1;
    let callStart = i;

    if (methodBindings.has(tokens[i].raw) && tokens[i + 1]?.raw === '(') {
      method = methodBindings.get(tokens[i].raw);
      openIndex = i + 1;
    } else if (methodBindings.has(tokens[i].raw) &&
               tokens[i + 1]?.raw === '?.' &&
               tokens[i + 2]?.raw === '(') {
      method = methodBindings.get(tokens[i].raw);
      openIndex = i + 2;
    } else if (tokens[i].raw === '(' &&
               methodBindings.has(tokens[i + 1]?.raw) &&
               tokens[i + 2]?.raw === ')' &&
               tokens[i + 3]?.raw === '(') {
      method = methodBindings.get(tokens[i + 1].raw);
      openIndex = i + 3;
    } else if (namespaceBindings.has(tokens[i].raw) &&
               ['.', '?.'].includes(tokens[i + 1]?.raw) &&
               PROCESS_METHODS.has(tokens[i + 2]?.raw) &&
               tokens[i + 3]?.raw === '(') {
      method = tokens[i + 2].raw;
      openIndex = i + 3;
    } else if (namespaceBindings.has(tokens[i].raw) &&
               ['.', '?.'].includes(tokens[i + 1]?.raw) &&
               PROCESS_METHODS.has(tokens[i + 2]?.raw) &&
               tokens[i + 3]?.raw === '?.' &&
               tokens[i + 4]?.raw === '(') {
      method = tokens[i + 2].raw;
      openIndex = i + 4;
    } else if (namespaceBindings.has(tokens[i].raw) && tokens[i + 1]?.raw === '[') {
      const close = matchingIndex(tokens, i + 1);
      if (close !== -1 &&
          (tokens[close + 1]?.raw === '(' ||
           (tokens[close + 1]?.raw === '?.' && tokens[close + 2]?.raw === '('))) {
        const member = tokens[i + 2];
        const memberName = member?.type === 'string' ? decodeStringLiteral(member.raw) : null;
        if (close === i + 3 && PROCESS_METHODS.has(memberName)) {
          method = memberName;
          if (tokens[close + 1]?.raw === '?.' && tokens[close + 2]?.raw === '(') {
            openIndex = close + 2;
          } else {
            openIndex = tokens[close + 1]?.raw === '?.' ? close + 2 : close + 1;
          }
        } else {
          calls.push({
            ambiguous: true,
            method: 'unknown',
            token: tokens[i],
            canonical: canonicalCall(tokens, i, Math.min(close + 2, tokens.length)),
          });
          continue;
        }
      }
    } else if (namespaceBindings.has(tokens[i].raw) &&
               tokens[i + 1]?.raw === '?.' &&
               tokens[i + 2]?.raw === '[') {
      const close = matchingIndex(tokens, i + 2);
      if (close !== -1 &&
          (tokens[close + 1]?.raw === '(' ||
           (tokens[close + 1]?.raw === '?.' && tokens[close + 2]?.raw === '('))) {
        const member = tokens[i + 3];
        const memberName = member?.type === 'string' ? decodeStringLiteral(member.raw) : null;
        if (close === i + 4 && PROCESS_METHODS.has(memberName)) {
          method = memberName;
          openIndex = tokens[close + 1]?.raw === '?.' ? close + 2 : close + 1;
        } else {
          calls.push({
            ambiguous: true,
            method: 'unknown',
            token: tokens[i],
            canonical: canonicalCall(tokens, i, Math.min(close + 2, tokens.length)),
          });
          continue;
        }
      }
    } else if (tokens[i].raw === '(' &&
               namespaceBindings.has(tokens[i + 1]?.raw) &&
               ['.', '?.'].includes(tokens[i + 2]?.raw) &&
               PROCESS_METHODS.has(tokens[i + 3]?.raw) &&
               tokens[i + 4]?.raw === ')' &&
               tokens[i + 5]?.raw === '(') {
      method = tokens[i + 3].raw;
      openIndex = i + 5;
    } else if (childProcessRequireExpression(tokens, i)) {
      const required = childProcessRequireExpression(tokens, i);
      if (['.', '?.'].includes(tokens[required.end]?.raw) &&
          PROCESS_METHODS.has(tokens[required.end + 1]?.raw)) {
        method = tokens[required.end + 1].raw;
        if (tokens[required.end + 2]?.raw === '?.' && tokens[required.end + 3]?.raw === '(') {
          openIndex = required.end + 3;
        } else if (tokens[required.end + 2]?.raw === '(') {
          openIndex = required.end + 2;
        }
      } else if (tokens[required.end]?.raw === '[' ||
                 (tokens[required.end]?.raw === '?.' && tokens[required.end + 1]?.raw === '[')) {
      const bracket = tokens[required.end]?.raw === '[' ? required.end : required.end + 1;
      const close = matchingIndex(tokens, bracket);
      if (close !== -1 && tokens[close + 1]?.raw === '(') {
        const member = tokens[bracket + 1];
        const memberName = member?.type === 'string' ? decodeStringLiteral(member.raw) : null;
        if (close === bracket + 2 && PROCESS_METHODS.has(memberName)) {
          method = memberName;
          openIndex = close + 1;
        } else {
          calls.push({
            ambiguous: true,
            method: 'unknown',
            token: tokens[i],
            canonical: canonicalCall(tokens, i, Math.min(close + 2, tokens.length)),
          });
          continue;
        }
      }
      }
    }

    if (!method) continue;
    const closeIndex = matchingIndex(tokens, openIndex);
    if (closeIndex === -1) {
      calls.push({
        ambiguous: true,
        method,
        token: tokens[i],
        canonical: canonicalCall(tokens, callStart, tokens.length),
      });
      continue;
    }
    calls.push({
      method,
      token: tokens[i],
      args: splitTopLevel(tokens, openIndex + 1, closeIndex),
      canonical: canonicalCall(tokens, callStart, closeIndex + 1),
    });
    i = closeIndex;
  }
  return calls;
}

function analyzeSource(source, filePath = '<source>') {
  let tokens;
  try {
    tokens = tokenize(source);
  } catch (error) {
    return [{
      path: filePath,
      line: error.line || 1,
      column: error.column || 1,
      rule: 'unsupported-source-syntax',
      callee: 'unknown',
      call: '',
      message: `Source cannot be analyzed safely: ${error.message}.`,
    }];
  }

  const bindings = discoverBindings(tokens);
  const calls = findCalls(tokens, bindings);
  const findings = [];

  for (const call of calls) {
    if (call.ambiguous) {
      findings.push(finding(
        filePath,
        call,
        'ambiguous-child-process-call',
        'Child process call shape is ambiguous; use a direct named method with a fixed executable and argv array.'
      ));
      continue;
    }
    if (call.args.length === 0) {
      findings.push(finding(
        filePath,
        call,
        'ambiguous-child-process-call',
        `${call.method} requires an explicit command or executable.`
      ));
      continue;
    }

    if (SHELL_METHODS.has(call.method)) {
      const commandType = classifyShellCommand(tokens, call.args[0], bindings.constBindings);
      if (commandType === 'dynamic-template') {
        findings.push(finding(
          filePath,
          call,
          'dynamic-shell-command',
          `${call.method} command uses template interpolation; use execFile/spawn with a fixed executable and argv array.`
        ));
      } else if (commandType === 'concatenation') {
        findings.push(finding(
          filePath,
          call,
          'concatenated-shell-command',
          `${call.method} command uses string concatenation; use execFile/spawn with a fixed executable and argv array.`
        ));
      } else if (commandType !== 'static') {
        findings.push(finding(
          filePath,
          call,
          'nonconstant-shell-command',
          `${call.method} command is not a static literal; non-constant data must be passed as argv, never shell syntax.`
        ));
      }
      continue;
    }

    if (!ARGV_METHODS.has(call.method)) continue;
    if (!isFixedExecutable(tokens, call.args[0], bindings.constBindings)) {
      findings.push(finding(
        filePath,
        call,
        'nonconstant-executable',
        `${call.method} executable is not a fixed literal or process.execPath.`
      ));
    }

    let optionsRange = null;
    if (call.args.length >= 3) {
      optionsRange = call.args[2];
    } else if (call.args.length === 2) {
      const resolved = resolveRange(tokens, call.args[1], bindings.constBindings);
      if (tokens[resolved[0]]?.raw === '{') {
        optionsRange = call.args[1];
      } else if (tokens[resolved[0]]?.raw !== '[') {
        findings.push(finding(
          filePath,
          call,
          'ambiguous-shell-option',
          `${call.method} second argument could be an options object; pass an argv array and explicit shell:false options.`
        ));
      }
    }

    if (optionsRange) {
      const shell = shellProperty(tokens, optionsRange, bindings.constBindings);
      if (shell === 'true') {
        findings.push(finding(
          filePath,
          call,
          'shell-true',
          `${call.method} enables shell:true; pass arguments directly with shell:false.`
        ));
      } else if (shell === 'ambiguous') {
        findings.push(finding(
          filePath,
          call,
          'ambiguous-shell-option',
          `${call.method} options cannot be proven to keep shell execution disabled.`
        ));
      }
    }
  }

  return findings;
}

function shouldScan(relativePath) {
  const normalized = toPosix(relativePath);
  if (!/\.(?:cjs|js|mjs)$/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
  if (normalized.startsWith(`${POWER_PAGES_ROOT}/hooks/`)) return true;
  if (normalized.startsWith(`${POWER_PAGES_ROOT}/scripts/`)) return true;
  return normalized.startsWith(`${POWER_PAGES_ROOT}/skills/`) &&
    normalized.includes('/scripts/');
}

function walkJavaScript(root, relativeDirectory, results) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return;
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = toPosix(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        walkJavaScript(root, relativePath, results);
      }
    } else if (entry.isFile() && shouldScan(relativePath)) {
      results.push(relativePath);
    }
  }
}

function listProductionJavaScript(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) walkJavaScript(root, scanRoot, files);
  return files.sort();
}

function validateExceptions(exceptions) {
  for (const exception of exceptions) {
    for (const field of ['path', 'rule', 'callee', 'call', 'reason']) {
      if (typeof exception[field] !== 'string' || exception[field].trim() === '') {
        throw new Error(`Audited exception is missing required field '${field}'.`);
      }
    }
  }
}

function applyAuditedExceptions(findings, exceptions = AUDITED_EXCEPTIONS) {
  validateExceptions(exceptions);
  const matches = new Map(exceptions.map((exception) => [exception, 0]));
  const remaining = [];

  for (const item of findings) {
    const exception = exceptions.find((candidate) =>
      candidate.path === item.path &&
      candidate.rule === item.rule &&
      candidate.callee === item.callee &&
      candidate.call === item.call
    );
    if (exception) {
      matches.set(exception, matches.get(exception) + 1);
    } else {
      remaining.push(item);
    }
  }

  const audited = [];
  for (const exception of exceptions) {
    const count = matches.get(exception);
    if (count === 1) {
      audited.push(exception);
    } else {
      remaining.push({
        path: exception.path,
        line: 1,
        column: 1,
        rule: 'stale-audited-exception',
        callee: exception.callee,
        call: exception.call,
        message: count === 0
          ? `Audited exception no longer matches exactly: ${exception.reason}`
          : `Audited exception matched ${count} calls instead of one: ${exception.reason}`,
      });
    }
  }

  return { findings: remaining, audited };
}

function auditRepository(root = REPOSITORY_ROOT, exceptions = AUDITED_EXCEPTIONS) {
  const rawFindings = [];
  const files = listProductionJavaScript(root);
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    rawFindings.push(...analyzeSource(source, relativePath));
  }
  const result = applyAuditedExceptions(rawFindings, exceptions);
  return { ...result, files };
}

function parseCli(argv) {
  let root = REPOSITORY_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a path');
      root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--help') {
      return { help: true, root };
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { help: false, root };
}

function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/validate-secure-process-execution.js [--root <repository>]\n' +
      'Audits production Power Pages hooks, shared scripts, and skill scripts.\n'
    );
    return 0;
  }

  const result = auditRepository(options.root);
  for (const exception of result.audited) {
    process.stdout.write(
      `AUDITED ${exception.path} [${exception.rule}]: ${exception.reason}\n`
    );
  }

  if (result.findings.length > 0) {
    process.stderr.write('Secure process execution validation failed:\n');
    for (const item of result.findings) {
      process.stderr.write(
        `${item.path}:${item.line}:${item.column} [${item.rule}] ${item.message}\n`
      );
    }
    return 1;
  }

  process.stdout.write(
    `Secure process execution validation passed (${result.files.length} production files, ` +
    `${result.audited.length} audited exception${result.audited.length === 1 ? '' : 's'}).\n`
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  AUDITED_EXCEPTIONS,
  EXCLUDED_DIRECTORY_NAMES,
  SCAN_ROOTS,
  analyzeSource,
  applyAuditedExceptions,
  auditRepository,
  canonicalCall,
  listProductionJavaScript,
  runCli,
  shouldScan,
  tokenize,
  validateExceptions,
};
