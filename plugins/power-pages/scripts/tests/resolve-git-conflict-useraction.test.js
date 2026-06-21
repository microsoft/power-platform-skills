'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveGitConflictUserAction, findConflictRow, buildBatchBody, USERACTION } = require('../lib/resolve-git-conflict-useraction');

// A tiny stand-in Dataverse: GET sourcecontrolcomponents → queued rows; POST $batch → 200.
function createServer({ rows = [], batchStatus = 200, batchBody = '' } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (req.method === 'GET' && /sourcecontrolcomponents/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: rows }));
      } else if (req.method === 'POST' && /\$batch/.test(req.url)) {
        res.writeHead(batchStatus, { 'Content-Type': 'application/json' });
        res.end(batchBody);
      } else { res.writeHead(404); res.end('{}'); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}
const url = (s) => `http://127.0.0.1:${s.port}`;
const close = (s) => new Promise((r) => s.server.close(r));

const SOL = '52cdfb68-415e-f111-a826-6045bd08be8b';
const COMP = '3c84087d-fcde-4262-b5b4-4df33fd23435';
const SCC = 'd31e1093-fb6a-f111-a825-70a8a5b108f1';

test('USERACTION codes match the HAR + option-set metadata (keep-current=1/Push, accept-incoming=2/Pull)', () => {
  assert.equal(USERACTION['accept-incoming'], 2); // Pull
  assert.equal(USERACTION['keep-current'], 1);    // Push
});

test('keep-current PATCHes useraction=1 (Push)', async () => {
  const rows = [{ sourcecontrolcomponentid: SCC, action: 3, useraction: 0, componentid: COMP }];
  const s = await createServer({ rows, batchStatus: 200, batchBody: 'HTTP/1.1 204' });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, componentId: COMP, decision: 'keep-current' });
  await close(s);
  assert.equal(r.ok, true);
  assert.equal(r.useraction, 1);
  assert.equal(r.concurrency, 'blind');
  const batchReq = s.received.find((x) => x.method === 'POST' && /\$batch/.test(x.url));
  assert.match(batchReq.body, /\{"useraction":1\}/);
  assert.match(batchReq.body, /If-Match: \*/);
});

test('buildBatchBody mirrors the HAR PATCH fallback (useraction in a $batch changeset)', () => {
  const { batch, body } = buildBatchBody({ base: 'https://e', sourceControlComponentId: SCC, solutionId: SOL, useraction: 2 });
  assert.match(body, /multipart\/mixed; boundary=changeset_/);
  assert.match(body, new RegExp(`PATCH https://e/api/data/v9\\.0/sourcecontrolcomponents\\(sourcecontrolcomponentid=${SCC}, partitionid='${SOL}'\\)`));
  assert.match(body, /If-Match: \*/);
  assert.match(body, /\{"useraction":2\}/);
  assert.match(body, new RegExp(`^--${batch}`));
});

test('buildBatchBody uses the row etag when available', () => {
  const { body, concurrency } = buildBatchBody({ base: 'https://e', sourceControlComponentId: SCC, solutionId: SOL, useraction: 2, etag: 'W/"123456"' });
  assert.equal(concurrency, 'etag');
  assert.match(body, /If-Match: W\/"123456"/);
  assert.doesNotMatch(body, /If-Match: \*/);
});

test('validation rejects bad inputs', async () => {
  await assert.rejects(resolveGitConflictUserAction({ solutionId: SOL, decision: 'accept-incoming', token: 't' }), /envUrl/);
  await assert.rejects(resolveGitConflictUserAction({ envUrl: 'https://e', decision: 'accept-incoming', token: 't' }), /solutionId/);
  await assert.rejects(resolveGitConflictUserAction({ envUrl: 'https://e', solutionId: SOL, decision: 'bogus', token: 't' }), /accept-incoming or keep-current/);
});

test('findConflictRow matches componentId client-side among action=3 rows', async () => {
  const rows = [
    { sourcecontrolcomponentid: 'other', action: 3, useraction: 0, componentid: 'zzzz' },
    { sourcecontrolcomponentid: SCC, action: 3, useraction: 0, componentid: COMP, '@odata.etag': 'W/"etag-1"' },
  ];
  const s = await createServer({ rows });
  const r = await findConflictRow({ base: url(s), token: 't', solutionId: SOL, componentId: COMP });
  await close(s);
  assert.equal(r.found, true);
  assert.equal(r.id, SCC);
  assert.equal(r.etag, 'W/"etag-1"');
});

