#!/usr/bin/env node
'use strict';

/**
 * Deterministically prepares a fresh expo-app-standalone template for either
 * the real or mock-backed mobile creation flow.
 *
 * Usage:
 *   node prepare-mobile-template.js --project-root <dir> --display-name <name>
 *     --slug <slug> --mode <real|prototype>
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  hashFiles,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} = require('./lib/workflow-artifacts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const NAV_START = '  // MOBILE NAVIGATION START - managed by build-screen-artifacts.js\n';
const NAV_END = '  // MOBILE NAVIGATION END - managed by build-screen-artifacts.js\n';

function fail(message) {
  console.error(`prepare-mobile-template: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function ensureImport(source, importLine, anchor) {
  if (source.includes(importLine)) return source;
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0) fail(`root layout import anchor missing: ${anchor}`);
  const lineEnd = source.indexOf('\n', anchorIndex);
  return `${source.slice(0, lineEnd + 1)}${importLine}\n${source.slice(lineEnd + 1)}`;
}

function patchRootLayout(filePath) {
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  source = ensureImport(
    source,
    "import { useColorScheme } from 'react-native';",
    "from 'expo-status-bar';",
  );
  source = ensureImport(
    source,
    "import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';",
    "from 'react-native';",
  );
  source = source.replace(
    /import \{ PowerAppsProvider \} from '@microsoft\/power-apps-native-host';/,
    "import { PowerAppsProvider, lightTheme, darkTheme } from '@microsoft/power-apps-native-host';",
  );
  if (!source.includes('lightTheme') || !source.includes('darkTheme')) {
    fail('root layout PowerAppsProvider import has an unsupported shape');
  }
  if (!source.includes('const colorScheme = useColorScheme();')) {
    source = source.replace(
      /export default function RootLayout\(\) \{\n/,
      'export default function RootLayout() {\n  const colorScheme = useColorScheme();\n',
    );
  }
  if (!source.includes('defaultTheme={colorScheme')) {
    source = source.replace(
      /([ \t]+tamaguiConfig=\{tamaguiConfig\}\n)/,
      '$1        defaultTheme={colorScheme === \'dark\' ? \'dark\' : \'light\'}\n        theme={lightTheme}\n        darkTheme={darkTheme}\n',
    );
  }
  if (!source.includes('<SafeAreaProvider>')) {
    source = source.replace(/([ \t]*)<PowerAppsProvider/, '$1<SafeAreaProvider>\n$1  <PowerAppsProvider');
    source = source.replace(/([ \t]*)<\/PowerAppsProvider>/, '$1</PowerAppsProvider>\n$1</SafeAreaProvider>');
  }
  if (!source.includes('<SafeAreaView')) {
    source = source.replace(
      /([ \t]*)<Slot \/>/,
      "$1<SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>\n$1  <Slot />\n$1</SafeAreaView>",
    );
  }
  if (!source.includes('// @ts-ignore - power.config.json')) {
    fail('root layout lost the power.config.json @ts-ignore boundary');
  }
  writeTextAtomic(filePath, source);
}

function addNavigationMarkers(filePath) {
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  if (source.includes(NAV_START.trim())) return;
  const match = source.match(/\n  return \(\n[\s\S]*?\n  \);\n(?=\})/);
  if (!match) fail('protected layout navigation return block has an unsupported shape');
  source = source.replace(match[0], `\n${NAV_START}${match[0].slice(1)}${NAV_END}`);
  writeTextAtomic(filePath, source);
}

function mergeAliases(filePath) {
  const config = readJson(filePath, 'tsconfig.json');
  config.compilerOptions = config.compilerOptions || {};
  config.compilerOptions.baseUrl = config.compilerOptions.baseUrl || '.';
  config.compilerOptions.paths = config.compilerOptions.paths || {};
  const aliases = {
    '@/components': ['src/components'],
    '@/hooks': ['src/hooks'],
    '@/utils': ['src/utils'],
    '@/tokens': ['src/tokens'],
    '@/generated': ['src/generated'],
    '@/native': ['src/native'],
  };
  Object.assign(config.compilerOptions.paths, aliases);
  writeJsonAtomic(filePath, config);
  return aliases;
}

function copySamples(projectRoot) {
  const sampleRoot = path.join(PLUGIN_ROOT, 'shared', 'samples', 'src');
  const copied = [];
  const managed = [];
  if (!fs.existsSync(sampleRoot)) fail(`shared samples missing: ${sampleRoot}`);

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(sampleRoot, sourcePath);
      if (!/^(?:components|hooks|utils|tokens)[/\\]/.test(relativePath)) continue;
      const targetPath = path.join(projectRoot, 'src', relativePath);
      managed.push(path.relative(projectRoot, targetPath).split(path.sep).join('/'));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
        copied.push(path.relative(projectRoot, targetPath).split(path.sep).join('/'));
      }
    }
  }

  visit(sampleRoot);
  return { copied: copied.sort(), managed: managed.sort() };
}

function cleanLegacyGenerated(projectRoot) {
  const removed = [];
  const targets = [
    'src/generated/models',
    'src/generated/services',
    'src/generated/index.ts',
    'src/hooks/useContacts.ts',
    'src/hooks/useAccounts.ts',
    'src/hooks/useUserProfile.ts',
    'src/queryClient.ts',
  ];
  for (const relativePath of targets) {
    const targetPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(targetPath)) continue;
    fs.rmSync(targetPath, { recursive: true, force: true });
    removed.push(relativePath);
  }
  const generatedIndex = path.join(projectRoot, 'src', 'generated', 'index.ts');
  writeTextAtomic(
    generatedIndex,
    '// Populated by generated data-source tooling. Do not edit.\nexport {};\n',
  );
  return removed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['project-root'] || !args['display-name'] || !args.slug || !args.mode) {
    fail('usage: --project-root <dir> --display-name <name> --slug <slug> --mode <real|prototype>');
  }
  if (!['real', 'prototype'].includes(args.mode)) fail('--mode must be real or prototype');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug)) fail('--slug must be lowercase kebab-case');

  const projectRoot = path.resolve(args['project-root']);
  const required = ['package.json', 'app.config.js', 'auth.config.json', 'tamagui.config.ts', 'tsconfig.json', 'app/_layout.tsx', 'app/(app)/_layout.tsx'];
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(projectRoot, relativePath))) fail(`fresh template file missing: ${relativePath}`);
  }
  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'expo'))) {
    fail('dependencies are not installed: node_modules/expo is missing');
  }
  const generatedServicesRoot = path.join(projectRoot, 'src', 'generated', 'services');
  const generatedServices = fs.existsSync(generatedServicesRoot)
    ? fs.readdirSync(generatedServicesRoot).filter((name) => name.endsWith('.ts'))
    : [];
  if (
    generatedServices.length > 0
    || fs.existsSync(path.join(projectRoot, '.datamodel-manifest.json'))
    || fs.existsSync(path.join(projectRoot, 'src', 'generated', '.prototype-manifest.json'))
  ) {
    fail('project already contains generated data services; template preparation is fresh-create only');
  }

  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = readJson(packagePath, 'package.json');
  packageJson.name = args.slug;
  writeJsonAtomic(packagePath, packageJson);

  const appConfigPath = path.join(projectRoot, 'app.config.js');
  let appConfig = fs.readFileSync(appConfigPath, 'utf8');
  const namePattern = /const APP_NAME = process\.env\.APP_DISPLAY_NAME \|\| ['"][^'"]*['"];/;
  const slugPattern = /const APP_SLUG = process\.env\.APP_SLUG \|\| ['"][^'"]*['"];/;
  if (!namePattern.test(appConfig) || !slugPattern.test(appConfig)) {
    fail('app.config.js customer identity anchors are missing');
  }
  appConfig = appConfig
    .replace(namePattern, `const APP_NAME = process.env.APP_DISPLAY_NAME || ${JSON.stringify(args['display-name'])};`)
    .replace(slugPattern, `const APP_SLUG = process.env.APP_SLUG || ${JSON.stringify(args.slug)};`);
  writeTextAtomic(appConfigPath, appConfig);

  const removed = cleanLegacyGenerated(projectRoot);
  const sampleResult = copySamples(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src', 'native'), { recursive: true });
  const aliases = mergeAliases(path.join(projectRoot, 'tsconfig.json'));
  patchRootLayout(path.join(projectRoot, 'app', '_layout.tsx'));
  addNavigationMarkers(path.join(projectRoot, 'app', '(app)', '_layout.tsx'));

  const powerConfigPath = path.join(projectRoot, 'power.config.json');
  if (fs.existsSync(powerConfigPath)) fs.rmSync(powerConfigPath, { force: true });

  const touched = [
    packagePath,
    appConfigPath,
    path.join(projectRoot, 'tsconfig.json'),
    path.join(projectRoot, 'app', '_layout.tsx'),
    path.join(projectRoot, 'app', '(app)', '_layout.tsx'),
    path.join(projectRoot, 'src', 'generated', 'index.ts'),
    ...sampleResult.managed.map((relativePath) => path.join(projectRoot, relativePath)),
  ];
  const snapshot = hashFiles(projectRoot, [...new Set(touched)]);
  const receiptPath = path.join(projectRoot, '.tmp', 'template-prep-receipt.json');
  writeJsonAtomic(receiptPath, {
    schemaVersion: 1,
    mode: args.mode,
    displayName: args['display-name'],
    slug: args.slug,
    aliases,
    copied: sampleResult.copied,
    removed,
    files: snapshot.files,
    totalChecksum: snapshot.sha256,
    preparedAt: new Date().toISOString(),
  });
  console.log(`prepare-mobile-template: prepared ${projectRoot} (${snapshot.files.length} files)`);
}

main();
