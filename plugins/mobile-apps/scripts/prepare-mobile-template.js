#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_FILES = [
  'package.json',
  'app.config.js',
  'auth.config.json',
  'tamagui.config.ts',
  'app/_layout.tsx',
  'tsconfig.json',
];

const HOST_TSCONFIG = '@microsoft/power-apps-native-host/config/tsconfig';

const GUIDANCE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
];

const SHARED_FILES = [
  ['components/index.tsx', 'src/components/index.tsx'],
  ['hooks/index.ts', 'src/hooks/index.ts'],
  ['hooks/useCursorListData.ts', 'src/hooks/useCursorListData.ts'],
  ['hooks/useListData.ts', 'src/hooks/useListData.ts'],
  ['hooks/useSearchFilter.ts', 'src/hooks/useSearchFilter.ts'],
  ['utils/index.ts', 'src/utils/index.ts'],
  ['utils/formatters.ts', 'src/utils/formatters.ts'],
  ['utils/text.ts', 'src/utils/text.ts'],
  ['utils/choices.ts', 'src/utils/choices.ts'],
  ['utils/dataverse.ts', 'src/utils/dataverse.ts'],
  ['tokens/index.ts', 'src/tokens/index.ts'],
];

// The preview data layer's shared contract, copied only for the screens-first build order
// (`--screens-first`). Its screens are built against `@/hooks/data` before any data source
// exists, so it must be present before the first screen skeleton is written. A data-model-first
// app must not get it: `screen-builder` and `/edit-app` read an existing `src/hooks/data/` as a
// data-layer app and would stop importing the generated services those screens are built on.
const DATA_LAYER_FILES = [
  ['hooks/data/core.ts', 'src/hooks/data/core.ts'],
];

const LEGACY_EXAMPLE_FILES = [
  'src/hooks/useContacts.ts',
  'src/hooks/useAccounts.ts',
  'src/hooks/useUserProfile.ts',
  'src/queryClient.ts',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function singleQuoted(value) {
  return `'${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/'/g, "\\'")}'`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertFreshTemplate(projectRoot) {
  const missing = REQUIRED_FILES.filter((relativePath) => (
    !fs.existsSync(path.join(projectRoot, relativePath))
  ));
  if (missing.length > 0) {
    throw new Error(`Not a supported Expo standalone template; missing: ${missing.join(', ')}`);
  }

  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'expo'))) {
    throw new Error('Template dependencies are not installed; node_modules/expo is missing');
  }

  const createdMarkers = [
    'memory-bank.md',
    '.datamodel-manifest.json',
  ].filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));

  const generatedServices = path.join(projectRoot, 'src', 'generated', 'services');
  if (
    fs.existsSync(generatedServices)
    && fs.readdirSync(generatedServices).some((name) => name.endsWith('.ts'))
  ) {
    createdMarkers.push('src/generated/services/*.ts');
  }

  if (createdMarkers.length > 0) {
    throw new Error(`Template already contains created-app markers: ${createdMarkers.join(', ')}`);
  }

  verifyHostTsconfig(projectRoot);
  verifyLifecycleScripts(projectRoot);
}

// `npm run dev` is the development entry point, and npm runs `predev` before it. The
// template owns both command bodies and may change them as the native host evolves, so
// check only that each is a non-empty string: comparing or rewriting them would pin a
// host version. Failing here, before `pa app init`, beats discovering it at the end of
// a run when the dev server will not start.
function verifyLifecycleScripts(projectRoot) {
  const pkg = readJson(path.join(projectRoot, 'package.json'));
  for (const scriptName of ['dev', 'predev']) {
    if (typeof pkg.scripts?.[scriptName] !== 'string' || pkg.scripts[scriptName].trim() === '') {
      throw new Error(`Expected package.json scripts.${scriptName} to be a non-empty command.`);
    }
  }
}

