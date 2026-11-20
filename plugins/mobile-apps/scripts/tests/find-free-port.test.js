'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const { findFreePort, isPortFree } = require('../find-free-port');

const SCRIPT = path.join(__dirname, '..', 'find-free-port.js');

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('a port something already listens on is skipped', async () => {
  const busy = await listen('127.0.0.1');
  try {
    const { port } = busy.address();
    assert.equal(await isPortFree(port), false);
    const found = await findFreePort({ start: port, attempts: 20 });
    assert.ok(found > port, `expected a port above ${port}, got ${found}`);
  } finally {
    await close(busy);
  }
});

test('a port bound only on IPv6 loopback is also treated as taken', async (t) => {
  let busy;
  try {
    busy = await listen('::1');
  } catch {
    t.skip('IPv6 loopback is not available on this host');
    return;
  }
  try {
    assert.equal(await isPortFree(busy.address().port), false);
  } finally {
    await close(busy);
  }
});

test('a port another dev server holds on every interface is treated as taken', async (t) => {
  // `npm run dev` serves the phone on the LAN, so Metro and power-apps-dev bind without a host. A
  // loopback-only probe called such a port free on macOS while power-apps-dev refused it, so the
  // skill's "find another port and restart" recovery kept choosing the same port.
  for (const host of [undefined, '0.0.0.0', '::']) {
    let busy;
    try {
      busy = await listen(host);
    } catch {
      t.diagnostic(`cannot listen on ${host} here`);
      continue;
    }
    try {
      assert.equal(await isPortFree(busy.address().port), false, `held on ${host ?? 'every interface'}`);
    } finally {
      await close(busy);
    }
  }
});

test('the CLI prints the port and a localhost URL as JSON', () => {
  const output = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--start', '19006'], { encoding: 'utf8' }));
  assert.ok(Number.isInteger(output.port) && output.port >= 19006);
  assert.equal(output.url, `http://localhost:${output.port}`);
});

test('invalid arguments are rejected instead of probing privileged or unbounded ranges', async () => {
  await assert.rejects(findFreePort({ start: 80 }), /--start/);
  await assert.rejects(findFreePort({ start: 19006, attempts: 0 }), /--attempts/);
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    /Unknown argument/,
  );
});
