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

const REQUIRED_ALIASES = {
  '@/components': ['./src/components'],
  '@/components/*': ['./src/components/*'],
  '@/hooks': ['./src/hooks'],
  '@/hooks/*': ['./src/hooks/*'],
  '@/utils': ['./src/utils'],
  '@/utils/*': ['./src/utils/*'],
  '@/tokens': ['./src/tokens'],
  '@/tokens/*': ['./src/tokens/*'],
  '@/generated': ['./src/generated'],
  '@/generated/*': ['./src/generated/*'],
  '@/native': ['./src/native'],
  '@/native/*': ['./src/native/*'],
};

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
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
    .replace(namePattern, `$1${singleQuoted(displayName)};`)
    .replace(slugPattern, `$1${singleQuoted(slug)};`);
  fs.writeFileSync(appConfigPath, appConfig);

  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = readJson(packagePath);
  packageJson.name = slug;
  writeJson(packagePath, packageJson);
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

function copySharedFiles(projectRoot, samplesRoot) {
  for (const directory of ['components', 'hooks', 'utils', 'tokens', 'native']) {
    fs.mkdirSync(path.join(projectRoot, 'src', directory), { recursive: true });
  }

  const copied = [];
  const preserved = [];
  for (const [sampleRelativePath, destinationRelativePath] of SHARED_FILES) {
    const sourcePath = path.join(samplesRoot, sampleRelativePath);
    const destinationPath = path.join(projectRoot, destinationRelativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Shared template helper is missing: ${sourcePath}`);
    }
    if (fs.existsSync(destinationPath)) {
      preserved.push(destinationRelativePath);
      continue;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    copied.push(destinationRelativePath);
  }

  return { copied, preserved };
}

function mergeAliases(projectRoot) {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  const tsconfig = readJson(tsconfigPath);
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  tsconfig.compilerOptions.paths = tsconfig.compilerOptions.paths || {};
  delete tsconfig.compilerOptions.baseUrl;

  for (const [alias, targets] of Object.entries(tsconfig.compilerOptions.paths)) {
    if (!Array.isArray(targets)) {
      throw new Error(`tsconfig path alias ${alias} must contain an array of targets`);
    }
    tsconfig.compilerOptions.paths[alias] = targets.map((target) => {
      if (typeof target !== 'string' || !target) {
        throw new Error(`tsconfig path alias ${alias} contains an invalid target`);
      }
      return target.startsWith('.') || path.isAbsolute(target) ? target : `./${target}`;
    });
  }

  for (const [alias, targets] of Object.entries(REQUIRED_ALIASES)) {
    tsconfig.compilerOptions.paths[alias] = targets;
  }

  writeJson(tsconfigPath, tsconfig);
}

function ensureNamedImports(source, moduleName, requiredNames) {
  const modulePattern = escapeRegExp(moduleName);
  const importPattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${modulePattern}['"]\\s*;?`,
    'g',
  );
  const localNames = new Set();
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    for (const entry of match[1].split(',')) {
      const parts = entry.trim().split(/\s+as\s+/);
      const localName = parts[1] || parts[0];
      if (localName) localNames.add(localName);
    }
  }

  const missingNames = requiredNames.filter((name) => !localNames.has(name));
  if (missingNames.length === 0) return source;

  // Keep existing imports byte-for-byte intact. A separate exact-local import
  // also handles aliases such as `lightTheme as hostLightTheme` without
  // injecting a duplicate exported name into the same declaration.
  return `import { ${missingNames.join(', ')} } from '${moduleName}';\n${source}`;
}

function ensureDefaultImport(source, moduleName, localName) {
  const modulePattern = escapeRegExp(moduleName);
  const importPattern = new RegExp(
    `import\\s+${escapeRegExp(localName)}\\s+from\\s*['"]${modulePattern}['"]\\s*;?`,
  );
  if (importPattern.test(source)) return source;
  return `import ${localName} from '${moduleName}';\n${source}`;
}

function ensureColorSchemeHook(source) {
  if (/\b(?:const|let|var)\s+colorScheme\b/.test(source)) return source;

  const rootPattern = /(export\s+default\s+function\s+RootLayout\s*\([^)]*\)\s*\{)/;
  if (!rootPattern.test(source)) {
    throw new Error('app/_layout.tsx must export a supported RootLayout function');
  }
  return source.replace(rootPattern, '$1\n  const colorScheme = useColorScheme();');
}

