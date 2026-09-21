#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProvisionSolution, findPublisher, odataEscape } = require('../provision-solution.js');

// Mock SDK for tests
function mockSdk({ publishers = [], solution = [], createSolutionResult = null, createSolutionError = null }) {
  const calls = [];
  return {
    queryRecords: async (entityLogicalName, options) => {
      calls.push({ method: 'queryRecords', entity: entityLogicalName, options });
      if (entityLogicalName === 'publisher') {
        return publishers.filter((p) => {
          if (!options.filter) return true;
          // Simple filter matcher for test purposes
          if (options.filter.includes(`uniquename eq '`)) {
            const match = options.filter.match(/uniquename eq '([^']*)'/);
            return match && p.uniquename === match[1];
          }
          if (options.filter.includes('publisherid eq ')) {
            // GUID literals are unquoted in Dataverse OData; tolerate an optional quote for the test.
            const match = options.filter.match(/publisherid eq '?([^'\s]+)'?/);
            return match && p.publisherid === match[1];
          }
          if (options.filter.includes('isreadonly eq false')) {
            return p.isreadonly === false;
          }
          return false;
        });
      }
      // The default-publisher path queries the `Default` solution for its publisher.
      if (entityLogicalName === 'solution') {
        return solution;
      }
      return [];
    },
    createSolution: async (opts) => {
      calls.push({ method: 'createSolution', opts });
      if (createSolutionError) throw new Error(createSolutionError);
      return createSolutionResult || { id: 'solution-id-123', uniqueName: opts.uniqueName };
    },
    calls,
  };
}

test('odataEscape handles single quotes', () => {
  assert.equal(odataEscape("O'Brien"), "O''Brien");
  assert.equal(odataEscape("Test"), "Test");
  assert.equal(odataEscape("It's"), "It''s");
});

test('findPublisher: explicit publisher found', async () => {
  const sdk = mockSdk({
    publishers: [
      { publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'cto' },
      { publisherid: 'pub-2', uniquename: 'fabrikam', customizationprefix: 'fab' },
    ],
  });

  const result = await findPublisher(sdk, 'contoso');
  assert.equal(result.publisherid, 'pub-1');
  assert.equal(result.uniquename, 'contoso');
  assert.equal(result.customizationprefix, 'cto');

  // Verify queryRecords was called with correct filter
  const call = sdk.calls.find((c) => c.method === 'queryRecords' && c.entity === 'publisher');
  assert.ok(call);
  assert.ok(call.options.filter.includes("uniquename eq 'contoso'"));
});

test('findPublisher: explicit publisher not found', async () => {
  const sdk = mockSdk({
    publishers: [{ publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'cto' }],
  });

  const result = await findPublisher(sdk, 'nonexistent');
  assert.equal(result, null);
});

test('findPublisher: default publisher via Default solution', async () => {
  const sdk = mockSdk({
    solution: [{ _publisherid_value: 'default-pub-id' }],
    publishers: [
      { publisherid: 'default-pub-id', uniquename: 'defaultpub', customizationprefix: 'new' },
      { publisherid: 'other-pub', uniquename: 'otherpub', customizationprefix: 'oth' },
    ],
  });

  const result = await findPublisher(sdk, null);
  assert.equal(result.publisherid, 'default-pub-id');
  assert.equal(result.uniquename, 'defaultpub');
  assert.equal(result.customizationprefix, 'new');

  // Verify the Default solution was queried for its publisher
  const solCall = sdk.calls.find((c) => c.entity === 'solution');
  assert.ok(solCall);
  assert.deepEqual(solCall.options.select, ['_publisherid_value']);
  assert.match(solCall.options.filter, /uniquename eq 'Default'/);
});

test('findPublisher: fallback to non-readonly publisher', async () => {
  const sdk = mockSdk({
    solution: [],
    publishers: [
      { publisherid: 'fallback-pub', uniquename: 'fallbackpub', customizationprefix: 'fbk', isreadonly: false },
    ],
  });

  const result = await findPublisher(sdk, null);
  assert.equal(result.publisherid, 'fallback-pub');
  assert.equal(result.customizationprefix, 'fbk');
});

