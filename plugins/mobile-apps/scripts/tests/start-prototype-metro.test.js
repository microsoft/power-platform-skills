'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRouteManifest, updateRouteStatus } = require('../route-manifest');
const { patchTextPreservingEol, probeMetroStatus, selectMetroPort, startPrototypeMetro, validateCanaryReadiness, waitForMetroReady } = require('../start-prototype-metro');

function canaryProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-canary-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  const screens = [
    { id: 'Home', route: '/(app)/home', file: 'app/(app)/home.tsx', role: 'primary', productRole: 'durable-destination', header: { title: 'Home' }, navigation: { role: 'durable-destination', destinationId: 'home' }, routeParameters: [], data: { operations: [] }, journey: { stageId: null } },
    { id: 'Work', route: '/(app)/work', file: 'app/(app)/work.tsx', role: 'key-flow', productRole: 'bounded-flow-step', header: { title: 'Work' }, navigation: { role: 'bounded-flow-step', destinationId: 'home', deepLinkable: true }, routeParameters: [], data: { operations: [] }, journey: { stageId: 'work' } },
  ];
  const pack = {
    schemaVersion: 2,
    revision: 'a'.repeat(64),
    screens,
    builderWaves: [{ id: 'native-canary', kind: 'screen', targets: ['Home', 'Work'], dependsOn: ['foundations'] }],
    navigation: {
      initialRoute: '/(app)/home', routingPolicy: { launchRoute: '/(app)/home' },
      destinations: [{ id: 'home', rootScreenId: 'Home', route: '/(app)/home' }],
      flows: [{ id: 'journey-work', ownerDestinationId: 'home', screenIds: ['Work'] }],
      globalRoutePolicy: { profileScreenId: null },
    },
    journey: { actions: [] },
  };
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  let manifest = buildRouteManifest(pack);
  manifest = updateRouteStatus(manifest, ['Home', 'Work'], 'type-safe');
  fs.writeFileSync(path.join(root, '.tmp', 'route-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const screen of screens) fs.writeFileSync(path.join(root, screen.file), `export default function ${screen.id}() { return <ScreenShell><Text>${screen.id}</Text></ScreenShell>; }\n`);
  return { root, pack };
}

test('selects the next explicit available port without an interactive prompt', async (context) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const occupied = server.address().port;
  const port = await selectMetroPort(occupied, occupied + 5);
  assert.ok(port > occupied);
});

test('plans an explicit non-interactive Expo command', async () => {
  const result = await startPrototypeMetro(process.cwd(), { preferredPort: 19090, maximumPort: 19110, planOnly: true });
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.command.slice(-4), ['--', '--port', String(result.port), '--non-interactive']);
});

test('patches LF and CRLF text without changing the file convention', () => {
  assert.equal(patchTextPreservingEol('before\nafter\n', 'before\nafter', 'before\ninserted\nafter'), 'before\ninserted\nafter\n');
  assert.equal(patchTextPreservingEol('before\r\nafter\r\n', 'before\r\nafter', 'before\ninserted\nafter'), 'before\r\ninserted\r\nafter\r\n');
});

test('reports Metro ready only after the status endpoint responds', async (context) => {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/status' ? 200 : 404, { 'content-type': 'text/plain' });
    response.end(request.url === '/status' ? 'packager-status:running' : 'missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const port = server.address().port;
  assert.equal(await probeMetroStatus(port), true);
  assert.equal((await waitForMetroReady(port, { timeoutMs: 1000, intervalMs: 10 })).ready, true);
});

test('requires real type-safe Home and key-flow TSX before Metro planning', async (context) => {
  const { root } = canaryProject(context);
  assert.deepEqual(validateCanaryReadiness(root), { packRevision: 'a'.repeat(64), screenIds: ['Home', 'Work'] });
  const planned = await startPrototypeMetro(root, { requireCanary: true, planOnly: true, preferredPort: 19120, maximumPort: 19140 });
  assert.deepEqual(planned.canary.screenIds, ['Home', 'Work']);

  fs.writeFileSync(path.join(root, 'app/(app)/work.tsx'), 'export default function Work() { return null; }\n');
  assert.throws(() => validateCanaryReadiness(root), /still a skeleton/);
});
