'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bumpSolutionVersion,
  bumpPatchSegment,
  parseVersionToSegments,
  compareVersions,
} = require('../lib/bump-solution-version');

test('bumpPatchSegment increments the 4th segment', () => {
  assert.equal(bumpPatchSegment('1.0.0.2'), '1.0.0.3');
  assert.equal(bumpPatchSegment('2.7.13.99'), '2.7.13.100');
  assert.equal(bumpPatchSegment('1.0.0.9'), '1.0.0.10'); // not lexical
});

test('bumpPatchSegment pads missing trailing segments with zero', () => {
  assert.equal(bumpPatchSegment('1'), '1.0.0.1');
  assert.equal(bumpPatchSegment('1.0'), '1.0.0.1');
  assert.equal(bumpPatchSegment('1.2.3'), '1.2.3.1');
});

test('bumpPatchSegment rejects more than 4 segments', () => {
  assert.throws(() => bumpPatchSegment('1.0.0.0.0'), /more than 4 segments/);
});

test('bumpPatchSegment rejects non-numeric or negative segments', () => {
  assert.throws(() => bumpPatchSegment('1.0.0.a'), /not a non-negative integer/);
  assert.throws(() => bumpPatchSegment('1.0.-1.0'), /not a non-negative integer/);
  assert.throws(() => bumpPatchSegment(''), /version is required/);
  assert.throws(() => bumpPatchSegment(null), /version is required/);
});

test('bumpSolutionVersion requires envUrl and one of uniqueName/solutionId', async () => {
  await assert.rejects(
    () => bumpSolutionVersion({ uniqueName: 'Foo', token: 't' }),
    /--envUrl is required/
  );
  await assert.rejects(
    () => bumpSolutionVersion({ envUrl: 'https://org.crm.dynamics.com', token: 't' }),
    /--uniqueName or --solutionId is required/
  );
});

test('bumpSolutionVersion resolves by uniqueName, PATCHes, returns { previous, next }', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    if (req.method === 'PATCH') {
      return { statusCode: 204, body: '', headers: {} };
    }
    // GET solutions list (verifySolutionExists)
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{
          solutionid: 'sol-1234',
          uniquename: 'ContosoSite',
          version: '1.0.0.2',
          ismanaged: false,
        }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'ContosoSite',
    token: 'fake',
  });

  assert.equal(result.bumped, true);
  assert.equal(result.solutionId, 'sol-1234');
  assert.equal(result.uniqueName, 'ContosoSite');
  assert.equal(result.previous, '1.0.0.2');
  assert.equal(result.next, '1.0.0.3');

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'PATCH call must have been made');
  assert.ok(patch.url.includes('solutions(sol-1234)'));
  assert.equal(patch.headers['If-Match'], '*');
  assert.equal(JSON.parse(patch.body).version, '1.0.0.3');
});

test('bumpSolutionVersion resolves by solutionId via direct GET', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    if (req.method === 'PATCH') return { statusCode: 204, body: '', headers: {} };
    // GET solutions(<id>)
    return {
      statusCode: 200,
      body: JSON.stringify({
        solutionid: 'sol-1234',
        uniquename: 'ContosoSite',
        version: '2.0.0.5',
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    solutionId: 'sol-1234',
    token: 'fake',
  });

  assert.equal(result.previous, '2.0.0.5');
  assert.equal(result.next, '2.0.0.6');
  assert.equal(calls[0].method || 'GET', 'GET');
  assert.ok(calls[0].url.includes('solutions(sol-1234)'));
});

test('bumpSolutionVersion --dryRun does not PATCH and returns bumped:false', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1234', uniquename: 'X', version: '1.0.0.7', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'X',
    token: 'fake',
    dryRun: true,
  });

  assert.equal(result.bumped, false);
  assert.equal(result.previous, '1.0.0.7');
  assert.equal(result.next, '1.0.0.8');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('bumpSolutionVersion surfaces 404 on unknown solutionId', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 404, body: '{}' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      solutionId: 'sol-missing',
      token: 'fake',
    }),
    /not found/
  );
});

test('bumpSolutionVersion surfaces non-204 PATCH responses', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async (req) => {
    if (req.method === 'PATCH') {
      return { statusCode: 412, body: '{"error":{"message":"version mismatch"}}' };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1234', uniquename: 'X', version: '1.0.0.0', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      uniqueName: 'X',
      token: 'fake',
    }),
    /Version PATCH returned 412/
  );
});

