#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./lib/product-experience-contracts');

const DEFAULT_SCOPE = '.tmp/product-scope-contract.json';
const DEFAULT_OUTPUT = '.tmp/navigation-manifest.json';
const ICON_PACKAGE = '@expo/vector-icons';
const ICONS = {
  home: 'home-outline',
  work: 'clipboard-outline',
  profile: 'person-outline',
  settings: 'settings-outline',
  reports: 'bar-chart-outline',
  map: 'map-outline',
  messages: 'chatbubble-outline',
  apps: 'apps-outline',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function iconIntentFor(screen) {
  const text = normalizeText(`${screen.id} ${screen.title}`);
  if (/\b(home|dashboard|overview)\b/.test(text)) return 'home';
  if (/\b(inspect|audit|checklist|task|work|maintenance|repair)\b/.test(text)) return 'work';
  if (/\b(profile|account|me|user)\b/.test(text)) return 'profile';
  if (/\b(settings|config|preferences)\b/.test(text)) return 'settings';
  if (/\b(report|analytics|chart|stats|history)\b/.test(text)) return 'reports';
  if (/\b(map|location|sites|field)\b/.test(text)) return 'map';
  if (/\b(message|chat|inbox|notify)\b/.test(text)) return 'messages';
  return 'apps';
}

function assertIconPackage(packageJson) {
  const version = packageJson?.dependencies?.[ICON_PACKAGE]
    || packageJson?.devDependencies?.[ICON_PACKAGE];
  if (!version) {
    throw new Error(`Navigation requires installed package ${ICON_PACKAGE}`);
  }
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const id of items) {
    if (seen.has(id)) throw new Error(`${label} contains duplicate id ${id}`);
    seen.add(id);
  }
}

function normalizedRoutePath(value) {
  const route = String(value || '').trim();
  if (!route) return null;
  return route === '/' ? route : route.replace(/\/+$/, '');
}

function typedHideReason(screen) {
  if (!screen.hideTabs) return null;
  if (!screen.tabVisibilityReason) {
    throw new Error(`screen ${screen.id} hides tabs without tabVisibilityReason`);
  }
  if (screen.pattern === 'capture') return 'immersive-capture';
  if (screen.classification === 'bounded-flow-step') return 'bounded-flow';
  if (screen.classification === 'modal-or-immersive-utility') return 'immersive-utility';
  throw new Error(
    `screen ${screen.id} hides tabs without a supported typed navigation reason`,
  );
}

function destination(screen) {
  const iconIntent = iconIntentFor(screen);
  return {
    destinationId: screen.id,
    label: screen.title,
    iconIntent,
    iconName: ICONS[iconIntent],
    rootScreenId: screen.id,
    targetPath: screen.route,
  };
}

