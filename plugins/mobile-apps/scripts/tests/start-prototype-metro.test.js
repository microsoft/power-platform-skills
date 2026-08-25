'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { patchTextPreservingEol, probeMetroStatus, selectMetroPort, startPrototypeMetro, validateCanaryReceipt, waitForMetroReady } = require('../start-prototype-metro');
const { sha256 } = require('../validate-native-canary');

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

test('Metro rejects a canary receipt after a screen source changes', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-canary-receipt-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  const sourcePath = path.join(root, 'app', 'home.tsx');
  fs.writeFileSync(sourcePath, 'export default function Home() { return null; }\n');
  fs.writeFileSync(path.join(root, '.tmp', 'screen-build-pack.json'), JSON.stringify({ revision: 'a'.repeat(64), nativeCanary: { screenIds: ['home'] } }));
  fs.writeFileSync(path.join(root, '.tmp', 'native-canary-validation.json'), JSON.stringify({
    kind: 'native-canary-validation', valid: true, packRevision: 'a'.repeat(64), screenIds: ['home'], validatedAt: '2026-08-25T00:00:00.000Z',
    sources: { home: { file: 'app/home.tsx', sha256: sha256(fs.readFileSync(sourcePath)) } },
  }));
  assert.equal(validateCanaryReceipt(root).receipt.valid, true);
  fs.appendFileSync(sourcePath, '// changed\n');
  assert.throws(() => validateCanaryReceipt(root), /source changed after validation/);
});