function updateIdentity(projectRoot, displayName, slug) {
  const appConfigPath = path.join(projectRoot, 'app.config.js');
  let appConfig = fs.readFileSync(appConfigPath, 'utf8');
  const namePattern = /(const APP_NAME\s*=\s*process\.env\.APP_DISPLAY_NAME\s*\|\|\s*)'(?:\\.|[^'\\])*';/;
  const slugPattern = /(const APP_SLUG\s*=\s*process\.env\.APP_SLUG\s*\|\|\s*)'(?:\\.|[^'\\])*';/;

  if (!namePattern.test(appConfig) || !slugPattern.test(appConfig)) {
    throw new Error('app.config.js does not contain the supported APP_NAME and APP_SLUG declarations');
  }

  appConfig = appConfig
    .replace(namePattern, (_match, prefix) => `${prefix}${singleQuoted(displayName)};`)
    .replace(slugPattern, (_match, prefix) => `${prefix}${singleQuoted(slug)};`);
  fs.writeFileSync(appConfigPath, appConfig);

  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = readJson(packagePath);
  packageJson.name = slug;
  writeJson(packagePath, packageJson);
}

const WEB_PREVIEW_ENV = 'POWER_APPS_WEB_PREVIEW';

// Inserted at the top of the template's `customizeExpoConfig(config)` hook, the one place the
// template reserves for Expo config overrides. The native host sets `web.output: 'static'`, and in
// development that makes the Expo dev server render every page request on the server. Measured
// against Expo SDK 55: each render kept roughly 30 MB, so the build plan's live phone frame, which
// reloads every 10 seconds during a run, exhausted a 4 GB heap within the hour. `single` serves the
// client-rendered shell with no per-request render and stayed flat over the same load. The
// override applies only when `/create-mobile-app` starts its sample-data preview with
// POWER_APPS_WEB_PREVIEW=1, so `npm run web`, `bundle:web`, and native builds keep the host default.
const WEB_PREVIEW_OVERRIDE = `
  // Sample-data web preview started by /create-mobile-app: serve a client-rendered shell instead
  // of server-rendering every request, which grows the dev server's memory on each reload.
  if (process.env.${WEB_PREVIEW_ENV} === '1') {
    config.web = { ...config.web, output: 'single' };
  }
`;

/**
 * Returns `present` when the override already exists, `added` after inserting it, or `unsupported`
 * when the hook is not in its template shape. Unsupported is not an error: the preview still runs,
 * only with per-request server rendering.
 */
