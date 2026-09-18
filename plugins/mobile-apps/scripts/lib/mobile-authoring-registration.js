'use strict';

const protocol = require('./authoring-protocol');
const { exists, readJson } = require('./mobile-authoring-files');

const REGISTRY = '.tmp/authoring-registry.json';
const RUNTIME_MANIFEST = '.tmp/mobile-authoring-runtime.json';
const DERIVED_FILES = Object.freeze([REGISTRY, RUNTIME_MANIFEST, 'src/authoring/registry.ts']);
const RUNTIME_HELPERS = Object.freeze([
  'src/authoring/index.tsx', 'src/authoring/controller.ts', 'src/authoring/README.md',
]);
const RUNTIME_INSTALL_FILES = Object.freeze([...DERIVED_FILES, ...RUNTIME_HELPERS, 'app/_layout.tsx', 'tsconfig.json']);

function requiresAuthoringCheck(root) {
  return exists(root, '.tmp/prototype-profile.json') || exists(root, RUNTIME_MANIFEST);
}

function registeredReadyScreenIds(root, screenFiles) {
  if (!Array.isArray(screenFiles) || !screenFiles.length || new Set(screenFiles).size !== screenFiles.length) {
    throw new Error('Authoring readiness requires unique registered screen source files');
  }
  const { validateAuthoringRegistry } = require('./authoring-runtime');
  const registry = validateAuthoringRegistry(root, readJson(root, REGISTRY));
  const ids = screenFiles.map((file) => {
    const matches = registry.screens.filter((screen) => screen.sourceFile === file);
    if (matches.length !== 1) throw new Error('A ready source must match exactly one explicitly registered screen');
    return protocol.id(matches[0].screenId, 'ready authoring screen ID');
  });
  if (new Set(ids).size !== ids.length) throw new Error('Ready authoring screen IDs must be unique');
  return ids;
}

function verifyAuthoringProjection(root, { readyScreenIds = [], screenSources } = {}) {
  const result = require('./prototype-authoring').configurePrototypeAuthoring(root, {
    check: true, readyScreenIds, ...(screenSources === undefined ? {} : { screenSources }),
  });
  if (!result || result.ok !== true || result.publicationReady !== false) {
    throw new Error('The authoring projection checker did not verify the derived outputs');
  }
  return result;
}

module.exports = {
  REGISTRY, RUNTIME_MANIFEST, DERIVED_FILES, RUNTIME_HELPERS, RUNTIME_INSTALL_FILES,
  requiresAuthoringCheck, registeredReadyScreenIds, verifyAuthoringProjection,
};