test('parseVersionToSegments pads + validates the same way bumpPatchSegment does', () => {
  assert.deepEqual(parseVersionToSegments('1.0.0.2'), [1, 0, 0, 2]);
  assert.deepEqual(parseVersionToSegments('1.2.3'), [1, 2, 3, 0]);
  assert.deepEqual(parseVersionToSegments('1'), [1, 0, 0, 0]);
  assert.throws(() => parseVersionToSegments('1.0.0.a'), /not a non-negative integer/);
  assert.throws(() => parseVersionToSegments('1.0.0.0.0'), /more than 4 segments/);
  assert.throws(() => parseVersionToSegments(''), /version is required/);
});

test('compareVersions compares segment-wise as integers (not lexically)', () => {
  // The canary case — string comparison would say '1.0.0.9' > '1.0.0.10' (true!),
  // i.e. label v1.0.0.10 as a downgrade from v1.0.0.9. Integer comparison gets it right.
  assert.equal(compareVersions('1.0.0.9', '1.0.0.10'), -1);
  assert.equal(compareVersions('1.0.0.10', '1.0.0.9'), 1);

  // Equal versions
  assert.equal(compareVersions('1.0.0.2', '1.0.0.2'), 0);
  assert.equal(compareVersions('2.0.0.0', '2.0.0.0'), 0);

  // Major / minor / build segments dominate
  assert.equal(compareVersions('2.0.0.0', '1.99.99.99'), 1);
  assert.equal(compareVersions('1.0.0.0', '1.0.1.0'), -1);
  assert.equal(compareVersions('1.1.0.0', '1.0.99.99'), 1);

  // Pads with zero — '1.0.0' should equal '1.0.0.0'
  assert.equal(compareVersions('1.0.0', '1.0.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0.1'), -1);

  // Integer arithmetic across multiple ten-crossings
  assert.equal(compareVersions('1.0.10.0', '1.0.9.99'), 1);
  assert.equal(compareVersions('1.10.0.0', '1.9.99.99'), 1);
});

test('compareVersions rejects malformed input on either side', () => {
  assert.throws(() => compareVersions('1.0.0.a', '1.0.0.0'), /not a non-negative integer/);
  assert.throws(() => compareVersions('1.0.0.0', '1.0.0.a'), /not a non-negative integer/);
  assert.throws(() => compareVersions('', '1.0.0.0'), /version is required/);
});

test('bumpSolutionVersion surfaces unknown uniqueName before any PATCH', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    // verifySolutionExists returns empty value array
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      uniqueName: 'Nope',
      token: 'fake',
    }),
    /not found in/
  );
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

// ── updateManifestVersion ─────────────────────────────────────────────────────

const { updateManifestVersion } = require('../lib/bump-solution-version');
const fs = require('fs');
const os = require('os');
const pathlib = require('path');

function makeProjectDir(t) {
  const dir = fs.mkdtempSync(pathlib.join(os.tmpdir(), 'bump-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('updateManifestVersion updates single-solution manifest by solutionId', (t) => {
  const root = makeProjectDir(t);
  const manifest = {
    schemaVersion: 1,
    solution: { uniqueName: 'ContosoSite', solutionId: 'sol-1', version: '1.0.0.2' },
  };
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), JSON.stringify(manifest, null, 2));

  const result = updateManifestVersion(root, { solutionId: 'sol-1', uniqueName: null, nextVersion: '1.0.0.3' });

  assert.equal(result.updated, true);
  const after = JSON.parse(fs.readFileSync(pathlib.join(root, '.solution-manifest.json'), 'utf8'));
  assert.equal(after.solution.version, '1.0.0.3');
  // Other fields preserved
  assert.equal(after.solution.uniqueName, 'ContosoSite');
  assert.equal(after.solution.solutionId, 'sol-1');
  assert.equal(after.schemaVersion, 1);
});

test('updateManifestVersion updates multi-solution manifest by matching solutionId', (t) => {
  const root = makeProjectDir(t);
  const manifest = {
    schemaVersion: 2,
    solutions: [
      { uniqueName: 'Site_Core', solutionId: 'sol-1', version: '1.0.0.2' },
      { uniqueName: 'Site_WebAssets', solutionId: 'sol-2', version: '1.0.0.5' },
      { uniqueName: 'Site_Future', solutionId: 'sol-3', version: '1.0.0.0' },
    ],
  };
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), JSON.stringify(manifest, null, 2));

  const result = updateManifestVersion(root, { solutionId: 'sol-2', uniqueName: null, nextVersion: '1.0.0.6' });

  assert.equal(result.updated, true);
  const after = JSON.parse(fs.readFileSync(pathlib.join(root, '.solution-manifest.json'), 'utf8'));
  // Only the matching entry updated
  assert.equal(after.solutions[0].version, '1.0.0.2', 'non-matching entry preserved');
  assert.equal(after.solutions[1].version, '1.0.0.6', 'matching entry bumped');
  assert.equal(after.solutions[2].version, '1.0.0.0', 'non-matching entry preserved');
});

