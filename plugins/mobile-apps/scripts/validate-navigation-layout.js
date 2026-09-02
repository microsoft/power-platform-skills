#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MANIFEST = '.tmp/navigation-manifest.json';

function finding(code, message, file = null) {
  return file ? { code, message, file } : { code, message };
}

function walkTsx(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTsx(target));
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(target);
  }
  return files.sort();
}

function fileToRoute(file, appRoot) {
  const relative = path.relative(appRoot, file).replace(/\\/g, '/');
  const withoutExtension = relative.replace(/\.tsx$/, '');
  if (/(^|\/)_layout$/.test(withoutExtension)) return null;
  const segments = withoutExtension
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

function routeEntryName(route) {
  return String(route || '').split('/').filter(Boolean)[0] || 'index';
}

function screenRegistrations(content, navigator) {
  // Expo layouts are JSX blocks such as `<Tabs.Screen name="home" options={{...}} />`.
  // Splitting on the controlled component token keeps nested icon JSX from prematurely
  // terminating a regex match at the icon's `/>`.
  return content.split(`<${navigator}.Screen`).slice(1).map((chunk) => {
    const name = chunk.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] || null;
    return {
      name,
      hidden: /\bhref\s*:\s*null\b/.test(chunk),
      source: chunk.split(`<${navigator}.Screen`)[0],
    };
  }).filter((entry) => entry.name);
}

function topLevelRouteEntries(appRoot) {
  if (!fs.existsSync(appRoot)) return [];
  return fs.readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '_layout.tsx'
      && !entry.name.startsWith('.')
      && (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.tsx'))))
    .map((entry) => entry.isDirectory() ? entry.name : entry.name.replace(/\.tsx$/, ''))
    .sort();
}

function validateNavigationLayout(projectRoot, manifest) {
  const root = path.resolve(projectRoot);
  const appRoot = path.join(root, 'app', '(app)');
  const errors = [];
  const outerLayout = path.join(appRoot, '_layout.tsx');
  if (!fs.existsSync(outerLayout)) {
    return {
      ok: false,
      errors: [finding('outer-layout-missing', 'app/(app)/_layout.tsx is missing', outerLayout)],
      summary: { routeCount: 0, visibleDestinationCount: 0 },
    };
  }

  const expectedNavigator = manifest.pattern === 'tabs-plus-stacks'
    ? 'Tabs'
    : manifest.pattern === 'drawer' ? 'Drawer' : 'Stack';
  const content = fs.readFileSync(outerLayout, 'utf8');
  if (!new RegExp(`<${expectedNavigator}\\b`).test(content)) {
    errors.push(finding(
      'navigation-pattern-mismatch',
      `outer layout must render ${expectedNavigator} for ${manifest.pattern}`,
      outerLayout,
    ));
  }

  const expectedDestinations = manifest.pattern === 'tabs-plus-stacks'
    ? manifest.visibleTabs
    : manifest.pattern === 'drawer' ? manifest.durableDestinations : [];
  const expectedByEntry = new Map(expectedDestinations.map(
    (destination) => [routeEntryName(destination.targetPath), destination],
  ));
  const registrations = screenRegistrations(content, expectedNavigator);
  const visibleRegistrations = registrations.filter((entry) => !entry.hidden);
  for (const [entryName, destination] of expectedByEntry) {
    const registration = visibleRegistrations.find((entry) => entry.name === entryName);
    if (!registration) {
      errors.push(finding(
        'missing-visible-destination',
        `${destination.label} must be registered as visible ${expectedNavigator}.Screen ${entryName}`,
        outerLayout,
      ));
      continue;
    }
    if (!registration.source.includes(destination.iconName)) {
      errors.push(finding(
        'navigation-icon-mismatch',
        `${destination.label} must use installed icon ${destination.iconName}`,
        outerLayout,
      ));
    }
  }
  for (const registration of visibleRegistrations) {
    if (expectedByEntry.has(registration.name)) continue;
    errors.push(finding(
      'phantom-visible-destination',
      `${registration.name} is visible in ${expectedNavigator} but absent from the manifest`,
      outerLayout,
    ));
  }

  if (manifest.pattern === 'tabs-plus-stacks') {
    const hiddenNames = new Set(registrations.filter((entry) => entry.hidden).map((entry) => entry.name));
    for (const entryName of topLevelRouteEntries(appRoot)) {
      if (expectedByEntry.has(entryName) || hiddenNames.has(entryName)) continue;
      errors.push(finding(
        'phantom-visible-destination',
        `${entryName} is a top-level Expo route and must be nested or registered with href: null`,
        outerLayout,
      ));
    }
  }

  const routeFiles = walkTsx(appRoot)
    .map((file) => ({ file, route: fileToRoute(file, appRoot) }))
    .filter((entry) => entry.route);
  const fileByRoute = new Map();
  for (const entry of routeFiles) {
    if (fileByRoute.has(entry.route)) {
      errors.push(finding(
        'duplicate-expo-route',
        `${entry.route} is implemented by both ${path.relative(root, fileByRoute.get(entry.route))} and ${path.relative(root, entry.file)}`,
      ));
    } else {
      fileByRoute.set(entry.route, entry.file);
    }
  }

  const plannedRoutes = new Set();
  for (const [screenId, screen] of Object.entries(manifest.screens || {})) {
    if (!screen.targetPath) continue;
    plannedRoutes.add(screen.targetPath);
    if (!fileByRoute.has(screen.targetPath)) {
      errors.push(finding(
        'planned-route-missing',
        `${screenId} expects Expo route ${screen.targetPath}`,
      ));
    }
    if (screen.parentTabId) {
      const parent = manifest.visibleTabs.find(
        (entry) => entry.destinationId === screen.parentTabId,
      );
      if (!parent || routeEntryName(parent.targetPath) !== routeEntryName(screen.targetPath)) {
        errors.push(finding(
          'parent-tab-route-mismatch',
          `${screenId} must live under its parent tab ${screen.parentTabId}`,
        ));
      }
      const stackLayout = path.join(appRoot, routeEntryName(screen.targetPath), '_layout.tsx');
      if (screenId !== screen.parentTabId
        && (!fs.existsSync(stackLayout) || !/<Stack\b/.test(fs.readFileSync(stackLayout, 'utf8')))) {
        errors.push(finding(
          'parent-stack-missing',
          `${screenId} requires a nested Stack under ${screen.parentTabId}`,
          stackLayout,
        ));
      }
    }
  }
  for (const entry of routeFiles) {
    if (plannedRoutes.has(entry.route)) continue;
    errors.push(finding(
      'unplanned-route',
      `${entry.route} exists in Expo Router but not in the navigation manifest`,
      entry.file,
    ));
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      routeCount: plannedRoutes.size,
      visibleDestinationCount: expectedDestinations.length,
      generatedRouteCount: routeFiles.length,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--manifest') args.manifest = argv[++index];
    else if (argv[index] === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const manifestPath = path.resolve(projectRoot, args.manifest || DEFAULT_MANIFEST);
    const result = validateNavigationLayout(
      projectRoot,
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    if (args.json || result.ok) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`validate-navigation-layout: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  fileToRoute,
  main,
  validateNavigationLayout,
};