function ensureWebPreviewOutput(projectRoot) {
  const appConfigPath = path.join(projectRoot, 'app.config.js');
  const appConfig = fs.readFileSync(appConfigPath, 'utf8');
  if (appConfig.includes(WEB_PREVIEW_ENV)) return 'present';
  const hook = /function customizeExpoConfig\(config\)\s*\{\n/;
  if (!hook.test(appConfig)) return 'unsupported';
  fs.writeFileSync(appConfigPath, appConfig.replace(hook, (match) => `${match}${WEB_PREVIEW_OVERRIDE.slice(1)}`));
  return 'added';
}

function removeEmptyPowerConfig(projectRoot) {
  const powerConfigPath = path.join(projectRoot, 'power.config.json');
  if (!fs.existsSync(powerConfigPath)) return false;

  const powerConfig = readJson(powerConfigPath);
  if (typeof powerConfig.environmentId === 'string' && powerConfig.environmentId.trim()) {
    return false;
  }

  fs.unlinkSync(powerConfigPath);
  return true;
}

function removeLegacyExamples(projectRoot) {
  const removed = [];
  for (const relativePath of LEGACY_EXAMPLE_FILES) {
    const filePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    removed.push(relativePath);
  }
  return removed;
}

function copySharedFiles(projectRoot, samplesRoot, files = SHARED_FILES) {
  for (const directory of ['components', 'hooks', 'utils', 'tokens', 'native']) {
    fs.mkdirSync(path.join(projectRoot, 'src', directory), { recursive: true });
  }

  const copied = [];
  const preserved = [];
  for (const [sampleRelativePath, destinationRelativePath] of files) {
    const sourcePath = path.join(samplesRoot, sampleRelativePath);
    const destinationPath = path.join(projectRoot, destinationRelativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Shared template helper is missing: ${sourcePath}`);
    }
    if (fs.existsSync(destinationPath)) {
      preserved.push(destinationRelativePath);
      continue;
    }
    // Some helpers live below the top-level source folders (for example `hooks/data/`).
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    copied.push(destinationRelativePath);
  }

  return { copied, preserved };
}

function assertPreparationPath(projectRoot, relativePath) {
  // lstat each component: existsSync follows links and misses dangling ones.
  // In particular, a customer-owned `.github` must never redirect guidance writes.
  // relativePath is a repository-relative constant such as '.github/copilot-instructions.md',
  // not a native root. path.join handles an untouched Windows root such as 'C:\\Apps\\Demo'.
  const components = relativePath.split('/');
  for (let index = 0; index < components.length; index += 1) {
    const prefix = components.slice(0, index + 1).join('/');
    const stat = fs.lstatSync(path.join(projectRoot, prefix), { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Template preparation must not traverse a symlink: ${prefix}`);
    }
    const isParent = index < components.length - 1;
    if (isParent ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Template preparation target must be a ${isParent ? 'directory' : 'regular file'}: ${prefix}`);
    }
  }
}

function copyMissingGuidance(projectRoot, state) {
  const copied = [];
  const preserved = [];
  const skipped = [];
  for (const relativePath of GUIDANCE_FILES) {
    assertPreparationPath(projectRoot, relativePath);
    if (state.files.get(relativePath).exists) {
      preserved.push(relativePath);
      continue;
    }
    if (relativePath.includes('/')) {
      // Node exposes no cross-platform openat/no-follow copy primitive. Never write
      // through a replaceable nested parent after a path-only validation.
      skipped.push(relativePath);
      continue;
    }
    // Exclusive creation preserves even a customer file appearing after preflight.
    // Track successful copies, not planned targets, so rollback owns only our files.
    const sourcePath = path.join(__dirname, '..', 'template', relativePath);
    fs.copyFileSync(sourcePath, path.join(projectRoot, relativePath), fs.constants.COPYFILE_EXCL);
    state.createdGuidanceFiles.add(relativePath);
    state.createdGuidanceContents.set(relativePath, fs.readFileSync(sourcePath));
    copied.push(relativePath);
  }
  return { copied, preserved, skipped };
}

function verifyHostTsconfig(projectRoot) {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  const tsconfig = readJson(tsconfigPath);
  const inheritedConfigs = Array.isArray(tsconfig.extends)
    ? tsconfig.extends
    : [tsconfig.extends];
  if (!inheritedConfigs.includes(HOST_TSCONFIG)) {
    throw new Error(`tsconfig.json must extend ${HOST_TSCONFIG}`);
  }
}

function ensureNamedImports(source, moduleName, requiredNames) {
  const modulePattern = escapeRegExp(moduleName);
  const importPattern = new RegExp(
    `import\\s+(?!type\\b)(?:([A-Za-z_$][\\w$]*)\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${modulePattern}['"][ \\t]*;?`,
  );
  const match = source.match(importPattern);

  if (!match) {
    return `import { ${requiredNames.join(', ')} } from '${moduleName}';\n${source}`;
  }

  const existingNames = match[2]
    .split(',')
    .map((entry) => entry.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);
  const missingNames = requiredNames.filter((name) => !existingNames.includes(name));
  if (missingNames.length === 0) return source;

  const updatedNames = [...match[2].split(',').map((entry) => entry.trim()).filter(Boolean), ...missingNames];
  const defaultImport = match[1] ? `${match[1]}, ` : '';
  const replacement = `import ${defaultImport}{\n  ${updatedNames.join(',\n  ')},\n} from '${moduleName}';`;
  return source.replace(importPattern, replacement);
}

function defaultImportPattern(moduleName, localName) {
  const modulePattern = escapeRegExp(moduleName);
  return new RegExp(
    `import\\s+${escapeRegExp(localName)}\\s*(?:,\\s*(?:\\{[^}]*\\}|\\*\\s+as\\s+[A-Za-z_$][\\w$]*))?\\s+from\\s*['"]${modulePattern}['"][ \\t]*;?`,
  );
}

function ensureDefaultImport(source, moduleName, localName) {
  const importPattern = defaultImportPattern(moduleName, localName);
  if (importPattern.test(source)) return source;
  return `import ${localName} from '${moduleName}';\n${source}`;
}

function ensureColorSchemeHook(source) {
  if (/\b(?:const|let)\s+colorScheme\s*=\s*useColorScheme\s*\(\s*\)/.test(source)) {
    return source;
  }

  const rootPattern = /(export\s+default\s+function\s+RootLayout\s*\([^)]*\)\s*\{)/;
  if (!rootPattern.test(source)) {
    throw new Error('app/_layout.tsx must export a supported RootLayout function');
  }
  return source.replace(rootPattern, '$1\n  const colorScheme = useColorScheme();');
}

function findJsxOpeningTagEnd(source, startIndex) {
  let braceDepth = 0;
  let quote = null;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      let slashCount = 0;
      for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
        slashCount += 1;
      }
      if (character === quote && slashCount % 2 === 0) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth -= 1;
      if (braceDepth < 0) {
        throw new Error('PowerAppsProvider opening tag contains an unmatched closing brace');
      }
      continue;
    }
    if (character === '>' && braceDepth === 0) return index;
  }

  throw new Error('PowerAppsProvider opening tag is not terminated');
}