test('findConflictRow falls back to versionnumber when @odata.etag is absent', async () => {
  const rows = [{ sourcecontrolcomponentid: SCC, action: 3, useraction: 0, componentid: COMP, versionnumber: '98765' }];
  const s = await createServer({ rows });
  const r = await findConflictRow({ base: url(s), token: 't', solutionId: SOL, componentId: COMP });
  await close(s);
  assert.equal(r.found, true);
  assert.equal(r.etag, 'W/"98765"');
});

test('findConflictRow returns not-found when no action=3 row matches', async () => {
  const s = await createServer({ rows: [] });
  const r = await findConflictRow({ base: url(s), token: 't', solutionId: SOL, componentId: COMP });
  await close(s);
  assert.equal(r.found, false);
});

test('accept-incoming: looks up the row then PATCHes useraction=2 via $batch', async () => {
  const rows = [{ sourcecontrolcomponentid: SCC, action: 3, useraction: 0, componentid: COMP, '@odata.etag': 'W/"2468"' }];
  const s = await createServer({ rows, batchStatus: 200, batchBody: 'HTTP/1.1 204 No Content' });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, componentId: COMP, decision: 'accept-incoming' });
  await close(s);
  assert.equal(r.ok, true);
  assert.equal(r.useraction, 2);
  assert.equal(r.sourceControlComponentId, SCC);
  assert.equal(r.etag, 'W/"2468"');
  assert.equal(r.concurrency, 'etag');
  // verify the $batch carried the PATCH
  const batchReq = s.received.find((x) => x.method === 'POST' && /\$batch/.test(x.url));
  assert.match(batchReq.body, /\{"useraction":2\}/);
  assert.match(batchReq.body, /If-Match: W\/"2468"/);
  assert.match(batchReq.headers['content-type'], /multipart\/mixed; boundary=batch_/);
});

test('explicit sourceControlComponentId with etag skips the lookup', async () => {
  const s = await createServer({ rows: [], batchStatus: 200, batchBody: 'HTTP/1.1 204' });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, sourceControlComponentId: SCC, etag: 'W/"already-read"', decision: 'keep-current' });
  await close(s);
  assert.equal(r.ok, true);
  assert.equal(r.useraction, 1);
  assert.equal(r.concurrency, 'etag');
  // no GET should have happened
  assert.equal(s.received.some((x) => x.method === 'GET'), false);
  const batchReq = s.received.find((x) => x.method === 'POST' && /\$batch/.test(x.url));
  assert.match(batchReq.body, /If-Match: W\/"already-read"/);
});

test('explicit sourceControlComponentId fetches etag before PATCHing', async () => {
  const rows = [{ sourcecontrolcomponentid: SCC, versionnumber: '13579' }];
  const s = await createServer({ rows, batchStatus: 200, batchBody: 'HTTP/1.1 204' });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, sourceControlComponentId: SCC, decision: 'keep-current' });
  await close(s);
  assert.equal(r.ok, true);
  assert.equal(r.etag, 'W/"13579"');
  assert.equal(r.concurrency, 'etag');
  assert.equal(s.received.some((x) => x.method === 'GET'), true);
  const batchReq = s.received.find((x) => x.method === 'POST' && /\$batch/.test(x.url));
  assert.match(batchReq.body, /If-Match: W\/"13579"/);
});

test('notFound when no conflict row and no explicit id', async () => {
  const s = await createServer({ rows: [] });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, componentId: COMP, decision: 'accept-incoming' });
  await close(s);
  assert.equal(r.ok, false);
  assert.equal(r.notFound, true);
});

test('inner PATCH failure inside a 200 $batch is surfaced as not-ok', async () => {
  const rows = [{ sourcecontrolcomponentid: SCC, action: 3, useraction: 0, componentid: COMP, '@odata.etag': 'W/"2468"' }];
  const s = await createServer({ rows, batchStatus: 200, batchBody: 'HTTP/1.1 412 Precondition Failed' });
  const r = await resolveGitConflictUserAction({ envUrl: url(s), token: 't', solutionId: SOL, componentId: COMP, decision: 'accept-incoming' });
  await close(s);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.statusCode, 412);
  assert.match(r.error, /changed since it was read \(412\)/);
});
