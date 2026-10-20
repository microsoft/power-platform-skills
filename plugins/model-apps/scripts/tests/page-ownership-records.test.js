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

// The reset remedy must preserve every non-reconstructible store, not only SDK cache. Page receipts
// retain pending creates and deletion progress; resource receipts retain the id needed to rewrite an
// unconfirmed publication. Its named globs must cover the actual files both modules write.
test('the workspace-reset advice keeps the baseline, approval and every page and resource recovery store', (t) => {
  const { RESET_WORKSPACE } = require('../lib/entity-provision.js');
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPagePending(dir, APP, 'detail', OTHER, 'Detail', ENV_A, 'a'.repeat(64));
  lib().recordPageTeardown(dir, APP, [{ id: ID, key: 'overview', name: 'Overview' }], ENV_A);
  const { openUnconfirmedWebResources, unconfirmedRecordPath } = require('../lib/web-resource-records.js');
  assert.equal(openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV_A }).note('contoso_/reset.js', ID), true);
  const written = fs.readdirSync(dir);
  assert.equal(written.length, 4);
  const pageRecords = written.filter((name) => name.startsWith('page-ownership.'));
  assert.deepEqual(pageRecords.map((name) => name.split('.')[1]).sort(), ['created', 'pending', 'teardown']);
  assert.ok(pageRecords.every((name) => /^page-ownership\..+\.json$/.test(name)), 'every page record is page-ownership.<kind>.<hash>.json');
  assert.match(path.basename(unconfirmedRecordPath(dir, ENV_A)), /^web-resource-unconfirmed\.[a-f0-9]{64}\.json$/);
  assert.match(RESET_WORKSPACE, /except last-applied\.json, destructive-approval\.json, web-resource-unconfirmed\.\*\.json \(the durable ids needed to recover unconfirmed web-resource writes\) and the page-ownership\.\*\.json records/);
  assert.match(RESET_WORKSPACE, /pending records/);
});

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

test('a record retired while the source resolver re-inspects it is skipped; other refusals still halt', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageCreation(dir, APP, 'detail', OTHER, 'Detail', ENV_A);
  const [retired, kept] = fs.readdirSync(dir).map((f) => path.join(dir, f));
  const keptRecord = JSON.parse(fs.readFileSync(kept, 'utf8'));

  // readRecord's own lstat succeeds; the record is then unlinked, so resolveAppSource's walk meets a
  // real ENOENT, which it wraps as APP_SOURCE_PATH. That is still a retirement, not a malformed record.
  const realLstat = fs.lstatSync;
  let armed = true;
  const mock = t.mock.method(fs, 'lstatSync', function lstatSync(p, ...rest) {
    const st = realLstat.call(fs, p, ...rest);
    if (armed && String(p) === retired) { armed = false; fs.unlinkSync(retired); }
    return st;
  });
  const state = lib().readPageOwnership(dir, APP, ENV_A);
  assert.equal(armed, false, 'the record was unlinked after the first stat');
  assert.deepEqual(state.created.map((r) => r.pageId), [keptRecord.pageId]);
  mock.mock.restore();

  // A second name for the surviving record is not a retirement: it still halts with its file name.
  fs.linkSync(kept, path.join(dir, 'hard-link-elsewhere.json'));
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => e.message.includes(kept) && e.code !== 'ENOENT');
  assert.equal(lib().checkPageOwnershipClearable(dir).ok, false);
});

test('a record the source resolver cannot inspect still halts rather than reading as retired', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const realLstat = fs.lstatSync;
  let calls = 0;
  // Call 1 is readRecord's own lstat; call 2 is resolveAppSource's re-inspection of the same name.
  t.mock.method(fs, 'lstatSync', function lstatSync(p, ...rest) {
    if (String(p) === file && ++calls === 2) throw Object.assign(new Error('inspection refused'), { code: 'EACCES' });
    return realLstat.call(fs, p, ...rest);
  });
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => e.message.includes(file) && e.code === 'APP_SOURCE_PATH');
  calls = 0;
  assert.equal(lib().checkPageOwnershipClearable(dir).ok, false);
  calls = 0;
  assert.throws(() => lib().completePageDeletions(dir, APP, [ID], ENV_A), (e) => e.code === 'APP_SOURCE_PATH');
  assert.ok(fs.existsSync(file), 'an uninspectable record is never consumed');
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
      // The record is read through its canonical path (resolveAppSource returns the realpath), which differs
      // from `file` where the temp folder has an alias (macOS /var -> /private/var, a Windows 8.3 name).
      const target = fs.realpathSync.native(file);
      t.mock.method(fs, 'readFileSync', (p, ...args) => {
        if (String(p) === file || String(p) === target) throw Object.assign(new Error('record read refused'), { code: 'EACCES' });
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

// A "pending" record is written BEFORE a create is sent. It is the only local pointer to a page whose create was cut short, and it must never be taken for what
// a creation receipt is: a receipt authorizes an update and a delete, a pending record authorizes neither. It carries the name and the source hash of the create it stands for.
const pendingFiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('page-ownership.pending.'));
const { sha256 } = require('../lib/hash.js');
const SRC = sha256('page source one');
const SRC2 = sha256('page source two');

test('a pending creation is intent, not ownership: it is not in the ownership state, and no creation id comes of it', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'detail', OTHER, 'Detail', ENV_A);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  assert.equal(pendingFiles(dir).length, 1);
  const state = lib().readPageOwnership(dir, APP, ENV_A);
  assert.deepEqual(state.created.map((r) => r.pageId), [OTHER], 'only the acknowledged create is a receipt');
  assert.deepEqual(state.teardown, []);
  assert.equal(lib().creationIds(state).has('overview'), false, 'the pending page is not one this app is known to have created');
  assert.deepEqual(lib().readPendingCreations(dir, APP, ENV_A).get('overview'), [{ pageId: ID, sent: [{ name: 'Overview', sourceSha256: SRC }] }]);
});

