'use strict';

const path = require('node:path');
const protocol = require('./authoring-protocol');
const { fileToRoute } = require('../validate-navigation-layout');
const { canonicalJson, exists, readJson, relativePath } = require('./mobile-authoring-files');
const {
  RUNTIME_MANIFEST, DERIVED_FILES, RUNTIME_HELPERS, RUNTIME_INSTALL_FILES,
  requiresAuthoringCheck, verifyAuthoringProjection,
} = require('./mobile-authoring-registration');

function assignments(root, value, screens, newScreens) {
  if (!Array.isArray(value) || value.length !== screens.length || value.length > 100) {
    throw new Error('Authoring source assignments must cover every compiled and explicitly proposed screen');
  }
  const ids = new Set();
  const files = new Set();
  return value.map((entry) => {
    protocol.object(entry, 'authoring source assignment');
    if (Object.keys(entry).some((key) => !['screenId', 'sourceFile'].includes(key))) {
      throw new Error('Authoring source assignments accept only explicit screen IDs and source files');
    }
    const screenId = protocol.id(entry.screenId, 'authoring screen ID');
    const sourceFile = relativePath(entry.sourceFile);
    const matches = screens.filter((screen) => screen.screenId === screenId);
    const proposed = newScreens.find((screen) => screen.screenId === screenId);
    if (ids.has(screenId) || files.has(sourceFile) || matches.length !== 1
      || !sourceFile.startsWith('app/') || !sourceFile.endsWith('.tsx')
      || /(?:^|\/)(?:_layout|\+[^/]*)\.tsx$/.test(sourceFile)
      || fileToRoute(path.join(root, sourceFile), path.join(root, 'app')) !== matches[0].route
      || (proposed ? proposed.sourceFile !== sourceFile : !exists(root, sourceFile))) {
      throw new Error('Authoring sources must be unique explicit screen files matching their canonical routes');
    }
    ids.add(screenId);
    files.add(sourceFile);
    return { screenId, sourceFile };
  }).sort((left, right) => left.screenId < right.screenId ? -1 : left.screenId > right.screenId ? 1 : 0);
}

function planAuthoring(root, input, { kind, compiled, registry, newScreens }) {
  const allowedFiles = new Set(input.allowedFiles);
  const derived = DERIVED_FILES.some((file) => allowedFiles.has(file));
  const helper = RUNTIME_HELPERS.some((file) => allowedFiles.has(file));
  const intent = input.authoringRuntime === undefined ? undefined
    : protocol.enumeration(input.authoringRuntime, ['install', 'upgrade'], 'authoring runtime change');
  if ((derived || helper || intent || input.authoringSources !== undefined) && !['screen', 'integration'].includes(kind)) {
    throw new Error('Derived authoring outputs belong only to an explicit screen or integration scope');
  }
  if (helper && !intent) throw new Error('Compiler-owned authoring helpers require an intentional runtime installation or upgrade');
  if ((derived || newScreens.length || intent) && DERIVED_FILES.some((file) => !allowedFiles.has(file))) {
    throw new Error('Explicitly include all three derived authoring outputs when changing screen registration');
  }
  if (derived && !exists(root, RUNTIME_MANIFEST) && intent === undefined) {
    throw new Error('Missing authoring runtime requires an explicitly approved installation, not only registry writes');
  }
  if (intent) {
    if ((intent === 'install') === exists(root, RUNTIME_MANIFEST)) {
      throw new Error('Authoring runtime installation/upgrade must match its sealed existence at proposal time');
    }
    if (RUNTIME_INSTALL_FILES.some((file) => !allowedFiles.has(file))) {
      throw new Error('Authoring runtime changes must explicitly include all owned helpers, derived outputs, root and TypeScript aliases');
    }
    if (!exists(root, 'app/_layout.tsx') || !exists(root, 'tsconfig.json')) {
      throw new Error('Authoring runtime integration requires the existing app root and TypeScript configuration');
    }
  }
  const tracked = requiresAuthoringCheck(root) || derived || intent || input.authoringSources !== undefined;
  if (!tracked) return { allowed: new Set() };
  const screens = [...compiled.screens, ...newScreens];
  let sources;
  if (registry) {
    const inherited = [...registry.screens.map(({ screenId, sourceFile }) => ({ screenId, sourceFile })),
      ...newScreens.map(({ screenId, sourceFile }) => ({ screenId, sourceFile }))];
    sources = assignments(root, inherited, screens, newScreens);
    if (input.authoringSources !== undefined
      && canonicalJson(assignments(root, input.authoringSources, screens, newScreens)) !== canonicalJson(sources)) {
      throw new Error('Existing authoring source assignments cannot be redirected by an edit proposal');
    }
  } else {
    if (intent !== 'install' || input.authoringSources === undefined) {
      throw new Error('Initial authoring installation requires explicit authoringSources; source paths are never inferred from routes');
    }
    sources = assignments(root, input.authoringSources, screens, newScreens);
  }
  return {
    allowed: new Set([...(derived ? DERIVED_FILES : []), ...(intent ? RUNTIME_INSTALL_FILES : [])]),
    authoringSources: sources, ...(intent ? { authoringRuntime: intent } : {}),
  };
}

function assertAuthoringDelta(root, plan, changes, originalJson) {
  const derived = changes.some((entry) => DERIVED_FILES.includes(entry.path));
  const helper = changes.some((entry) => RUNTIME_HELPERS.includes(entry.path));
  if (derived && DERIVED_FILES.some((file) => !plan.allowedFiles.includes(file))) {
    throw new Error('Derived authoring changes require the complete explicitly approved output set');
  }
  if (helper && !plan.authoringRuntime) {
    throw new Error('Compiler-owned authoring helpers cannot change without an approved runtime installation or upgrade');
  }
  if (plan.authoringRuntime && changes.some((entry) => entry.path === 'tsconfig.json')) {
    const expected = structuredClone(originalJson('tsconfig.json'));
    expected.compilerOptions ??= {};
    expected.compilerOptions.paths ??= {};
    expected.compilerOptions.paths['@/authoring'] = ['src/authoring'];
    expected.compilerOptions.paths['@/authoring/*'] = ['src/authoring/*'];
    if (canonicalJson(readJson(root, 'tsconfig.json')) !== canonicalJson(expected)) {
      throw new Error('Authoring installation may change only its two owned TypeScript import aliases');
    }
  }
  const authored = plan.authoringSources?.some((screen) => changes.some((entry) => entry.path === screen.sourceFile));
  const compiled = plan.authoringSources && changes.some((entry) => entry.path === '.tmp/compiled-screen-build-pack.json');
  if (derived || helper || authored || compiled || (plan.authoringRuntime
    && changes.some((entry) => ['app/_layout.tsx', 'tsconfig.json'].includes(entry.path)))) {
    if (!plan.authoringSources) throw new Error('Authoring changes require sealed explicit screen source assignments');
    verifyAuthoringProjection(root, { screenSources: plan.authoringSources });
  }
}

module.exports = { assignments, planAuthoring, assertAuthoringDelta };
