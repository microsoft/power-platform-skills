'use strict';
// lib/throwaway-sdk.js: the bundled SDK over a throwaway workspace folder, removed whichever way the run ends. apps.js, list-tables.js and
// list-languages.js each wrote this out before it was one module; these tests make every thing that can go wrong go wrong, and look for the folder.
// The scripts' own tests drive the helper too (with the SDK and the client stubbed), and the real-bundle tests drive it with the real ones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const ENV = 'https://contoso.crm.dynamics.com';

// A stand-in for lib/maker-sdk.js and the az-token client that records what they are asked.
function stubs() {
  const made = [];
  const clients = [];
  return {
    made,
    clients,
    deps: {
      makerSdk: {
        createNodeWorkspaceStorage: (dir) => ({ dir }),
        createMakerSdk: (cfg) => { made.push(cfg); return { cfg }; },
      },
      createAzHttpClient: (env) => { const client = { marker: 'az-client', env }; clients.push(client); return client; },
    },
  };
}

// Every folder `fs.mkdtempSync` makes while `body` runs. Each test file runs in its own process, so patching `fs` here reaches nothing else.
async function trackingFolders(body) {
  const folders = [];
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...rest) => { const dir = mkdtemp(prefix, ...rest); folders.push(dir); return dir; };
  try {
    await body();
  } finally {
    fs.mkdtempSync = mkdtemp;
  }
  return folders;
}

test('make() builds SDKs over ONE folder under the OS temp directory, named by the prefix, for the origin, with ONE client — and the run\u2019s value is the answer', async () => {
  const { deps, made, clients } = stubs();
  let seen;
  const folders = await trackingFolders(async () => {
    const answer = await withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async (make) => {
      const reader = make();
      const writer = make({ languageCode: 3082 });
      seen = { exists: fs.existsSync(made[0].workspaceStorage.dir), reader, writer };
      return 'the answer';
    });
    assert.strictEqual(answer, 'the answer');
  });
  assert.strictEqual(folders.length, 1);
  assert.strictEqual(seen.exists, true, 'the folder exists while the run is going');
  assert.strictEqual(path.dirname(folders[0]), os.tmpdir());
  assert.ok(path.basename(folders[0]).startsWith('probe-'), 'the prefix says whose folder it was');
  assert.deepStrictEqual(made.map((cfg) => cfg.workspaceStorage.dir), [folders[0], folders[0]], 'one folder for both');
  assert.deepStrictEqual(made.map((cfg) => cfg.instanceUrl), [ENV, ENV]);
  assert.deepStrictEqual(clients.map((c) => c.env), [ENV], 'the client is built once, for the origin');
  assert.ok(made.every((cfg) => cfg.httpClient === clients[0]), 'and it serves every instance');
  assert.deepStrictEqual(made.map((cfg) => cfg.languageCode), [undefined, 3082], 'a construction option of the SDK is what make(extra) is for');
});

test('a client given is used as it is, and none is made', async () => {
  const { deps, made, clients } = stubs();
  const given = { marker: 'the caller\u2019s' };
  await withThrowawaySdk({ env: ENV, prefix: 'probe-', httpClient: given, deps }, async (make) => { make(); });
  assert.strictEqual(made[0].httpClient, given);
  assert.deepStrictEqual(clients, []);
});

test('the folder is removed after a run, with what the run put in it, and after a run that throws — the error is the run\u2019s own', async () => {
  const { deps } = stubs();
  const folders = await trackingFolders(async () => {
    await withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async (make) => {
      const { dir } = make().cfg.workspaceStorage;
      fs.mkdirSync(path.join(dir, 'apps', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps', 'deep', 'app.json'), '{}');
    });
    const failure = new Error('the run failed');
    await assert.rejects(withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async (make) => { make(); throw failure; }), (err) => err === failure);
    await assert.rejects(withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, () => Promise.reject(new Error('rejected before any SDK was made'))), /rejected before any SDK was made/);
  });
  assert.strictEqual(folders.length, 3);
  for (const dir of folders) assert.strictEqual(fs.existsSync(dir), false, dir);
});