function ensureProviderProps(source) {
  const providerPattern = /<PowerAppsProvider\b([\s\S]*?)>/;
  const match = source.match(providerPattern);
  if (!match) {
    throw new Error('app/_layout.tsx does not contain a PowerAppsProvider opening tag');
  }

  const requiredProps = [
    ['tamaguiConfig', 'tamaguiConfig={tamaguiConfig}'],
    ['defaultTheme', "defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}"],
    ['theme', 'theme={lightTheme}'],
    ['darkTheme', 'darkTheme={darkTheme}'],
  ];
  const additions = requiredProps
    .filter(([name]) => !new RegExp(`\\b${name}\\s*=`).test(match[1]))
    .map(([, text]) => text);
  if (additions.length === 0) return source;

  const indentMatch = source.slice(0, match.index).match(/(^|\n)([ \t]*)[^\n]*$/);
  const propIndent = `${indentMatch ? indentMatch[2] : ''}  `;
  const existingProps = match[1].trimEnd();
  const replacement = `<PowerAppsProvider${existingProps}${existingProps ? '\n' : ' '}${additions
    .map((prop) => `${propIndent}${prop}`)
    .join('\n')}\n${indentMatch ? indentMatch[2] : ''}>`;
  return source.replace(providerPattern, replacement);
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
    ['SafeAreaProvider import', /import\s*\{[^}]*\bSafeAreaProvider\b[^}]*\}\s*from\s*['"]react-native-safe-area-context['"]/],
    ['useColorScheme import', /import\s*\{[^}]*\buseColorScheme\b[^}]*\}\s*from\s*['"]react-native['"]/],
    ['colorScheme binding', /\b(?:const|let|var)\s+colorScheme\b/],
    ['host light theme', /import\s*\{[^}]*\blightTheme\b[^}]*\}\s*from\s*['"]@microsoft\/power-apps-native-host['"]/],
    ['host dark theme', /import\s*\{[^}]*\bdarkTheme\b[^}]*\}\s*from\s*['"]@microsoft\/power-apps-native-host['"]/],
    ['Tamagui config import', /tamaguiConfig\s+from\s*['"]\.\.\/tamagui\.config['"]/],
    ['Tamagui config provider prop', /\btamaguiConfig\s*=\s*\{tamaguiConfig\}/],
    ['default theme provider prop', /\bdefaultTheme\s*=/],
    ['light theme provider prop', /\btheme\s*=\s*\{lightTheme\}/],
    ['dark theme provider prop', /\bdarkTheme\s*=\s*\{darkTheme\}/],
  ];

  const missing = requiredChecks
    .filter(([, pattern]) => !pattern.test(source))
    .map(([label]) => label);
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
  source = ensureNamedImports(source, '@microsoft/power-apps-native-host', [
    'PowerAppsProvider',
    'lightTheme',
    'darkTheme',
  ]);
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
  const relativeFiles = [
    'app.config.js',
    'package.json',
    'power.config.json',
    'tsconfig.json',
    'app/_layout.tsx',
    ...LEGACY_EXAMPLE_FILES,
    ...SHARED_FILES.map(([, destinationRelativePath]) => destinationRelativePath),
  ];
  const files = new Map();

  for (const relativePath of new Set(relativeFiles)) {
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

  return { directories, files };
}

function restorePreparationState(projectRoot, state) {
  for (const [relativePath, snapshot] of state.files) {
    const filePath = path.join(projectRoot, relativePath);
    if (snapshot.exists) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, snapshot.content);
      fs.chmodSync(filePath, snapshot.mode);
    } else if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
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
  try {
    updateIdentity(projectRoot, options.displayName, options.slug);
    removedPowerConfig = removeEmptyPowerConfig(projectRoot);
    removedLegacyFiles = removeLegacyExamples(projectRoot);
    sharedFiles = copySharedFiles(projectRoot, samplesRoot);
    mergeAliases(projectRoot);
    prepareRootLayout(projectRoot);
    assertNoDanglingLegacyImports(projectRoot);
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
    removedPowerConfig,
    removedLegacyFiles,
    copiedSharedFiles: sharedFiles.copied,
    preservedSharedFiles: sharedFiles.preserved,
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
  REQUIRED_ALIASES,
  SHARED_FILES,
  assertFreshTemplate,
  copySharedFiles,
  ensureProviderProps,
  ensureSafeAreaProviderWrapper,
  mergeAliases,
  prepareMobileTemplate,
  prepareRootLayout,
  removeEmptyPowerConfig,
  restorePreparationState,
  updateIdentity,
  verifyRootLayout,
};
