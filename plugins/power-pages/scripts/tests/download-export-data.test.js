const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Unit tests for download-export-data.js
// File I/O uses real temp directories; HTTP is mocked via the helpers module.

const { downloadExportData } = require('../lib/download-export-data');

// ── Helper: mock helpers module ────────────────────────────────────────────────

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

test('downloadExportData throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => downloadExportData({ asyncOperationId: 'op-1', outputPath: '/tmp/out.zip', token: 'tok' }),
    /--envUrl is required/
  );
});

test('downloadExportData throws when --asyncOperationId is missing', async () => {
  await assert.rejects(
    () => downloadExportData({ envUrl: 'https://org.crm.dynamics.com', outputPath: '/tmp/out.zip', token: 'tok' }),
    /--asyncOperationId is required/
  );
});

test('downloadExportData throws when --outputPath is missing', async () => {
  await assert.rejects(
    () => downloadExportData({ envUrl: 'https://org.crm.dynamics.com', asyncOperationId: 'op-1', token: 'tok' }),
    /--outputPath is required/
  );
});

// ── Test 2: Writes zip file on success ────────────────────────────────────────

test('downloadExportData writes zip file and returns { zipPath, fileSizeBytes } on success', async (t) => {
  // Create a real temp dir for the output
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-export-test-'));
  const outputPath = path.join(tmpDir, 'MySolution_managed.zip');

  // Build a small fake zip-like buffer (just needs to be non-empty)
  const fakeContent = 'PK\x03\x04fake-zip-content-for-test';
  const base64Content = Buffer.from(fakeContent).toString('base64');

  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async (opts) => {
      assert.ok(opts.url.includes('DownloadSolutionExportData'), 'Should call DownloadSolutionExportData');
      const body = JSON.parse(opts.body);
      assert.equal(body.ExportJobId, 'op-abc-123', 'Body should include ExportJobId');
      return {
        statusCode: 200,
        body: JSON.stringify({ ExportSolutionFile: base64Content }),
      };
    },
  });

  const result = await downloadExportData({
    envUrl: 'https://org.crm.dynamics.com',
    asyncOperationId: 'op-abc-123',
    outputPath,
    token: 'mock-token',
  });

  // Verify return value
  assert.equal(result.zipPath, outputPath);
  assert.ok(result.fileSizeBytes > 0, 'fileSizeBytes should be > 0');
  assert.equal(result.fileSizeBytes, Buffer.from(fakeContent).length);

  // Verify file was actually written to disk
  assert.ok(fs.existsSync(outputPath), 'Zip file should exist on disk');
  const written = fs.readFileSync(outputPath);
  assert.equal(written.toString(), fakeContent, 'File contents should match decoded base64');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 3: Throws when response is missing ExportSolutionFile ────────────────

test('downloadExportData throws when response body is missing ExportSolutionFile', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-export-test-'));
  const outputPath = path.join(tmpDir, 'out.zip');

  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async () => ({
      statusCode: 200,
      body: JSON.stringify({ someOtherField: 'value' }),
    }),
  });

  await assert.rejects(
    () =>
      downloadExportData({
        envUrl: 'https://org.crm.dynamics.com',
        asyncOperationId: 'op-1',
        outputPath,
        token: 'mock-token',
      }),
    /ExportSolutionFile/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 4: Throws when API returns non-200 ───────────────────────────────────

test('downloadExportData throws when DownloadSolutionExportData returns HTTP 500', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-export-test-'));
  const outputPath = path.join(tmpDir, 'out.zip');

  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async () => ({
      statusCode: 500,
      body: 'Internal Server Error',
    }),
  });

  await assert.rejects(
    () =>
      downloadExportData({
        envUrl: 'https://org.crm.dynamics.com',
        asyncOperationId: 'op-1',
        outputPath,
        token: 'mock-token',
      }),
    /DownloadSolutionExportData returned HTTP 500/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 5: Throws when token cannot be acquired ──────────────────────────────

test('downloadExportData throws when token cannot be acquired and none passed', async (t) => {
  mockHelpers(t, {
    getAuthToken: () => null,
    makeRequest: async () => { throw new Error('should not be called'); },
  });

  await assert.rejects(
    () =>
      downloadExportData({
        envUrl: 'https://org.crm.dynamics.com',
        asyncOperationId: 'op-1',
        outputPath: '/tmp/out.zip',
        // no token
      }),
    /Azure CLI token acquisition failed/
  );
});

// ── Test 6: Creates output directory if it does not exist ─────────────────────

test('downloadExportData creates output directory when it does not exist', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-export-test-'));
  // Use a nested sub-dir that does not exist yet
  const nestedOutput = path.join(tmpDir, 'new', 'sub', 'dir', 'solution.zip');

  const fakeContent = 'fake-zip';
  const base64Content = Buffer.from(fakeContent).toString('base64');

  mockHelpers(t, {
    getAuthToken: () => 'mock-token',
    makeRequest: async () => ({
      statusCode: 200,
      body: JSON.stringify({ ExportSolutionFile: base64Content }),
    }),
  });

  const result = await downloadExportData({
    envUrl: 'https://org.crm.dynamics.com',
    asyncOperationId: 'op-nested',
    outputPath: nestedOutput,
    token: 'mock-token',
  });

  assert.ok(fs.existsSync(result.zipPath), 'File should exist in newly created directory');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
