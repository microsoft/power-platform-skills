'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { validateNoSharedComponents } = require('../lib/validate-no-shared-components');

function createTestServer(responses) {
  const list = Array.isArray(responses) ? responses : [responses];
  let i = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const r = list[Math.min(i, list.length - 1)];
      i++;
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function serverUrl(s) { const { address, port } = s.address(); return `http://${address}:${port}`; }

// ===== validateNoSharedComponents =====

test('errors if --solutionUniqueName missing', async () => {
  const r = await validateNoSharedComponents({ envUrl: 'http://x', token: 't' });
  assert.ok(r.error);
  assert.match(r.error, /solutionUniqueName/i);
});

test('errors if target solution not in bound solutions list', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 's1', uniquename: 'Other' }] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'NotBound',
    });
    assert.ok(r.error);
    assert.match(r.error, /not found among Git-bound/i);
  } finally { server.close(); }
});

test('approves when target is only bound solution (others=[])', async () => {
  const server = await createTestServer([
    // listBoundSolutions
    { status: 200, body: { value: [{ solutionid: 's1', uniquename: 'Target' }] } },
    // target components
    { status: 200, body: { value: [{ objectid: 'a', componenttype: 1 }] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocking, []);
    assert.equal(r.boundSolutions.length, 1);
  } finally { server.close(); }
});

test('approves when other solutions exist but no shared components', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [
      { solutionid: 's1', uniquename: 'Target' },
      { solutionid: 's2', uniquename: 'Other' },
    ] } },
    // target components
    { status: 200, body: { value: [{ objectid: 'a', componenttype: 1 }, { objectid: 'b', componenttype: 1 }] } },
    // other components — disjoint
    { status: 200, body: { value: [{ objectid: 'c', componenttype: 1 }, { objectid: 'd', componenttype: 1 }] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocking, []);
    assert.equal(r.totalChecked, 4);
  } finally { server.close(); }
});

test('flags each overlapping component as a BLOCKER citing the other solution', async () => {
  const server = await createTestServer([
    { status: 200, body: { value: [
      { solutionid: 's1', uniquename: 'Target' },
      { solutionid: 's2', uniquename: 'Other' },
    ] } },
    // target components
    { status: 200, body: { value: [
      { objectid: 'shared1', componenttype: 1 },
      { objectid: 'shared2', componenttype: 10 },
      { objectid: 'local', componenttype: 1 },
    ] } },
    // other components — 2 overlaps + 1 unique
    { status: 200, body: { value: [
      { objectid: 'shared1', componenttype: 1 },
      { objectid: 'shared2', componenttype: 10 },
      { objectid: 'unique', componenttype: 1 },
    ] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
    });
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 2);
    const ids = r.blocking.map((b) => b.details.objectId).sort();
    assert.deepEqual(ids, ['shared1', 'shared2']);
    assert.equal(r.blocking[0].severity, 'blocker');
    assert.equal(r.blocking[0].ref, 'IL-009');
    assert.equal(r.blocking[0].details.otherSolutionUniqueName, 'Other');
    assert.match(r.blocking[0].remediation, /Remove/);
  } finally { server.close(); }
});

test('skips with info finding when other-solutions count exceeds limit', async () => {
  const others = Array.from({ length: 6 }, (_, i) => ({ solutionid: `o${i}`, uniquename: `Other${i}` }));
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 's1', uniquename: 'Target' }, ...others] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
      maxOtherSolutions: 5,
    });
    assert.equal(r.ok, true);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.info.length, 1);
    assert.equal(r.info[0].key, 'shared-components-skipped-too-many-solutions');
    assert.equal(r.info[0].details.otherCount, 6);
  } finally { server.close(); }
});

test('falls back to enabledforsourcecontrolintegration filter on 400 from isgitintegrationenabled', async () => {
  const server = await createTestServer([
    // first attempt: 400 (column unrecognised)
    { status: 400, body: { error: { message: 'unknown column isgitintegrationenabled' } } },
    // second attempt: 200 with target
    { status: 200, body: { value: [{ solutionid: 's1', uniquename: 'Target' }] } },
    { status: 200, body: { value: [] } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
    });
    assert.equal(r.ok, true);
  } finally { server.close(); }
});

test('truncates target component list when count exceeds maxTargetComponents (info finding)', async () => {
  // Generate 10 target components but cap at 3 so an info finding fires.
  const targetRows = Array.from({ length: 10 }, (_, i) => ({ objectid: `t${i}`, componenttype: 1 }));
  const server = await createTestServer([
    { status: 200, body: { value: [{ solutionid: 's1', uniquename: 'Target' }] } },
    { status: 200, body: { value: targetRows } },
  ]);
  try {
    const r = await validateNoSharedComponents({
      envUrl: serverUrl(server), token: 'tok',
      solutionUniqueName: 'Target',
      maxTargetComponents: 3,
    });
    assert.equal(r.ok, true);
    assert.ok(r.info.find((f) => f.key === 'shared-components-target-truncated'));
  } finally { server.close(); }
});
