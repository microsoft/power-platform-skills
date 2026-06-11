'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateSolutionVersionBumped, countNonTrivialPending } = require('../lib/validate-solution-version-bumped');

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

function mkTmp(content) {
  const p = path.join(os.tmpdir(), `vsvb-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return p;
}

// ===== countNonTrivialPending =====

test('countNonTrivialPending counts items array', () => {
  assert.equal(countNonTrivialPending([{}, {}, {}]), 3);
  assert.equal(countNonTrivialPending([]), 0);
  assert.equal(countNonTrivialPending(null), 0);
});

// ===== validateSolutionVersionBumped =====

test('errors if --solutionUniqueName missing', async () => {
  const r = await validateSolutionVersionBumped({ envUrl: 'http://x', token: 't' });
  assert.ok(r.error);
});

test('errors when solution not found in env', async () => {
  const server = await createTestServer({ status: 200, body: { value: [] } });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'Missing',
    });
    assert.ok(r.error);
    assert.match(r.error, /not found/i);
  } finally { server.close(); }
});

test('skips with info finding when no prior baseline file', async () => {
  const server = await createTestServer({
    status: 200, body: { value: [{ solutionid: 's1', uniquename: 'X', version: '1.0.0.0' }] },
  });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'X',
      lastValidationFile: '/nonexistent-' + Date.now(),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.info[0].key, 'version-bump-no-prior-baseline');
    assert.equal(r.scope.current, '1.0.0.0');
    assert.equal(r.scope.lastCommitted, null);
  } finally { server.close(); }
});

test('warns when version unchanged AND pending changes > 0', async () => {
  const server = await createTestServer({
    status: 200, body: { value: [{ solutionid: 's1', uniquename: 'X', version: '1.0.0.0' }] },
  });
  const lvFile = mkTmp({ lastCommittedSolutionVersion: '1.0.0.0' });
  const pendingFile = mkTmp({ items: [{ componentId: 'a' }, { componentId: 'b' }] });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'X',
      lastValidationFile: lvFile,
      pendingFile,
    });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].severity, 'warn');
    assert.equal(r.warnings[0].key, 'solution-version-not-bumped');
    assert.equal(r.warnings[0].details.currentVersion, '1.0.0.0');
    assert.equal(r.warnings[0].details.lastCommittedVersion, '1.0.0.0');
    assert.equal(r.warnings[0].details.pendingNonTrivialCount, 2);
    assert.match(r.warnings[0].remediation, /Maker Portal/);
  } finally { server.close(); fs.unlinkSync(lvFile); fs.unlinkSync(pendingFile); }
});

test('no warning when version has been bumped since last commit', async () => {
  const server = await createTestServer({
    status: 200, body: { value: [{ solutionid: 's1', uniquename: 'X', version: '1.0.0.1' }] },
  });
  const lvFile = mkTmp({ lastCommittedSolutionVersion: '1.0.0.0' });
  const pendingFile = mkTmp({ items: [{ componentId: 'a' }] });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'X',
      lastValidationFile: lvFile, pendingFile,
    });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0);
  } finally { server.close(); fs.unlinkSync(lvFile); fs.unlinkSync(pendingFile); }
});

test('no warning when version unchanged but pending changes count is 0', async () => {
  const server = await createTestServer({
    status: 200, body: { value: [{ solutionid: 's1', uniquename: 'X', version: '1.0.0.0' }] },
  });
  const lvFile = mkTmp({ lastCommittedSolutionVersion: '1.0.0.0' });
  const pendingFile = mkTmp({ items: [] });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'X',
      lastValidationFile: lvFile, pendingFile,
    });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0);
  } finally { server.close(); fs.unlinkSync(lvFile); fs.unlinkSync(pendingFile); }
});

test('returns {error} on Dataverse HTTP failure', async () => {
  const server = await createTestServer({ status: 500, body: { error: { message: 'boom' } } });
  try {
    const r = await validateSolutionVersionBumped({
      envUrl: serverUrl(server), token: 'tok', solutionUniqueName: 'X',
    });
    assert.ok(r.error);
    assert.equal(r.statusCode, 500);
  } finally { server.close(); }
});