test('an SDK the SDK module cannot make, a module that cannot be loaded and a client that cannot be built each leave no folder', async () => {
  const broken = {
    'a constructor that throws': () => ({ deps: { ...stubs().deps, makerSdk: { createNodeWorkspaceStorage: () => ({}), createMakerSdk: () => { throw new Error('the SDK will not be made'); } } }, message: /the SDK will not be made/ }),
    'a storage that cannot be built': () => ({ deps: { ...stubs().deps, makerSdk: { createNodeWorkspaceStorage: () => { throw new Error('no storage'); }, createMakerSdk: () => ({}) } }, message: /no storage/ }),
    'a module that cannot be loaded': () => ({ deps: { ...stubs().deps, makerSdk: { get createMakerSdk() { throw new Error('the SDK module is broken'); }, createNodeWorkspaceStorage: () => ({}) } }, message: /the SDK module is broken/ }),
    'a client that cannot be built': () => ({ deps: { ...stubs().deps, createAzHttpClient: () => { throw new Error('no client for this origin'); } }, message: /no client for this origin/ }),
  };
  for (const [what, make] of Object.entries(broken)) {
    const { deps, message } = make();
    const folders = await trackingFolders(async () => {
      // The construction happens when make() is called inside the run, and the module and the client are met before the run is.
      await assert.rejects(withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async (build) => build()), message, what);
    });
    assert.strictEqual(folders.length, 1, what);
    assert.strictEqual(fs.existsSync(folders[0]), false, `${what}: removed`);
  }
});

test('apps.js, list-tables.js and list-languages.js make their SDK through the helper — none writes the folder lifecycle out again', () => {
  const { scriptsMatching } = require('./helpers/production-scripts.js');
  const users = scriptsMatching(/\bwithThrowawaySdk\(/);
  const ownFolders = scriptsMatching(/\bmkdtempSync\b/);
  for (const file of ['apps.js', 'list-tables.js', 'list-languages.js']) {
    assert.ok(users.includes(file), `${file} uses withThrowawaySdk`);
    assert.ok(!ownFolders.includes(file), `${file} makes no workspace folder of its own`);
  }
  assert.ok(ownFolders.includes('lib/throwaway-sdk.js'), 'the one place that does is the helper');
});

test('with nothing replaced it makes the real SDK through lib/maker-sdk.js and the az-token client for the origin: an origin that is not Dataverse\u2019s is refused, and the folder is gone', async () => {
  const folders = await trackingFolders(async () => {
    await withThrowawaySdk({ env: ENV, prefix: 'real-', httpClient: createAzHttpClient(ENV, { getToken: () => 'test-token', request: async () => { throw new Error('this read makes no request'); } }) }, async (make) => {
      const sdk = make();
      assert.strictEqual(typeof sdk.fetchArtifactList, 'function');
      assert.strictEqual(typeof sdk.dataverse.get, 'function', 'the SDK\u2019s own Dataverse client, which the scripts read through');
      assert.strictEqual(typeof sdk.findTables, 'function');
    });
    // No client is given, so the az-token client is made for this origin — which refuses one that is not an environment's.
    await assert.rejects(withThrowawaySdk({ env: 'https://example.com', prefix: 'real-' }, async (make) => make()), /Invalid Dataverse org URL/);
  });
  assert.strictEqual(folders.length, 2);
  for (const dir of folders) assert.strictEqual(fs.existsSync(dir), false, dir);
});

test('a folder that cannot be removed neither fails a run that finished nor hides the failure of one that did not', async () => {
  const { deps } = stubs();
  const rm = fs.rmSync;
  const folders = [];
  fs.rmSync = (target, ...rest) => { folders.push(target); throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
  try {
    assert.strictEqual(await withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async () => 'done'), 'done');
    await assert.rejects(withThrowawaySdk({ env: ENV, prefix: 'probe-', deps }, async () => { throw new Error('the run failed'); }), /^Error: the run failed$/);
  } finally {
    fs.rmSync = rm;
  }
  assert.strictEqual(folders.length, 2, 'removal was tried both times');
  for (const dir of folders) rm(dir, { recursive: true, force: true });
});
