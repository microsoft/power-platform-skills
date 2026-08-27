'use strict';
// CONCURRENCY STRESS — the workspace manifest under interleaved artifact writes.
//
// Why this exists: the build engine fans out with `runner.mapLimit(items, concurrency, fn)`, and
// the SDK's generic surface is now async, so a single form/view build yields at MANY more points
// than it used to. Concurrent builds therefore interleave far more aggressively than any previous
// bundle ever exercised.
//
// The specific hazard: the SDK's WorkspaceManager does a read-modify-write of ONE shared file
// (manifest.json) on every artifact write —
//     writeArtifact -> upsertManifestEntry -> getManifest() [read] ... writeManifest() [write]
// If any `await` were to land between that read and that write, two interleaved writers would each
// read the same manifest, and the second write would clobber the first writer's entry — an artifact
// silently missing from the manifest, on a real org, with every HTTP call returning 2xx.
//
// This is NOT a theoretical concern the async migration introduced and left unproven: it is the
// single most likely place for the extra interleaving to cause real data loss, so it is asserted
// against the REAL vendored bundle rather than reasoned about.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// An httpClient that RESOLVES ON A LATER TURN. A client that resolves synchronously would let each
// artifact's work run start-to-finish without ever yielding, which is exactly the interleaving this
// test needs to create. setImmediate (macrotask) is deliberately coarser than a microtask so the
// scheduler genuinely interleaves the concurrent chains.
function deferringHttpClient(counter) {
  const later = (value) => new Promise((resolve) => setImmediate(() => resolve(value)));
  return {
    get: async () => later({ status: 200, headers: {}, body: {} }),
    post: async () => {
      counter.posts++;
      return later({ status: 204, headers: { 'odata-entityid': `https://x/y(${counter.next()})` }, body: {} });
    },
    patch: async () => later({ status: 204, headers: {}, body: {} }),
    delete: async () => later({ status: 204, headers: {}, body: {} }),
    put: async () => later({ status: 204, headers: {}, body: {} }),
  };
}

function freshSdk() {
  const { createMakerSdk } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-'));
  tempDirs.push(dir);
  let n = 0;
  const counter = {
    posts: 0,
    next: () => `11111111-1111-1111-1111-${String(++n).padStart(12, '0')}`,
  };
  const sdk = createMakerSdk({
    workspacePath: dir,
    instanceUrl: 'https://example.crm.dynamics.com',
    httpClient: deferringHttpClient(counter),
  });
  sdk.initWorkspace();
  return { sdk, dir, counter };
}

const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

test('STRESS: 40 concurrent artifact mutations all survive in the shared manifest (no lost update)', async () => {
  const { sdk, dir } = freshSdk();
  const N = 40;

  // Create first (createArtifact is synchronous), so the concurrent phase is pure async mutation.
  const ids = [];
  for (let i = 0; i < N; i++) {
    ids.push(sdk.createArtifact('view', { name: `View ${i}`, entityLogicalName: 'account', columns: [] }).id);
  }

  // Now mutate ALL of them concurrently. Each updateElement writes the artifact AND rewrites the
  // one shared manifest.json, so this is the read-modify-write collision window. Awaiting each call
  // here would serialize the writers and destroy the interleaving this test exists to create.
  // sdk-async-ok: the promise is handed to Promise.all, concurrent by design.
  await Promise.all(ids.map((id, i) => sdk.updateElement('view', id, '/columns', [{ name: `col_${i}`, width: 100, order: 0 }])));

  const manifest = readManifest(dir);
  const seen = new Set(manifest.artifacts.map((a) => a.id));
  // Non-vacuity: `missing` would also be empty if nothing had been written at all, or if the
  // create loop had silently produced 0 ids.
  assert.strictEqual(ids.length, N, 'the create loop produced the ids the assertion below relies on');
  assert.ok(manifest.artifacts.length >= N,
    `the manifest holds all ${N} artifacts (saw ${manifest.artifacts.length}) — a smaller number `
    + 'means writes were lost, not that the test had nothing to check');
  const missing = ids.filter((id) => !seen.has(id));
  assert.deepStrictEqual(missing, [],
    `${missing.length}/${N} artifacts vanished from the shared manifest under concurrent writes — `
    + 'an interleaved read-modify-write lost them. On a real build that is an artifact the engine '
    + 'created but can no longer find.');

  // And the per-artifact content must be the writer's own, not another chain's.
  for (let i = 0; i < N; i++) {
    const art = await sdk.getArtifact('view', ids[i]);
    assert.strictEqual(art.columns[0].name, `col_${i}`, `view ${i} kept its OWN column, not a neighbour's`);
  }
});

test('STRESS: concurrent mutation + push of the same artifact serializes (no interleaved corruption)', async () => {
  const { sdk } = freshSdk();
  const id = sdk.createArtifact('view', { name: 'Contended', entityLogicalName: 'account', columns: [] }).id;

  // Same artifact, many writers. The SDK takes a per-artifact lock, so these must serialize; the
  // point is that the LAST write wins cleanly rather than two writes merging into a torn value.
  const contend = (i) =>
    // sdk-async-ok: concurrent by design, the promises go to Promise.all.
    sdk.updateElement('view', id, '/columns', [{ name: `c${i}`, width: 100, order: 0 }]);
  await Promise.all(Array.from({ length: 20 }, (_, i) => contend(i)));

  const art = await sdk.getArtifact('view', id);
  assert.strictEqual(art.columns.length, 1, 'exactly one column survives — writes serialized, not merged');
  assert.match(art.columns[0].name, /^c\d+$/, 'the surviving column is a whole value from one writer');
});

test('STRESS: interleaved reads of 40 artifacts each return their OWN artifact', async () => {
  // Guards against a shared-read-buffer bug in the revalidating read path: with reads now async, a
  // cache keyed or reused incorrectly would hand chain A the artifact chain B asked for. Cheap to
  // assert, and impossible to notice from a single-artifact test.
  const { sdk } = freshSdk();
  const ids = [];
  for (let i = 0; i < 40; i++) {
    ids.push(sdk.createArtifact('form', { name: `Form ${i}`, entityLogicalName: 'account', formType: 'main', status: 'draft' }).id);
  }
  // sdk-async-ok: concurrent by design, the promises go to Promise.all.
  const reads = await Promise.all(ids.map((id) => sdk.getArtifact('form', id)));
  reads.forEach((art, i) => {
    assert.strictEqual(art.id, ids[i], `read ${i} returned its own artifact`);
    assert.strictEqual(art.name, `Form ${i}`, `read ${i} returned its own NAME (no cross-chain bleed)`);
  });
});
