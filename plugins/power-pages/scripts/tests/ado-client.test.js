'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createAdoClient, parseRetryAfter, buildQueryString, RETRY_ON_STATUSES,
} = require('../lib/ado-client');

function createQueuedServer(responses) {
  const queue = [...responses];
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const next = queue.shift() || { status: 500, body: '' };
      res.writeHead(next.status, next.headers || { 'Content-Type': 'application/json' });
      res.end(next.body || '');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}
function serverUrl(s) { return `http://127.0.0.1:${s.port}`; }
function closeAll(...servers) { return Promise.all(servers.map(s => new Promise(r => s.server.close(r)))); }

test('ado-client: parseRetryAfter parses integer seconds', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '5' }), 5000);
  assert.equal(parseRetryAfter({ 'Retry-After': '0' }), 0);
});
test('ado-client: parseRetryAfter returns null on missing/invalid', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter({}), null);
  assert.equal(parseRetryAfter({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), null);
});
test('ado-client: buildQueryString builds correctly', () => {
  assert.equal(buildQueryString({ a: 1, b: 'x' }, '7.0'), '?a=1&b=x&api-version=7.0');
  assert.equal(buildQueryString(null, '7.0'), '?api-version=7.0');
  assert.equal(buildQueryString({}, null), '');
  assert.equal(buildQueryString({ a: null, b: undefined, c: 'ok' }, '7.0'), '?c=ok&api-version=7.0');
});
test('ado-client: RETRY_ON_STATUSES contains canonical transient codes', () => {
  assert.ok(RETRY_ON_STATUSES.has(429));
  assert.ok(RETRY_ON_STATUSES.has(503));
  assert.ok(!RETRY_ON_STATUSES.has(400));
  assert.ok(!RETRY_ON_STATUSES.has(404));
});

test('ado-client: createAdoClient validates required organization', () => {
  assert.throws(() => createAdoClient({ pat: 'p' }), /organization is required/);
});
test('ado-client: createAdoClient validates pat or token', () => {
  assert.throws(() => createAdoClient({ organization: 'o' }), /pat or token is required/);
});

test('ado-client: GET happy path returns response', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const c = createAdoClient({
    organization: 'org', project: 'proj', repository: 'repo',
    pat: 'PAT', baseUrl: serverUrl(s),
  });
  const r = await c.get('/refs');
  await closeAll(s);
  assert.equal(r.statusCode, 200);
  assert.match(s.received[0].url, /\/proj\/_apis\/git\/repositories\/repo\/refs\?api-version=7\.0$/);
  assert.match(s.received[0].headers.authorization, /^Basic /);
});

test('ado-client: POST sends Content-Type and serializes object body', async () => {
  const s = await createQueuedServer([
    { status: 201, body: JSON.stringify({ id: 1 }) },
  ]);
  const c = createAdoClient({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  const r = await c.post('/pullrequests', { body: { title: 'x' } });
  await closeAll(s);
  assert.equal(r.statusCode, 201);
  assert.equal(s.received[0].headers['content-type'], 'application/json');
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.title, 'x');
});

test('ado-client: retries on 503 and succeeds on attempt 2', async () => {
  const s = await createQueuedServer([
    { status: 503, body: '' },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const c = createAdoClient({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
    retryAttempts: 3, retryBaseMs: 1,
  });
  const r = await c.get('/refs');
  await closeAll(s);
  assert.equal(r.statusCode, 200);
  assert.equal(s.received.length, 2);
});

test('ado-client: gives up after retryAttempts', async () => {
  const s = await createQueuedServer([
    { status: 503, body: '' }, { status: 503, body: '' },
    { status: 503, body: '' }, { status: 503, body: '' },
  ]);
  const c = createAdoClient({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
    retryAttempts: 2, retryBaseMs: 1,
  });
  const r = await c.get('/refs');
  await closeAll(s);
  assert.equal(r.statusCode, 503);
  assert.equal(s.received.length, 3); // initial + 2 retries
});

test('ado-client: honors Retry-After header on 429', async () => {
  const s = await createQueuedServer([
    { status: 429, body: '', headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } },
    { status: 200, body: JSON.stringify({ ok: true }) },
  ]);
  const c = createAdoClient({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
    retryAttempts: 2, retryBaseMs: 1,
  });
  const r = await c.get('/refs');
  await closeAll(s);
  assert.equal(r.statusCode, 200);
});

test('ado-client: does NOT retry on 400/404', async () => {
  const s = await createQueuedServer([{ status: 404, body: JSON.stringify({ message: 'not found' }) }]);
  const c = createAdoClient({
    organization: 'o', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
    retryAttempts: 3, retryBaseMs: 1,
  });
  const r = await c.get('/refs/x');
  await closeAll(s);
  assert.equal(r.statusCode, 404);
  assert.equal(s.received.length, 1);
});

test('ado-client: _apis/ path skips project segment', async () => {
  const s = await createQueuedServer([{ status: 200, body: JSON.stringify({}) }]);
  const c = createAdoClient({
    organization: 'org', project: 'p', repository: 'r',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await c.get('/_apis/projects');
  await closeAll(s);
  assert.match(s.received[0].url, /^\/_apis\/projects\?api-version=7\.0$/);
});

test('ado-client: requires project/repository for repo-scoped paths', () => {
  const c = createAdoClient({ organization: 'o', pat: 'P' });
  assert.throws(() => c._buildUrl('/refs', null, '7.0'), /project required/);
});