function readJsxAttributeValue(source, startIndex) {
  const opening = source[startIndex];
  if (opening === '\'' || opening === '"') {
    for (let index = startIndex + 1; index < source.length; index += 1) {
      let slashCount = 0;
      for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
        slashCount += 1;
      }
      if (source[index] === opening && slashCount % 2 === 0) return index + 1;
    }
    throw new Error('PowerAppsProvider opening tag contains an unterminated quoted prop');
  }
  if (opening === '{') {
    let depth = 0;
    let quote = null;
    for (let index = startIndex; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
          slashCount += 1;
        }
        if (character === quote && slashCount % 2 === 0) quote = null;
        continue;
      }
      if (character === '\'' || character === '"' || character === '`') {
        quote = character;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    throw new Error('PowerAppsProvider opening tag contains an unterminated expression prop');
  }
  let index = startIndex;
  while (index < source.length && !/\s/.test(source[index])) index += 1;
  return index;
}

function getTopLevelJsxAttributes(providerProps) {
  const attributes = new Map();
  let index = 0;
  while (index < providerProps.length) {
    while (index < providerProps.length && /\s/.test(providerProps[index])) index += 1;
    if (index >= providerProps.length || providerProps[index] === '/') break;
    if (providerProps[index] === '{') {
      index = readJsxAttributeValue(providerProps, index);
      continue;
    }

    const nameMatch = providerProps.slice(index).match(/^([A-Za-z_$][\w$:.-]*)/);
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const name = nameMatch[1];
    index += name.length;
    while (index < providerProps.length && /\s/.test(providerProps[index])) index += 1;
    if (providerProps[index] !== '=') {
      attributes.set(name, true);
      continue;
    }
    index += 1;
    while (index < providerProps.length && /\s/.test(providerProps[index])) index += 1;
    const valueStart = index;
    index = readJsxAttributeValue(providerProps, valueStart);
    attributes.set(name, providerProps.slice(valueStart, index));
  }
  return attributes;
}

function ensureProviderProps(source) {
  const match = /<PowerAppsProvider\b/.exec(source);
  if (!match) {
    throw new Error('app/_layout.tsx does not contain a PowerAppsProvider opening tag');
  }
  const tagNameEnd = match.index + match[0].length;
  const tagEnd = findJsxOpeningTagEnd(source, tagNameEnd);
  const providerProps = source.slice(tagNameEnd, tagEnd);
  const providerAttributes = getTopLevelJsxAttributes(providerProps);

  const requiredProps = [
    ['tamaguiConfig', 'tamaguiConfig={tamaguiConfig}'],
    ['defaultTheme', "defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}"],
  ];
  const additions = requiredProps
    .filter(([name]) => !providerAttributes.has(name))
    .map(([, text]) => text);
  if (additions.length === 0) return source;

  const indentMatch = source.slice(0, match.index).match(/(^|\n)([ \t]*)[^\n]*$/);
  const propIndent = `${indentMatch ? indentMatch[2] : ''}  `;
  const existingProps = providerProps.trimEnd();
  const replacement = `<PowerAppsProvider${existingProps}${existingProps ? '\n' : ' '}${additions
    .map((prop) => `${propIndent}${prop}`)
    .join('\n')}\n${indentMatch ? indentMatch[2] : ''}>`;
  return `${source.slice(0, match.index)}${replacement}${source.slice(tagEnd + 1)}`;
}

