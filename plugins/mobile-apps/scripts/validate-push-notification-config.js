#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const {
  parseAndroidClientIdentities,
  parsePlistStrings,
} = require('./validate-firebase-client-config');

const REQUIRED_DEPS = [
  'expo-notifications',
  '@react-native-firebase/app',
  '@react-native-firebase/messaging',
  'expo-router',
];
const FIREBASE_PLUGINS = [
  '@react-native-firebase/app',
  '@react-native-firebase/messaging',
];
const HOST_TYPE_PATHS = [
  'lib/typescript/module/auth/AuthContext.d.ts',
  'lib/typescript/commonjs/auth/AuthContext.d.ts',
];

function fail(message) {
  process.stderr.write(`BLOCKED: ${message}\n`);
  return 2;
}

function parseArgs(argv) {
  const index = argv.indexOf('--project-root');
  return {
    projectRoot: index >= 0 ? argv[index + 1] : process.cwd(),
    strictClientIntegration: argv.includes('--strict-client-integration'),
  };
}

function isWithinRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveRegularProjectFile(root, configuredPath, label, required) {
  if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
    if (required) throw new Error(`${label} path must be a non-empty project-relative string.`);
    return null;
  }
  if (path.isAbsolute(configuredPath)) {
    throw new Error(`${label} path must be project-relative.`);
  }

  const requestedPath = path.resolve(root, configuredPath);
  if (!isWithinRoot(requestedPath, root)) {
    throw new Error(`${label} path escapes the project root.`);
  }
  if (!fs.existsSync(requestedPath)) {
    if (required) throw new Error(`${label} file is missing.`);
    return null;
  }

  const stat = fs.lstatSync(requestedPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file.`);
  }

  const realPath = fs.realpathSync(requestedPath);
  if (!isWithinRoot(realPath, root)) {
    throw new Error(`${label} resolves outside the project root.`);
  }

  return {
    absolutePath: realPath,
    expoPath: `./${path.relative(root, realPath).split(path.sep).join('/')}`,
  };
}

function configuredFirebaseFile(root, envName, defaultPath, label) {
  const hasOverride = Object.hasOwn(process.env, envName) && process.env[envName] !== '';
  const configuredPath = hasOverride ? process.env[envName] : defaultPath;
  return resolveRegularProjectFile(root, configuredPath, label, hasOverride);
}

function findForbiddenCredential(root) {
  const ignoredDirectories = new Set(['.git', 'node_modules', 'android', 'ios', 'dist', 'build']);
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pending.push(path.join(directory, entry.name));
        }
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      const isAdminJson =
        lowerName.endsWith('.json') &&
        (lowerName.includes('service-account') || lowerName.includes('firebase-adminsdk'));
      if (lowerName.endsWith('.p8') || isAdminJson) {
        return path.relative(root, path.join(directory, entry.name));
      }
    }
  }

  return null;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function fallbackPowerAppsExpoConfig(config, options, customize) {
  const resolved = {
    ...config,
    name: options.name,
    slug: options.slug,
    version: options.version,
    scheme: options.scheme,
    ...(options.iconPath ? { icon: options.iconPath } : {}),
    web: {
      bundler: 'metro',
      output: 'static',
    },
    platforms: ['ios', 'android', 'web'],
    experiments: {
      typedRoutes: true,
    },
    plugins: [
      ...(options.isDevClient ? ['expo-dev-client'] : []),
      'expo-router',
      'expo-secure-store',
      '@microsoft/power-apps-native-host',
      '@microsoft/power-apps-native-offline',
      '@react-native-community/datetimepicker',
    ],
    android: {
      package: options.androidPackage,
      versionCode: options.versionCode,
      ...(options.iconPath ? {
        adaptiveIcon: {
          foregroundImage: options.iconPath,
          backgroundColor: '#ffffff',
        },
      } : {}),
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: options.iosBundleIdentifier,
      infoPlist: {
        LSApplicationQueriesSchemes: [
          'intunemam',
          'ms-acompli',
          'msauthv2',
          'msauthv3',
        ],
      },
    },
  };
  return typeof customize === 'function' ? customize(resolved) : resolved;
}

function evaluateExpoConfig(configPath) {
  const source = fs.readFileSync(configPath, 'utf8');
  const localRequire = createRequire(configPath);
  const configModule = { exports: {} };
  const requireFromConfig = (specifier) => {
    if (specifier !== '@microsoft/power-apps-native-host/config/expoConfig') {
      return localRequire(specifier);
    }
    try {
      return localRequire(specifier);
    } catch (error) {
      if (
        error?.code !== 'MODULE_NOT_FOUND' ||
        !String(error.message).includes(specifier)
      ) {
        throw error;
      }
      return { createPowerAppsExpoConfig: fallbackPowerAppsExpoConfig };
    }
  };

  const load = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    source,
  );
  load(
    configModule.exports,
    requireFromConfig,
    configModule,
    configPath,
    path.dirname(configPath),
  );
  const exported = configModule.exports;
  const config = typeof exported === 'function' ? exported({ config: {} }) : exported;
  if (!config || typeof config !== 'object') {
    throw new Error('configuration did not return an object');
  }
  return config;
}

function pluginNames(plugins) {
  if (!Array.isArray(plugins)) return [];
  return plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

function pluginOptions(plugins, name) {
  if (!Array.isArray(plugins)) return null;
  const entry = plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name);
  return entry ? entry[1] : null;
}

function stripJavaScriptComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function maskJavaScriptStrings(source) {
  let quote = null;
  let escaped = false;
  return Array.from(source, (character) => {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
        return character;
      }
      return character === '\n' ? '\n' : ' ';
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    }
    return character;
  }).join('');
}

function findClosingBrace(source, openBraceIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findClosingDelimiter(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === openCharacter) depth += 1;
    else if (source[index] === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// This deliberately small lexer/control-flow pass avoids adding a parser dependency to
// the shipped plugin. General validation keeps unknown branches, while Android-specific
// proof can exclude them so helper-based platform guards are never assumed to reach Android.
function tokenizeJavaScript(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const start = index;
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const current = source[index];
        index += 1;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) break;
      }
      tokens.push({ value: source.slice(start, index), type: 'string' });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      index += 1;
      while (index < source.length && /[\w$]/.test(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), type: 'word' });
      continue;
    }
    if (/\d/.test(character)) {
      index += 1;
      while (index < source.length && /[\w.]/.test(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), type: 'number' });
      continue;
    }

    const operator = [
      '===', '!==', '>>>', '**=', '=>', '==', '!=', '<=', '>=', '&&', '||',
      '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '**', '<<', '>>',
    ].find((candidate) => source.startsWith(candidate, index));
    const value = operator || character;
    tokens.push({ value, type: 'punctuation' });
    index += value.length;
  }

  return tokens;
}

function pairJavaScriptDelimiters(tokens) {
  const pairs = new Map();
  const stacks = { '(': [], '[': [], '{': [] };
  const closing = { ')': '(', ']': '[', '}': '{' };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (stacks[value]) stacks[value].push(index);
    else if (closing[value]) {
      const open = stacks[closing[value]].pop();
      if (open !== undefined) {
        pairs.set(open, index);
        pairs.set(index, open);
      }
    }
  }
  return pairs;
}

function constantBoolean(tokens, constants = new Map()) {
  let values = tokens.map(({ value }) => value);
  while (
    values.length >= 2 &&
    values[0] === '(' &&
    values[values.length - 1] === ')'
  ) {
    values = values.slice(1, -1);
  }
  if (values.length === 1) {
    const value = values[0];
    if (constants.has(value)) return constants.get(value);
    if (['false', '0', 'null', 'undefined', 'NaN'].includes(value)) return false;
    if (['true', '1'].includes(value)) return true;
  }
  if (values.length === 2 && values[0] === '!') {
    const nested = constantBoolean([{ value: values[1] }], constants);
    return nested === undefined ? undefined : !nested;
  }
  if (values.length === 2 && values[0] === 'void') return false;

  const logicalIndex = values.findIndex((value) => value === '&&' || value === '||');
  if (logicalIndex > 0) {
    const left = constantBoolean(values.slice(0, logicalIndex).map((value) => ({ value })), constants);
    const right = constantBoolean(values.slice(logicalIndex + 1).map((value) => ({ value })), constants);
    if (values[logicalIndex] === '&&') {
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
    } else {
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
    }
  }

  const comparisonIndex = values.findIndex(
    (value) => ['===', '!==', '==', '!='].includes(value),
  );
  if (comparisonIndex > 0) {
    const left = values.slice(0, comparisonIndex).join('');
    const right = values.slice(comparisonIndex + 1).join('');
    if (/^(?:true|false|null|undefined|\d+)$/.test(left) &&
        /^(?:true|false|null|undefined|\d+)$/.test(right)) {
      const equal = left === right;
      return ['!==', '!='].includes(values[comparisonIndex]) ? !equal : equal;
    }
  }
  return undefined;
}

function reachableJavaScript(source, { includeUnknownBranches = true } = {}) {
  const tokens = tokenizeJavaScript(source);
  const pairs = pairJavaScriptDelimiters(tokens);

  function statementEnd(start, end) {
    for (let index = start; index < end; index += 1) {
      const value = tokens[index].value;
      if (['(', '[', '{'].includes(value) && pairs.has(index)) {
        index = pairs.get(index);
      } else if (value === ';') {
        return index + 1;
      }
    }
    return end;
  }

  function renderNested(start, end, constants) {
    const rendered = [];
    for (let index = start; index < end; index += 1) {
      if (tokens[index].value === '{' && pairs.has(index)) {
        const close = pairs.get(index);
        const nested = sequence(index + 1, close, new Map(constants));
        rendered.push(tokens[index], ...nested.rendered, tokens[close]);
        index = close;
      } else {
        rendered.push(tokens[index]);
      }
    }
    return rendered;
  }

  function statement(start, end, constants) {
    if (start >= end) return { next: end, rendered: [], terminates: false };
    const value = tokens[start].value;

    if (value === '{' && pairs.has(start)) {
      const close = pairs.get(start);
      const nested = sequence(start + 1, close, new Map(constants));
      return {
        next: close + 1,
        rendered: [tokens[start], ...nested.rendered, tokens[close]],
        terminates: nested.terminates,
      };
    }

    if (value === 'if' && tokens[start + 1]?.value === '(' && pairs.has(start + 1)) {
      const conditionClose = pairs.get(start + 1);
      const condition = constantBoolean(tokens.slice(start + 2, conditionClose), constants);
      const consequent = statement(conditionClose + 1, end, new Map(constants));
      let next = consequent.next;
      let alternate = null;
      if (tokens[next]?.value === 'else') {
        alternate = statement(next + 1, end, new Map(constants));
        next = alternate.next;
      }
      if (condition === false) {
        return {
          next,
          rendered: alternate?.rendered || [],
          terminates: Boolean(alternate?.terminates),
        };
      }
      if (condition === true) {
        return { next, rendered: consequent.rendered, terminates: consequent.terminates };
      }
      if (!includeUnknownBranches) {
        return {
          next,
          rendered: tokens.slice(start, conditionClose + 1),
          terminates: false,
        };
      }
      return {
        next,
        rendered: [
          ...tokens.slice(start, conditionClose + 1),
          ...consequent.rendered,
          ...(alternate ? [tokens[consequent.next], ...alternate.rendered] : []),
        ],
        terminates: Boolean(alternate && consequent.terminates && alternate.terminates),
      };
    }

    if (
      ['while', 'for'].includes(value) &&
      tokens[start + 1]?.value === '(' &&
      pairs.has(start + 1)
    ) {
      const conditionClose = pairs.get(start + 1);
      let conditionTokens = tokens.slice(start + 2, conditionClose);
      if (value === 'for') {
        const semicolons = conditionTokens
          .map((token, index) => token.value === ';' ? index : -1)
          .filter((index) => index >= 0);
        if (semicolons.length === 2) {
          conditionTokens = conditionTokens.slice(semicolons[0] + 1, semicolons[1]);
        }
      }
      const body = statement(conditionClose + 1, end, new Map(constants));
      if (constantBoolean(conditionTokens, constants) === false) {
        return { next: body.next, rendered: [], terminates: false };
      }
      return {
        next: body.next,
        rendered: [...tokens.slice(start, conditionClose + 1), ...body.rendered],
        terminates: false,
      };
    }

    if (value === 'return' || value === 'throw') {
      const next = statementEnd(start, end);
      return {
        next,
        rendered: renderNested(start, next, constants),
        terminates: true,
      };
    }

    if (value === 'try') {
      let next = start + 1;
      const rendered = [tokens[start]];
      const tryBlock = statement(next, end, new Map(constants));
      rendered.push(...tryBlock.rendered);
      next = tryBlock.next;
      let catchTerminates = false;
      if (tokens[next]?.value === 'catch') {
        rendered.push(tokens[next]);
        next += 1;
        if (tokens[next]?.value === '(' && pairs.has(next)) {
          const close = pairs.get(next);
          rendered.push(...tokens.slice(next, close + 1));
          next = close + 1;
        }
        const catchBlock = statement(next, end, new Map(constants));
        rendered.push(...catchBlock.rendered);
        catchTerminates = catchBlock.terminates;
        next = catchBlock.next;
      }
      if (tokens[next]?.value === 'finally') {
        rendered.push(tokens[next]);
        const finallyBlock = statement(next + 1, end, new Map(constants));
        rendered.push(...finallyBlock.rendered);
        next = finallyBlock.next;
        if (finallyBlock.terminates) {
          return { next, rendered, terminates: true };
        }
      }
      return {
        next,
        rendered,
        terminates: tryBlock.terminates && catchTerminates,
      };
    }

    const next = statementEnd(start, end);
    const rendered = renderNested(start, next, constants);
    if (
      value === 'const' &&
      tokens[start + 1]?.type === 'word' &&
      tokens[start + 2]?.value === '='
    ) {
      const expressionEnd = tokens[next - 1]?.value === ';' ? next - 1 : next;
      const constant = constantBoolean(tokens.slice(start + 3, expressionEnd), constants);
      if (constant !== undefined) constants.set(tokens[start + 1].value, constant);
    }
    return { next, rendered, terminates: false };
  }

  function sequence(start, end, constants) {
    const rendered = [];
    let index = start;
    while (index < end) {
      const previousIndex = index;
      const parsed = statement(index, end, constants);
      rendered.push(...parsed.rendered);
      index = parsed.next;
      if (parsed.terminates) return { rendered, terminates: true };
      if (index <= previousIndex) break;
    }
    return { rendered, terminates: false };
  }

  const reachable = sequence(0, tokens.length, new Map()).rendered;
  let output = '';
  for (const token of reachable) {
    const previous = output[output.length - 1];
    if (previous && /[\w$]/.test(previous) && /^[\w$]/.test(token.value)) output += ' ';
    output += token.value;
  }
  return output;
}

function specializeAndroidPlatformChecks(source) {
  return source
    .replace(/\bPlatform\.OS\s*={2,3}\s*(['"])android\1/g, 'true')
    .replace(/\bPlatform\.OS\s*!={1,2}\s*(['"])android\1/g, 'false')
    .replace(/\bPlatform\.OS\s*={2,3}\s*(['"])(?:ios|web)\1/g, 'false')
    .replace(/\bPlatform\.OS\s*!={1,2}\s*(['"])(?:ios|web)\1/g, 'true')
    .replace(/(['"])android\1\s*={2,3}\s*Platform\.OS\b/g, 'true')
    .replace(/(['"])android\1\s*!={1,2}\s*Platform\.OS\b/g, 'false')
    .replace(/(['"])(?:ios|web)\1\s*={2,3}\s*Platform\.OS\b/g, 'false')
    .replace(/(['"])(?:ios|web)\1\s*!={1,2}\s*Platform\.OS\b/g, 'true');
}

function rejectConditionallyGuardedAndroidEvidence(source) {
  const specialized = specializeAndroidPlatformChecks(source);
  const masked = maskJavaScriptStrings(specialized);
  const requiredCall = /\b(?:Notifications\.(?:setNotificationChannelAsync|setNotificationHandler)|messaging\s*\(\s*\)\.(?:onMessage|onTokenRefresh))\s*\(/g;
  let match;

  while ((match = requiredCall.exec(masked)) !== null) {
    const statementStart = Math.max(
      masked.lastIndexOf(';', match.index),
      masked.lastIndexOf('{', match.index),
      masked.lastIndexOf('}', match.index),
    ) + 1;
    const prefix = specialized.slice(statementStart, match.index);
    const tokens = tokenizeJavaScript(prefix);
    const pairs = pairJavaScriptDelimiters(tokens);
    let conditionalIndex = -1;
    for (let index = 0; index < tokens.length; index += 1) {
      const value = tokens[index].value;
      if (['(', '[', '{'].includes(value) && pairs.has(index)) {
        index = pairs.get(index);
      } else if (value === '?' || value === '&&' || value === '||') {
        conditionalIndex = index;
      }
    }
    if (conditionalIndex < 0) continue;

    const operator = tokens[conditionalIndex].value;
    if (operator === '?') {
      throw new Error(
        'Android-required implementation evidence must not be ternary-guarded; use an explicit Platform.OS Android branch.',
      );
    }

    const condition = constantBoolean(tokens.slice(0, conditionalIndex));
    const guaranteed =
      (operator === '&&' && condition === true) ||
      (operator === '||' && condition === false);
    if (!guaranteed) {
      throw new Error(
        'Android-required implementation evidence must not use an unknown logical guard; use an explicit Platform.OS Android branch.',
      );
    }
  }
}

function androidReachableJavaScript(source) {
  const specialized = specializeAndroidPlatformChecks(source);
  if (/\bPlatform\.select\s*\(/.test(maskJavaScriptStrings(specialized))) {
    throw new Error(
      'Android-required implementation evidence must not use Platform.select; use an explicit Platform.OS Android branch.',
    );
  }
  rejectConditionallyGuardedAndroidEvidence(source);
  return reachableJavaScript(specialized, { includeUnknownBranches: false });
}

function androidReachableExpression(source) {
  let expression = specializeAndroidPlatformChecks(source).trim();
  if (/\bPlatform\.select\s*\(/.test(maskJavaScriptStrings(expression))) {
    throw new Error(
      'Android-required implementation evidence must not use Platform.select; use an explicit Platform.OS Android branch.',
    );
  }
  while (expression.startsWith('(')) {
    const closeParenthesis = findClosingDelimiter(expression, 0, '(', ')');
    if (closeParenthesis !== expression.length - 1) break;
    expression = expression.slice(1, closeParenthesis).trim();
  }

  const masked = maskJavaScriptStrings(expression);
  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let questionIndex = -1;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth -= 1;
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth -= 1;
    else if (
      character === '?'
      && roundDepth === 0
      && squareDepth === 0
      && braceDepth === 0
    ) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return expression;

  const condition = expression.slice(0, questionIndex).trim();
  if (condition !== 'true' && condition !== 'false') return expression;
  roundDepth = 0;
  squareDepth = 0;
  braceDepth = 0;
  let nestedTernaryDepth = 0;
  for (let index = questionIndex + 1; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth -= 1;
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth -= 1;
    else if (
      character === '?'
      && roundDepth === 0
      && squareDepth === 0
      && braceDepth === 0
    ) {
      nestedTernaryDepth += 1;
    } else if (
      character === ':'
      && roundDepth === 0
      && squareDepth === 0
      && braceDepth === 0
    ) {
      if (nestedTernaryDepth > 0) {
        nestedTernaryDepth -= 1;
        continue;
      }
      return condition === 'true'
        ? expression.slice(questionIndex + 1, index).trim()
        : expression.slice(index + 1).trim();
    }
  }
  return expression;
}

function exportedFunctionBody(source, name) {
  const masked = maskJavaScriptStrings(source);
  const functionMatch = new RegExp(
    `\\bexport\\s+(?:async\\s+)?function\\s+${name}\\b`,
  ).exec(masked);
  const constMatch = new RegExp(
    `\\bexport\\s+const\\s+${name}\\s*=`,
  ).exec(masked);
  const match = functionMatch || constMatch;
  if (!match) return null;

  let searchFrom = match.index + match[0].length;
  if (functionMatch) {
    const parametersOpen = masked.indexOf('(', searchFrom);
    const parametersClose = findClosingDelimiter(masked, parametersOpen, '(', ')');
    if (parametersOpen < 0 || parametersClose < 0) return null;
    searchFrom = parametersClose + 1;
  } else {
    const arrowIndex = masked.indexOf('=>', searchFrom);
    if (arrowIndex < 0) return null;
    searchFrom = arrowIndex + 2;
  }
  const openBraceIndex = masked.indexOf('{', searchFrom);
  if (openBraceIndex < 0) return null;
  const closeBraceIndex = findClosingBrace(masked, openBraceIndex);
  if (closeBraceIndex < 0) return null;
  return source.slice(openBraceIndex + 1, closeBraceIndex);
}

function requireEvidence(source, checks, label) {
  const missing = checks
    .filter(({ pattern }) => !pattern.test(source))
    .map(({ description }) => description);
  if (missing.length > 0) {
    throw new Error(`${label} is missing concrete implementation evidence: ${missing.join(', ')}.`);
  }
}

function requireNonThrowingBody(source, name, { catchesErrors = true } = {}) {
  const body = exportedFunctionBody(source, name);
  if (!body) {
    throw new Error(`generated push wrapper must define ${name} with a block body.`);
  }
  const reachable = reachableJavaScript(body);
  const masked = maskJavaScriptStrings(reachable);
  if (/\bthrow\b/.test(masked)) {
    throw new Error(`${name} must return a non-throwing result instead of throwing.`);
  }
  if (catchesErrors && (!/\btry\s*\{/.test(masked) || !/\bcatch\b/.test(masked))) {
    throw new Error(`${name} must catch native failures and return a discriminated result.`);
  }
  return { body: reachable, masked };
}

function requireAwaitedCall(source, pattern, description, label) {
  const awaitedPattern = new RegExp(`\\bawait\\s+${pattern.source}`);
  if (!awaitedPattern.test(source)) {
    throw new Error(`${label} must await ${description} so native failures influence its result.`);
  }
  requireCallInsideTryCatch(source, awaitedPattern, description, label);
}

function requireAssignedCallInfluence(source, pattern, description, label) {
  const assignment = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+${pattern.source}`,
  ).exec(source);
  if (!assignment) {
    throw new Error(`${label} must assign and await ${description}.`);
  }
  requireCallInsideTryCatch(
    source,
    new RegExp(assignment[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    description,
    label,
  );
  const tail = source.slice(assignment.index + assignment[0].length);
  const variable = assignment[1].replace(/\$/g, '\\$');
  const influencesControlOrReturn = new RegExp(
    `\\b(?:if|switch)\\s*\\([^)]*\\b${variable}\\b|\\breturn\\b[^;]*\\b${variable}\\b`,
  ).test(tail);
  if (!influencesControlOrReturn) {
    throw new Error(
      `${label} must use the ${description} result in a subsequent check or returned outcome.`,
    );
  }
}

function requireCallInsideTryCatch(source, pattern, description, label) {
  const caughtRanges = [];
  const tryPattern = /\btry\s*\{/g;
  let tryMatch;
  while ((tryMatch = tryPattern.exec(source)) !== null) {
    const openBrace = source.indexOf('{', tryMatch.index);
    const closeBrace = findClosingBrace(source, openBrace);
    if (closeBrace < 0) continue;
    if (/^\s*catch\b/.test(source.slice(closeBrace + 1))) {
      caughtRanges.push({ start: openBrace + 1, end: closeBrace });
    }
  }

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const allMatches = new RegExp(pattern.source, flags);
  let matched = false;
  let callMatch;
  while ((callMatch = allMatches.exec(source)) !== null) {
    matched = true;
    const isCaught = caughtRanges.some(
      ({ start, end }) => callMatch.index >= start && callMatch.index < end,
    );
    if (!isCaught) {
      throw new Error(
        `${label} must catch every ${description} failure inside the same callback.`,
      );
    }
    if (callMatch[0].length === 0) allMatches.lastIndex += 1;
  }
  if (!matched) {
    throw new Error(`${label} is missing ${description}.`);
  }
}

function requireDiscriminatedOutcome(source, label, delegated = []) {
  if (!/\bok\s*:\s*false\b/.test(source)) {
    throw new Error(`${label} must expose a reachable failure result.`);
  }
  const delegates = delegated.some((name) => new RegExp(`\\breturn\\s+(?:await\\s+)?${name}\\s*\\(`).test(source));
  if (!/\bok\s*:\s*true\b/.test(source) && !delegates) {
    throw new Error(`${label} must expose a reachable success result or return a validated operation result.`);
  }
}

function extractCallArguments(source, pattern, label) {
  const masked = maskJavaScriptStrings(source);
  const match = pattern.exec(masked);
  if (!match) {
    throw new Error(`${label} is missing the required call.`);
  }
  const open = masked.indexOf('(', match.index + match[0].length);
  const close = findClosingDelimiter(masked, open, '(', ')');
  if (open < 0 || close < 0) {
    throw new Error(`${label} must use a statically analyzable call.`);
  }
  return source.slice(open + 1, close);
}

function extractInlineCallbackBody(source, pattern, label) {
  const argumentsSource = extractCallArguments(source, pattern, label);
  const masked = maskJavaScriptStrings(argumentsSource);
  const arrow = masked.indexOf('=>');
  const open = arrow >= 0 ? masked.indexOf('{', arrow + 2) : -1;
  const close = open >= 0 ? findClosingBrace(masked, open) : -1;
  if (arrow < 0 || open < 0 || close < 0) {
    throw new Error(`${label} must use an inline callback with a block body.`);
  }
  return argumentsSource.slice(open + 1, close);
}

function extractArrowReturnedObject(expression, label) {
  const masked = maskJavaScriptStrings(expression);
  const arrow = masked.indexOf('=>');
  if (arrow < 0) {
    throw new Error(`${label} must use an inline arrow callback.`);
  }

  let cursor = arrow + 2;
  while (/\s/.test(masked[cursor] || '')) cursor += 1;
  if (masked[cursor] === '(') {
    cursor += 1;
    while (/\s/.test(masked[cursor] || '')) cursor += 1;
  } else if (masked[cursor] === '{') {
    const bodyClose = findClosingBrace(masked, cursor);
    const body = masked.slice(cursor + 1, bodyClose);
    const returnedObject = /\breturn\s*(?:\(\s*)?\{/.exec(body);
    if (!returnedObject) {
      throw new Error(`${label} must return a statically analyzable presentation object.`);
    }
    cursor += 1 + returnedObject.index + returnedObject[0].lastIndexOf('{');
  }

  if (masked[cursor] !== '{') {
    throw new Error(`${label} must return a statically analyzable presentation object.`);
  }
  const close = findClosingBrace(masked, cursor);
  if (close < 0) {
    throw new Error(`${label} must return a complete presentation object.`);
  }
  return expression.slice(cursor, close + 1);
}

function firstCallArgument(argumentsSource) {
  const masked = maskJavaScriptStrings(argumentsSource);
  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth -= 1;
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth -= 1;
    else if (
      character === ',' &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      braceDepth === 0
    ) {
      return argumentsSource.slice(0, index).trim();
    }

  }
  return argumentsSource.trim();
}

function extractTopLevelObjectProperty(objectSource, propertyName, label) {
  let normalizedSource = objectSource.trim();
  let normalizedMasked = maskJavaScriptStrings(normalizedSource);
  while (normalizedMasked.startsWith('(')) {
    const closeParenthesis = findClosingDelimiter(normalizedMasked, 0, '(', ')');
    if (closeParenthesis !== normalizedMasked.length - 1) break;
    normalizedSource = normalizedSource.slice(1, closeParenthesis).trim();
    normalizedMasked = maskJavaScriptStrings(normalizedSource);
  }
  const masked = normalizedMasked;
  const open = masked.indexOf('{');
  const close = open >= 0 ? findClosingBrace(masked, open) : -1;
  if (open < 0 || close < 0 || masked.slice(0, open).trim() !== '') {
    throw new Error(`${label} must use a statically analyzable object literal.`);
  }
  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 1;
  for (let index = open + 1; index < close; index += 1) {
    const character = masked[index];
    if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth -= 1;
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth -= 1;
    else if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth -= 1;
    if (
      roundDepth !== 0
      || squareDepth !== 0
      || braceDepth !== 1
      || !masked.startsWith(propertyName, index)
      || /[\w$]/.test(masked[index - 1] || '')
      || /[\w$]/.test(masked[index + propertyName.length] || '')
    ) {
      continue;
    }
    let colon = index + propertyName.length;
    while (/\s/.test(masked[colon] || '')) colon += 1;
    if (masked[colon] !== ':') continue;
    const expressionStart = colon + 1;
    let expressionRound = 0;
    let expressionSquare = 0;
    let expressionBrace = 0;
    for (let end = expressionStart; end <= close; end += 1) {
      const current = masked[end];
      if (current === '(') expressionRound += 1;
      else if (current === ')') expressionRound -= 1;
      else if (current === '[') expressionSquare += 1;
      else if (current === ']') expressionSquare -= 1;
      else if (current === '{') expressionBrace += 1;
      else if (current === '}') {
        if (expressionBrace === 0 && expressionRound === 0 && expressionSquare === 0) {
          return normalizedSource.slice(expressionStart, end).trim();
        }
        expressionBrace -= 1;
      } else if (
        current === ','
        && expressionRound === 0
        && expressionSquare === 0
        && expressionBrace === 0
      ) {
        return normalizedSource.slice(expressionStart, end).trim();
      }
    }
  }
  throw new Error(`${label} must define a top-level ${propertyName} property.`);
}

function literalStringConstants(source) {
  const constants = new Map();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2\s*;/g;
  let match;
  while ((match = pattern.exec(source))) constants.set(match[1], match[3]);
  return constants;
}

function resolveStaticString(expression, constants, label) {
  const trimmed = expression.trim();
  const literal = /^(['"])([^'"]+)\1$/.exec(trimmed);
  if (literal) return literal[2];
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && constants.has(trimmed)) {
    return constants.get(trimmed);
  }
  throw new Error(`${label} must resolve to one non-empty static string.`);
}

function validateEntryPoint(root, pkg, strictClientIntegration = false) {
  const entry = resolveRegularProjectFile(root, pkg.main, 'package main', true);
  const source = stripJavaScriptComments(fs.readFileSync(entry.absolutePath, 'utf8'));
  const messagingIndex = source.search(
    /require\(\s*['"]@react-native-firebase\/messaging['"]\s*\)/,
  );
  const handlerMatches = source.match(/\.setBackgroundMessageHandler\s*\(/g) || [];
  const handlerIndex = source.search(
    /\.setBackgroundMessageHandler\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)/,
  );
  const routerMatches = source.match(/require\(\s*['"]expo-router\/entry['"]\s*\)/g) || [];
  const routerIndex = source.search(/require\(\s*['"]expo-router\/entry['"]\s*\)/);
  const nativeGuardIndex = source.search(
    /if\s*\(\s*Platform\.OS\s*!==\s*['"]web['"]\s*\)/,
  );
  const nativeGuardOpen = source.indexOf('{', nativeGuardIndex);
  const nativeGuardClose =
    nativeGuardOpen >= 0 ? findClosingBrace(source, nativeGuardOpen) : -1;

  if (
    nativeGuardIndex < 0 ||
    nativeGuardOpen < 0 ||
    nativeGuardClose < 0 ||
    messagingIndex < nativeGuardOpen ||
    handlerIndex > nativeGuardClose
  ) {
    throw new Error('package entry must guard native Firebase Messaging from web.');
  }
  if (handlerMatches.length !== 1 || handlerIndex < messagingIndex) {
    throw new Error('package entry must register one valid Firebase background handler.');
  }
  if (routerMatches.length !== 1 || routerIndex < handlerIndex) {
    throw new Error('package entry must register the background handler before expo-router/entry.');
  }
  if (strictClientIntegration) {
    const wrapperImport = source.match(
      /require\(\s*['"]\.\/src\/native\/pushNotifications['"]\s*\)/,
    );
    const delegatedHandler = source.match(
      /\.setBackgroundMessageHandler\s*\(\s*handleBackgroundNotification\s*\)/,
    );
    if (!wrapperImport || !delegatedHandler) {
      throw new Error(
        'strict client integration requires index.js to delegate to the generated handleBackgroundNotification before expo-router/entry.',
      );
    }
  }
}

function listSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(absolute);
    }
  }
  return files;
}

function validateStrictClientIntegration(root) {
  const navigation = resolveRegularProjectFile(
    root,
    'src/navigation/linkContract.ts',
    'shared navigation contract module',
    true,
  );
  const navigationSource = stripJavaScriptComments(
    fs.readFileSync(navigation.absolutePath, 'utf8'),
  );
  const wrapper = resolveRegularProjectFile(
    root,
    'src/native/pushNotifications.ts',
    'generated push notification wrapper',
    true,
  );
  const wrapperSource = stripJavaScriptComments(fs.readFileSync(wrapper.absolutePath, 'utf8'));
  const requiredExports = [
    'getPushPermissionState',
    'requestPushPermission',
    'openPushSettings',
    'syncPushTopic',
    'disablePushNotifications',
    'registerNotificationHandlers',
    'handleBackgroundNotification',
    'consumeInitialNotificationIntent',
  ];
  const missingExports = requiredExports.filter((name) => !new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`,
  ).test(wrapperSource));
  if (missingExports.length > 0) {
    throw new Error(`generated push wrapper is missing required exports: ${missingExports.join(', ')}.`);
  }

  requireEvidence(wrapperSource, [
    {
      pattern: /\bimport\s+\*\s+as\s+Notifications\s+from\s+['"]expo-notifications['"]/,
      description: 'the generated `Notifications` import from expo-notifications',
    },
    {
      pattern: /\bimport\s+messaging\s+from\s+['"]@react-native-firebase\/messaging['"]/,
      description: 'the generated default `messaging` import from @react-native-firebase/messaging',
    },
    {
      pattern: /\bimport\s*\{[^}]*\bparsePushNavigationIntent\b[^}]*\}\s*from\s*['"][^'"]*navigation\/linkContract['"]/,
      description: 'the shared push navigation-intent parser import',
    },
  ], 'generated push wrapper');

  requireEvidence(navigationSource, [
    {
      pattern: /\bexport\s+(?:function|const)\s+parsePushNavigationIntent\b/,
      description: 'the push navigation-intent parser',
    },
    {
      pattern: /\bexport\s+(?:function|const)\s+parseNavigationUrl\b/,
      description: 'the custom-scheme/HTTPS URL parser',
    },
    {
      pattern: /\bexport\s+(?:function|const)\s+navigateTo\b/,
      description: 'the typed in-app navigation helper',
    },
    {
      pattern: /\bschemaVersion\b/,
      description: 'schema-version validation',
    },
    {
      pattern: /\bdestination\b/,
      description: 'semantic destination validation',
    },
    {
      pattern: /\bparams\b/,
      description: 'typed navigation parameter validation',
    },
    {
      pattern: /\brouter\.(?:navigate|push|replace)\s*\(/,
      description: 'Expo Router navigation execution',
    },
    {
      pattern: /unsupported-version/,
      description: 'unsupported-version rejection',
    },
    {
      pattern: /unknown-destination/,
      description: 'unknown-destination rejection',
    },
    {
      pattern: /invalid-params/,
      description: 'invalid-params rejection',
    },
    {
      pattern: /unapproved-origin/,
      description: 'unapproved-origin rejection',
    },
    {
      pattern: /malformed-link/,
      description: 'malformed-link rejection',
    },
  ], 'shared navigation contract module');
  if (/\bdeepLink\b/.test(navigationSource)) {
    throw new Error('shared navigation contract module must reject the legacy deepLink shape.');
  }
  if (/\bdeepLink\b/.test(wrapperSource)) {
    throw new Error('generated push wrapper must not read or emit the legacy deepLink field.');
  }

  const permissionState = requireNonThrowingBody(wrapperSource, 'getPushPermissionState');
  requireEvidence(permissionState.masked, [
    { pattern: /\bNotifications\.getPermissionsAsync\s*\(/, description: 'permission query' },
  ], 'getPushPermissionState');
  requireAssignedCallInfluence(
    permissionState.masked,
    /Notifications\.getPermissionsAsync\s*\(/,
    'permission query',
    'getPushPermissionState',
  );
  requireDiscriminatedOutcome(permissionState.body, 'getPushPermissionState');

  const permissionRequest = requireNonThrowingBody(wrapperSource, 'requestPushPermission');
  requireEvidence(permissionRequest.masked, [
    {
      pattern: /\bNotifications\.setNotificationChannelAsync\s*\(/,
      description: 'Android notification channel creation',
    },
    { pattern: /\bNotifications\.requestPermissionsAsync\s*\(/, description: 'permission request' },
    {
      pattern: /\bmessaging\s*\(\s*\)\.registerDeviceForRemoteMessages\s*\(/,
      description: 'remote-message registration',
    },
    {
      pattern: /\bmessaging\s*\(\s*\)\.setAutoInitEnabled\s*\(\s*true\s*\)/,
      description: 'post-consent Messaging auto-init',
    },
    { pattern: /\bmessaging\s*\(\s*\)\.getToken\s*\(/, description: 'token acquisition' },
  ], 'requestPushPermission');
  const requestOrder = [
    permissionRequest.masked.search(/\bNotifications\.setNotificationChannelAsync\s*\(/),
    permissionRequest.masked.search(/\bNotifications\.requestPermissionsAsync\s*\(/),
    permissionRequest.masked.search(/\bmessaging\s*\(\s*\)\.registerDeviceForRemoteMessages\s*\(/),
    permissionRequest.masked.search(/\bmessaging\s*\(\s*\)\.setAutoInitEnabled\s*\(\s*true\s*\)/),
    permissionRequest.masked.search(/\bmessaging\s*\(\s*\)\.getToken\s*\(/),
  ];
  if (!requestOrder.every((index, position) => position === 0 || index > requestOrder[position - 1])) {
    throw new Error(
      'requestPushPermission must create the Android channel, request consent, register remote messages, enable auto-init, then acquire the token in that order.',
    );
  }
  if (!/\bif\s*\(/.test(permissionRequest.masked) || !/['"]permission-denied['"]/.test(permissionRequest.body)) {
    throw new Error('requestPushPermission must branch on consent and return permission-denied.');
  }
  requireAssignedCallInfluence(
    permissionRequest.masked,
    /Notifications\.requestPermissionsAsync\s*\(/,
    'permission request',
    'requestPushPermission',
  );
  requireAwaitedCall(
    permissionRequest.masked,
    /Notifications\.setNotificationChannelAsync\s*\(/,
    'Android notification channel creation',
    'requestPushPermission',
  );
  const androidPermissionRequest = androidReachableJavaScript(permissionRequest.body);
  const androidPermissionMasked = maskJavaScriptStrings(androidPermissionRequest);
  requireEvidence(androidPermissionMasked, [{
    pattern: /\bNotifications\.setNotificationChannelAsync\s*\(/,
    description: 'Android-reachable notification channel creation',
  }], 'requestPushPermission');
  const channelArguments = extractCallArguments(
    androidPermissionRequest,
    /\bNotifications\.setNotificationChannelAsync\b/,
    'requestPushPermission Android notification channel creation',
  );
  if (
    !/\bimportance\s*:\s*Notifications\.AndroidImportance\.(?:DEFAULT|HIGH|MAX)\b/.test(
      maskJavaScriptStrings(channelArguments),
    )
  ) {
    throw new Error(
      'requestPushPermission must create the Android channel with visible, non-silent DEFAULT, HIGH, or MAX importance.',
    );
  }
  requireAwaitedCall(
    permissionRequest.masked,
    /messaging\s*\(\s*\)\.registerDeviceForRemoteMessages\s*\(/,
    'remote-message registration',
    'requestPushPermission',
  );
  requireAwaitedCall(
    permissionRequest.masked,
    /messaging\s*\(\s*\)\.setAutoInitEnabled\s*\(\s*true\s*\)/,
    'Messaging auto-init enablement',
    'requestPushPermission',
  );
  requireAssignedCallInfluence(
    permissionRequest.masked,
    /messaging\s*\(\s*\)\.getToken\s*\(/,
    'token acquisition',
    'requestPushPermission',
  );
  requireDiscriminatedOutcome(permissionRequest.body, 'requestPushPermission', ['syncPushTopic']);

  const topicSync = requireNonThrowingBody(wrapperSource, 'syncPushTopic');
  requireEvidence(topicSync.masked, [
    {
      pattern: /\bmessaging\s*\(\s*\)\.subscribeToTopic\s*\(/,
      description: 'topic subscription',
    },
    {
      pattern: /\bmessaging\s*\(\s*\)\.unsubscribeFromTopic\s*\(/,
      description: 'topic unsubscription',
    },
    { pattern: /\.toLowerCase\s*\(/, description: 'lowercase OID canonicalization' },
  ], 'syncPushTopic');
  requireEvidence(topicSync.body, [
    { pattern: /['"]allUsers['"]/, description: 'the exact signed-out allUsers topic' },
    { pattern: /['"]missing-oid['"]/, description: 'the missing-oid result' },
  ], 'syncPushTopic');
  const subscribeIndex = topicSync.masked.search(
    /\bmessaging\s*\(\s*\)\.subscribeToTopic\s*\(/,
  );
  const unsubscribeIndex = topicSync.masked.search(
    /\bmessaging\s*\(\s*\)\.unsubscribeFromTopic\s*\(/,
  );
  if (unsubscribeIndex < subscribeIndex) {
    throw new Error('syncPushTopic must subscribe the desired topic before removing the old topic.');
  }
  requireAwaitedCall(
    topicSync.masked,
    /messaging\s*\(\s*\)\.subscribeToTopic\s*\(/,
    'topic subscription',
    'syncPushTopic',
  );
  requireAwaitedCall(
    topicSync.masked,
    /messaging\s*\(\s*\)\.unsubscribeFromTopic\s*\(/,
    'topic unsubscription',
    'syncPushTopic',
  );
  requireDiscriminatedOutcome(topicSync.body, 'syncPushTopic');

  const disable = requireNonThrowingBody(wrapperSource, 'disablePushNotifications');
  requireEvidence(disable.masked, [
    {
      pattern: /\bmessaging\s*\(\s*\)\.unsubscribeFromTopic\s*\(/,
      description: 'topic cleanup on opt-out',
    },
  ], 'disablePushNotifications');
  requireAwaitedCall(
    disable.masked,
    /messaging\s*\(\s*\)\.unsubscribeFromTopic\s*\(/,
    'topic cleanup',
    'disablePushNotifications',
  );
  requireDiscriminatedOutcome(disable.body, 'disablePushNotifications');

  const settings = requireNonThrowingBody(wrapperSource, 'openPushSettings');
  requireEvidence(settings.masked, [
    { pattern: /\bLinking\.openSettings\s*\(/, description: 'system settings launch' },
  ], 'openPushSettings');
  requireAwaitedCall(
    settings.masked,
    /Linking\.openSettings\s*\(/,
    'system settings launch',
    'openPushSettings',
  );
  requireDiscriminatedOutcome(settings.body, 'openPushSettings');
  const handlers = requireNonThrowingBody(wrapperSource, 'registerNotificationHandlers');
  requireEvidence(handlers.masked, [
    {
      pattern: /\bNotifications\.setNotificationHandler\s*\(/,
      description: 'foreground presentation handler',
    },
    { pattern: /\bmessaging\s*\(\s*\)\.onMessage\s*\(/, description: 'foreground message listener' },
    { pattern: /\bmessaging\s*\(\s*\)\.onTokenRefresh\s*\(/, description: 'token-refresh listener' },
    {
      pattern: /\bNotifications\.addNotificationResponseReceivedListener\s*\(/,
      description: 'warm notification-response listener',
    },
    { pattern: /\breturn\s*\(\s*\)\s*=>\s*\{/, description: 'listener cleanup function' },
  ], 'registerNotificationHandlers');
  for (const [pattern, description] of [
    [/\bNotifications\.setNotificationHandler\s*\(/, 'foreground presentation handler registration'],
    [/\bmessaging\s*\(\s*\)\.onMessage\s*\(/, 'foreground message listener registration'],
    [/\bmessaging\s*\(\s*\)\.onTokenRefresh\s*\(/, 'token-refresh listener registration'],
    [
      /\bNotifications\.addNotificationResponseReceivedListener\s*\(/,
      'notification-response listener registration',
    ],
  ]) {
    requireCallInsideTryCatch(handlers.masked, pattern, description, 'registerNotificationHandlers');
  }
  const handlerValidationCount = (
    handlers.masked.match(/\bparsePushNavigationIntent\s*\(/g) || []
  ).length;
  if (handlerValidationCount < 2) {
    throw new Error(
      'registerNotificationHandlers must validate both foreground and notification-response payloads.',
    );
  }
  const androidHandlers = androidReachableJavaScript(handlers.body);
  requireEvidence(androidHandlers, [
    {
      pattern: /\bNotifications\.setNotificationHandler\s*\(/,
      description: 'Android-reachable foreground presentation handler',
    },
    {
      pattern: /\bmessaging\s*\(\s*\)\.onMessage\s*\(/,
      description: 'Android-reachable foreground message listener',
    },
  ], 'registerNotificationHandlers');
  const presentationArguments = extractCallArguments(
    androidHandlers,
    /\bNotifications\.setNotificationHandler\b/,
    'Android foreground presentation handler',
  );
  const presentationConfig = firstCallArgument(presentationArguments);
  const presentationCallback = extractTopLevelObjectProperty(
    presentationConfig,
    'handleNotification',
    'Android foreground presentation handler',
  );
  const presentationResult = extractArrowReturnedObject(
    presentationCallback,
    'Android foreground presentation handler handleNotification',
  );
  for (const propertyName of ['shouldShowBanner', 'shouldShowList']) {
    const value = extractTopLevelObjectProperty(
      presentationResult,
      propertyName,
      'Android foreground presentation result',
    );
    if (value.trim() !== 'true') {
      throw new Error(
        `Android foreground presentation result must set ${propertyName}: true.`,
      );
    }
  }

  const foregroundCallback = androidReachableJavaScript(extractInlineCallbackBody(
    androidHandlers,
    /\bmessaging\s*\(\s*\)\.onMessage\b/,
    'messaging().onMessage foreground listener',
  ));
  const foregroundMasked = maskJavaScriptStrings(foregroundCallback);
  requireEvidence(foregroundMasked, [
    {
      pattern: /\bparsePushNavigationIntent\s*\(\s*message\s*\.\s*data\s*\)/,
      description: 'foreground message.data validation',
    },
    {
      pattern: /\bNotifications\.scheduleNotificationAsync\s*\(/,
      description: 'visible foreground local notification scheduling',
    },
  ], 'messaging().onMessage foreground callback');
  if (
    !/\btry\s*\{/.test(foregroundMasked) ||
    !/\bcatch\b/.test(foregroundMasked) ||
    /\bthrow\b|\bPromise\.reject\s*\(/.test(foregroundMasked)
  ) {
    throw new Error(
      'messaging().onMessage must catch foreground presentation failures and must not throw.',
    );
  }
  requireAwaitedCall(
    foregroundMasked,
    /Notifications\.scheduleNotificationAsync\s*\(/,
    'foreground local notification scheduling',
    'messaging().onMessage foreground callback',
  );
  requireCallInsideTryCatch(
    foregroundMasked,
    /\bawait\s+Notifications\.scheduleNotificationAsync\s*\(/,
    'foreground local notification scheduling',
    'messaging().onMessage foreground callback',
  );
  const scheduleArguments = extractCallArguments(
    foregroundCallback,
    /\bNotifications\.scheduleNotificationAsync\b/,
    'messaging().onMessage foreground presentation',
  );
  if (
    !/\bcontent\s*:\s*\{[\s\S]*?\bdata\s*:\s*message\s*\.\s*data\s*\?\?\s*\{\s*\}/.test(
      maskJavaScriptStrings(scheduleArguments),
    )
  ) {
    throw new Error(
      'foreground local notification content must preserve safe message.data with data: message.data ?? {} for response navigation.',
    );
  }
  const scheduleObject = firstCallArgument(scheduleArguments);
  const triggerExpression = androidReachableExpression(extractTopLevelObjectProperty(
    scheduleObject,
    'trigger',
    'messaging().onMessage foreground presentation',
  ));
  const scheduledChannelExpression = extractTopLevelObjectProperty(
    triggerExpression,
    'channelId',
    'messaging().onMessage foreground presentation trigger',
  );
  for (const delayedProperty of [
    'date',
    'day',
    'hour',
    'minute',
    'month',
    'repeats',
    'seconds',
    'type',
    'weekday',
    'year',
  ]) {
    try {
      extractTopLevelObjectProperty(
        triggerExpression,
        delayedProperty,
        'messaging().onMessage foreground presentation trigger',
      );
      throw new Error(
        'foreground local notification trigger must be immediate and contain only the Android channelId.',
      );
    } catch (error) {
      if (!String(error.message).includes(`top-level ${delayedProperty} property`)) throw error;
    }
  }
  const constants = literalStringConstants(wrapperSource);
  const createdChannelId = resolveStaticString(
    firstCallArgument(channelArguments),
    constants,
    'setNotificationChannelAsync channel ID',
  );
  const scheduledChannelId = resolveStaticString(
    scheduledChannelExpression,
    constants,
    'scheduleNotificationAsync trigger channelId',
  );
  const firebaseConfig = readJson(path.join(root, 'firebase.json'), 'firebase.json');
  const firebaseChannelId =
    firebaseConfig['react-native']?.messaging_android_notification_channel_id;
  if (typeof firebaseChannelId !== 'string' || firebaseChannelId.trim() === '') {
    throw new Error(
      'firebase.json must define a non-empty messaging_android_notification_channel_id.',
    );
  }
  if (
    createdChannelId !== scheduledChannelId ||
    createdChannelId !== firebaseChannelId
  ) {
    throw new Error(
      'Android notification channel ID must match setNotificationChannelAsync, the foreground schedule trigger, and firebase.json.',
    );
  }
  const refreshIndex = handlers.masked.search(/\bmessaging\s*\(\s*\)\.onTokenRefresh\s*\(/);
  const refreshSyncIndex = handlers.masked.indexOf('syncPushTopic', refreshIndex);
  if (refreshSyncIndex < refreshIndex) {
    throw new Error('the token-refresh listener must re-run syncPushTopic.');
  }

  const background = requireNonThrowingBody(wrapperSource, 'handleBackgroundNotification');
  requireEvidence(background.masked, [
    { pattern: /\bparsePushNavigationIntent\s*\(/, description: 'background payload validation' },
  ], 'handleBackgroundNotification');
  if (/\b(?:router|navigation)\s*\./.test(background.masked)) {
    throw new Error('handleBackgroundNotification must never navigate.');
  }
  requireDiscriminatedOutcome(
    background.body,
    'handleBackgroundNotification',
    ['parsePushNavigationIntent'],
  );

  const coldStart = requireNonThrowingBody(
    wrapperSource,
    'consumeInitialNotificationIntent',
  );
  requireEvidence(coldStart.masked, [
    {
      pattern: /\bNotifications\.getLastNotificationResponseAsync\s*\(/,
      description: 'cold-start response consumption',
    },
    { pattern: /\bparsePushNavigationIntent\s*\(/, description: 'cold-start navigation-intent validation' },
  ], 'consumeInitialNotificationIntent');
  requireAssignedCallInfluence(
    coldStart.masked,
    /Notifications\.getLastNotificationResponseAsync\s*\(/,
    'cold-start response query',
    'consumeInitialNotificationIntent',
  );
  requireDiscriminatedOutcome(
    coldStart.body,
    'consumeInitialNotificationIntent',
    ['parsePushNavigationIntent'],
  );

  requireEvidence(wrapperSource, [
    { pattern: /\bok\s*:\s*true\b/, description: 'successful discriminant' },
    { pattern: /\bok\s*:\s*false\b/, description: 'failure discriminant' },
    { pattern: /['"]unsupported['"]/, description: 'unsupported result reason' },
    { pattern: /['"]permission-denied['"]/, description: 'permission-denied result reason' },
    { pattern: /['"]missing-oid['"]/, description: 'missing-oid result reason' },
    { pattern: /['"]unsupported-version['"]/, description: 'unsupported-version result reason' },
    { pattern: /['"]unknown-destination['"]/, description: 'unknown-destination result reason' },
    { pattern: /['"]invalid-params['"]/, description: 'invalid-params result reason' },
    { pattern: /['"]unapproved-origin['"]/, description: 'unapproved-origin result reason' },
    { pattern: /['"]malformed-link['"]/, description: 'malformed-link result reason' },
    { pattern: /['"]firebase-error['"]/, description: 'firebase-error result reason' },
    { pattern: /['"]notification-error['"]/, description: 'notification-error result reason' },
  ], 'generated push wrapper discriminated result contract');

  const appFiles = listSourceFiles(path.join(root, 'app'));
  const hookFiles = [
    ...listSourceFiles(path.join(root, 'src/hooks')),
    ...listSourceFiles(path.join(root, 'src/providers')),
  ];
  const sources = appFiles.map((filePath) => ({
    relative: path.relative(root, filePath).split(path.sep).join('/'),
    source: stripJavaScriptComments(fs.readFileSync(filePath, 'utf8')),
  }));
  const lifecycleOwners = hookFiles.map((filePath) => ({
    relative: path.relative(root, filePath).split(path.sep).join('/'),
    source: stripJavaScriptComments(fs.readFileSync(filePath, 'utf8')),
  })).filter(({ source }) => (
    /\bregisterNotificationHandlers\s*\(/.test(maskJavaScriptStrings(source))
    && /\bsyncPushTopic\s*\(/.test(maskJavaScriptStrings(source))
  ));
  if (lifecycleOwners.length !== 1) {
    throw new Error(
      'strict client integration requires exactly one hook/provider that calls registerNotificationHandlers and syncPushTopic.',
    );
  }
  const owner = lifecycleOwners[0];
  const hookExport = owner.source.match(
    /\bexport\s+(?:default\s+)?(?:function|const)\s+(use\w*(?:Push|Notification)\w*)\b/,
  );
  const providerExport = owner.source.match(
    /\bexport\s+(?:default\s+)?(?:function|const)\s+(\w*(?:Push|Notification)\w*Provider)\b/,
  );
  const ownerName = hookExport?.[1] || providerExport?.[1];
  if (!ownerName) {
    throw new Error(
      'notification lifecycle owner must export a named push/notification hook or Provider.',
    );
  }
  const mountPattern = hookExport
    ? new RegExp(`\\b${ownerName}\\s*\\(`, 'g')
    : new RegExp(`<\\s*${ownerName}\\b`, 'g');
  const mountCount = sources.reduce(
    (count, { source }) => count + (maskJavaScriptStrings(source).match(mountPattern) || []).length,
    0,
  );
  if (mountCount !== 1) {
    throw new Error('notification lifecycle hook/provider must be mounted exactly once under app/.');
  }

  const consentSources = sources.filter(({ relative }) => (
    /(?:^|\/)login\.tsx?$/.test(relative) || /settings/i.test(relative)
  ));
  if (!consentSources.some(({ source }) => /\brequestPushPermission\b/.test(source))) {
    throw new Error('strict client integration requires a login/settings notification consent surface.');
  }
  if (!sources.some(({ source }) => /\bopenPushSettings\b/.test(source))) {
    throw new Error('strict client integration requires an Open Settings notification recovery surface.');
  }
  if (!sources.some(({ source }) => /\bdisablePushNotifications\b/.test(source))) {
    throw new Error('strict client integration requires a notification disable surface.');
  }
}

function parseMemoryHandoff(root) {
  const memoryPath = path.join(root, 'memory-bank.md');
  if (!fs.existsSync(memoryPath)) return {};
  const source = fs.readFileSync(memoryPath, 'utf8');
  const labels = {
    projectId: /firebase project id/i,
    androidAppId: /(?:android firebase app id|firebase android app id)/i,
    iosAppId: /(?:ios firebase app id|firebase ios app id)/i,
    androidIdentifier: /(?:android package(?: identifier)?|android bundle id)/i,
    iosIdentifier: /(?:ios bundle id|ios bundle identifier)/i,
    androidPath: /android client config path/i,
    iosPath: /ios client config path/i,
  };
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const table = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    const scalar = line.match(/^\s*[-*]?\s*([^:]+?)\s*:\s*(\S.*?)\s*$/);
    const pair = table || scalar;
    if (!pair) continue;
    for (const [field, pattern] of Object.entries(labels)) {
      if (!result[field] && pattern.test(pair[1]) && pair[2] && !/^[_<]/.test(pair[2].trim())) {
        result[field] = pair[2].trim().replace(/`/g, '');
      }
    }
  }
  return result;
}

function normalizeHandoffPath(value) {
  if (!value) return value;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return `./${normalized}`;
}

function validateActiveFirebaseIdentity(root, config, androidClient, iosClient, {
  requireSelectedNativeClients = false,
} = {}) {
  // Expo targets both native platforms when `platforms` is omitted. Treat that
  // default as selected in strict mode instead of allowing a custom config to
  // evade required client integration by deleting the explicit array.
  const platforms = new Set(
    Array.isArray(config.platforms) ? config.platforms : ['android', 'ios', 'web'],
  );
  if (requireSelectedNativeClients && platforms.has('android') && !androidClient) {
    throw new Error('strict client integration requires an active Android Firebase client file.');
  }
  if (requireSelectedNativeClients && platforms.has('ios') && !iosClient) {
    throw new Error('strict client integration requires an active iOS Firebase client file.');
  }

  let androidIdentity = null;
  if (androidClient) {
    androidIdentity = parseAndroidClientIdentities(fs.readFileSync(androidClient.absolutePath));
    if (!androidIdentity.projectId) {
      throw new Error('Android Firebase client file is missing its Firebase project identity.');
    }
    const matches = androidIdentity.clients.filter(
      (client) => client.identifier === config.android?.package,
    );
    if (matches.length !== 1) {
      throw new Error('Android Firebase client package identity differs from evaluated Expo config.');
    }
    if (!matches[0].appId) {
      throw new Error('Android Firebase client file is missing its Firebase app identity.');
    }
    androidIdentity = { ...androidIdentity, appId: matches[0].appId, identifier: matches[0].identifier };
  }

  let iosIdentity = null;
  if (iosClient) {
    iosIdentity = parsePlistStrings(fs.readFileSync(iosClient.absolutePath));
    if (!iosIdentity.projectId || !iosIdentity.appId) {
      throw new Error('iOS Firebase plist is missing its Firebase project or app identity.');
    }
    if (iosIdentity.identifier !== config.ios?.bundleIdentifier) {
      throw new Error('iOS Firebase plist bundle identity differs from evaluated Expo config.');
    }
  }

  if (androidIdentity && iosIdentity && androidIdentity.projectId !== iosIdentity.projectId) {
    throw new Error('active Android and iOS Firebase client files must use one Firebase project.');
  }

  const handoff = parseMemoryHandoff(root);
  const actualProject = androidIdentity?.projectId || iosIdentity?.projectId;
  const checks = [
    [handoff.projectId, actualProject, 'Firebase project ID differs from memory-bank handoff.'],
    [handoff.androidAppId, androidIdentity?.appId, 'Android Firebase app ID differs from memory-bank handoff.'],
    [handoff.iosAppId, iosIdentity?.appId, 'iOS Firebase app ID differs from memory-bank handoff.'],
    [handoff.androidIdentifier, androidIdentity?.identifier, 'Android package differs from memory-bank handoff.'],
    [handoff.iosIdentifier, iosIdentity?.identifier, 'iOS bundle ID differs from memory-bank handoff.'],
    [
      normalizeHandoffPath(handoff.androidPath),
      androidClient?.expoPath,
      'Android client path differs from memory-bank handoff.',
    ],
    [
      normalizeHandoffPath(handoff.iosPath),
      iosClient?.expoPath,
      'iOS client path differs from memory-bank handoff.',
    ],
  ];
  for (const [remembered, actual, message] of checks) {
    if (remembered && remembered !== actual) throw new Error(message);
  }
}

function validateHostOidDeclarations(root) {
  const hostRoot = path.join(root, 'node_modules', '@microsoft', 'power-apps-native-host');
  for (const relativePath of HOST_TYPE_PATHS) {
    const declarationPath = path.join(hostRoot, relativePath);
    if (!fs.existsSync(declarationPath)) continue;

    const declaration = fs.readFileSync(declarationPath, 'utf8');
    const typedUserOid =
      /\buser\s*:\s*\{[\s\S]*?\boid\s*:\s*string\s*;[\s\S]*?\}\s*\|\s*null\s*;/.test(
        declaration,
      );
    if (!typedUserOid) {
      throw new Error('installed native host does not expose typed useAuth().user.oid; run npm install.');
    }
  }
}

function validateExpoConfig(root, config, androidClient, iosClient) {
  const names = pluginNames(config.plugins);
  if (names.filter((name) => name === 'expo-notifications').length !== 1) {
    throw new Error('Expo config must include exactly one expo-notifications plugin.');
  }

  const expectedAndroidPath = androidClient?.expoPath;
  const expectedIosPath = iosClient?.expoPath;
  if (config.android?.googleServicesFile !== expectedAndroidPath) {
    throw new Error('evaluated Android Firebase config does not match the validated project file.');
  }
  if (config.ios?.googleServicesFile !== expectedIosPath) {
    throw new Error('evaluated iOS Firebase plist does not match the validated project file.');
  }

  const hasClientConfig = Boolean(androidClient || iosClient);
  for (const plugin of FIREBASE_PLUGINS) {
    const count = names.filter((name) => name === plugin).length;
    if (count !== (hasClientConfig ? 1 : 0)) {
      throw new Error(`${plugin} activation must match validated Firebase client config.`);
    }
  }

  const buildPropertiesCount = names.filter((name) => name === 'expo-build-properties').length;
  if (hasClientConfig) {
    const options = pluginOptions(config.plugins, 'expo-build-properties');
    const ios = options?.ios;
    if (
      buildPropertiesCount !== 1 ||
      ios?.useFrameworks !== 'static' ||
      !Array.isArray(ios.forceStaticLinking) ||
      !ios.forceStaticLinking.includes('RNFBApp') ||
      !ios.forceStaticLinking.includes('RNFBMessaging')
    ) {
      throw new Error('Firebase activation requires static RNFirebase iOS build properties.');
    }
  } else if (buildPropertiesCount !== 0) {
    throw new Error('Firebase build properties must not activate without client config.');
  }

  const intendedApnsEnvironment = process.env.APNS_ENVIRONMENT || 'development';
  if (!['development', 'production'].includes(intendedApnsEnvironment)) {
    throw new Error('APNS_ENVIRONMENT must resolve to development or production.');
  }
  if (config.ios?.entitlements?.['aps-environment'] !== intendedApnsEnvironment) {
    throw new Error('iOS aps-environment does not resolve to the intended build mode.');
  }
  if (
    !Array.isArray(config.ios?.infoPlist?.UIBackgroundModes) ||
    !config.ios.infoPlist.UIBackgroundModes.includes('remote-notification')
  ) {
    throw new Error('iOS UIBackgroundModes must include remote-notification.');
  }
}

function validateProjectConfiguration(root, { strictClientIntegration = false } = {}) {
  const packagePath = path.join(root, 'package.json');
  const configPath = path.join(root, 'app.config.js');
  const firebaseConfigPath = path.join(root, 'firebase.json');

  if (!fs.existsSync(packagePath) || !fs.existsSync(configPath)) {
    throw new Error('package.json and app.config.js are required.');
  }

  const pkg = readJson(packagePath, 'package.json');
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const missing = REQUIRED_DEPS.filter((name) => !deps[name]);
  if (missing.length > 0) {
    throw new Error(`missing notification dependencies: ${missing.join(', ')}`);
  }
  if (pkg.scripts?.postinstall !== 'node scripts/patch-native-host-auth.js') {
    throw new Error('package.json must apply the version-guarded native host OID patch after install.');
  }

  resolveRegularProjectFile(root, 'scripts/patch-native-host-auth.js', 'native host OID patch', true);
  validateHostOidDeclarations(root);
  validateEntryPoint(root, pkg, strictClientIntegration);
  if (strictClientIntegration) validateStrictClientIntegration(root);

  if (!fs.existsSync(firebaseConfigPath)) {
    throw new Error('firebase.json is required for consent-first Messaging initialization.');
  }
  const firebaseConfig = readJson(firebaseConfigPath, 'firebase.json');
  const firebaseReactNative = firebaseConfig['react-native'];
  if (
    firebaseReactNative?.messaging_auto_init_enabled !== false ||
    firebaseReactNative?.messaging_ios_auto_register_for_remote_messages !== false
  ) {
    throw new Error('firebase.json must disable Messaging auto-init and iOS auto-registration.');
  }
  if (
    typeof firebaseReactNative.messaging_android_notification_channel_id !== 'string' ||
    firebaseReactNative.messaging_android_notification_channel_id.trim() === ''
  ) {
    throw new Error(
      'firebase.json must define a non-empty messaging_android_notification_channel_id.',
    );
  }

  const androidClient = configuredFirebaseFile(
    root,
    'GOOGLE_SERVICES_JSON',
    './firebase/google-services.json',
    'Android Firebase client config',
  );
  const iosClient = configuredFirebaseFile(
    root,
    'GOOGLE_SERVICE_INFO_PLIST',
    './firebase/GoogleService-Info.plist',
    'iOS Firebase plist',
  );
  const config = evaluateExpoConfig(configPath);
  validateExpoConfig(root, config, androidClient, iosClient);
  validateActiveFirebaseIdentity(root, config, androidClient, iosClient, {
    requireSelectedNativeClients: strictClientIntegration,
  });

  const forbiddenCredential = findForbiddenCredential(root);
  if (forbiddenCredential) {
    throw new Error(`secret credential file must not be stored in the project: ${forbiddenCredential}`);
  }
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    const rootArg = args.projectRoot;
    if (!rootArg) return fail('--project-root requires a path.');
    const root = fs.realpathSync(path.resolve(rootArg));
    validateProjectConfiguration(root, args);
    process.stdout.write('Push notification configuration passed static validation.\n');
    return 0;
  } catch (error) {
    return fail(error.message);
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  configuredFirebaseFile,
  evaluateExpoConfig,
  findClosingBrace,
  findForbiddenCredential,
  isWithinRoot,
  main,
  parseArgs,
  resolveRegularProjectFile,
  stripJavaScriptComments,
  validateActiveFirebaseIdentity,
  validateEntryPoint,
  validateHostOidDeclarations,
  validateProjectConfiguration,
  validateStrictClientIntegration,
};
