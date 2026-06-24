'use strict';

/**
 * Cross-module integration test: web-file sniff-based routing (B-wave).
 *
 * Verifies the end-to-end data flow:
 *   build-merge-inputs (type 3, componentId/componentPath, not pre-marked ineligible)
 *   → resolveUnits (sniff-based routing)
 *   → TEXT web file: textUnit with webfile:true
 *   → BINARY web file: goes to binaryUnits, NOT a text unit
 *   → reconcile-dataverse verify: OURS re-read via readWebFileBytes (pass on match)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMergeInputs } = require('../lib/build-merge-inputs');
const { resolveUnits } = require('../lib/clone-merge-resolver');
const { reconcileDataverse } = require('../lib/reconcile-dataverse');

// ── Shared fixtures ────────────────────────────────────────────────────────────

const BINDING = {
  organization: 'https://dev.azure.com/testorg',
  project: 'TestProject',
  repository: 'TestRepo',
  branch: 'main',
  rootFolder: 'powerpages',
  gitFolder: 'site',
  branchSyncedCommitId: 'abc123',
  upstreamBranchSyncedCommitId: null,
};

const ENV_URL = 'https://test.crm.dynamics.com';
const COMPONENT_ID = 'aaaabbbb-0000-1111-2222-ccccddddeeee';
const COMPONENT_PATH = '/powerpagesites/site/web-files/logo.png';
const CLONE_DIR = 'C:\\fake\\clone';

// ── Task 2: build-merge-inputs passes type-3 through as eligible ───────────────

test('build-merge-inputs: type-3 conflict is NOT pre-marked ineligible, carries componentId+componentPath', () => {
  const { inputs, warnings } = buildMergeInputs({
    binding: BINDING,
    conflicts: [{
      conflictId: 'cf1',
      componentId: COMPONENT_ID,
      name: 'logo.png',
      type: 3,
      componentPath: COMPONENT_PATH,
    }],
    cloneDir: CLONE_DIR,
    envUrl: ENV_URL,
    solutionUniqueName: 'TestSolution',
  });

  assert.ok(warnings.length === 0, `unexpected warnings: ${JSON.stringify(warnings)}`);
  assert.equal(inputs.conflicts.length, 1, 'should have 1 conflict');

  const c = inputs.conflicts[0];
  assert.equal(c.type, 3, 'type must be 3 (webfile)');
  assert.equal(c.componentId, COMPONENT_ID, 'componentId must be preserved');
  assert.equal(c.componentPath, COMPONENT_PATH, 'componentPath must be preserved');
  assert.equal(c.eligibleForSelectiveMerge, true, 'type-3 must be eligible for selective merge');
  // field is null for web files (no envelope field)
  assert.equal(c.field, null, 'field must be null for type-3 web file');
});

// ── TEXT web-file flow ─────────────────────────────────────────────────────────
// resolveUnits: type-3, valid ADO path, readWebFileBytes → text bytes,
// sniff → isText:true → produces a TEXT unit with webfile:true

test('resolveUnits: TEXT web file (sniff isText:true) → textUnit with webfile:true, NOT in binaryUnits', async () => {
  const TEXT_BYTES = Buffer.from('body { color: red; }\n');
  const TEXT_B64 = TEXT_BYTES.toString('base64');

  const conflicts = [{
    conflictId: 'cf1',
    componentId: COMPONENT_ID,
    name: 'style.css',
    type: 3,
    field: null,
    componentPath: COMPONENT_PATH,
  }];

  const binding = {
    rootFolder: BINDING.rootFolder,
    gitFolder: BINDING.gitFolder,
  };

  const res = await resolveUnits({
    conflicts,
    binding,
    envUrl: ENV_URL,
    dvToken: 'fake-token',
    deps: {
      buildAdoPath: ({ componentPath }) => ({
        supported: true,
        path: `${BINDING.gitFolder}/web-files/style.css`,
      }),
      readWebFileBytes: async () => ({
        bytes: TEXT_BYTES,
        base64: TEXT_B64,
        eol: '\n',
        bom: null,
      }),
      sniffTextOrBinary: (buf) => ({ isText: true, encoding: 'utf8', reason: 'no NUL bytes' }),
      readComponentContent: async () => { throw new Error('should not be called for web files'); },
    },
  });

  assert.equal(res.textUnits.length, 1, 'should produce exactly one text unit');
  assert.equal(res.binaryUnits.length, 0, 'should produce no binary units');
  assert.equal(res.textUnits[0].webfile, true, 'text unit must have webfile:true');
  assert.equal(res.textUnits[0].componentId, COMPONENT_ID, 'componentId must be on the text unit');
  assert.equal(typeof res.textUnits[0].oursContent, 'string', 'oursContent must be a string');
  assert.ok(res.textUnits[0].oursContent.includes('color: red'), 'oursContent must contain decoded text');
  assert.equal(res.eligibleButNotText.length, 0, 'webfile sniff failure must never appear in eligibleButNotText');
});

// ── BINARY web-file flow ───────────────────────────────────────────────────────
// resolveUnits: type-3, valid ADO path, sniff → isText:false → goes to binaryUnits

test('resolveUnits: BINARY web file (sniff isText:false) → binaryUnits only, NOT in textUnits', async () => {
  const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

  const conflicts = [{
    conflictId: 'cf2',
    componentId: COMPONENT_ID,
    name: 'image.png',
    type: 3,
    field: null,
    componentPath: COMPONENT_PATH,
  }];

  const binding = {
    rootFolder: BINDING.rootFolder,
    gitFolder: BINDING.gitFolder,
  };

  const res = await resolveUnits({
    conflicts,
    binding,
    envUrl: ENV_URL,
    dvToken: 'fake-token',
    deps: {
      buildAdoPath: () => ({ supported: true, path: `${BINDING.gitFolder}/web-files/image.png` }),
      readWebFileBytes: async () => ({
        bytes: BINARY_BYTES,
        base64: BINARY_BYTES.toString('base64'),
        eol: '\n',
        bom: null,
      }),
      sniffTextOrBinary: () => ({ isText: false, encoding: null, reason: 'NUL byte at index 0' }),
      readComponentContent: async () => { throw new Error('should not be called for web files'); },
    },
  });

  assert.equal(res.textUnits.length, 0, 'BINARY web file must NOT produce a text unit');
  assert.equal(res.binaryUnits.length, 1, 'BINARY web file must go to binaryUnits');
  assert.equal(res.binaryUnits[0].componentId, COMPONENT_ID, 'componentId must be on the binary unit');
  assert.equal(res.eligibleButNotText.length, 0,
    'binary web file must never appear in eligibleButNotText (sniff failure is never an error)');
});

// ── BINARY web file: readWebFileBytes error also routes to binaryUnits ────────

test('resolveUnits: readWebFileBytes error → binaryUnits, not eligibleButNotText', async () => {
  const conflicts = [{
    conflictId: 'cf3',
    componentId: COMPONENT_ID,
    name: 'data.bin',
    type: 3,
    field: null,
    componentPath: COMPONENT_PATH,
  }];

  const res = await resolveUnits({
    conflicts,
    binding: { rootFolder: BINDING.rootFolder, gitFolder: BINDING.gitFolder },
    envUrl: ENV_URL,
    dvToken: 'fake-token',
    deps: {
      buildAdoPath: () => ({ supported: true, path: `${BINDING.gitFolder}/web-files/data.bin` }),
      readWebFileBytes: async () => ({ error: 'HTTP 404', statusCode: 404 }),
      sniffTextOrBinary: () => { throw new Error('should not be called when read fails'); },
      readComponentContent: async () => { throw new Error('should not be called for web files'); },
    },
  });

  assert.equal(res.textUnits.length, 0);
  assert.equal(res.binaryUnits.length, 1);
  assert.equal(res.eligibleButNotText.length, 0);
});

// ── reconcile-dataverse: webfile text unit verifies OURS bytes (pass) ─────────

test('reconcileDataverse: webfile text unit — re-read bytes match mergedContent → contentVerify: verified', async () => {
  const MERGED = 'body { color: blue; }\n';
  const MERGED_BUF = Buffer.from(MERGED, 'utf8');

  const result = await reconcileDataverse({
    components: [{
      conflictId: 'cf1',
      componentId: COMPONENT_ID,
      name: 'style.css',
      type: 3,
      field: null,
      webfile: true,
      mergedContent: MERGED,
      decision: 'accept-incoming',
    }],
    envUrl: ENV_URL,
    solutionUniqueName: 'TestSolution',
    apply: true,
    writeState: false,
    deps: {
      refreshChangesFromGit: async () => ({}),
      resolveGitConflictUserAction: async () => ({ ok: true }),
      resolveConflictAccept: async () => ({ ok: true }),
      pullChangesFromGit: async () => ({}),
      listConflicts: async () => ({ conflicts: [] }),
      readComponentContent: async () => ({ mergeFields: [] }),
      resolveSolutionId: async () => null,
      runState: { writeRunState: () => {} },
      readWebFileBytes: async ({ componentId }) => {
        assert.equal(componentId, COMPONENT_ID, 'readWebFileBytes called with correct componentId');
        return { bytes: MERGED_BUF, base64: MERGED_BUF.toString('base64'), eol: '\n', bom: null };
      },
      patchWebFileBytes: async () => { throw new Error('patchWebFileBytes should not be called when bytes match'); },
    },
  });

  assert.ok(result, 'reconcile must return a result');
  const verifyStep = result.steps && result.steps.find((s) => s.step === 'content-verify');
  assert.ok(verifyStep, 'content-verify step must exist');
  assert.ok(Array.isArray(verifyStep.checks), 'checks must be an array');
  const check = verifyStep.checks.find((c) => c.name === 'style.css');
  assert.ok(check, 'check for style.css must exist');
  assert.equal(check.result, 'verified', `expected verified, got: ${check.result} (${JSON.stringify(check)})`);
});

// ── reconcile-dataverse: webfile text unit mismatch → patchWebFileBytes called ─

test('reconcileDataverse: webfile text unit — re-read bytes MISMATCH → patchWebFileBytes called as fallback', async () => {
  const MERGED = 'body { color: blue; }\n';
  const STALE = 'body { color: red; }\n'; // what Dataverse has after pull (stale)

  let patchCalled = false;
  let patchArgs = null;

  const result = await reconcileDataverse({
    components: [{
      conflictId: 'cf1',
      componentId: COMPONENT_ID,
      name: 'style.css',
      type: 3,
      field: null,
      webfile: true,
      mergedContent: MERGED,
      decision: 'accept-incoming',
    }],
    envUrl: ENV_URL,
    solutionUniqueName: 'TestSolution',
    apply: true,
    writeState: false,
    deps: {
      refreshChangesFromGit: async () => ({}),
      resolveGitConflictUserAction: async () => ({ ok: true }),
      resolveConflictAccept: async () => ({ ok: true }),
      pullChangesFromGit: async () => ({}),
      listConflicts: async () => ({ conflicts: [] }),
      readComponentContent: async () => ({ mergeFields: [] }),
      resolveSolutionId: async () => null,
      runState: { writeRunState: () => {} },
      readWebFileBytes: async () => ({
        bytes: Buffer.from(STALE, 'utf8'),
        base64: Buffer.from(STALE, 'utf8').toString('base64'),
        eol: '\n',
        bom: null,
      }),
      patchWebFileBytes: async (args) => {
        patchCalled = true;
        patchArgs = args;
        return { ok: true };
      },
    },
  });

  assert.ok(patchCalled, 'patchWebFileBytes must be called on bytes mismatch');
  assert.equal(patchArgs.componentId, COMPONENT_ID, 'patchWebFileBytes must receive the correct componentId');
  const expectedB64 = Buffer.from(MERGED, 'utf8').toString('base64');
  assert.equal(patchArgs.base64, expectedB64, 'patchWebFileBytes must receive mergedContent as base64');

  const verifyStep = result.steps && result.steps.find((s) => s.step === 'content-verify');
  const check = verifyStep && verifyStep.checks && verifyStep.checks.find((c) => c.name === 'style.css');
  assert.ok(check, 'check for style.css must exist');
  assert.equal(check.result, 'patched-fallback', `expected patched-fallback, got: ${check.result}`);
});