function isWrappedBySafeAreaProvider(source, powerOpenIndex, powerCloseEnd) {
  const safeOpenIndex = source.lastIndexOf('<SafeAreaProvider', powerOpenIndex);
  if (safeOpenIndex < 0) return false;
  const prematureClose = source.indexOf('</SafeAreaProvider>', safeOpenIndex);
  return prematureClose >= powerCloseEnd;
}

function ensureSafeAreaProviderWrapper(source) {
  const powerOpenIndex = source.indexOf('<PowerAppsProvider');
  const powerClose = '</PowerAppsProvider>';
  const powerCloseIndex = source.indexOf(powerClose, powerOpenIndex);
  if (powerOpenIndex < 0 || powerCloseIndex < 0) {
    throw new Error('app/_layout.tsx must contain a non-self-closing PowerAppsProvider');
  }
  const powerCloseEnd = powerCloseIndex + powerClose.length;
  if (isWrappedBySafeAreaProvider(source, powerOpenIndex, powerCloseEnd)) return source;

  const lineStart = source.lastIndexOf('\n', powerOpenIndex) + 1;
  const indent = source.slice(lineStart, powerOpenIndex);
  if (!/^[ \t]*$/.test(indent)) {
    throw new Error('Could not determine PowerAppsProvider indentation in app/_layout.tsx');
  }

  const providerBlock = source.slice(powerOpenIndex, powerCloseEnd);
  // Keep the provider block byte-for-byte intact. Reindenting its inner lines
  // could change values in multiline template-literal props.
  const nestedBlock = `${indent}${providerBlock}`;
  const wrapped = `<SafeAreaProvider>\n${nestedBlock}\n${indent}</SafeAreaProvider>`;
  return `${source.slice(0, powerOpenIndex)}${wrapped}${source.slice(powerCloseEnd)}`;
}

function verifyRootLayout(source) {
  const requiredChecks = [
    ['SafeAreaProvider import', /import\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^}]*\bSafeAreaProvider\b[^}]*\}\s*from\s*['"]react-native-safe-area-context['"]/],
    ['useColorScheme import', /import\s+(?!type\b)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^}]*\buseColorScheme\b[^}]*\}\s*from\s*['"]react-native['"]/],
    ['colorScheme binding', /\b(?:const|let)\s+colorScheme\s*=\s*useColorScheme\s*\(\s*\)/],
    ['Tamagui config import', defaultImportPattern('../tamagui.config', 'tamaguiConfig')],
  ];

  const missing = requiredChecks
    .filter(([, pattern]) => !pattern.test(source))
    .map(([label]) => label);
  const providerMatch = /<PowerAppsProvider\b/.exec(source);
  if (!providerMatch) {
    missing.push('PowerAppsProvider opening tag');
  } else {
    const tagNameEnd = providerMatch.index + providerMatch[0].length;
    const tagEnd = findJsxOpeningTagEnd(source, tagNameEnd);
    const attributes = getTopLevelJsxAttributes(source.slice(tagNameEnd, tagEnd));
    const providerChecks = [
      ['Tamagui config provider prop', attributes.get('tamaguiConfig') === '{tamaguiConfig}'],
      ['default theme provider prop', attributes.has('defaultTheme')],
    ];
    missing.push(...providerChecks.filter(([, valid]) => !valid).map(([label]) => label));
  }
  if (missing.length > 0) {
    throw new Error(`Root layout preparation failed postconditions: ${missing.join(', ')}`);
  }

  const powerOpenIndex = source.indexOf('<PowerAppsProvider');
  const powerCloseEnd = source.indexOf('</PowerAppsProvider>', powerOpenIndex)
    + '</PowerAppsProvider>'.length;
  if (!isWrappedBySafeAreaProvider(source, powerOpenIndex, powerCloseEnd)) {
    throw new Error('Root layout preparation did not wrap PowerAppsProvider with SafeAreaProvider');
  }

  if (/<SafeAreaView\b[\s\S]*<Slot\s*\/>/.test(source)) {
    throw new Error('Root layout must not wrap Slot with SafeAreaView; rendered routes own content edges');
  }
}

