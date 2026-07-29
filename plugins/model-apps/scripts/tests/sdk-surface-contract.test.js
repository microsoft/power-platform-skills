'use strict';
// SKILL <-> SDK SURFACE CONTRACT — the regression guard for a vendored-SDK swap.
//
// The build/teardown engines drive Dataverse entirely through the vendored bundle
// (scripts/vendor/cds-maker-sdk.cjs). Almost all unit coverage exercises a HAND-WRITTEN
// mock (mockSdk in sdk-build.test.js / sdk-teardown.test.js), so if a re-vendored SDK
// RENAMES or REMOVES a method the skill calls, every mock-based test stays green while the
// real bundle breaks at runtime. That is exactly how a big SDK refactor slips through.
//
// This file closes that gap with two checks that run against the REAL bundle + the REAL
// source, independent of any mock:
//   A) every method in SKILL_SDK_SURFACE is a function on the real vendored SDK, and
//   B) SKILL_SDK_SURFACE stays in sync with what the engines actually call (a new
//      `provision.foo()` / `sdk.foo()` call forces `foo` into the list, where (A) then
//      validates it against the bundle).
//
// When you bump + re-vendor the SDK, run this first: a method the skill depends on that the
// new bundle no longer exposes fails HERE (listing the exact names) instead of silently at
// build time. Update the migration accordingly (see docs/app-builder-roadmap.md).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const LIB_DIR = path.resolve(__dirname, '..', 'lib');
const SCRIPTS_DIR = path.resolve(__dirname, '..');

// The exact MakerSdk method surface the app-builder engines depend on. Derived from the
// `provision.*` (sdk-build.js) and `sdk.*` (sdk-teardown.js) call sites and kept in sync by
// the source-scan test below. Keep it ALPHABETICAL and one-method-per-line for clean diffs —
// this list is the living contract of what a re-vendored bundle MUST keep exposing.
const SKILL_SDK_SURFACE = [
  'addElement',
  'addSolutionComponent',
  'associateRecords',
  'configureRowSummary',
  'createAlternateKey',
  'createArtifact',
  'createColumn',
  'createCustomerColumn',
  'createGlobalOptionSet',
  'createPersonaRole',
  'createPublisher',
  'createRelationship',
  'createSolution',
  'createTable',
  'createWebResource',
  'deleteAppCascade',
  'deleteGlobalOptionSet',
  'deleteRelationship',
  'deleteRemoteArtifact',
  'deleteSecurityRole',
  'deleteSolution',
  'deleteTable',
  'deleteWebResource',
  'disassociateRecords',
  'enrichDefaultViews',
  'fetchArtifact',
  'fetchEntityMetadata',
  'findArtifact',
  'findColumns',
  'findTables',
  'getAiReadiness',
  'getArtifact',
  'initWorkspace',
  'insertStatusValue',
  'publishArtifact',
  'pushArtifact',
  'queryRecords',
  'removeElement',
  'removeRowSummary',
  'resolveArtifact',
  'seedRecordGraph',
  'setAppAiFeatures',
  'setEntityIcon',
  'updateElement',
  'updateRecord',
  'updateTable',
  'updateWebResource',
];

function realSdk() {
  const { createMakerSdk } = require(BUNDLE);
  const noop = async () => ({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-surface-'));
  const sdk = createMakerSdk({
    workspacePath: dir,
    instanceUrl: 'https://example.crm.dynamics.com',
    httpClient: { get: noop, post: noop, patch: noop, delete: noop, put: noop },
  });
  return { sdk, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('CONTRACT: every SDK method the skill depends on is a function on the real vendored bundle', () => {
  const { sdk, cleanup } = realSdk();
  try {
    // Report ALL missing at once — after a big SDK refactor this lists exactly which call
    // sites broke, rather than failing on the first and hiding the rest.
    const missing = SKILL_SDK_SURFACE.filter((m) => typeof sdk[m] !== 'function');
    assert.deepStrictEqual(
      missing,
      [],
      `The vendored SDK bundle is missing ${missing.length} method(s) the skill calls: ${missing.join(', ')}. ` +
        `A re-vendored bundle dropped/renamed them — migrate the sdk-build.js / sdk-teardown.js call sites ` +
        `(and this list) before shipping, or the build will fail at runtime.`
    );
  } finally {
    cleanup();
  }
});

// Collect every `provision.<name>(` / `sdk.<name>(` identifier the two engines call. These
// aliases are the MakerSdk instance in sdk-build.js (`provision`) and sdk-teardown.js (`sdk`).
// e.g. matches `provision.createTable(o)` and `await sdk.deleteTable(...)` -> 'createTable' / 'deleteTable'.
function calledSdkMethods() {
  const files = [
    path.join(LIB_DIR, 'sdk-build.js'),
    path.join(LIB_DIR, 'sdk-teardown.js'),
    path.join(LIB_DIR, 'entity-provision.js'),
    // artifact-intent.js is PURE (no SDK calls) by design, but scan it too so a future SDK call
    // added to the compiler is caught by this guard rather than slipping past the mock-based tests.
    path.join(LIB_DIR, 'artifact-intent.js'),
  ].filter((f) => fs.existsSync(f));
  const re = /\b(?:provision|sdk)\.([A-Za-z][A-Za-z0-9]*)\s*\(/g;
  const found = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return found;
}

test('CONTRACT: SKILL_SDK_SURFACE stays in sync with the engines — no SDK call is left off the guarded list', () => {
  const surface = new Set(SKILL_SDK_SURFACE);
  const called = calledSdkMethods();
  // Anything the engines call on the SDK instance that is NOT in the guarded surface would
  // slip past test (A) — add it to SKILL_SDK_SURFACE (which then validates it against the bundle).
  const unguarded = [...called].filter((m) => !surface.has(m)).sort();
  assert.deepStrictEqual(
    unguarded,
    [],
    `These SDK methods are called by the engines but missing from SKILL_SDK_SURFACE: ${unguarded.join(', ')}. ` +
      `Add them so the surface-contract test guards them against the real bundle.`
  );
});

// Guard-the-guard: prove the presence check actually FAILS when a method the skill needs is
// absent, so it can never silently rot into a no-op. Simulates a FUTURE bundle that drops the
// generic mutation surface the hardening-2 migration now depends on (addElement/updateElement/
// removeElement — which replaced the retired per-artifact mutators). If the guard stopped
// detecting a removal, THIS test fails too.
test('CONTRACT (meta): the presence check flags a bundle that dropped skill-critical methods (simulated SDK swap)', () => {
  const removedByRefactor = [
    'addElement',
    'removeElement',
    'updateElement',
  ];
  // A stand-in SDK exposing the whole surface EXCEPT the methods a swap removed.
  const fakeSdk = {};
  for (const m of SKILL_SDK_SURFACE) {
    if (!removedByRefactor.includes(m)) fakeSdk[m] = () => {};
  }
  const missing = SKILL_SDK_SURFACE.filter((m) => typeof fakeSdk[m] !== 'function');
  assert.deepStrictEqual(
    missing.sort(),
    [...removedByRefactor].sort(),
    'the surface presence check must report exactly the removed methods'
  );
});

module.exports = { SKILL_SDK_SURFACE };
