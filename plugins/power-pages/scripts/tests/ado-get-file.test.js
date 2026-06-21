'use strict';

const { withNoAdoAcquire } = require('./ado-test-helpers');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getFile } = require('../lib/ado-get-file');

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

test('ado-get-file: missing args reject', async () => {
  await assert.rejects(getFile({ project: 'p', repository: 'r', path: '/a', version: 'main', pat: 'P' }), /organization/);
  await assert.rejects(getFile({ organization: 'o', repository: 'r', path: '/a', version: 'main', pat: 'P' }), /project/);
  await assert.rejects(getFile({ organization: 'o', project: 'p', path: '/a', version: 'main', pat: 'P' }), /repository/);
  await assert.rejects(getFile({ organization: 'o', project: 'p', repository: 'r', version: 'main', pat: 'P' }), /path/);
  await assert.rejects(getFile({ organization: 'o', project: 'p', repository: 'r', path: '/a', pat: 'P' }), /version/);
  await assert.rejects(
    withNoAdoAcquire(() => getFile({ organization: 'o', project: 'p', repository: 'r', path: '/a', version: 'main' })),
    /pat or --token/,
  );
});

test('ado-get-file: rejects invalid versionType', async () => {
  await assert.rejects(
    getFile({ organization: 'o', project: 'p', repository: 'r', path: '/a', version: 'main', versionType: 'nope', pat: 'P' }),
    /versionType must be one of/,
  );
});

test('ado-get-file: happy path returns content + sends includeContent and versionDescriptor', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ objectId: 'd1a68c', commitId: 'c'.repeat(40), content: '<ul class="breadcrumb"></ul>' }) },
  ]);
  const r = await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: '/solutions/RetailOS/x.webtemplate.source.html',
    version: '19fa740', versionType: 'commit',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.content, '<ul class="breadcrumb"></ul>');
  assert.equal(r.contentLength, '<ul class="breadcrumb"></ul>'.length);
  assert.equal(r.objectId, 'd1a68c');
  const url = decodeURIComponent(s.received[0].url);
  assert.match(url, /includeContent=true/);
  assert.match(url, /versionDescriptor\.version=19fa740/);
  assert.match(url, /versionDescriptor\.versionType=commit/);
  assert.match(url, /\/items/);
  assert.match(s.received[0].url, /api-version=7\.0/);
});

test('ado-get-file: leading slash is added when missing', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ objectId: 'x', content: 'hi' }) },
  ]);
  const r = await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: 'solutions/RetailOS/x.html', version: 'main',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.path, '/solutions/RetailOS/x.html');
  const url = decodeURIComponent(s.received[0].url);
  assert.match(url, /path=\/solutions\/RetailOS\/x\.html/);
});

test('ado-get-file: 404 returns { found:false } NOT a thrown error (empty-BASE add/add case)', async () => {
  const s = await createQueuedServer([
    { status: 404, body: JSON.stringify({ message: 'TF401174: path not found' }) },
  ]);
  const r = await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: '/solutions/RetailOS/new.html', version: 'feature/dev-a',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, false);
  assert.equal(r.statusCode, 404);
  assert.equal(r.path, '/solutions/RetailOS/new.html');
});

test('ado-get-file: --no-content sends includeContent=false', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ objectId: 'x' }) },
  ]);
  await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: '/a', version: 'main', includeContent: false,
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  const url = decodeURIComponent(s.received[0].url);
  assert.match(url, /includeContent=false/);
});

test('ado-get-file: 5xx returns error envelope', async () => {
  const s = await createQueuedServer([
    { status: 500, body: JSON.stringify({ message: 'boom' }) },
    { status: 500, body: JSON.stringify({ message: 'boom' }) },
    { status: 500, body: JSON.stringify({ message: 'boom' }) },
    { status: 500, body: JSON.stringify({ message: 'boom' }) },
  ]);
  const r = await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: '/a', version: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.statusCode, 500);
  assert.match(r.error, /boom/);
});

test('ado-get-file: content null (metadata-only response) yields contentLength 0', async () => {
  const s = await createQueuedServer([
    { status: 200, body: JSON.stringify({ objectId: 'x' }) },
  ]);
  const r = await getFile({
    organization: 'o', project: 'p', repository: 'r',
    path: '/a', version: 'main', pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.found, true);
  assert.equal(r.content, null);
  assert.equal(r.contentLength, 0);
});