function prepareRootLayout(projectRoot) {
  const layoutPath = path.join(projectRoot, 'app', '_layout.tsx');
  let source = fs.readFileSync(layoutPath, 'utf8');

  source = ensureNamedImports(source, 'react-native', ['useColorScheme']);
  source = ensureNamedImports(source, 'react-native-safe-area-context', ['SafeAreaProvider']);
  source = ensureNamedImports(source, '@microsoft/power-apps-native-host', ['PowerAppsProvider']);
  source = ensureDefaultImport(source, '../tamagui.config', 'tamaguiConfig');
  source = ensureColorSchemeHook(source);
  source = ensureProviderProps(source);
  source = ensureSafeAreaProviderWrapper(source);
  verifyRootLayout(source);

  fs.writeFileSync(layoutPath, source);
}

function assertNoDanglingLegacyImports(projectRoot) {
  const roots = ['app', 'src'];
  const needles = [
    'useContacts',
    'useAccounts',
    'useUserProfile',
    'from "../generated/services',
    "from '../generated/services",
    'from "../generated/models',
    "from '../generated/models",
  ];
  const findings = [];

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'generated') continue;
        visit(absolutePath);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const source = fs.readFileSync(absolutePath, 'utf8');
        if (needles.some((needle) => source.includes(needle))) {
          findings.push(path.relative(projectRoot, absolutePath));
        }
      }
    }
  }

  roots.forEach((relativePath) => visit(path.join(projectRoot, relativePath)));
  if (findings.length > 0) {
    throw new Error(`Legacy example imports remain in: ${findings.join(', ')}`);
  }
}

