'use strict';
// The read-only manifest view of the managed binding store (lib/managed-bindings.js managedManifestView): what verify and
// download may read. It lists only committed, usable groups; it keeps a declaration exactly (an explicit false is not an
// absent option); it never writes; and a manifest copied into a workspace is not a binding store, so it authorizes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { openManagedBindings, managedManifestView, CODES } = require('../lib/managed-bindings.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const H = (c) => c.repeat(64);
const TABLE = { type: 'table', table: 'account' };
const open = (dir) => openManagedBindings({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL });
const rec = (kind, key, id) => ({ formatVersion: 1, appUniqueName: APP, environmentFingerprint: FP, kind, key, id, intentSha256: H('a'), origin: 'created' });
const PROOF = { savedSha256: H('1'), semanticSha256: H('2'), preservationSha256: H('3'), expectedChildrenSha256: null };

function settle(store, key, id, declaration) {
  const { committed } = store.readGroup('form', key);
  const base = committed ? committed.generation : null;
  const token = store.prepareAttempt({ family: 'form', key, baseGeneration: base, root: { kind: 'form', key, id }, knownScopes: [TABLE], declarationSha256: H('e') });
  store.markSending(token, { proofVersion: 1, proofSchema: 'form-v1', rootId: id, baseProofSha256: null, sentProjectionSha256: H('b'), preservationSha256: H('c'), baseObservation: null, children: [] });
  store.noteSaved(token, { proof: null, acknowledgedRoot: true });
  return store.commitGroup({ token, baseGeneration: base, records: [rec('form', key, id)], proof: PROOF, consumerState: { declaration, children: {}, proofSchema: 'form-v1' }, publication: { scope: TABLE, state: 'not-needed', desiredSha256: null, dispatchToken: null } });
}

const MAIN = '11111111-1111-4111-8111-111111111111';
const QUICK = '22222222-2222-4222-8222-222222222222';

test('the manifest lists committed groups with their declarations exactly: an explicit false is kept apart from an absent option', () => {
  const store = open(makeTempDir('mm-options-'));
  settle(store, 'account/main', MAIN, { name: 'Main', fieldOptions: { name: { required: false }, phone: { required: true } } });
  settle(store, 'account/quick', QUICK, { name: 'Quick', fieldOptions: { name: {} } });
  const view = managedManifestView(open(path.dirname(store.file)).snapshot());
  const byKey = Object.fromEntries(view.groups.map((g) => [g.key, g]));
  assert.deepEqual(byKey['account/main'].declaration.fieldOptions, { name: { required: false }, phone: { required: true } });
  assert.equal(Object.hasOwn(byKey['account/quick'].declaration.fieldOptions.name, 'required'), false, 'absent stays absent');
  assert.deepEqual(view.pending, []);
});

test('a pending group is listed as pending and not as a verifiable group; building the view writes nothing', () => {
  const dir = makeTempDir('mm-pending-');
  const store = open(dir);
  const g = settle(store, 'account/main', MAIN, { name: 'Main' });
  store.prepareAttempt({ family: 'form', key: 'account/main', baseGeneration: g.generation, root: g.root, knownScopes: [TABLE], declarationSha256: H('f') });
  const before = [fs.readdirSync(dir).sort(), fs.readFileSync(store.file, 'utf8'), fs.statSync(store.file).mtimeMs];
  const view = managedManifestView(store.snapshot());
  assert.deepEqual(view.groups, []);
  assert.deepEqual(view.pending, [{ family: 'form', key: 'account/main', code: CODES.pending }]);
  assert.deepEqual([fs.readdirSync(dir).sort(), fs.readFileSync(store.file, 'utf8'), fs.statSync(store.file).mtimeMs], before);
  assert.deepEqual(managedManifestView(null), { revision: 0, groups: [], pending: [], invalid: [] });
});

test('a manifest copied into a workspace binds nothing: beside the store it is ignored, in the store\'s place it is unreadable', () => {
  const source = open(makeTempDir('mm-source-'));
  settle(source, 'account/main', MAIN, { name: 'Main' });
  const manifest = JSON.stringify(managedManifestView(source.snapshot()), null, 2);

  const target = makeTempDir('mm-target-');
  fs.writeFileSync(path.join(target, 'managed-manifest.json'), manifest);
  const fresh = open(target);
  assert.equal(fresh.lookup('form', 'account/main'), null);
  assert.deepEqual(managedManifestView(fresh.snapshot()).groups, []);

  fs.writeFileSync(fresh.file, manifest);
  let code = null;
  try { open(target); } catch (e) { code = e.code; }
  assert.equal(code, CODES.unreadable);
});