test('a pending creation records what the create sent — the name and the SHA-256 of the source — and refuses a record that cannot say so', (t) => {
  const dir = workspace(t);
  const record = lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  assert.deepEqual(Object.keys(record).sort(), ['appUniqueName', 'environmentFingerprint', 'key', 'kind', 'name', 'pageId', 'schemaVersion', 'sourceSha256']);
  assert.equal(record.sourceSha256, SRC);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, pendingFiles(dir)[0]), 'utf8')).sourceSha256, SRC, 'it is in the file');
  for (const bad of [undefined, null, '', 'not a hash', SRC.toUpperCase(), SRC.slice(1)]) {
    assert.throws(() => lib().recordPagePending(dir, APP, 'detail', OTHER, 'Detail', ENV_A, bad), /the SHA-256 of the source sent/, `${String(bad)}`);
  }
  assert.equal(pendingFiles(dir).length, 1, 'nothing was written for them');
  // A receipt is the shape it always was: a source hash on one is not a receipt.
  assert.equal(Object.keys(lib().recordPageCreation(dir, APP, 'detail', OTHER, 'Detail', ENV_A)).length, 7);
});

test('pending creations are read per key — for this app and this environment only — one entry per page id, with every name and source it was sent with', (t) => {
  const dir = workspace(t);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', OTHER, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'detail', OTHER, 'Detail', ENV_A, SRC);
  lib().recordPagePending(dir, 'contoso_other', 'overview', ID, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_B, SRC);
  const pending = lib().readPendingCreations(dir, APP.toUpperCase(), ENV_A);
  assert.deepEqual([...pending.keys()].sort(), ['detail', 'overview']);
  assert.deepEqual(pending.get('overview').map((r) => r.pageId).sort(), [ID, OTHER], 'two unfinished creations of one key are both reported, so a build can refuse to guess between them');
  assert.deepEqual(pending.get('detail'), [{ pageId: OTHER, sent: [{ name: 'Detail', sourceSha256: SRC }] }]);
  assert.equal(lib().readPendingCreations(dir, APP, 'https://adatum.crm.dynamics.com').size, 0);
  assert.equal(lib().readPendingCreations(null, APP, ENV_A).size, 0, 'no workspace, no record');
  assert.throws(() => lib().recordPagePending(null, APP, 'overview', ID, 'Overview', ENV_A, SRC), /workspace/i);
});

test('completing a pending creation consumes only the ids named, for this app and environment — never a receipt or a teardown record', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPageTeardown(dir, APP, [{ id: OTHER, key: 'detail', name: 'Detail' }], ENV_A);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview, renamed', ENV_A, SRC2);
  lib().recordPagePending(dir, APP, 'detail', OTHER, 'Detail', ENV_A, SRC);
  lib().recordPagePending(dir, 'contoso_other', 'overview', ID, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_B, SRC);
  lib().completePendingCreations(dir, APP, [ID.toUpperCase()], ENV_A);
  assert.deepEqual([...lib().readPendingCreations(dir, APP, ENV_A).keys()], ['detail'], 'the page that was settled no longer has a record — of any of the creates sent under it');
  assert.equal(lib().readPendingCreations(dir, 'contoso_other', ENV_A).size, 1, 'another app\'s record is not this app\'s to consume');
  assert.equal(lib().readPendingCreations(dir, APP, ENV_B).size, 1, 'nor is another environment\'s');
  const state = lib().readPageOwnership(dir, APP, ENV_A);
  assert.equal(state.created.length, 1, 'the receipt the pending record stood in for is kept');
  assert.equal(state.teardown.length, 1);
  lib().completePendingCreations(dir, APP, [ID], ENV_A);
  lib().completePendingCreations(null, APP, [ID], ENV_A);
});

