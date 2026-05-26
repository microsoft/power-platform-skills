const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for export-solution-async.js
// Network calls are mocked via the validation-helpers module reference.

const { exportSolutionAsync } = require('../lib/export-solution-async');

// ── Helper: mock helpers module ────────────────────────────────────────────────

/**
 * Sets up mock functions on the shared helpers module and restores them after
 * the test via t.after(). Returns the helpers module for further customisation.
 */
function mockHelpers(t, overrides = {}) {
  const helpers = require('../lib/validation-helpers');
  const origGetAuthToken = helpers.getAuthToken;
  const origMakeRequest = helpers.makeRequest;

  helpers.getAuthToken = overrides.getAuthToken ?? (() => 'mock-token');
  helpers.makeRequest = overrides.makeRequest ?? (async () => ({ statusCode: 200, body: '{}' }));

  t.after(() => {
    helpers.getAuthToken = origGetAuthToken;
    helpers.makeRequest = origMakeRequest;
  });

  return helpers;
}

// ── Test 1: Required arg validation ───────────────────────────────────────────

test('exportSolutionAsync throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => exportSolutionAsync({ solutionName: 'MySolution', managed: 'false', token: 'tok' }),
    /--envUrl is required/
  );
});

test('exportSolutionAsync throws when --solutionName is missing', async () => {
  await assert.rejects(
    () => exportSolutionAsync({ envUrl: 'https://org.crm.dynamics.com', managed: 'false', token: 'tok' }),
    /--solutionName is required/
  );
});

test('exportSolutionAsync throws when --managed is missing', async () => {
  await assert.rejects(
    () => exportSolutionAsync({ envUrl: 'https://org.crm.dynamics.com', solutionName: 'MySolution', token: 'tok' }),
    /--managed is required/
  );
});

// ── Test 2: Succeeds when first poll returns statecode 3 ──────────────────────

test('exportSolutionAsync returns asyncOperationId when export job completes on first poll', async (t) => {
  const ASYNC_OP_ID = 'aaaa-bbbb-cccc-dddd';

  // makeRequest is called twice: once for the POST, once for the poll
  let callCount = 0;
  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async (opts) => {
      callCount++;
      if (callCount === 1) {
        // ExportSolutionAsync POST
        assert.ok(opts.url.includes('ExportSolutionAsync'), 'First call should be ExportSolutionAsync');
        return {
          statusCode: 200,
          body: JSON.stringify({ AsyncOperationId: ASYNC_OP_ID }),
        };
      }
      // Poll asyncoperations — return Succeeded immediately
      assert.ok(opts.url.includes(ASYNC_OP_ID), 'Poll URL should include asyncOperationId');
      return {
        statusCode: 200,
        body: JSON.stringify({ statecode: 3, statuscode: 30, message: null }),
      };
    },
  });

  const result = await exportSolutionAsync({
    envUrl: 'https://org.crm.dynamics.com',
    solutionName: 'MySolution',
    managed: 'false',
    token: 'mock-token',
  });

  assert.equal(result.asyncOperationId, ASYNC_OP_ID);
  assert.equal(result.solutionName, 'MySolution');
  assert.equal(result.managed, false);
  assert.equal(callCount, 2);
});

// ── Test 3: Throws when export job fails (statecode 4) ────────────────────────

test('exportSolutionAsync throws when export job fails with statecode 4', async (t) => {
  const ASYNC_OP_ID = 'fail-op-id';

  let callCount = 0;
  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          statusCode: 200,
          body: JSON.stringify({ AsyncOperationId: ASYNC_OP_ID }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ statecode: 4, statuscode: 31, message: 'Solution export failed: missing dependency' }),
      };
    },
  });

  await assert.rejects(
    () =>
      exportSolutionAsync({
        envUrl: 'https://org.crm.dynamics.com',
        solutionName: 'MySolution',
        managed: 'true',
        token: 'mock-token',
      }),
    /Solution export failed: missing dependency/
  );
});

// ── Test 4: Throws when ExportSolutionAsync returns non-200 ───────────────────

test('exportSolutionAsync throws when ExportSolutionAsync returns HTTP 400', async (t) => {
  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async () => ({
      statusCode: 400,
      body: JSON.stringify({ error: { message: 'Bad request' } }),
    }),
  });

  await assert.rejects(
    () =>
      exportSolutionAsync({
        envUrl: 'https://org.crm.dynamics.com',
        solutionName: 'BadSolution',
        managed: 'false',
        token: 'mock-token',
      }),
    /ExportSolutionAsync returned HTTP 400/
  );
});

// ── Test 5: Throws when token cannot be acquired ──────────────────────────────

test('exportSolutionAsync throws when token cannot be acquired and none passed', async (t) => {
  mockHelpers(t, {
    getAuthToken: () => null,
    makeRequest: async () => { throw new Error('should not be called'); },
  });

  await assert.rejects(
    () =>
      exportSolutionAsync({
        envUrl: 'https://org.crm.dynamics.com',
        solutionName: 'MySolution',
        managed: 'false',
        // no token passed
      }),
    /Azure CLI token acquisition failed/
  );
});

// ── Test 6: managed flag coercion ─────────────────────────────────────────────

test('exportSolutionAsync coerces managed string "true" to boolean true in output', async (t) => {
  let exportBody;
  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async (opts) => {
      if (opts.url.includes('ExportSolutionAsync')) {
        exportBody = JSON.parse(opts.body);
        return {
          statusCode: 200,
          body: JSON.stringify({ AsyncOperationId: 'op-123' }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ statecode: 3, statuscode: 30, message: null }),
      };
    },
  });

  const result = await exportSolutionAsync({
    envUrl: 'https://org.crm.dynamics.com',
    solutionName: 'MySolution',
    managed: 'true',
    token: 'mock-token',
  });

  assert.equal(result.managed, true, 'managed should be boolean true');
  assert.equal(exportBody.Managed, true, 'request body Managed should be boolean true');
});
