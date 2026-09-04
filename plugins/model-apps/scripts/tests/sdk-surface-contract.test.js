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
// build time. Update the migration accordingly (see docs/app-builder-capabilities.md).
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
  'deleteRecord',
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
  'getColumnVisualization',
  'getSolution',
  'initWorkspace',
  'insertStatusValue',
  'moveElement',
  'publishArtifact',
  'pushArtifact',
  'queryRecords',
  'removeElement',
  'removeRowSummary',
  'resolveArtifact',
  'retrieveSetting',
  'seedRecordGraph',
  'setAppAiFeatures',
  'setColumnVisualization',
  // Offers a form to specific security roles (AB#6648526). The roles are NOT a relationship —
  // `systemform` reports `CanBeInManyToMany: { Value: false, CanBeChanged: false }` and there is no
  // `systemformrole` entity — they live inside `formxml` as `<DisplayConditions>`, so this dedicated
  // call is the only way to write them.
  'setFormSecurityRoles',
  // Written by the app-shell phase for `app.newLook` — the modern shell is a per-app SETTING
  // (`NewLookAlwaysOn`), not an appmodule column.
  'saveSettingValue',
  'setEntityIcon',
  // Wave 2 header/navigation refresh (`app.headerNavigationRefresh`). Used instead of a raw setting
  // write because the value is a Number TRI-STATE where ON is '2', not '1' — writing '1' is accepted
  // by the API and silently fails to enable the feature. The SDK owns that encoding.
  'setHeaderAndNavigationRefresh',
  'updateColumn',
  'updateElement',
  'updateRecord',
  'updateTable',
  'updateWebResource',
  // The business-rule designer's OWN completeness validator. Nothing on the push path runs it, and a
  // rule the compiler could not understand deploys as an EMPTY rule with HTTP 204 — so losing this
  // method silently re-opens a trap that has no other detector.
  'validateBusinessRule',
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

// Collect every `provision.<name>(` / `sdk.<name>(` identifier the plugin calls. These aliases are
// the MakerSdk instance in sdk-build.js (`provision`) and sdk-teardown.js (`sdk`).
// e.g. matches `provision.createTable(o)` and `await sdk.deleteTable(...)` -> 'createTable' / 'deleteTable'.
//
// The scan covers scripts/ RECURSIVELY, not a hand-listed set of library files. An adversarial
// review found that the hand-listed version silently omitted two real calls made from the top-level
// CLI scripts — `sdk.getSolution(...)` in download-model-app.js and `sdk.retrieveSetting(...)` in
// verify-model-app.js — so the "every method the engines call is guarded" claim was false, and a
// future bundle could drop either method with this test still green and download/verify failing at
// runtime with a TypeError. A list of files to scan is exactly the kind of thing that rots; a walk
// does not.
function calledSdkMethods() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // vendor/ is the generated SDK itself; _vendor-build is the dev-only bundler; tests/ define
        // MOCK sdk objects whose method set is deliberately not the real surface.
        if (['vendor', '_vendor-build', 'node_modules', 'tests'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  };
  walk(SCRIPTS_DIR);
  // Receivers: any identifier that plausibly holds an SDK instance, not a two-name allow-list.
  //
  // A review found `provisionSdk.initWorkspace()` in build-model-app.js was invisible to the old
  // `(provision|sdk)` pattern — the method happened to be listed anyway, via a `sdk.` call
  // elsewhere, so nothing failed; a method used ONLY through such a receiver would have been
  // silently unguarded. Matching any identifier containing "sdk" or "provision" (case-insensitive)
  // covers every handle the plugin actually uses (`provision`, `sdk`, `provisionSdk`) and errs
  // toward over-collecting: a false positive here just adds a name to SKILL_SDK_SURFACE, where the
  // bundle check immediately proves whether it is real.
  //
  // Still invisible, and deliberately not chased: a destructured or fully dynamic call. Those need
  // real data-flow analysis, and unlike the async guard — where an unguarded call CORRUPTS data —
  // the failure here is a loud TypeError at runtime, so a tripwire is proportionate.
  // `matchAll`, not a shared `/g` regex with `exec`. The exec form is CORRECT here as written — a
  // loop run to exhaustion gets `lastIndex` reset to 0 by the failing `exec`, verified: three files
  // scanned in sequence find all matches and leave `lastIndex` at 0 after each. But the correctness
  // depends entirely on nobody ever adding a `break`, `continue` or early `return` inside the loop:
  // with one `break`, the same three files yield 2 of 5 matches instead of 5, silently. A guard whose
  // soundness rests on an invisible invariant is one edit from being a no-op, and this one exists to
  // catch unguarded SDK calls. `matchAll` does not touch the source regex's `lastIndex` at all.
  const re = /\b([A-Za-z_$][\w$]*)\.([A-Za-z][A-Za-z0-9]*)\s*\(/g;
  const found = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      if (/sdk|provision/i.test(m[1])) found.add(m[2]);
    }
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