test('teardown consumes receipts and teardown records, and leaves a pending creation to be settled by evidence', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  lib().completePageDeletions(dir, APP, [ID], ENV_A);
  assert.deepEqual(lib().readPageOwnership(dir, APP, ENV_A), { created: [], teardown: [] });
  assert.equal(lib().readPendingCreations(dir, APP, ENV_A).size, 1, 'a pending record names a create that may still land: confirming a receipt\'s page gone does not retire it');
});

test('a pending record is one per create sent under the id: another name or source adds a record, the same create adds none, and a receipt for another name is still refused', (t) => {
  const dir = workspace(t);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  assert.equal(pendingFiles(dir).length, 1, 'the same create, recorded again, is the same record');
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview, renamed', ENV_A, SRC);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC2);
  assert.equal(pendingFiles(dir).length, 3, 'the earlier creates stay: the page may hold what any of them sent');
  const byText = (a, b) => (`${a.name}\n${a.sourceSha256}` < `${b.name}\n${b.sourceSha256}` ? -1 : 1);
  assert.deepEqual(lib().readPendingCreations(dir, APP, ENV_A).get('overview'), [{
    pageId: ID,
    sent: [
      { name: 'Overview', sourceSha256: SRC },
      { name: 'Overview', sourceSha256: SRC2 },
      { name: 'Overview, renamed', sourceSha256: SRC },
    ].sort(byText),
  }], 'one entry for the id, with each create that was sent under it');
  lib().recordPageCreation(dir, APP, 'overview', ID, 'Overview', ENV_A);
  assert.throws(() => lib().recordPageCreation(dir, APP, 'overview', ID, 'Another name', ENV_A), /different page name/);
});

test('a pending record keeps --clear-workspace from clearing, and says how it is settled — the build adopts, resumes or reports it, teardown deletes the page, or the record is deleted by hand once no such page exists; a receipt alone does not say that', (t) => {
  const dir = workspace(t);
  lib().recordPageCreation(dir, APP, 'detail', OTHER, 'Detail', ENV_A);
  assert.doesNotMatch(lib().checkPageOwnershipClearable(dir).reason, /pending/i);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  const clear = lib().checkPageOwnershipClearable(dir);
  assert.equal(clear.ok, false);
  assert.ok(clear.reason.includes(path.join(dir, pendingFiles(dir)[0])), 'the record is named');
  assert.match(clear.reason, /"pending" record is a page creation that was started and never acknowledged — the page may exist, or may still appear/);
  assert.match(clear.reason, /it adopts the page if it is there and is the one that was sent, creates it under the same id while its key has no page, and reports it as an unused page when the key is bound to another one — teardown deletes it too/);
  assert.match(clear.reason, /or delete the record by hand once you have confirmed that no such page exists, here or in Maker, and that no request can still create it/);
  lib().completePendingCreations(dir, APP, [ID], ENV_A);
  fs.rmSync(path.join(dir, fs.readdirSync(dir)[0]));
  assert.equal(lib().checkPageOwnershipClearable(dir).ok, true);
});

test('a pending record cannot be relabelled into a receipt, and a damaged one fails closed with its file name', (t) => {
  const dir = workspace(t);
  lib().recordPagePending(dir, APP, 'overview', ID, 'Overview', ENV_A, SRC);
  const file = path.join(dir, pendingFiles(dir)[0]);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  // The kind is part of the record's identity (its file name), so neither a renamed file nor an edited kind is read as a creation receipt.
  const asCreated = path.join(dir, path.basename(file).replace('.pending.', '.created.'));
  fs.copyFileSync(file, asCreated);
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => e.message.includes(asCreated));
  fs.rmSync(asCreated);
  fs.writeFileSync(file, JSON.stringify({ ...record, kind: 'created' }) + '\n');
  assert.throws(() => lib().readPageOwnership(dir, APP, ENV_A), (e) => e.message.includes(file));
  assert.throws(() => lib().readPendingCreations(dir, APP, ENV_A), (e) => e.message.includes(file));

  // What a pending record says it sent is part of its identity too: a record whose hash was edited, or dropped, is not read.
  fs.writeFileSync(file, JSON.stringify({ ...record, sourceSha256: SRC2 }) + '\n');
  assert.throws(() => lib().readPendingCreations(dir, APP, ENV_A), (e) => e.message.includes(file) && /inspect it/.test(e.message));
  const { sourceSha256, ...without } = record;
  fs.writeFileSync(file, JSON.stringify(without) + '\n');
  assert.throws(() => lib().readPendingCreations(dir, APP, ENV_A), (e) => e.message.includes(file));

  fs.writeFileSync(file, '{');
  assert.throws(() => lib().readPendingCreations(dir, APP, ENV_A), (e) => e.message.includes(file) && /inspect it/.test(e.message));
  assert.throws(() => lib().completePendingCreations(dir, APP, [ID], ENV_A), (e) => e.message.includes(file));
  assert.ok(fs.existsSync(file), 'a record that cannot be read is never consumed');
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
