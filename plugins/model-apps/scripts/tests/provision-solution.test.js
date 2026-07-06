#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProvisionSolution, findPublisher, odataEscape } = require('../provision-solution.js');

// Mock SDK for tests
function mockSdk({ publishers = [], organization = [], createSolutionResult = null, createSolutionError = null }) {
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
          if (options.filter.includes(`publisherid eq '`)) {
            const match = options.filter.match(/publisherid eq '([^']*)'/);
            return match && p.publisherid === match[1];
          }
          if (options.filter.includes('isreadonly eq false')) {
            return p.isreadonly === false;
          }
          return false;
        });
      }
      if (entityLogicalName === 'organization') {
        return organization;
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

test('findPublisher: default publisher via organization', async () => {
  const sdk = mockSdk({
    organization: [{ _defaultpublisherid_value: 'default-pub-id' }],
    publishers: [
      { publisherid: 'default-pub-id', uniquename: 'defaultpub', customizationprefix: 'new' },
      { publisherid: 'other-pub', uniquename: 'otherpub', customizationprefix: 'oth' },
    ],
  });

  const result = await findPublisher(sdk, null);
  assert.equal(result.publisherid, 'default-pub-id');
  assert.equal(result.uniquename, 'defaultpub');
  assert.equal(result.customizationprefix, 'new');

  // Verify organization was queried first
  const orgCall = sdk.calls.find((c) => c.entity === 'organization');
  assert.ok(orgCall);
  assert.deepEqual(orgCall.options.select, ['_defaultpublisherid_value']);
});

test('findPublisher: fallback to non-readonly publisher', async () => {
  const sdk = mockSdk({
    organization: [],
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
    organization: [{ _defaultpublisherid_value: 'default-pub' }],
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
  assert.ok(result.error.includes('must be alphanumeric'));

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
  assert.ok(result.error.includes('must be alphanumeric'));
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