test('updateManifestVersion falls back to uniqueName when solutionId not present in manifest', (t) => {
  const root = makeProjectDir(t);
  const manifest = {
    schemaVersion: 1,
    solution: { uniqueName: 'ContosoSite', version: '1.0.0.2' },  // no solutionId in manifest
  };
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), JSON.stringify(manifest, null, 2));

  const result = updateManifestVersion(root, { solutionId: 'sol-1', uniqueName: 'ContosoSite', nextVersion: '1.0.0.3' });

  assert.equal(result.updated, true);
  const after = JSON.parse(fs.readFileSync(pathlib.join(root, '.solution-manifest.json'), 'utf8'));
  assert.equal(after.solution.version, '1.0.0.3');
});

test('updateManifestVersion is a no-op when no matching entry found (writes nothing)', (t) => {
  const root = makeProjectDir(t);
  const manifest = {
    schemaVersion: 1,
    solution: { uniqueName: 'OtherSite', solutionId: 'sol-other', version: '1.0.0.0' },
  };
  const initialContent = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), initialContent);

  const result = updateManifestVersion(root, { solutionId: 'sol-nomatch', uniqueName: 'AlsoNoMatch', nextVersion: '1.0.0.1' });

  assert.equal(result.updated, false);
  assert.equal(result.reason, 'no-matching-entry');
  // File untouched
  assert.equal(fs.readFileSync(pathlib.join(root, '.solution-manifest.json'), 'utf8'), initialContent);
});

test('updateManifestVersion silently handles missing manifest', (t) => {
  const root = makeProjectDir(t);
  // No .solution-manifest.json
  const result = updateManifestVersion(root, { solutionId: 'sol-1', uniqueName: 'X', nextVersion: '1.0.0.3' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'no-manifest');
});

test('updateManifestVersion silently handles missing projectRoot', () => {
  const result = updateManifestVersion(null, { solutionId: 'sol-1', uniqueName: 'X', nextVersion: '1.0.0.3' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'no-projectRoot');
});

test('updateManifestVersion silently handles unparseable manifest', (t) => {
  const root = makeProjectDir(t);
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), 'not-valid-json{{{');
  const result = updateManifestVersion(root, { solutionId: 'sol-1', uniqueName: 'X', nextVersion: '1.0.0.3' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'unparseable');
});

test('bumpSolutionVersion calls updateManifestVersion when --projectRoot is supplied', async (t) => {
  const helpers2 = require('../lib/validation-helpers');
  const orig = helpers2.makeRequest;
  helpers2.makeRequest = async (req) => {
    if (req.method === 'PATCH') return { statusCode: 204, body: '', headers: {} };
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1', uniquename: 'ContosoSite', version: '1.0.0.2', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers2.makeRequest = orig; });

  const root = makeProjectDir(t);
  fs.writeFileSync(pathlib.join(root, '.solution-manifest.json'), JSON.stringify({
    solution: { uniqueName: 'ContosoSite', solutionId: 'sol-1', version: '1.0.0.2' },
  }, null, 2));

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'ContosoSite',
    token: 'fake',
    projectRoot: root,
  });

  assert.equal(result.bumped, true);
  assert.equal(result.next, '1.0.0.3');
  assert.equal(result.manifestUpdated, true);
  // Manifest reflects the bump
  const manifestAfter = JSON.parse(fs.readFileSync(pathlib.join(root, '.solution-manifest.json'), 'utf8'));
  assert.equal(manifestAfter.solution.version, '1.0.0.3');
});

test('bumpSolutionVersion does NOT update manifest when --projectRoot is omitted', async (t) => {
  const helpers2 = require('../lib/validation-helpers');
  const orig = helpers2.makeRequest;
  helpers2.makeRequest = async (req) => {
    if (req.method === 'PATCH') return { statusCode: 204, body: '', headers: {} };
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1', uniquename: 'ContosoSite', version: '1.0.0.2', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers2.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'ContosoSite',
    token: 'fake',
    // no projectRoot
  });

  assert.equal(result.bumped, true);
  assert.equal(result.manifestUpdated, false);
  assert.equal(result.manifestUpdateReason, 'no-projectRoot');
});
