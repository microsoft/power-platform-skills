'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  prepareSession,
  readSession,
  recordFailure,
  recordReady,
  sessionPath,
} = require('../manage-prototype-metro');

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-metro-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('prepare probes from the requested port immediately before launch', async (context) => {
  const root = project(context);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const occupied = server.address().port;
  const prepared = await prepareSession(root, { startPort: occupied });
  assert.equal(prepared.action, 'start');
  assert.notEqual(prepared.port, occupied);
  assert.equal(prepared.command, `npx expo start --port ${prepared.port}`);
  assert.match(prepared.manualCommand, /cd '.+' && npx expo start --port \d+/);
});

test('ready metadata requests foreground banner verification before reuse', async (context) => {
  const root = project(context);
  const ready = recordReady(root, {
    port: 8087,
    terminalId: 'terminal-123',
    url: 'exp+demo://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8087',
    now: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(ready.healthEvidence, 'foreground-terminal-banner');
  const prepared = await prepareSession(root);
  assert.equal(prepared.action, 'verify-reuse');
  assert.equal(prepared.session.terminalId, 'terminal-123');
  assert.match(prepared.reason, /Foreground must confirm/);

  const replacement = await prepareSession(root, { ignoreExisting: true, startPort: 8090 });
  assert.equal(replacement.action, 'start');
  assert.equal(replacement.port >= 8090, true);
});

test('failed launch preserves a truthful manual command and cannot be reused', async (context) => {
  const root = project(context);
  const failed = recordFailure(root, {
    port: 8099,
    reason: 'Metro exited before the ready banner.',
    now: '2026-08-26T00:01:00.000Z',
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.manualCommand, /npx expo start --port 8099/);
  assert.deepEqual(readSession(root), failed);
  assert.equal((await prepareSession(root, { startPort: 8100 })).action, 'start');
  const files = fs.readdirSync(path.dirname(sessionPath(root)));
  assert.equal(files.some((file) => file.includes('.tmp-')), false);
});