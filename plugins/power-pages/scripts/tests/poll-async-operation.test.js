'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parsePositiveInteger, pollAsyncOperation } = require('../poll-async-operation');

test('parsePositiveInteger accepts positive integers and rejects invalid poll settings', () => {
  assert.deepEqual(parsePositiveInteger(undefined, 5000, '--intervalMs'), { value: 5000 });
  assert.deepEqual(parsePositiveInteger('25', 5000, '--intervalMs'), { value: 25 });
  for (const value of ['0', '-1', '1.5', '1ms', 'NaN']) {
    assert.deepEqual(
      parsePositiveInteger(value, 5000, '--intervalMs'),
      { error: 'Invalid --intervalMs: expected a positive integer' }
    );
  }
});

test('poll-async-operation rejects invalid polling arguments before requests', async () => {
  let requested = false;
  const baseArgs = {
    asyncJobId: '00000000-0000-0000-0000-000000000000',
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
  };
  const deps = {
    makeRequest: async () => {
      requested = true;
      return { statusCode: 200, body: '{}' };
    },
  };

  assert.deepEqual(
    await pollAsyncOperation({ ...baseArgs, intervalMs: 'bad' }, deps),
    { error: 'Invalid --intervalMs: expected a positive integer' }
  );
  assert.deepEqual(
    await pollAsyncOperation({ ...baseArgs, maxAttempts: '0' }, deps),
    { error: 'Invalid --maxAttempts: expected a positive integer' }
  );
  assert.equal(requested, false);
});


test('poll-async-operation leaves progress indeterminate while import is running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-async-operation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let requests = 0;
  const makeRequest = async () => {
    requests += 1;
    return { statusCode: 200, body: JSON.stringify({
      statecode: 0,
      statuscode: 20,
      message: 'Import is still running',
    }) };
  };
  const statusFile = path.join(dir, 'status.json');

  const result = await pollAsyncOperation({
    asyncJobId: '00000000-0000-0000-0000-000000000000',
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    intervalMs: '1',
    maxAttempts: '1',
    statusFile,
  }, { makeRequest, sleep: async () => {} });

  assert.equal(requests, 1);
  assert.equal(result.status, 'Timeout');

  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(status.state, 'timeout');
  assert.equal('progressPercent' in status, false);
});

test('poll-async-operation normalizes envUrl and braced async operation ids', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-async-operation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let requestedUrl = '';
  const makeRequest = async ({ url }) => {
    requestedUrl = new URL(url).pathname + new URL(url).search;
    return { statusCode: 200, body: JSON.stringify({
      statecode: 3,
      statuscode: 30,
      progress: 100,
    }) };
  };

  const result = await pollAsyncOperation({
    asyncJobId: '{ABCDEFAB-1234-5678-9ABC-ABCDEFABCDEF}',
    envUrl: 'https://org.crm.dynamics.com/api/data/v9.2',
    token: 'token',
    intervalMs: '1',
    maxAttempts: '1',
    statusFile: path.join(dir, 'status.json'),
  }, { makeRequest, sleep: async () => {} });

  assert.equal(result.status, 'Succeeded');
  assert.match(requestedUrl, /^\/api\/data\/v9\.2\/asyncoperations\(abcdefab-1234-5678-9abc-abcdefabcdef\)\?/);
  assert.doesNotMatch(requestedUrl, /progress/);
});

test('poll-async-operation keeps transient HTTP status details out of the loader message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-async-operation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeRequest = async () => ({ statusCode: 400, body: JSON.stringify({ error: { message: 'Bad request' } }) });
  const statusFile = path.join(dir, 'status.json');

  const result = await pollAsyncOperation({
    asyncJobId: '00000000-0000-0000-0000-000000000000',
    envUrl: 'https://org.crm.dynamics.com',
    token: 'token',
    intervalMs: '1',
    maxAttempts: '1',
    statusFile,
  }, { makeRequest, sleep: async () => {} });

  assert.equal(result.status, 'Timeout');
  assert.equal(result.lastHttpStatus, 400);

  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(status.message, 'Template import is still running. Check the agent terminal.');
  assert.equal('progressPercent' in status, false);
});
