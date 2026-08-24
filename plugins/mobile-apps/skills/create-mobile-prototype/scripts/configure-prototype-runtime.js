#!/usr/bin/env node
'use strict';

/**
 * Toggle the reversible runtime shell used by local prototypes.
 *
 * Prototype mode bypasses only route-level authentication, supplies the two
 * generated modules Metro needs, and prevents `npm run dev` from invoking real
 * connector schema generation. PowerAppsProvider remains mounted so Tamagui
 * and the native host surface stay identical to a real app.
 *
 * Usage:
 *   node configure-prototype-runtime.js <project-dir> prototype [entry-route]
 *   node configure-prototype-runtime.js <project-dir> dataverse
 */

const fs = require('node:fs');
const path = require('node:path');

const [, , projectArg, mode, entryRouteArg] = process.argv;
if (!projectArg || !['prototype', 'dataverse'].includes(mode)) {
  console.error('Usage: node configure-prototype-runtime.js <project-dir> <prototype|dataverse> [entry-route]');
  process.exit(1);
}

const projectDir = path.resolve(projectArg);
const packagePath = path.join(projectDir, 'package.json');
const indexPath = path.join(projectDir, 'app', 'index.tsx');
const rootLayoutPath = path.join(projectDir, 'app', '_layout.tsx');
const appLayoutPath = path.join(projectDir, 'app', '(app)', '_layout.tsx');
const prototypeProviderPath = path.join(projectDir, 'src', 'data', 'PrototypeDataProvider.tsx');
const modePath = path.join(projectDir, 'src', 'config', 'dataMode.ts');
const backupPath = path.join(projectDir, '.mobile-app', 'runtime-backup.json');
const powerConfigPath = path.join(projectDir, 'power.config.json');
const connectorSchemasPath = path.join(projectDir, 'src', 'generated', 'connectorSchemas.ts');

function fail(message) {
  console.error(`prototype-runtime: ${message}`);
  process.exit(1);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${path.relative(projectDir, filePath)}: ${error.message}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    fail(`${path.relative(projectDir, filePath)} is not valid JSON: ${error.message}`);
  }
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureImport(contents, importLine, anchor) {
  if (contents.includes(importLine)) return contents;
  const anchorIndex = contents.indexOf(anchor);
  if (anchorIndex < 0) fail(`cannot patch import; anchor not found: ${anchor}`);
  const lineEnd = contents.indexOf('\n', anchorIndex);
  return `${contents.slice(0, lineEnd + 1)}${importLine}\n${contents.slice(lineEnd + 1)}`;
}

function patchIndex(contents) {
  contents = ensureImport(contents, "import { dataMode, prototypeEntryRoute } from '../src/config/dataMode';", "from '@microsoft/power-apps-native-host';");
  if (contents.includes('if (dataMode === \'prototype\')')) return contents;
  const anchor = '  const { isLoading, isSignedIn } = useAuth();\n';
  if (!contents.includes(anchor)) fail('app/index.tsx auth-state anchor not found');
  return contents.replace(anchor, `${anchor}\n  if (dataMode === 'prototype') {\n    return <Redirect href={prototypeEntryRoute} />;\n  }\n`);
}

function patchAppLayout(contents) {
  contents = ensureImport(contents, "import { dataMode } from '../../src/config/dataMode';", "from '@microsoft/power-apps-native-host';");
  if (contents.includes("dataMode !== 'prototype' && !isLoading && !isSignedIn")) return contents;
  const guard = 'if (!isLoading && !isSignedIn) {';
  if (!contents.includes(guard)) fail('app/(app)/_layout.tsx auth guard not found');
  return contents.replace(guard, "if (dataMode !== 'prototype' && !isLoading && !isSignedIn) {");
}

function patchRootLayout(contents) {
  contents = ensureImport(contents, "import type { PropsWithChildren } from 'react';", "from '@microsoft/power-apps-native-host';");
  contents = ensureImport(contents, "import { PrototypeDataProvider } from '../src/data';", "from '@microsoft/power-apps-native-host';");
  contents = contents.replace(
    /function DataModeProvider\(\{ children \}: PropsWithChildren\) \{\n\s*return dataMode === 'prototype'\n\s*\? <PrototypeDataProvider>\{children\}<\/PrototypeDataProvider>\n\s*: <>\{children\}<\/>;\n\}/,
    "function DataModeProvider({ children }: PropsWithChildren) {\n  return <PrototypeDataProvider>{children}</PrototypeDataProvider>;\n}",
  );
  if (!contents.includes("dataMode === 'prototype'")) contents = contents.replace("import { dataMode } from '../src/config/dataMode';\n", '');
  if (!contents.includes('function DataModeProvider(')) {
    const anchor = 'export default function RootLayout() {';
    if (!contents.includes(anchor)) fail('app/_layout.tsx RootLayout anchor not found');
    contents = contents.replace(anchor, `function DataModeProvider({ children }: PropsWithChildren) {\n  return <PrototypeDataProvider>{children}</PrototypeDataProvider>;\n}\n\n${anchor}`);
  }
  if (/<DataModeProvider>/.test(contents)) return contents;
  const provider = contents.match(/(<PowerAppsProvider\b[\s\S]*?>)([\s\S]*?)(<\/PowerAppsProvider>)/);
  if (!provider) fail('app/_layout.tsx PowerAppsProvider boundary not found');
  return contents.replace(provider[0], `${provider[1]}\n      <DataModeProvider>${provider[2]}\n      </DataModeProvider>\n    ${provider[3]}`);
}

