#!/usr/bin/env node
'use strict';

/**
 * Toggle the reversible runtime shell used by local prototypes.
 *
 * Prototype mode bypasses only route-level authentication, supplies the two
 * generated modules Metro needs, masks the zero-GUID lifecycle placeholder
 * before it reaches PowerAppsProvider, and prevents `npm run dev` from invoking
 * real connector schema generation. PowerAppsProvider remains mounted so
 * Tamagui and the native host surface stay identical to a real app.
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
const rootLayoutPath = path.join(projectDir, 'app', '_layout.tsx');
const indexPath = path.join(projectDir, 'app', 'index.tsx');
const appLayoutPath = path.join(projectDir, 'app', '(app)', '_layout.tsx');
const modePath = path.join(projectDir, 'src', 'config', 'dataMode.ts');
const backupPath = path.join(projectDir, '.mobile-app', 'runtime-backup.json');
const powerConfigPath = path.join(projectDir, 'power.config.json');
const connectorSchemasPath = path.join(projectDir, 'src', 'generated', 'connectorSchemas.ts');

function fail(message) {
  console.error(`prototype-runtime: ${message}`);
  process.exit(1);
}

function normalizeLineEndings(contents) {
  return contents.replace(/\r\n?/g, '\n');
}

function readText(filePath) {
  try {
    return normalizeLineEndings(fs.readFileSync(filePath, 'utf8'));
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
  fs.writeFileSync(filePath, normalizeLineEndings(contents));
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
  contents = ensureImport(contents, "import { dataMode } from '../src/config/dataMode';", "from '../tamagui.config';");
  if (!contents.includes("const runtimePowerConfig = dataMode === 'prototype'")) {
    const anchor = 'export default function RootLayout()';
    if (!contents.includes(anchor)) fail('app/_layout.tsx RootLayout anchor not found');
    contents = contents.replace(
      anchor,
      "// Keep the zero-GUID file as a lifecycle marker, but do not let the host\n"
        + "// mistake a mock-only prototype for a Power Platform-bound app.\n"
        + "const runtimePowerConfig = dataMode === 'prototype'\n"
        + "  ? {\n"
        + "      ...powerConfig,\n"
        + "      appId: null,\n"
        + "      environmentId: '',\n"
        + "      connectionReferences: {},\n"
        + "      databaseReferences: {},\n"
        + "    }\n"
        + "  : powerConfig;\n\n"
        + anchor,
    );
  }
  if (contents.includes('powerConfig={powerConfig}')) {
    contents = contents.replace('powerConfig={powerConfig}', 'powerConfig={runtimePowerConfig}');
  }
  if (!contents.includes('powerConfig={runtimePowerConfig}')) {
    fail('app/_layout.tsx PowerAppsProvider powerConfig prop not found');
  }
  return contents;
}

function packageDisplayName(packageJson) {
  return String(packageJson.name || 'mobile-prototype')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

if (!fs.existsSync(packagePath)
  || !fs.existsSync(rootLayoutPath)
  || !fs.existsSync(indexPath)
  || !fs.existsSync(appLayoutPath)) {
  fail('project must contain package.json, app/_layout.tsx, app/index.tsx, and app/(app)/_layout.tsx');
}

const packageJson = readJson(packagePath);
const existingBackup = fs.existsSync(backupPath) ? readJson(backupPath) : null;

if (mode === 'prototype') {
  const entryRoute = entryRouteArg || '/(app)/home';
  if (!entryRoute.startsWith('/(app)/')) fail('prototype entry route must start with /(app)/');

  if (!existingBackup) {
    writeJson(backupPath, {
      schemaVersion: 1,
      originalPredev: Object.prototype.hasOwnProperty.call(packageJson.scripts || {}, 'predev')
        ? packageJson.scripts.predev
        : null,
    });
  }

  packageJson.scripts = packageJson.scripts || {};
  packageJson.scripts.predev = "node -e \"console.log('prototype mode: using local mock services')\"";
  writeJson(packagePath, packageJson);

  writeFile(modePath, `// Managed by /create-mobile-prototype and /prototype-to-real-app.\nexport const dataMode: 'prototype' | 'dataverse' = 'prototype';\nexport const prototypeEntryRoute = ${JSON.stringify(entryRoute)} as const;\n`);
  writeFile(rootLayoutPath, patchRootLayout(readText(rootLayoutPath)));
  writeFile(indexPath, patchIndex(readText(indexPath)));
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

if (!existingBackup) fail('.mobile-app/runtime-backup.json is missing; cannot restore package scripts safely');
packageJson.scripts = packageJson.scripts || {};
if (existingBackup.originalPredev === null) delete packageJson.scripts.predev;
else packageJson.scripts.predev = existingBackup.originalPredev;
writeJson(packagePath, packageJson);

const currentMode = fs.existsSync(modePath) ? readText(modePath) : '';
const routeMatch = currentMode.match(/prototypeEntryRoute\s*=\s*([^;]+);/);
const routeExpression = routeMatch ? routeMatch[1].trim() : "'/(app)/home' as const";
writeFile(modePath, `// Managed by /create-mobile-prototype and /prototype-to-real-app.\nexport const dataMode: 'prototype' | 'dataverse' = 'dataverse';\nexport const prototypeEntryRoute = ${routeExpression};\n`);
console.log('prototype-runtime: switched to dataverse mode; run npm run generate-schemas before type-checking');