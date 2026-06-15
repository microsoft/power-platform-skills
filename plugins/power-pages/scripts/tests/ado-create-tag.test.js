'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTag, isValidTagName } = require('../lib/ado-create-tag');

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

test('isValidTagName: accepts canonical names', () => {
  assert.ok(isValidTagName('v1.2.3'));
  assert.ok(isValidTagName('release/2026-06'));
  assert.ok(isValidTagName('alpha_1'));
  assert.ok(isValidTagName('beta-3.0'));
});

test('isValidTagName: rejects illegal patterns', () => {
  assert.equal(isValidTagName(''), false);
  assert.equal(isValidTagName('-leading-dash'), false);
  assert.equal(isValidTagName('.'), false);
  assert.equal(isValidTagName('foo..bar'), false);
  assert.equal(isValidTagName('v1.2@{0}'), false);
  assert.equal(isValidTagName('v1.lock'), false);
  assert.equal(isValidTagName('v1 with space'), false);
  assert.equal(isValidTagName('a'.repeat(101)), false);
});

test('ado-create-tag: missing args reject', async () => {
  await assert.rejects(createTag({ project: 'p', repository: 'r', name: 'v1', commitSha: 'a'.repeat(40), pat: 'P' }), /organization/);
  await assert.rejects(createTag({ organization: 'o', repository: 'r', name: 'v1', commitSha: 'a'.repeat(40), pat: 'P' }), /project/);
  await assert.rejects(createTag({ organization: 'o', project: 'p', name: 'v1', commitSha: 'a'.repeat(40), pat: 'P' }), /repository/);
  await assert.rejects(createTag({ organization: 'o', project: 'p', repository: 'r', commitSha: 'a'.repeat(40), pat: 'P' }), /name/);
  await assert.rejects(createTag({ organization: 'o', project: 'p', repository: 'r', name: 'v1', pat: 'P' }), /commitSha/);
  await assert.rejects(createTag({ organization: 'o', project: 'p', repository: 'r', name: 'v1', commitSha: 'a'.repeat(40) }), /pat or --token/);
});

test('ado-create-tag: rejects invalid tag names with a clear error', async () => {
  await assert.rejects(
    createTag({
      organization: 'o', project: 'p', repository: 'r',
      name: 'foo..bar', commitSha: 'a'.repeat(40), pat: 'P',
    }),
    /not a valid git tag name/,
  );
});

test('ado-create-tag: rejects short SHAs', async () => {
  await assert.rejects(
    createTag({
      organization: 'o', project: 'p', repository: 'r',
      name: 'v1', commitSha: 'abc1234', pat: 'P',
    }),
    /must be a full 40-char hex SHA/,
  );
});

test('ado-create-tag: happy path posts to /annotatedtags with correct body', async () => {
  const s = await createQueuedServer([
    {
      status: 201,
      body: JSON.stringify({
        name: 'v1.0.0',
        objectId: 'b'.repeat(40),
        taggedObject: { objectId: 'a'.repeat(40) },
        message: 'Release v1.0.0',
        url: 'https://dev.azure.com/o/_apis/git/.../annotatedTags/b...',
      }),
    },
  ]);
  const r = await createTag({
    organization: 'o', project: 'p', repository: 'r',
    name: 'v1.0.0', commitSha: 'a'.repeat(40), message: 'Release v1.0.0',
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.name, 'v1.0.0');
  assert.equal(r.tagSha, 'b'.repeat(40));
  assert.equal(r.commitSha, 'a'.repeat(40));
  // Verify the request
  assert.equal(s.received[0].method, 'POST');
  assert.match(s.received[0].url, /\/annotatedtags/);
  const body = JSON.parse(s.received[0].body);
  assert.equal(body.name, 'v1.0.0');
  assert.equal(body.taggedObject.objectId, 'a'.repeat(40));
  assert.equal(body.message, 'Release v1.0.0');
});

test('ado-create-tag: 409 Conflict surfaces a friendly "tag already exists" error', async () => {
  const s = await createQueuedServer([
    { status: 409, body: JSON.stringify({ message: 'Tag ref refs/tags/v1.0.0 already exists' }) },
  ]);
  const r = await createTag({
    organization: 'o', project: 'p', repository: 'r',
    name: 'v1.0.0', commitSha: 'a'.repeat(40),
    pat: 'P', baseUrl: serverUrl(s),
  });
  await closeAll(s);
  assert.equal(r.statusCode, 409);
  assert.match(r.error, /already exists in r/);
});

test('ado-create-tag: --tokenFile JSON envelope resolves for Authorization header', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const tokenFile = path.join(__dirname, '.ado-token-ado-create-tag.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'header.payload.sig' }));
  const s = await createQueuedServer([{ status: 201, body: JSON.stringify({ name: 'v1.2.3', taggedObject: { objectId: 'a'.repeat(40) }, url: 'u' }) }]);
  try {
    const r = await createTag({ organization: 'o', project: 'p', repository: 'r', name: 'v1.2.3', commitSha: 'a'.repeat(40), tokenFile, baseUrl: serverUrl(s) });
    assert.equal(r.name, 'v1.2.3');
    assert.equal(s.received[0].headers.authorization, 'Bearer header.payload.sig');
  } finally { await closeAll(s); fs.rmSync(tokenFile, { force: true }); }
});
