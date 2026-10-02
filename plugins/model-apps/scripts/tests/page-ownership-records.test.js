'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APP = 'contoso_pages';
const ENV_A = 'https://contoso.crm.dynamics.com';
const ENV_B = 'https://fabrikam.crm.dynamics.com';
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lib = () => require('../lib/page-ownership-records.js');

test('a JSON-named backup beside the records is not a record, and a record retired mid-read blocks nothing', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  const [record] = fs.readdirSync(dir);
  fs.copyFileSync(path.join(dir, record), path.join(dir, record.replace(/\.json$/, '.backup.json')));
  fs.writeFileSync(path.join(dir, 'page-ownership.notes.json'), '{"not":"a record"}');
  assert.equal(lib().readPageOwnership(dir, APP, ENV_A).created.length, 1, 'backups and look-alikes are ignored, not malformed records');
  assert.equal(lib().checkPageOwnershipClearable(dir).ok, false, 'the real record still blocks clearing');

  // A concurrent teardown retires a record between the listing and the read: the read sees ENOENT.
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function readFileSync(p, ...rest) {
    if (String(p).endsWith(record)) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return realRead.call(fs, p, ...rest);
  });
  assert.deepEqual(lib().readPageOwnership(dir, APP, ENV_A), { created: [], teardown: [] });
});

test('foreign-environment creation and teardown records supply no authority and are not consumed', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageTeardown(dir, APP, [{ id: ID, key: 'overview', name: 'Overview' }], ENV_A);
  const before = new Map(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  assert.deepEqual(lib().readPageOwnership(dir, APP, ENV_B), { created: [], teardown: [] });
  lib().completePageDeletions(dir, APP, [ID], ENV_B);
  assert.deepEqual(new Map(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])), before);
  assert.equal(lib().readPageOwnership(dir, APP, ENV_A).created.length, 1);
  assert.equal(lib().readPageOwnership(dir, APP, ENV_A).teardown.length, 1);
});

test('the same app/key/id can retain distinct receipts in two environments', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_B);
  assert.equal(fs.readdirSync(dir).length, 2);
  lib().completePageDeletions(dir, APP, [ID], ENV_B);
  assert.equal(lib().readPageOwnership(dir, APP, ENV_A).created.length, 1);
  assert.equal(lib().readPageOwnership(dir, APP, ENV_B).created.length, 0);
});

test('receipt fingerprints normalize host case, path and trailing slash without storing the URL', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', 'HTTPS://CONTOSO.CRM.DYNAMICS.COM/api/data/v9.2/');
  const record = lib().readPageOwnership(dir, APP, ENV_A).created[0];
  assert.match(record.environmentFingerprint, /^[a-f0-9]{64}$/);
  const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.doesNotMatch(text, /https?:\/\/|instanceUrl|envUrl/i);
});

for (const env of [undefined, '', 'not a URL', 'http://contoso.crm.dynamics.com', 'https://maker:password@contoso.crm.dynamics.com']) {
  test(`an invalid target environment cannot mint a receipt: ${JSON.stringify(env)}`, (t) => {
    assert.throws(() => lib().recordPageCreation(workspace(t), APP, 'overview', ID, 'Overview', env), /environment|origin|https/i);
  });
}

test('creation receipts are local app/key/id records, not deployed baselines or diagnostic journals', (t) => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, 'last-applied.json'), JSON.stringify({ __deployedIds: { pages: { overview: ID } } }));
  fs.writeFileSync(path.join(dir, 'build-log.jsonl'), JSON.stringify({ status: 'ok', result: ID }) + '\n');
  assert.deepEqual(lib().readPageOwnership(dir, APP, ENV_A).created, []);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  const state = lib().readPageOwnership(dir, APP.toUpperCase(), ENV_A);
  assert.equal(state.created.length, 1);
  assert.deepEqual(lib().creationIds(state).get('overview'), new Set([ID]));
  assert.deepEqual(lib().readPageOwnership(dir, 'contoso_other', ENV_A).created, []);
  const file = fs.readdirSync(dir).find((name) => name.startsWith('page-ownership.created.'));
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.doesNotMatch(text, /https?:\/\/|instanceUrl|envUrl/i);
  assert.match(JSON.parse(text).environmentFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(text).name, 'Overview');
});

test('different keys and ids keep distinct receipts without a shared mutable list', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageCreation(dir, APP, 'overview', OTHER, 'Overview', ENV_A);
  lib().recordPageCreation(dir, APP, 'detail', OTHER, 'Detail', ENV_A);
  assert.equal(lib().readPageOwnership(dir, APP, ENV_A).created.length, 3);
  assert.deepEqual(lib().creationIds(lib().readPageOwnership(dir, APP, ENV_A)).get('overview'), new Set([ID, OTHER]));
});

