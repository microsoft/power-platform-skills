#!/usr/bin/env node
'use strict';

/**
 * Validates the planner-owned structured screen contract and deterministically
 * writes navigation layouts, service inventory, and typed screen skeletons.
 *
 * Usage:
 *   node build-screen-artifacts.js <project-dir> <check|generate>
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  hashFile,
  hashFiles,
  readJson,
  requireString,
  sanitizeId,
  sha256,
  stableJson,
  writeJsonAtomic,
  writeTextAtomic,
} = require('./lib/workflow-artifacts');

const NAV_START = '// MOBILE NAVIGATION START - managed by build-screen-artifacts.js';
const NAV_END = '// MOBILE NAVIGATION END - managed by build-screen-artifacts.js';

function fail(message) {
  console.error(`build-screen-artifacts: ${message}`);
  process.exit(1);
}

function normalizeRoute(route) {
  const normalized = requireString(route, 'screen.route');
  if (!normalized.startsWith('/')) fail(`route must start with /: ${normalized}`);
  return normalized.replace(/\/$/, '') || '/';
}

function normalizeFile(file) {
  const normalized = requireString(file, 'screen.file').replace(/\\/g, '/');
  if (!/^app\/.*\.tsx$/.test(normalized) || normalized.includes('../')) {
    fail(`screen file must be a safe app/*.tsx path: ${normalized}`);
  }
  if (normalized.endsWith('/_layout.tsx')) fail(`screen file cannot be a layout: ${normalized}`);
  return normalized;
}

function fileToRoute(file) {
  const noExtension = file.replace(/^app\//, '').replace(/\.tsx$/, '');
  const segments = noExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .filter((segment, index, values) => !(segment === 'index' && index === values.length - 1));
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

function normalizeContract(projectRoot) {
  const contractPath = path.join(projectRoot, '.tmp', 'screen-contract.json');
  const contract = readJson(contractPath, '.tmp/screen-contract.json');
  if (contract.schemaVersion !== 1) fail('screen contract schemaVersion must be 1');
  const planPath = path.join(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) fail('native-app-plan.md is missing');
  const planHash = hashFile(planPath);
  if (contract.approvedPlanSha256 !== planHash) fail('screen contract approvedPlanSha256 is stale');
  if (!['stack', 'tabs', 'drawer'].includes(contract.navigation?.pattern)) {
    fail('navigation.pattern must be stack, tabs, or drawer');
  }
  if (!Array.isArray(contract.screens) || contract.screens.length === 0) {
    fail('screen contract must contain screens');
  }

  const ids = new Set();
  const routes = new Set();
  const files = new Set();
  const screens = contract.screens.map((input, index) => {
    if (!input || typeof input !== 'object') fail(`screens[${index}] must be an object`);
    const id = sanitizeId(input.id || input.name, `screens[${index}].id`);
    const name = requireString(input.name, `screens[${index}].name`);
    const route = normalizeRoute(input.route);
    const file = normalizeFile(input.file);
    if (ids.has(id) || routes.has(route) || files.has(file)) fail(`duplicate screen id, route, or file: ${id}`);
    ids.add(id); routes.add(route); files.add(file);
    if (fileToRoute(file) !== route.replace(/\/\(app\)/g, '')) {
      const routeWithoutGroups = route.replace(/\/\([^)]+\)/g, '');
      if (fileToRoute(file) !== routeWithoutGroups) {
        fail(`screen route/file mismatch for ${id}: ${route} vs ${file}`);
      }
    }
    const source = input.source || 'new';
    if (!['new', 'replace', 'keep'].includes(source)) fail(`invalid source for ${id}`);
    const presentation = input.presentation || 'default';
    if (!['default', 'modal', 'formSheet', 'tab-root'].includes(presentation)) {
      fail(`invalid presentation for ${id}`);
    }
    const services = Array.isArray(input.services) ? input.services.map(String).sort() : [];
    const nativeCapabilities = Array.isArray(input.nativeCapabilities)
      ? input.nativeCapabilities.map(String).sort()
      : [];
    const scaffold = input.scaffold && typeof input.scaffold === 'object'
      ? {
        componentName: requireString(input.scaffold.componentName, `${id}.scaffold.componentName`),
        imports: Array.isArray(input.scaffold.imports) ? input.scaffold.imports.map(String) : [],
        statements: Array.isArray(input.scaffold.statements) ? input.scaffold.statements.map(String) : [],
      }
      : null;
    if (source !== 'keep' && !scaffold) fail(`screen ${id} requires a scaffold contract`);
    if (scaffold && scaffold.imports.some((line) => !/^import\s/.test(line))) {
      fail(`screen ${id} scaffold imports must be complete import statements`);
    }
    return {
      id, name, route, file, source, presentation,
      archetype: String(input.archetype || 'custom'),
      services, nativeCapabilities, scaffold,
      title: String(input.title || name),
      icon: String(input.icon || 'apps-outline'),
    };
  });

  const roots = Array.isArray(contract.navigation.roots)
    ? contract.navigation.roots.map((value) => sanitizeId(value, 'navigation root'))
    : [];
  const hidden = Array.isArray(contract.navigation.hidden)
    ? contract.navigation.hidden.map((value) => sanitizeId(value, 'hidden navigation screen'))
    : [];
  for (const id of [...roots, ...hidden]) if (!ids.has(id)) fail(`navigation references unknown screen: ${id}`);
  if (contract.navigation.pattern !== 'stack' && (roots.length < 1 || roots.length > 5)) {
    fail('tabs/drawer navigation requires 1-5 visible roots');
  }

  return {
    schemaVersion: 1,
    approvedPlanSha256: planHash,
    navigation: { pattern: contract.navigation.pattern, roots, hidden },
    screens,
  };
}

function serviceInventory(projectRoot) {
  const serviceRoot = path.join(projectRoot, 'src', 'generated', 'services');
  const files = fs.existsSync(serviceRoot)
    ? fs.readdirSync(serviceRoot)
      .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
      .map((name) => path.join(serviceRoot, name))
      .sort()
    : [];
  const services = files.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const methods = [...content.matchAll(/(?:static\s+)?async\s+([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((match) => match[1]);
    const exports = [...content.matchAll(/export\s+(?:const|class|function|type|interface)\s+([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1]);
    return {
      name: path.basename(filePath, '.ts'),
      path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
      methods: [...new Set(methods)].sort(),
      exports: [...new Set(exports)].sort(),
      sha256: hashFile(filePath),
    };
  });
  return {
    schemaVersion: 1,
    services,
    inventorySha256: sha256(stableJson(services)),
  };
}

function directoryLayouts(contract) {
  const directories = new Map();
  for (const screen of contract.screens) {
    if (!screen.file.startsWith('app/(app)/')) continue;
    const relative = screen.file.slice('app/(app)/'.length).replace(/\.tsx$/, '');
    const segments = relative.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      const child = segments[depth];
      if (!directories.has(directory)) directories.set(directory, new Map());
      const presentation = depth === segments.length - 1 ? screen.presentation : 'default';
      directories.get(directory).set(child, presentation);
    }
  }
  return directories;
}

function renderInnerLayout(directory, children) {
  const functionName = `${directory.split('/').map((segment) => segment.replace(/[^A-Za-z0-9]/g, '')).map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join('')}Layout`;
  const entries = [...children.entries()].sort(([left], [right]) => {
    if (left === 'index') return -1;
    if (right === 'index') return 1;
    return left.localeCompare(right);
  });
  const screens = entries.map(([name, presentation]) => {
    const options = presentation === 'modal' || presentation === 'formSheet'
      ? ` options={{ presentation: '${presentation}' }}`
      : '';
    return `      <Stack.Screen name="${name}"${options} />`;
  }).join('\n');
  return `import { Stack } from 'expo-router';\n\nexport default function ${functionName}() {\n  return (\n    <Stack screenOptions={{ headerShown: false }}>\n${screens}\n    </Stack>\n  );\n}\n`;
}

function outerEntryName(screen) {
  const relative = screen.file.slice('app/(app)/'.length).replace(/\.tsx$/, '');
  const first = relative.split('/')[0];
  return first === 'index' ? 'home' : first;
}

function patchProtectedLayout(projectRoot, contract) {
  const filePath = path.join(projectRoot, 'app', '(app)', '_layout.tsx');
  let source = fs.readFileSync(filePath, 'utf8');
  const startIndex = source.indexOf(NAV_START);
  const endIndex = source.indexOf(NAV_END);
  if (startIndex < 0 || endIndex < startIndex) fail('protected layout is missing managed navigation markers');

  const byId = new Map(contract.screens.map((screen) => [screen.id, screen]));
  let navigationReturn;
  if (contract.navigation.pattern === 'stack') {
    const registrations = contract.screens
      .filter((screen) => screen.file.startsWith('app/(app)/'))
      .map((screen) => `      <Stack.Screen name="${outerEntryName(screen)}" />`)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join('\n');
    navigationReturn = `  return (\n    <Stack screenOptions={{ headerShown: false }}>\n${registrations}\n    </Stack>\n  );\n`;
    source = source.replace(/import \{[^}]+\} from 'expo-router';/, "import { Redirect, Stack } from 'expo-router';");
  } else {
    const component = contract.navigation.pattern === 'tabs' ? 'Tabs' : 'Drawer';
    const moduleName = contract.navigation.pattern === 'tabs' ? 'expo-router' : 'expo-router/drawer';
    source = source.replace(/import \{[^}]+\} from 'expo-router';/, `import { Redirect } from 'expo-router';\nimport { ${component} } from '${moduleName}';`);
    if (!source.includes("from '@expo/vector-icons'")) {
      source = `import { Ionicons } from '@expo/vector-icons';\n${source}`;
    }
    const entries = contract.navigation.roots.map((id) => {
      const screen = byId.get(id);
      const name = outerEntryName(screen);
      const iconProp = contract.navigation.pattern === 'tabs' ? 'tabBarIcon' : 'drawerIcon';
      return `      <${component}.Screen\n        name="${name}"\n        options={{\n          title: ${JSON.stringify(screen.title)},\n          ${iconProp}: ({ color, size }) => <Ionicons name=${JSON.stringify(screen.icon)} color={color} size={size} />,\n        }}\n      />`;
    });
    for (const id of contract.navigation.hidden) {
      const screen = byId.get(id);
      entries.push(`      <${component}.Screen name="${outerEntryName(screen)}" options={{ href: null }} />`);
    }
    navigationReturn = `  return (\n    <${component} screenOptions={{ headerShown: false }}>\n${entries.join('\n')}\n    </${component}>\n  );\n`;
  }

  source = `${source.slice(0, startIndex + NAV_START.length)}\n${navigationReturn}${source.slice(endIndex)}`;
  writeTextAtomic(filePath, source);
  return filePath;
}

function renderSkeleton(screen) {
  const imports = [...new Set(screen.scaffold.imports)].join('\n');
  const statements = screen.scaffold.statements.length
    ? `${screen.scaffold.statements.map((line) => `  ${line}`).join('\n')}\n\n`
    : '';
  return `${imports}\n\nexport default function ${screen.scaffold.componentName}() {\n${statements}  // TODO: screen-builder fills the approved JSX layout.\n  return null;\n}\n`;
}

function generate(projectRoot, contract) {
  const written = [];
  for (const [directory, children] of directoryLayouts(contract)) {
    const layoutPath = path.join(projectRoot, 'app', '(app)', directory, '_layout.tsx');
    writeTextAtomic(layoutPath, renderInnerLayout(directory, children));
    written.push(layoutPath);
  }
  written.push(patchProtectedLayout(projectRoot, contract));

  for (const screen of contract.screens) {
    if (screen.source === 'keep') continue;
    const targetPath = path.join(projectRoot, screen.file);
    writeTextAtomic(targetPath, renderSkeleton(screen));
    written.push(targetPath);
  }
  return written;
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['check', 'generate'].includes(action)) {
    fail('usage: node build-screen-artifacts.js <project-dir> <check|generate>');
  }
  const projectRoot = path.resolve(projectArg);
  try {
    const contract = normalizeContract(projectRoot);
    const inventory = serviceInventory(projectRoot);
    const missingServices = [...new Set(contract.screens.flatMap((screen) => screen.services))]
      .filter((name) => !inventory.services.some((service) => service.name === name));
    if (action === 'generate' && missingServices.length) {
      fail(`screen contract references missing services: ${missingServices.join(', ')}`);
    }

    const contractPath = path.join(projectRoot, '.tmp', 'screen-contract.json');
    const contractSha256 = hashFile(contractPath);
    writeJsonAtomic(path.join(projectRoot, '.tmp', 'service-inventory.json'), inventory);
    const navigationContract = {
      schemaVersion: 1,
      approvedPlanSha256: contract.approvedPlanSha256,
      screenContractSha256: contractSha256,
      navigation: contract.navigation,
      routes: contract.screens.map(({ id, route, file, presentation }) => ({ id, route, file, presentation })),
    };
    navigationContract.contractSha256 = sha256(stableJson(navigationContract));
    writeJsonAtomic(path.join(projectRoot, '.tmp', 'navigation-contract.json'), navigationContract);

    if (action === 'check') {
      console.log(`build-screen-artifacts: valid (${contract.screens.length} screens, ${inventory.services.length} services)`);
      return;
    }
    const written = generate(projectRoot, contract);
    const hashes = hashFiles(projectRoot, written);
    writeJsonAtomic(path.join(projectRoot, '.tmp', 'screen-artifacts-receipt.json'), {
      schemaVersion: 1,
      approvedPlanSha256: contract.approvedPlanSha256,
      screenContractSha256: contractSha256,
      serviceInventorySha256: inventory.inventorySha256,
      navigationContractSha256: navigationContract.contractSha256,
      files: hashes.files,
      artifactsSha256: hashes.sha256,
      generatedAt: new Date().toISOString(),
    });
    console.log(`build-screen-artifacts: generated ${written.length} files`);
  } catch (error) {
    fail(error.message);
  }
}

main();