test('runProvisionSolution: explicit publisher found', async () => {
  const sdk = mockSdk({
    publishers: [{ publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'cto' }],
    createSolutionResult: { id: 'sol-123', uniqueName: 'MySolution' },
  });

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'MySolution',
      friendlyName: 'My Solution',
      description: 'Test solution',
      version: '1.0.0.0',
      publisherUniqueName: 'contoso',
    },
    { sdk }
  );

  assert.equal(result.ok, true);
  assert.equal(result.solutionId, 'sol-123');
  assert.equal(result.uniqueName, 'MySolution');
  assert.equal(result.friendlyName, 'My Solution');
  assert.equal(result.publisherUniqueName, 'contoso');
  assert.equal(result.publisherPrefix, 'cto');

  // Verify createSolution was called with correct args
  const createCall = sdk.calls.find((c) => c.method === 'createSolution');
  assert.ok(createCall);
  assert.equal(createCall.opts.uniqueName, 'MySolution');
  assert.equal(createCall.opts.friendlyName, 'My Solution');
  assert.equal(createCall.opts.description, 'Test solution');
  assert.equal(createCall.opts.version, '1.0.0.0');
  assert.equal(createCall.opts.publisherId, 'pub-1');
});

test('runProvisionSolution: default publisher', async () => {
  const sdk = mockSdk({
    solution: [{ _publisherid_value: 'default-pub' }],
    publishers: [{ publisherid: 'default-pub', uniquename: 'defaultpub', customizationprefix: 'new' }],
    createSolutionResult: { id: 'sol-456', uniqueName: 'AnotherSolution' },
  });

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'AnotherSolution',
      friendlyName: 'Another Solution',
    },
    { sdk }
  );

  assert.equal(result.ok, true);
  assert.equal(result.publisherUniqueName, 'defaultpub');
  assert.equal(result.publisherPrefix, 'new');

  // Verify default description was applied
  const createCall = sdk.calls.find((c) => c.method === 'createSolution');
  assert.ok(createCall.opts.description.includes('Another Solution'));
  assert.equal(createCall.opts.version, '1.0.0.0'); // default version
});

test('runProvisionSolution: explicit publisher not found', async () => {
  const sdk = mockSdk({
    publishers: [],
  });

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'MySolution',
      friendlyName: 'My Solution',
      publisherUniqueName: 'nonexistent',
    },
    { sdk }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("No publisher 'nonexistent' found"));

  // createSolution should NOT have been called
  const createCall = sdk.calls.find((c) => c.method === 'createSolution');
  assert.equal(createCall, undefined);
});

test('runProvisionSolution: invalid uniqueName (starts with digit)', async () => {
  const sdk = mockSdk({});

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: '1BadName',
      friendlyName: 'Bad Name',
    },
    { sdk }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('must start with a letter'));

  // No SDK calls should have been made
  assert.equal(sdk.calls.length, 0);
});

test('runProvisionSolution: invalid uniqueName (contains hyphen)', async () => {
  const sdk = mockSdk({});

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'Bad-Name',
      friendlyName: 'Bad Name',
    },
    { sdk }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('must start with a letter'));
  assert.equal(sdk.calls.length, 0);
});

test('runProvisionSolution: createSolution throws error', async () => {
  const sdk = mockSdk({
    publishers: [{ publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'cto' }],
    createSolutionError: 'Solution already exists',
  });

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'MySolution',
      friendlyName: 'My Solution',
      publisherUniqueName: 'contoso',
    },
    { sdk }
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Solution already exists'));
});

test('runProvisionSolution: valid uniqueName with underscores', async () => {
  const sdk = mockSdk({
    publishers: [{ publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'cto' }],
    createSolutionResult: { id: 'sol-789', uniqueName: 'Good_Name_123' },
  });

  const result = await runProvisionSolution(
    {
      envUrl: 'https://test.crm.dynamics.com',
      uniqueName: 'Good_Name_123',
      friendlyName: 'Good Name',
      publisherUniqueName: 'contoso',
    },
    { sdk }
  );

  assert.equal(result.ok, true);
  assert.equal(result.uniqueName, 'Good_Name_123');
});

// --- CLI main(): temp-workspace lifecycle -----------------------------------
//
// main() creates a throwaway SDK workspace with mkdtempSync. The SDK is only needed for its
// Dataverse client here — the workspace persists nothing — so it MUST be removed on every exit
// path. A leak is invisible per-run and only shows up as an ever-growing temp directory, which is
// exactly the kind of bug a test has to pin because nobody notices it manually.

const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');

const scriptPath = path.join(__dirname, '..', 'provision-solution.js');
const ENVU = 'https://contoso.crm.dynamics.com';

