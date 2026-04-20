'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveTargetSolution,
  NoSolutionConfiguredError,
  NO_SOLUTION_HINT,
} = require('../lib/resolve-target-solution');

function mkProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-target-solution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeManifest(dir, solutionBlock) {
  fs.writeFileSync(
    path.join(dir, '.solution-manifest.json'),
    JSON.stringify({ solution: solutionBlock }, null, 2)
  );
}

test('explicit arg wins over a present manifest', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, {
    uniqueName: 'FromManifest',
    solutionId: 'sol-manifest',
    version: '1.0.0.0',
  });

  const r = await resolveTargetSolution({
    explicit: 'FromArg',
    projectRoot,
  });
  assert.equal(r.solutionUniqueName, 'FromArg');
  assert.equal(r.source, 'arg');
  assert.equal(r.solutionId, undefined, 'arg path does not know the id unless verified');
});

test('falls through to manifest when no explicit arg', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, {
    uniqueName: 'FromManifest',
    solutionId: 'sol-manifest',
    version: '1.0.0.3',
  });
  const r = await resolveTargetSolution({ projectRoot });
  assert.equal(r.solutionUniqueName, 'FromManifest');
  assert.equal(r.source, 'manifest');
  assert.equal(r.solutionId, 'sol-manifest');
  assert.equal(r.version, '1.0.0.3');
  assert.match(r.manifestPath, /\.solution-manifest\.json$/);
});

test('walks up parent directories to find the manifest', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, { uniqueName: 'WalkedUp', solutionId: 'id' });
  const nested = path.join(projectRoot, 'src', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  const r = await resolveTargetSolution({ projectRoot: nested });
  assert.equal(r.solutionUniqueName, 'WalkedUp');
  assert.equal(r.source, 'manifest');
});

test('throws NoSolutionConfiguredError when nothing resolves', async (t) => {
  const projectRoot = mkProject(t); // no manifest written
  // Use a projectRoot that will not find any ancestor manifest in the temp dir.
  await assert.rejects(
    resolveTargetSolution({ projectRoot }),
    (err) => {
      assert.ok(err instanceof NoSolutionConfiguredError, 'should be NoSolutionConfiguredError');
      assert.equal(err.hint, NO_SOLUTION_HINT);
      return true;
    }
  );
});

test('rejects a malformed .solution-manifest.json with a helpful error', async (t) => {
  const projectRoot = mkProject(t);
  fs.writeFileSync(path.join(projectRoot, '.solution-manifest.json'), '{not valid json');
  await assert.rejects(
    resolveTargetSolution({ projectRoot }),
    /\.solution-manifest\.json.*could not be parsed/
  );
});

test('manifest missing solution.uniqueName is treated as absent', async (t) => {
  const projectRoot = mkProject(t);
  // Manifest exists but is missing the expected `solution.uniqueName` field.
  fs.writeFileSync(
    path.join(projectRoot, '.solution-manifest.json'),
    JSON.stringify({ publisher: { uniqueName: 'somepublisher' } })
  );
  await assert.rejects(
    resolveTargetSolution({ projectRoot }),
    NoSolutionConfiguredError
  );
});

test('verifyExists enriches the arg-path result with solutionId + version', async (t) => {
  const makeRequest = async ({ url }) => {
    assert.match(url, /uniquename eq 'MySolution'/);
    assert.match(url, /\/api\/data\/v9\.2\/solutions/);
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [
          {
            solutionid: 'sol-123',
            uniquename: 'MySolution',
            version: '2.0.0.0',
            ismanaged: false,
          },
        ],
      }),
    };
  };
  const r = await resolveTargetSolution({
    explicit: 'MySolution',
    envUrl: 'https://e.example.com',
    token: 't',
    verifyExists: true,
    makeRequest,
  });
  assert.equal(r.source, 'arg');
  assert.equal(r.solutionId, 'sol-123');
  assert.equal(r.version, '2.0.0.0');
  assert.equal(r.ismanaged, false);
});

test('verifyExists throws when explicit solution is not found', async (t) => {
  const makeRequest = async () => ({ statusCode: 200, body: '{"value":[]}' });
  await assert.rejects(
    resolveTargetSolution({
      explicit: 'Missing',
      envUrl: 'https://e.example.com',
      token: 't',
      verifyExists: true,
      makeRequest,
    }),
    /"Missing" not found/
  );
});

test('verifyExists throws when manifest references a stale solution', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, {
    uniqueName: 'StaleSol',
    solutionId: 'old-id',
    version: '1.0.0.0',
  });
  const makeRequest = async () => ({ statusCode: 200, body: '{"value":[]}' });
  await assert.rejects(
    resolveTargetSolution({
      projectRoot,
      envUrl: 'https://e.example.com',
      token: 't',
      verifyExists: true,
      makeRequest,
    }),
    /manifest may be stale/
  );
});

test('verifyExists prefers live solutionId + version over stale manifest values', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, {
    uniqueName: 'Refreshed',
    solutionId: 'STALE-ID',
    version: '1.0.0.0',
  });
  const makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      value: [{ solutionid: 'LIVE-ID', uniquename: 'Refreshed', version: '1.0.0.5', ismanaged: false }],
    }),
  });
  const r = await resolveTargetSolution({
    projectRoot,
    envUrl: 'https://e.example.com',
    token: 't',
    verifyExists: true,
    makeRequest,
  });
  assert.equal(r.solutionId, 'LIVE-ID');
  assert.equal(r.version, '1.0.0.5');
});

test('verifyExists rejects solution names with OData-injection characters', async () => {
  // Invalid characters (apostrophes, spaces, '=') must cause a hard error up front —
  // silently stripping them would convert a typo into a confusing "not found" and
  // could mask an attacker's input. No HTTP request should be issued.
  let captured = null;
  const makeRequest = async ({ url }) => {
    captured = url;
    return { statusCode: 200, body: '{"value":[]}' };
  };
  await assert.rejects(
    resolveTargetSolution({
      explicit: "MySolution' or '1'='1",
      envUrl: 'https://e.example.com',
      token: 't',
      verifyExists: true,
      makeRequest,
    }),
    /Invalid solution unique name/
  );
  assert.strictEqual(captured, null, 'no HTTP request should have been made');
});

test('verifyExists throws when envUrl is missing', async () => {
  await assert.rejects(
    resolveTargetSolution({ explicit: 'X', verifyExists: true }),
    /verifyExists.*requires envUrl/
  );
});

test('explicit arg with only whitespace falls through to manifest', async (t) => {
  const projectRoot = mkProject(t);
  writeManifest(projectRoot, { uniqueName: 'FromManifest', solutionId: 'id' });
  const r = await resolveTargetSolution({ explicit: '   ', projectRoot });
  assert.equal(r.solutionUniqueName, 'FromManifest');
  assert.equal(r.source, 'manifest');
});
