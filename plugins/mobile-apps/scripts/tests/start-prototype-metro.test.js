'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { patchTextPreservingEol, selectMetroPort, startPrototypeMetro } = require('../start-prototype-metro');

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