function solutionHarness({ argv, sdkFactoryThrows = null, initThrows = null, rmThrows = null, createSolution } = {}) {
  const fsCalls = [];
  const real = require('../lib/dataverse-auth.js');
  const emitted = [];
  const cli = loadCli(scriptPath, {
    argv: argv || [ENVU, 'my_solution', 'My Solution'],
    requires: {
      fs: {
        mkdtempSync: (p) => { fsCalls.push({ op: 'mkdtemp', p }); return p + 'XXXX'; },
        rmSync: (p, o) => {
          fsCalls.push({ op: 'rm', p, o });
          if (rmThrows) throw new Error(rmThrows);
        },
      },
      './lib/dataverse-auth': {
        parseArgs: real.parseArgs,
        validateFlags: real.validateFlags,
        emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
      },
      './lib/sdk-http-client': { createAzHttpClient: () => ({}) },
      './vendor/cds-maker-sdk.cjs': {
        // The CLI builds its store explicitly via the /node adapter, so the mocked bundle must
        // expose it. The marker carries the root so assertions can still check WHERE the throwaway
        // workspace was placed.
        createNodeWorkspaceStorage: (root) => ({ __mockWorkspaceRoot: root }),
        createMakerSdk: () => {
          if (sdkFactoryThrows) throw new Error(sdkFactoryThrows);
          return {
            initWorkspace: () => { if (initThrows) throw new Error(initThrows); },
            queryRecords: async (entity) => (entity === 'publisher'
              ? [{ publisherid: 'pub-1', uniquename: 'contoso', customizationprefix: 'new' }]
              : []),
            createSolution: createSolution || (async () => ({ id: 'sol-1' })),
          };
        },
      },
    },
  });
  return { cli, fsCalls, emitted };
}

test('main removes the throwaway workspace after a successful provision', async () => {
  const h = solutionHarness({});
  await h.cli.main();
  const made = h.fsCalls.find((c) => c.op === 'mkdtemp');
  const removed = h.fsCalls.find((c) => c.op === 'rm');
  assert.ok(made, 'a temp workspace is created');
  assert.ok(removed, 'and removed');
  assert.equal(removed.p, made.p + 'XXXX', 'the SAME directory mkdtempSync returned is removed');
  assert.deepEqual(removed.o, { recursive: true, force: true });
  assert.equal(h.emitted[0].ok, true);
});

test('main removes the workspace even when SDK CONSTRUCTION throws', async () => {
  // The documented hazard: a failing constructor happens after mkdtempSync, so construction must
  // sit inside the try or the directory leaks.
  const h = solutionHarness({ sdkFactoryThrows: 'bundle missing' });
  await h.cli.main();
  assert.ok(h.fsCalls.some((c) => c.op === 'rm'), 'workspace removed despite the constructor throwing');
  assert.equal(h.emitted[0].ok, false);
  assert.match(String(h.emitted[0].payload.message), /bundle missing/);
});

test('main removes the workspace even when initWorkspace throws', async () => {
  const h = solutionHarness({ initThrows: 'workspace init failed' });
  await h.cli.main();
  assert.ok(h.fsCalls.some((c) => c.op === 'rm'));
  assert.equal(h.emitted[0].ok, false);
  assert.match(String(h.emitted[0].payload.message), /workspace init failed/);
});

test('a cleanup failure does not mask the real provisioning error', async () => {
  // Windows can hold a transient handle on the temp dir; losing the Dataverse error behind an
  // EBUSY would leave the operator with nothing actionable.
  const h = solutionHarness({ sdkFactoryThrows: 'real failure', rmThrows: 'EBUSY' });
  await h.cli.main();
  assert.equal(h.emitted[0].ok, false);
  assert.match(String(h.emitted[0].payload.message), /real failure/);
  assert.doesNotMatch(String(h.emitted[0].payload.message), /EBUSY/);
});

test('a cleanup failure does not turn a SUCCESSFUL provision into a failure', async () => {
  const h = solutionHarness({ rmThrows: 'EBUSY' });
  await h.cli.main();
  assert.equal(h.emitted[0].ok, true, 'the solution was created; a temp-dir handle must not undo that');
  assert.equal(h.emitted[0].payload.solutionId, 'sol-1');
});

test('optional flags are forwarded to the solution record', async () => {
  let seen = null;
  const h = solutionHarness({
    argv: [ENVU, 'my_solution', 'My Solution', '--description', 'D', '--version', '2.0.0.0', '--publisher', 'contoso'],
    createSolution: async (args) => { seen = args; return { id: 'sol-2' }; },
  });
  await h.cli.main();
  assert.equal(seen.description, 'D');
  assert.equal(seen.version, '2.0.0.0');
  assert.equal(seen.publisherId, 'pub-1');
});

test('an omitted --version defaults to 1.0.0.0 and description is generated', async () => {
  let seen = null;
  const h = solutionHarness({ createSolution: async (args) => { seen = args; return { id: 'sol-3' }; } });
  await h.cli.main();
  assert.equal(seen.version, '1.0.0.0');
  assert.match(seen.description, /My Solution/);
});