function packageDisplayName(packageJson) {
  return String(packageJson.name || 'mobile-prototype')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

if (!fs.existsSync(packagePath) || !fs.existsSync(indexPath) || !fs.existsSync(rootLayoutPath) || !fs.existsSync(appLayoutPath)) {
  fail('project must contain package.json, app/_layout.tsx, app/index.tsx, and app/(app)/_layout.tsx');
}

const packageJson = readJson(packagePath);
const existingBackup = fs.existsSync(backupPath) ? readJson(backupPath) : null;

if (mode === 'prototype') {
  const entryRoute = entryRouteArg || '/(app)/home';
  if (!entryRoute.startsWith('/(app)/')) fail('prototype entry route must start with /(app)/');
  if (!fs.existsSync(prototypeProviderPath)) fail('src/data/PrototypeDataProvider.tsx is missing; generate the neutral data layer before configuring prototype runtime');

  const currentMode = fs.existsSync(modePath) ? readText(modePath) : '';
  if (!existingBackup || /dataMode:\s*'prototype'\s*\|\s*'dataverse'\s*=\s*'dataverse'/.test(currentMode)) {
    writeJson(backupPath, {
      schemaVersion: 1,
      originalPredev: Object.prototype.hasOwnProperty.call(packageJson.scripts || {}, 'predev')
        ? packageJson.scripts.predev
        : null,
    });
  }

  packageJson.scripts = packageJson.scripts || {};
  packageJson.scripts.predev = "node -e \"console.log('prototype mode: using local domain repositories')\"";
  writeJson(packagePath, packageJson);

  writeFile(modePath, `// Managed by /create-mobile-prototype and /prototype-to-real-app.\nexport const dataMode: 'prototype' | 'dataverse' = 'prototype';\nexport const prototypeEntryRoute = ${JSON.stringify(entryRoute)} as const;\n`);
  writeFile(indexPath, patchIndex(readText(indexPath)));
  writeFile(rootLayoutPath, patchRootLayout(readText(rootLayoutPath)));
  writeFile(appLayoutPath, patchAppLayout(readText(appLayoutPath)));
  writeFile(connectorSchemasPath, "// Prototype-only schema map. Real schema generation overwrites this file during graduation.\nexport const schemaMap = {};\n");
  writeJson(powerConfigPath, {
    version: '1.0',
    appId: null,
    appDisplayName: packageDisplayName(packageJson),
    region: 'prod',
    environmentId: '00000000-0000-0000-0000-000000000000',
    description: 'Local mock-data prototype',
    buildPath: './dist',
    buildEntryPoint: 'index.html',
    localAppUrl: 'http://localhost:3000',
    logoPath: 'Default',
    connectionReferences: {},
    databaseReferences: {},
  });
  console.log(`prototype-runtime: enabled (entry ${entryRoute})`);
  process.exit(0);
}

if (existingBackup) {
  packageJson.scripts = packageJson.scripts || {};
  if (existingBackup.originalPredev === null) delete packageJson.scripts.predev;
  else packageJson.scripts.predev = existingBackup.originalPredev;
  writeJson(packagePath, packageJson);
}

const currentMode = fs.existsSync(modePath) ? readText(modePath) : '';
const routeMatch = currentMode.match(/prototypeEntryRoute\s*=\s*([^;]+);/);
const routeExpression = routeMatch ? routeMatch[1].trim() : "'/(app)/home' as const";
writeFile(modePath, `// Managed by /create-mobile-prototype and /prototype-to-real-app.\nexport const dataMode: 'prototype' | 'dataverse' = 'dataverse';\nexport const prototypeEntryRoute = ${routeExpression};\n`);
if (!fs.existsSync(prototypeProviderPath)) fail('src/data/PrototypeDataProvider.tsx is missing; generate the neutral data layer before configuring dataverse runtime');
writeFile(rootLayoutPath, patchRootLayout(readText(rootLayoutPath)));
console.log('prototype-runtime: switched to dataverse mode; run npm run generate-schemas before type-checking');