function buildNavigationManifest(scope, options = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('Product Scope must be an object');
  }
  const screens = Array.isArray(scope.screens) ? scope.screens : [];
  const navigation = scope.navigation;
  if (!navigation || typeof navigation !== 'object') {
    throw new Error('Product Scope navigation is required');
  }
  if (!['tabs-plus-stacks', 'stack-only', 'drawer'].includes(navigation.pattern)) {
    throw new Error(`Unsupported navigation pattern ${navigation.pattern || '(missing)'}`);
  }

  const screenIds = screens.map((screen) => screen.id);
  assertUniqueIds(screenIds, 'screens');
  const screenByRoute = new Map();
  for (const screen of screens) {
    const route = normalizedRoutePath(screen.route);
    if (!route) continue;
    if (screenByRoute.has(route)) {
      throw new Error(
        `screens ${screenByRoute.get(route)} and ${screen.id} claim the same route ${route}`,
      );
    }
    screenByRoute.set(route, screen.id);
  }
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const durableIds = navigation.durableDestinationIds || [];
  const visibleTabIds = navigation.visibleTabIds || [];
  assertUniqueIds(durableIds, 'durableDestinationIds');
  assertUniqueIds(visibleTabIds, 'visibleTabIds');
  if (visibleTabIds.length > 5) throw new Error('navigation may expose at most five visible tabs');
  for (const id of durableIds) {
    const screen = screenById.get(id);
    if (!screen || screen.classification !== 'durable-destination') {
      throw new Error(`durable destination ${id} must reference a durable screen`);
    }
  }
  for (const id of visibleTabIds) {
    if (!durableIds.includes(id)) throw new Error(`visible tab ${id} is not durable`);
  }
  if (navigation.pattern !== 'tabs-plus-stacks' && visibleTabIds.length > 0) {
    throw new Error(`${navigation.pattern} navigation cannot declare visible tabs`);
  }
  if (navigation.pattern === 'stack-only' && !navigation.returnHomeMechanism) {
    throw new Error('stack-only navigation requires returnHomeMechanism');
  }

  function rootDestinationId(screen) {
    const seen = new Set();
    let current = screen;
    while (current) {
      if (durableIds.includes(current.id)) return current.id;
      if (!current.parentScreenId) return null;
      if (seen.has(current.id)) throw new Error(`screen parent cycle includes ${current.id}`);
      seen.add(current.id);
      current = screenById.get(current.parentScreenId);
      if (!current) throw new Error(`screen ${screen.id} has unknown parent ${screen.parentScreenId}`);
    }
    return null;
  }

  const screenEntries = {};
  for (const screen of screens) {
    if (options.requireRoutes && !screen.route) {
      throw new Error(`screen ${screen.id} requires a canonical route`);
    }
    const rootId = rootDestinationId(screen);
    const hideTabsReason = typedHideReason(screen);
    const parentTabId = navigation.pattern === 'tabs-plus-stacks'
      && rootId
      && visibleTabIds.includes(rootId)
      ? rootId
      : null;
    const isRoot = durableIds.includes(screen.id);
    screenEntries[screen.id] = {
      parentTabId,
      tabVisible: navigation.pattern === 'tabs-plus-stacks'
        && Boolean(parentTabId)
        && !screen.hideTabs,
      headerMode: isRoot ? 'root' : 'back',
      backBehavior: isRoot
        ? navigation.pattern === 'stack-only' ? 'return-home' : 'none'
        : 'stack-pop',
      targetPath: normalizedRoutePath(screen.route),
      hideTabsReason,
    };
  }

  if (navigation.authenticated) {
    const profile = screenById.get(navigation.profileScreenId);
    if (!profile || navigation.profileAccess === 'not-applicable') {
      throw new Error('authenticated navigation requires a reachable Profile screen');
    }
    if (navigation.profileAccess === 'tab'
      && !visibleTabIds.includes(navigation.profileScreenId)) {
      throw new Error('Profile access is tab but Profile is not a visible durable tab');
    }
  }

  const manifest = {
    schemaVersion: 1,
    contractType: 'navigation-manifest',
    scopeRevision: contractRevision(scope),
    pattern: navigation.pattern,
    visibleTabs: visibleTabIds.map((id) => destination(screenById.get(id))),
    durableDestinations: durableIds.map((id) => destination(screenById.get(id))),
    screens: screenEntries,
    returnHomeMechanism: navigation.returnHomeMechanism || null,
    drawerReason: navigation.drawerReason || null,
    profile: navigation.authenticated
      ? {
        screenId: navigation.profileScreenId,
        access: navigation.profileAccess,
        visibleTab: visibleTabIds.includes(navigation.profileScreenId),
      }
      : null,
  };
  manifest.manifestRevision = sha256Hex(canonicalJson(manifest));
  return manifest;
}

function compileNavigationManifest(scope, packageJson) {
  assertIconPackage(packageJson);
  return buildNavigationManifest(scope, { requireRoutes: true });
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--package') args.package = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot) throw new Error('--project-root is required');
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const scopePath = path.resolve(projectRoot, args.scope || DEFAULT_SCOPE);
    const packagePath = path.resolve(projectRoot, args.package || 'package.json');
    const outputPath = path.resolve(projectRoot, args.output || DEFAULT_OUTPUT);
    const manifest = compileNavigationManifest(
      JSON.parse(fs.readFileSync(scopePath, 'utf8')),
      JSON.parse(fs.readFileSync(packagePath, 'utf8')),
    );
    atomicWriteJson(outputPath, manifest);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      output: outputPath,
      revision: manifest.manifestRevision,
      pattern: manifest.pattern,
      visibleTabCount: manifest.visibleTabs.length,
      screenCount: Object.keys(manifest.screens).length,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`compile-navigation-manifest: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ICONS,
  buildNavigationManifest,
  compileNavigationManifest,
  iconIntentFor,
  main,
};
