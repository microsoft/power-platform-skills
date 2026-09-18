'use strict';

const path = require('node:path');
const protocol = require('./authoring-protocol');
const { fileToRoute } = require('../validate-navigation-layout');
const { compilePersistenceContract, conceptId } = require('../compile-persistence-contract');
const { validateDomain, compilePrototype } = require('./prototype-domain');
const { canonicalJson, digest, relativePath, readJson, readFile, inside, exists, atomicWrite } = require('./mobile-authoring-files');

const INPUT = '.tmp/phone-app-plan.json';
const COMPILED = '.tmp/compiled-screen-build-pack.json';
const NAVIGATION = '.tmp/navigation-manifest.json';
const INITIAL_LIMIT = 3;

function exact(value, keys, label) {
  protocol.object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

function stamped(value, key) {
  const result = { ...value };
  delete result[key];
  return { ...result, [key]: digest(canonicalJson(result)) };
}

function readPhonePlan(root, { initial = false } = {}) {
  const input = readJson(root, INPUT);
  exact(input, ['schemaVersion', 'entryRoute', 'screens', 'deferredScreens', 'navigation', 'nativeCapabilities', 'deferredConnectors'], 'phone app plan');
  if (input.schemaVersion !== 1 || !Array.isArray(input.screens) || !input.screens.length || input.screens.length > 100) {
    throw new Error('Phone app planning requires schemaVersion 1 and a bounded screen list');
  }
  if (initial && (input.screens.length < 2 || input.screens.length > INITIAL_LIMIT)) {
    throw new Error('The first app must complete one 2-3-screen journey. Keep additional screens in deferredScreens for Build more screens.');
  }
  const ids = new Set(), routes = new Set(), files = new Set();
  const screens = input.screens.map(screen => {
    exact(screen, ['screenId', 'title', 'route', 'sourceFile', 'dependencies', 'entityIds', 'navigation', 'primaryActions', 'secondaryActions', 'dataAssumptions'], 'phone screen');
    const screenId = protocol.id(screen.screenId, 'screen ID');
    const title = protocol.text(screen.title, 'screen title', 200);
    const route = protocol.text(screen.route, 'screen route', 500);
    relativePath(screen.sourceFile);
    if (!screen.sourceFile.startsWith('app/(app)/') || !screen.sourceFile.endsWith('.tsx')
      || /(?:^|\/)(?:_layout|\+[^/]*)\.tsx$/.test(screen.sourceFile)
      || route === '/' || /[?#\\]/.test(route)
      || fileToRoute(path.join(root, screen.sourceFile), path.join(root, 'app')) !== route) {
      throw new Error('Each phone screen needs its explicit app/(app) TSX file and matching non-root Expo route');
    }
    if (ids.has(screenId) || routes.has(route) || files.has(screen.sourceFile)) throw new Error('Phone screen IDs, routes and source files must be unique');
    ids.add(screenId); routes.add(route); files.add(screen.sourceFile);
    for (const key of ['dependencies', 'entityIds']) {
      if (!Array.isArray(screen[key]) || new Set(screen[key]).size !== screen[key].length) throw new Error(`${key} must be an explicit unique array`);
      screen[key].forEach(value => protocol.id(value, key));
    }
    for (const key of ['primaryActions', 'secondaryActions', 'dataAssumptions']) {
      if (!Array.isArray(screen[key]) || screen[key].length > 50) throw new Error(`${key} must be an explicit bounded array`);
      screen[key].forEach(value => protocol.text(value, key, 2000));
    }
    if (screen.navigation !== undefined) protocol.object(screen.navigation, 'screen navigation contract');
    return { ...screen, screenId, title, route };
  });
  for (const screen of screens) {
    if (screen.dependencies.some(id => id === screen.screenId || !ids.has(id))) throw new Error('Screen dependencies must name another screen in this build');
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Phone screen dependencies contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    screens.find(screen => screen.screenId === id).dependencies.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  screens.forEach(screen => visit(screen.screenId));
  if (!routes.has(input.entryRoute) || /[\[\]]/.test(input.entryRoute)) throw new Error('entryRoute must name a static screen in this build');
  if (!Array.isArray(input.deferredScreens) || input.deferredScreens.length > 100) throw new Error('Keep a bounded explicit deferred screen list');
  const deferredIds = new Set(ids);
  for (const screen of input.deferredScreens) {
    exact(screen, ['screenId', 'title', 'purpose'], 'deferred screen');
    protocol.id(screen.screenId, 'deferred screen ID');
    protocol.text(screen.title, 'deferred screen title', 200);
    protocol.text(screen.purpose, 'deferred screen purpose', 2000);
    if (deferredIds.has(screen.screenId)) throw new Error('Deferred screens must have unique IDs outside the current build');
    deferredIds.add(screen.screenId);
  }
  exact(input.navigation, ['pattern', 'destinations'], 'phone navigation');
  protocol.enumeration(input.navigation.pattern, ['stack', 'tabs-plus-stacks', 'drawer'], 'navigation pattern');
  if (!Array.isArray(input.navigation.destinations)) throw new Error('Navigation destinations must be explicit');
  const destinations = new Set();
  for (const destination of input.navigation.destinations) {
    exact(destination, ['screenId', 'label', 'iconName'], 'navigation destination');
    if (!ids.has(destination.screenId) || destinations.has(destination.screenId)) throw new Error('A visible destination must name one unique current screen');
    destinations.add(destination.screenId);
    protocol.text(destination.label, 'destination label', 100);
    protocol.text(destination.iconName, 'destination icon', 100);
    if (/[\[\]]/.test(screens.find(screen => screen.screenId === destination.screenId).route)) throw new Error('A dynamic detail cannot be a primary destination');
  }
  if (input.navigation.pattern === 'stack' ? destinations.size !== 0 : destinations.size === 0) {
    throw new Error('Stack navigation has no persistent destinations; tabs and drawer require explicit destinations');
  }
  if (!Array.isArray(input.nativeCapabilities) || !Array.isArray(input.deferredConnectors)) {
    throw new Error('Native capabilities and deferred connector needs must be explicit arrays, including when empty');
  }
  const nativeIds = new Set();
  for (const capability of input.nativeCapabilities) {
    exact(capability, ['id', 'displayName', 'persistenceConsequence'], 'native capability');
    protocol.id(capability.id, 'native capability ID');
    protocol.text(capability.displayName, 'native capability name', 200);
    protocol.text(capability.persistenceConsequence, 'native persistence consequence', 1000);
    if (nativeIds.has(capability.id)) throw new Error('Native capabilities must be unique');
    nativeIds.add(capability.id);
  }
  for (const connector of input.deferredConnectors) protocol.text(connector, 'deferred connector need', 1000);
  return { ...input, screens };
}

function screenContracts(plan) {
  const destinations = plan.navigation.destinations.map(destination => ({
    destinationId: destination.screenId, label: destination.label, iconName: destination.iconName,
    targetPath: plan.screens.find(screen => screen.screenId === destination.screenId).route,
  }));
  // These are execution projections of the approved main-branch screen map,
  // not a second product planner or a reinstated Product Experience workflow.
  const compiled = stamped({
    schemaVersion: 1, contractType: 'compiled-screen-build-pack', producer: 'phone-app-plan',
    screens: plan.screens.map(({ screenId, title, route, sourceFile, dependencies, entityIds, navigation, primaryActions, secondaryActions, dataAssumptions }) => ({
      screenId, title, route, sourceFile, dependencies, entityIds, primaryActions, secondaryActions, dataAssumptions,
      ...(navigation ? { navigation } : {}),
    })),
  }, 'compiledRevision');
  const navigation = stamped({
    schemaVersion: 1, pattern: plan.navigation.pattern,
    visibleTabs: plan.navigation.pattern === 'tabs-plus-stacks' ? destinations : [],
    durableDestinations: plan.navigation.pattern === 'drawer' ? destinations : [],
    screens: Object.fromEntries(plan.screens.map(screen => [screen.screenId, {
      targetPath: screen.route, sourceFile: screen.sourceFile,
    }])),
  }, 'navigationRevision');
  return { [COMPILED]: compiled, [NAVIGATION]: navigation };
}

function writeProjections(root, outputs, check) {
  if (check) {
    for (const [file, value] of Object.entries(outputs)) {
      if (!exists(root, file) || canonicalJson(readJson(root, file)) !== canonicalJson(value)) {
        throw new Error(`Phone planning projection is missing or stale: ${file}`);
      }
    }
  } else {
    for (const [file, value] of Object.entries(outputs)) atomicWrite(root, file, value);
  }
  return { ok: true, files: Object.keys(outputs), publicationReady: false };
}

function screenModel(root, plan) {
  const domain = validateDomain(readJson(root, '.tmp/prototype-domain.json'));
  if (readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId !== domain.appInstanceId) {
    throw new Error('The phone data model must retain the verified app identity');
  }
  for (const screen of plan.screens) {
    if (screen.entityIds.some(id => !domain.entities.some(entity => entity.id === id))) throw new Error('A screen references an entity absent from the reviewed data model');
  }
  return domain;
}

function compilePhoneScreens(root, { check = false } = {}) {
  const plan = readPhonePlan(root);
  screenModel(root, plan);
  return writeProjections(root, screenContracts(plan), check);
}

function isPhoneApp(root) {
  return exists(root, INPUT) && exists(root, COMPILED) && readJson(root, COMPILED).producer === 'phone-app-plan';
}

function compileInitialPhonePlan(root, { check = false, approved = false } = {}) {
  if (exists(root, '.tmp/prototype-profile.json')) throw new Error('Do not reinitialize an existing app. Use its edit workflow and refresh only the affected screen or data contracts.');
  const plan = readPhonePlan(root, { initial: true });
  const humanPlan = readFile(inside(root, 'native-app-plan.md')).toString('utf8');
  for (const heading of ['App Requirements', 'Data Model', 'Native Capabilities', 'Connectors', 'Screens']) {
    if (!new RegExp(`^## ${heading}\\s*$`, 'm').test(humanPlan)) throw new Error(`The main app plan is missing ## ${heading}`);
  }
  const domain = screenModel(root, plan);
  const scope = {
    schemaVersion: 1, contractType: 'phone-data-scope',
    dataEntities: domain.entities.length
      ? domain.entities.map(entity => ({ name: entity.id, role: 'domain-record', realization: 'local-configuration' }))
      : [{ name: 'AppViewState', role: 'presentation', realization: 'transient-ui-state' }],
  };
  const architecture = {
    schemaVersion: 1,
    conceptOwners: scope.dataEntities.map(entity => ({
      conceptId: conceptId(entity.name), owner: domain.entities.length ? 'local' : 'transient',
      reason: domain.entities.length ? 'App records remain local until a separate approved data connection.' : 'The app currently needs only transient view state.',
    })),
    // The CLI activates selected capabilities only after verifying the signed
    // app-plan decision; compiling a proposal never approves its selections.
    nativeCapabilities: plan.nativeCapabilities.map(capability => ({ ...capability, approved })),
    connectors: [],
  };
  // Persistence describes the proposed selections, not their approval state.
  // Keep its revision stable across acceptance so the signed sample-data input
  // does not change when the separate architecture approval flags are activated.
  const persistence = compilePersistenceContract(scope, {
    ...architecture,
    nativeCapabilities: plan.nativeCapabilities.map(capability => ({ ...capability, approved: true })),
  });
  const bindings = { schemaVersion: 1, entities: domain.entities.map(entity => ({ entityId: entity.id, conceptId: conceptId(entity.id) })) };
  const facts = stamped({
    ...readJson(root, '.tmp/scenario-facts.json'),
    persistenceRevision: persistence.persistenceRevision,
    scopeRevision: persistence.scopeRevision,
  }, 'scenarioRevision');
  const rules = readJson(root, '.tmp/prototype-rules.json');
  compilePrototype(domain, bindings, { persistence, facts }, rules);
  return writeProjections(root, {
    '.tmp/product-scope-contract.json': scope,
    '.tmp/architecture-decisions.json': architecture,
    '.tmp/persistence-contract.json': persistence,
    '.tmp/prototype-bindings.json': bindings,
    '.tmp/scenario-facts.json': facts,
    ...screenContracts(plan),
  }, check);
}

module.exports = { INPUT, COMPILED, NAVIGATION, INITIAL_LIMIT, readPhonePlan, screenContracts, isPhoneApp, compilePhoneScreens, compileInitialPhonePlan };
