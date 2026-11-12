'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { checkWebPreview, entryBundleUrl, staticPageError, stripAnsi } = require('../check-web-preview');

const SCRIPT = path.join(__dirname, '..', 'check-web-preview.js');
const ENTRY = '/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.routerRoot=app';
const PAGE = `<!DOCTYPE html><html><body><div id="root"></div><script src="${ENTRY.replace(/&/g, '&amp;')}" defer></script></body></html>`;

/** A stand-in for the Expo dev server that records which bundle URL was requested. */
function serve(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      handler(request, response);
    });
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('a page whose bundle compiles is ok, and every route is compiled rather than lazily skipped', async () => {
  const stub = await serve((request, response) => {
    if (request.url === '/') return response.end(PAGE);
    response.setHeader('Content-Type', 'application/javascript');
    return response.end('var __BUNDLE_START_TIME__=0;');
  });
  try {
    const result = await checkWebPreview(stub.url, { timeoutMs: 5000 });
    assert.equal(result.status, 'ok');
    const bundleRequest = stub.requests.find((url) => url.includes('.bundle'));
    assert.match(bundleRequest, /[?&]lazy=false(&|$)/);
    assert.match(bundleRequest, /platform=web/);
  } finally {
    await close(stub.server);
  }
});

test('a bundle that fails to compile reports Metro\'s cause without colour codes', async () => {
  const stub = await serve((request, response) => {
    if (request.url === '/') return response.end(PAGE);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify({
      type: 'UnableToResolveError',
      originModulePath: '/app/app/(app)/home.tsx',
      targetModuleName: '@/hooks/data/missing',
      message: 'Unable to resolve module @/hooks/data/missing\n\u001b[31m\u001b[1m>\u001b[22m\u001b[39m 35 | import',
    }));
  });
  try {
    const result = await checkWebPreview(stub.url, { timeoutMs: 5000 });
    assert.equal(result.status, 'bundle-error');
    assert.equal(result.type, 'UnableToResolveError');
    assert.equal(result.target, '@/hooks/data/missing');
    assert.doesNotMatch(result.message, /\u001b/);
    assert.match(result.message, /Unable to resolve module/);
  } finally {
    await close(stub.server);
  }
});

test('a page that itself fails with Expo\'s error payload is reported at once, not retried', async () => {
  const payload = { logs: [{ level: 'resolution', type: 'error', message: { content: 'Unable to resolve module ./gone' } }] };
  const stub = await serve((request, response) => {
    response.statusCode = 500;
    response.end(`<html><body><script id="_expo-static-error" type="application/json">${JSON.stringify(payload)}</script></body></html>`);
  });
  try {
    const started = Date.now();
    const result = await checkWebPreview(stub.url, { timeoutMs: 20000 });
    assert.ok(Date.now() - started < 5000, 'a compile failure must not wait out the timeout');
    assert.equal(result.status, 'bundle-error');
    assert.equal(result.type, 'resolution');
    assert.equal(result.message, 'Unable to resolve module ./gone');
  } finally {
    await close(stub.server);
  }
});

test('a server that never answers is unreachable once the budget runs out', async () => {
  const stub = await serve(() => {});
  const { url } = stub;
  await close(stub.server);
  const result = await checkWebPreview(url, { timeoutMs: 1500 });
  assert.equal(result.status, 'unreachable');
});

test('helpers parse the shapes Expo actually produces', () => {
  assert.equal(stripAnsi('\u001b[0m\u001b[90m 33 |\u001b[39m }'), ' 33 | }');
  assert.match(entryBundleUrl(PAGE, 'http://localhost:19006/'), /^http:\/\/localhost:19006\/node_modules\/expo-router\/entry\.bundle\?.*lazy=false/);
  assert.equal(entryBundleUrl('<script src="https://cdn.example/x.bundle"></script>', 'http://localhost:19006/'), null);
  assert.equal(staticPageError('<html></html>'), null);
});

test('the CLI refuses anything but a loopback http URL', () => {
  for (const url of ['https://localhost:19006', 'http://example.com:19006', 'javascript:alert(1)']) {
    const run = spawnSync(process.execPath, [SCRIPT, '--url', url], { encoding: 'utf8' });
    assert.equal(run.status, 2, `${url} should be rejected`);
  }
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