test('teardown proof is consumed only for completed ids and leaves other apps intact', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageTeardown(dir, APP, [{ id: ID, key: 'overview', name: 'Overview' }, { id: OTHER, key: 'detail', name: 'Detail' }], ENV_A);
  lib().recordPageTeardown(dir, 'contoso_other', [{ id: ID, name: 'Other' }], ENV_A);
  lib().completePageDeletions(dir, APP, [ID], ENV_A);
  const state = lib().readPageOwnership(dir, APP, ENV_A);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.teardown.map((p) => p.pageId), [OTHER]);
  assert.equal(lib().readPageOwnership(dir, 'contoso_other', ENV_A).teardown.length, 1);
  lib().completePageDeletions(dir, APP, [OTHER], ENV_A);
  assert.deepEqual(lib().readPageOwnership(dir, APP, ENV_A).teardown, []);
});

test('no workspace supplies no authority and cannot persist a teardown proof', () => {
  assert.deepEqual(lib().readPageOwnership(null, APP), { created: [], teardown: [] });
  assert.throws(() => lib().recordPageTeardown(null, APP, [{ id: ID, name: 'Overview' }]), /workspace/i);
});

test('a workspace whose final component is a link or junction is refused for reads, writes and clearing', (t) => {
  const outside = workspace(t);
  const parent = workspace(t);
  const linked = path.join(parent, '.maker-workspace');
  // A junction needs no privilege on Windows; elsewhere a directory symlink is the same hazard.
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  lib().recordPageCreation(outside, APP, 'overview', ID, 'Overview', ENV_A);
  const before = fs.readdirSync(outside).sort();

  assert.throws(() => lib().readPageOwnership(linked, APP, ENV_A), (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'link');
  assert.throws(() => lib().recordPageCreation(linked, APP, 'detail', OTHER, 'Detail', ENV_A), (e) => e.code === 'UNSAFE_OUTPUT');
  assert.throws(() => lib().completePageDeletions(linked, APP, [ID], ENV_A), (e) => e.code === 'UNSAFE_OUTPUT');
  const clear = lib().checkPageOwnershipClearable(linked);
  assert.equal(clear.ok, false);
  assert.match(clear.reason, /could not be checked/);
  assert.deepEqual(fs.readdirSync(outside).sort(), before, 'nothing was written or consumed through the link');
});

test('a workspace that was never created holds no records; a missing workspace is created plain for a write', (t) => {
  const parent = workspace(t);
  const missing = path.join(parent, 'never-built');
  assert.deepEqual(lib().readPageOwnership(missing, APP, ENV_A), { created: [], teardown: [] });
  assert.equal(lib().checkPageOwnershipClearable(missing).ok, true);
  assert.equal(fs.existsSync(missing), false, 'a read never creates the workspace');
  lib().recordPageCreation(missing, APP, 'overview', ID, 'Overview', ENV_A);
  assert.equal(lib().readPageOwnership(missing, APP, ENV_A).created.length, 1);
});

for (const issue of ['corrupt JSON', 'unknown version', 'unreadable file']) {
  test(`an ownership record with ${issue} fails closed with filename-specific recovery guidance`, (t) => {
    const dir = workspace(t);
    lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    if (issue === 'corrupt JSON') fs.writeFileSync(file, '{');
    if (issue === 'unknown version') {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.schemaVersion = 99;
      fs.writeFileSync(file, JSON.stringify(record));
    }
    if (issue === 'unreadable file') {
      const read = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', (p, ...args) => {
        if (String(p) === file) throw Object.assign(new Error('record read refused'), { code: 'EACCES' });
        return read(p, ...args);
      });
    }
    assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => {
      assert.ok(e.message.includes(file));
      assert.match(e.message, /is not a readable page-ownership record/i);
      assert.match(e.message, /inspect it; delete it only if no page it names still exists/i);
      return true;
    });
  });
}

test('a linked receipt cannot provide local ownership authority', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const copy = path.join(dir, 'copy.json');
  fs.renameSync(file, copy);
  try { fs.symlinkSync(copy, file, 'file'); } catch (e) {
    if (!['EPERM', 'EACCES'].includes(e.code)) throw e;
    t.skip('file links are not available to this process');
    return;
  }
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), /link|ownership|receipt/i);
});

test('an unsupported receipt version cannot be treated as an empty ownership set', (t) => {
  const dir = workspace(t);
  const record = { schemaVersion: 1, kind: 'created', appUniqueName: APP, key: 'overview', pageId: ID, name: 'Overview' };
  const hash = require('../lib/hash.js').sha256(JSON.stringify([APP, 'overview', ID]));
  const file = path.join(dir, `page-ownership.created.${hash}.json`);
  const text = JSON.stringify(record) + '\n';
  fs.writeFileSync(file, text);
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => e.message.includes(file) && /inspect it/.test(e.message));
  assert.throws(() => lib().completePageDeletions(dir, APP, [ID], ENV_A), /readable page-ownership record/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const clear = lib().checkPageOwnershipClearable(dir);
  assert.equal(clear.ok, false);
  assert.ok(clear.reason.includes(file));
  assert.match(clear.reason, /readable page-ownership record/);
});