function capturePreparationState(projectRoot) {
  if (fs.lstatSync(projectRoot).isSymbolicLink()) {
    throw new Error('Template preparation must not traverse a symlink: project root');
  }
  const relativeFiles = [
    'app.config.js',
    'package.json',
    'power.config.json',
    'app/_layout.tsx',
    ...GUIDANCE_FILES,
    ...LEGACY_EXAMPLE_FILES,
    ...SHARED_FILES.map(([, destinationRelativePath]) => destinationRelativePath),
    ...DATA_LAYER_FILES.map(([, destinationRelativePath]) => destinationRelativePath),
  ];
  const files = new Map();

  for (const relativePath of new Set(relativeFiles)) {
    assertPreparationPath(projectRoot, relativePath);
    const filePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      files.set(relativePath, { exists: false });
      continue;
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Template preparation target must be a regular file: ${relativePath}`);
    }
    files.set(relativePath, {
      exists: true,
      content: fs.readFileSync(filePath),
      mode: stat.mode,
    });
  }

  const directories = ['components', 'hooks', 'utils', 'tokens', 'native']
    .map((directory) => path.join('src', directory))
    .map((relativePath) => ({
      relativePath,
      existed: fs.existsSync(path.join(projectRoot, relativePath)),
    }));

  return {
    directories,
    files,
    createdGuidanceFiles: new Set(),
    createdGuidanceContents: new Map(),
  };
}

function restorePreparationState(projectRoot, state) {
  const rollbackConflicts = [];
  for (const [relativePath, snapshot] of state.files) {
    if (GUIDANCE_FILES.includes(relativePath) && !state.createdGuidanceFiles.has(relativePath)) {
      continue;
    }
    assertPreparationPath(projectRoot, relativePath);
    const filePath = path.join(projectRoot, relativePath);
    if (snapshot.exists) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, snapshot.content);
      fs.chmodSync(filePath, snapshot.mode);
    } else if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (GUIDANCE_FILES.includes(relativePath) && state.createdGuidanceFiles.has(relativePath)) {
        const expectedContent = state.createdGuidanceContents.get(relativePath);
        if (!stat.isFile() || !expectedContent || !fs.readFileSync(filePath).equals(expectedContent)) {
          rollbackConflicts.push(relativePath);
          continue;
        }
      }
      if (!stat.isFile()) {
        throw new Error(`Cannot roll back non-file preparation target: ${relativePath}`);
      }
      fs.unlinkSync(filePath);
    }
  }

  for (const directory of [...state.directories].reverse()) {
    if (directory.existed) continue;
    const directoryPath = path.join(projectRoot, directory.relativePath);
    if (fs.existsSync(directoryPath) && fs.readdirSync(directoryPath).length === 0) {
      fs.rmdirSync(directoryPath);
    }
  }
  if (rollbackConflicts.length > 0) {
    throw new Error(`customer-modified guidance preserved: ${rollbackConflicts.join(', ')}`);
  }
}

function prepareMobileTemplate(options) {
  const projectRoot = path.resolve(options.workingDir);
  const samplesRoot = path.resolve(
    options.samplesRoot || path.join(__dirname, '..', 'shared', 'samples', 'src'),
  );
  if (!options.displayName || !options.slug) {
    throw new Error('displayName and slug are required');
  }

  assertFreshTemplate(projectRoot);
  const originalState = capturePreparationState(projectRoot);
  let removedPowerConfig;
  let removedLegacyFiles;
  let sharedFiles;
  let webPreviewOutput;
  let guidanceFiles;
  let writtenFiles;
  try {
    updateIdentity(projectRoot, options.displayName, options.slug);
    // The data-model-first order never starts the sample-data web preview, so its app.config.js
    // stays exactly as the template ships it.
    webPreviewOutput = options.screensFirst ? ensureWebPreviewOutput(projectRoot) : 'not-requested';
    removedPowerConfig = removeEmptyPowerConfig(projectRoot);
    removedLegacyFiles = removeLegacyExamples(projectRoot);
    sharedFiles = copySharedFiles(
      projectRoot,
      samplesRoot,
      options.screensFirst ? [...SHARED_FILES, ...DATA_LAYER_FILES] : SHARED_FILES,
    );
    guidanceFiles = copyMissingGuidance(projectRoot, originalState);
    prepareRootLayout(projectRoot);
    assertNoDanglingLegacyImports(projectRoot);
    writtenFiles = [...originalState.files]
      .filter(([relativePath, snapshot]) => {
        if (GUIDANCE_FILES.includes(relativePath)) {
          return originalState.createdGuidanceFiles.has(relativePath);
        }
        const filePath = path.join(projectRoot, relativePath);
        if (!fs.existsSync(filePath)) return false;
        return !snapshot.exists || !fs.readFileSync(filePath).equals(snapshot.content);
      })
      .map(([relativePath]) => relativePath)
      .sort();
  } catch (error) {
    try {
      restorePreparationState(projectRoot, originalState);
    } catch (rollbackError) {
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
    }
    throw error;
  }

  return {
    projectRoot,
    writtenFiles,
    removedPowerConfig,
    removedLegacyFiles,
    copiedSharedFiles: sharedFiles.copied,
    preservedSharedFiles: sharedFiles.preserved,
    webPreviewOutput,
    copiedGuidanceFiles: guidanceFiles.copied,
    preservedGuidanceFiles: guidanceFiles.preserved,
    skippedGuidanceFiles: guidanceFiles.skipped,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--working-dir') options.workingDir = argv[++index];
    else if (argument === '--display-name') options.displayName = argv[++index];
    else if (argument === '--slug') options.slug = argv[++index];
    else if (argument === '--samples-root') options.samplesRoot = argv[++index];
    else if (argument === '--screens-first') options.screensFirst = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.workingDir) throw new Error('--working-dir is required');
  return options;
}

if (require.main === module) {
  const result = prepareMobileTemplate(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  DATA_LAYER_FILES,
  HOST_TSCONFIG,
  SHARED_FILES,
  assertFreshTemplate,
  copySharedFiles,
  WEB_PREVIEW_ENV,
  ensureProviderProps,
  ensureWebPreviewOutput,
  ensureSafeAreaProviderWrapper,
  parseArgs,
  prepareMobileTemplate,
  prepareRootLayout,
  removeEmptyPowerConfig,
  restorePreparationState,
  updateIdentity,
  verifyHostTsconfig,
  verifyRootLayout,
};
