'use strict';
// The build lease (lib/app-operation-lease.js): one apply of an app holds it, in its workspace, for the whole of its work, and a second apply of the
// same app in the same workspace is refused before it reads or writes anything.
//
// What this holds, through the entries a maker's command and a program reach — runSdkBuild, buildModelApp, runChangedOnlyApply — and never through a
// stand-in for them:
//   - a second apply is refused (`build-locked`) while the first runs anywhere: in its phases, in the wait before its automatic re-run, in its
//     verify, in the close of its journal; the refused one calls nothing of the caller's (no SDK, no snapshot read, no content read, no WhoAmI);
//   - an apply nested in another borrows the lease it is handed and lets go of nothing; a lease that is not a live one for that app and workspace
//     — a string, one already let go, another app's or another folder's — is refused (`build-lease-invalid`), and no apply runs without a lease;
//   - a dry run takes no lease and makes no folder;
//   - a lock left by a build that is gone is taken over and said; one held by a build that runs is never taken, however old;
//   - a release leaves another build's token alone, and says so when it cannot confirm it removed its own, without changing the result.
// The command line's order (the lease before the auth check, the result printed after the release) is in build-lease-cli.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
const flow = require('../lib/changed-only-flow.js');
const store = require('../lib/apply-snapshot-store.js');
const { sha256 } = require('../lib/hash.js');
const { ownerStamp } = require('../lib/process-owner.js');
const { ConnectionError } = require('../lib/maker-sdk.js');
const { deadPid } = require('./helpers/kill-target-client.js');
const { deletedWhileOpen, deletedNamesLinger } = require('./helpers/delete-pending.js');

// A valid spec, and not the point: one table the phases these tests run never reach.
const spec = (name = 'Lease Probe') => ({
  schemaVersion: 2,
  solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
  app: { name },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
});
const APP = appUniqueName(spec());
// The lock's name, worked out here rather than read from the module: what a build of this release creates is pinned by the test.
const buildLock = (dir, app = APP) => path.join(dir, `app-build.${sha256(String(app).toLowerCase())}.lock`);
const REFUSAL = (dir, app = APP) => `another build may be applying '${app}' in this workspace — refusing a second concurrent apply (would risk duplicate creation). Re-run the same command after it finishes. If no build using this workspace is running, inspect ${buildLock(dir, app)} and remove it only if it is abandoned; keep the workspace and its recovery records.`;
const isBuildLocked = (dir, app = APP) => (e) => {
  assert.strictEqual(e && e.code, 'build-locked', String(e && e.stack));
  assert.strictEqual(e.name, 'BuildHalt');
  assert.strictEqual(e.phase, 'preflight');
  assert.strictEqual(e.recoverable, true);
  assert.strictEqual(e.retry, 'never');
  assert.strictEqual(e.transient, false);
  assert.strictEqual(e.message, REFUSAL(dir, app));
  return true;
};
const isLeaseInvalid = (e) => {
  assert.strictEqual(e && e.code, 'build-lease-invalid', String(e && e.stack));
  assert.strictEqual(e.phase, 'preflight');
  assert.strictEqual(e.recoverable, false);
  assert.strictEqual(e.retry, 'never');
  assert.strictEqual(e.transient, false);
  assert.strictEqual(e.message, 'the supplied build lease is not active for this app and workspace — refusing to apply without its own lease');
  return true;
};

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

// The engine's one phase that reads first: the solution step asks whether the solution exists. `hold` runs inside that read, while the build holds
// its lease — the place a test starts a second build from.
const solutionDouble = (hold = async () => {}) => {
  const reads = [];
  const sdk = { queryRecords: async (entity) => { reads.push(entity); await hold(); return [{ solutionid: '11111111-1111-4111-8111-111111111111' }]; } };
  return { sdk, reads };
};
const engineBuild = (s, dir, extra = {}) => runSdkBuild(s, { sdk: extra.sdk, provisionSdk: extra.sdk, apply: true, workspaceDir: dir, phases: ['solution'], ...extra });

test('a second apply of the same app in the same workspace is refused before it reads anything, while the first is in its phases — and the first, when it ends, lets go', async () => {
  const dir = makeTempDir('build-lease-');
  const held = gate();
  const inside = gate();
  const first = solutionDouble(async () => { inside.open(); await held.opened; });
  const running = engineBuild(spec(), dir, { sdk: first.sdk });
  await inside.opened;
  // Every applying entry, each on its own: the engine, the build with its retry loop, and the changed-only flow.
  const second = solutionDouble();
  await assert.rejects(engineBuild(spec(), dir, { sdk: second.sdk }), isBuildLocked(dir), 'runSdkBuild');
  const calls = [];
  await assert.rejects(buildModelApp(spec(), { apply: true, workspaceDir: dir }, { runBuild: async () => { calls.push('runBuild'); return { ok: true }; } }), isBuildLocked(dir), 'buildModelApp');
  await assert.rejects(flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true }, deps: {
    readContent: () => { calls.push('readContent'); return null; },
    resolveLiveIdentity: async () => { calls.push('resolveLiveIdentity'); return null; },
    buildModelApp: async () => { calls.push('buildModelApp'); return { ok: true }; },
  } }), isBuildLocked(dir), 'runChangedOnlyApply');
  assert.deepStrictEqual(second.reads, [], 'the refused engine read nothing');
  assert.deepStrictEqual(calls, [], 'the refused build ran nothing of its caller\'s');
  // Another app in the same workspace is another lease.
  const other = solutionDouble();
  assert.strictEqual((await engineBuild(spec('Other Probe'), dir, { sdk: other.sdk })).ok, true);
  held.open();
  assert.strictEqual((await running).ok, true);
  assert.ok(!fs.existsSync(buildLock(dir)), 'the first build let go when it ended');
  // And the next apply proceeds.
  assert.strictEqual((await engineBuild(spec(), dir, { sdk: solutionDouble().sdk })).ok, true);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /\.lock$/.test(n)), [], 'no lock left');
});

test('two spellings of one app share the lease: an app\'s unique name is compared without regard to case', async () => {
  const dir = makeTempDir('build-lease-case-');
  const held = gate();
  const inside = gate();
  const upper = { ...spec(), app: { name: 'Lease Probe', uniqueName: 'Contoso_LeaseProbe' } };
  const lower = { ...spec(), app: { name: 'Lease Probe', uniqueName: 'contoso_leaseprobe' } };
  const running = engineBuild(upper, dir, { sdk: solutionDouble(async () => { inside.open(); await held.opened; }).sdk });
  await inside.opened;
  await assert.rejects(engineBuild(lower, dir, { sdk: solutionDouble().sdk }), (e) => e.code === 'build-locked' && e.message.includes(buildLock(dir, 'Contoso_LeaseProbe')));
  held.open();
  await running;
});

test('an apply nested in another borrows the lease it is handed and lets go of nothing; a second, independent one in the same process is refused', async () => {
  const dir = makeTempDir('build-lease-nested-');
  let during = null;
  let independent = null;
  const r = await buildModelApp(spec(), { apply: true, workspaceDir: dir }, {
    // Each attempt of the build borrows the build's lease: the real engine, handed what buildModelApp hands every attempt.
    runBuild: async (s, o) => {
      assert.ok(o.buildLease, 'the build hands its lease to the attempt');
      const nested = await runSdkBuild(s, { ...o, phases: ['solution'], sdk: solutionDouble().sdk });
      assert.strictEqual(nested.ok, true, 'a nested engine run borrows the lease');
      during = fs.readFileSync(buildLock(dir), 'utf8');
      // A process is not a lease: a second apply that was not handed this one competes like another process does.
      independent = await runSdkBuild(s, { ...o, buildLease: undefined, phases: ['solution'], sdk: solutionDouble().sdk }).catch((e) => e);
      return { ok: true, dryRun: false, created: {} };
    },
  });
  assert.strictEqual(r.ok, true);
  assert.ok(JSON.parse(during).pid === process.pid, 'the lease was held, by this process, while the nested run borrowed it');
  assert.ok(isBuildLocked(dir)(independent));
  assert.ok(!fs.existsSync(buildLock(dir)), 'one lease, let go once, by the build that took it');
});

test('a lease that is not a live one for that app and that workspace is refused — a string, a lease already let go, another app\'s, another folder\'s — and no apply runs without one', async () => {
  const dir = makeTempDir('build-lease-invalid-');
  const elsewhere = makeTempDir('build-lease-invalid-');
  let kept = null;
  const runs = [];
  await buildModelApp(spec(), { apply: true, workspaceDir: dir }, {
    runBuild: async (s, o) => {
      kept = o.buildLease;
      // A live lease handed to an apply of another app, or of the same app in another folder.
      for (const [what, otherSpec, folder] of [['another app', spec('Other Probe'), dir], ['another folder', spec(), elsewhere]]) {
        const sdk = solutionDouble();
        await assert.rejects(engineBuild(otherSpec, folder, { sdk: sdk.sdk, buildLease: o.buildLease }), isLeaseInvalid, what);
        runs.push(...sdk.reads);
      }
      return { ok: true, dryRun: false, created: {} };
    },
  });
  for (const [what, lease] of [['a string', 'held'], ['true', true], ['an object that is no lease', {}], ['a lease already let go', kept]]) {
    const sdk = solutionDouble();
    await assert.rejects(engineBuild(spec(), dir, { sdk: sdk.sdk, buildLease: lease }), isLeaseInvalid, what);
    await assert.rejects(buildModelApp(spec(), { apply: true, workspaceDir: dir, buildLease: lease }, { runBuild: async () => { runs.push('runBuild'); return { ok: true }; } }), isLeaseInvalid, `${what}: buildModelApp`);
    await assert.rejects(flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true, buildLease: lease }, deps: { readContent: () => runs.push('readContent'), resolveLiveIdentity: async () => runs.push('resolveLiveIdentity') } }), isLeaseInvalid, `${what}: runChangedOnlyApply`);
    runs.push(...sdk.reads);
  }
  assert.deepStrictEqual(runs, [], 'nothing ran under a lease that was refused');
  assert.ok(!fs.existsSync(buildLock(dir)), 'and a refused borrower took no lease of its own');
});

test('a dry run takes no lease and makes no folder', async () => {
  const root = makeTempDir('build-lease-dry-');
  const dir = path.join(root, 'never-made');
  const r = await runSdkBuild(spec(), { apply: false, workspaceDir: dir, livePlan: false, phases: ['solution'] });
  assert.strictEqual(r.dryRun, true);
  const b = await buildModelApp(spec(), { apply: false, workspaceDir: dir, livePlan: false }, { runBuild: async () => ({ ok: true, dryRun: true, planItems: [] }) });
  assert.strictEqual(b.ok, true);
  assert.ok(!fs.existsSync(dir), 'no workspace was made for a lease');
  // And a dry run beside a running apply is not refused.
  const held = gate();
  const inside = gate();
  const running = engineBuild(spec(), root, { sdk: solutionDouble(async () => { inside.open(); await held.opened; }).sdk });
  await inside.opened;
  assert.strictEqual((await runSdkBuild(spec(), { apply: false, workspaceDir: root, livePlan: false, phases: ['solution'] })).dryRun, true);
  held.open();
  await running;
});

test('the lease spans the build\'s automatic re-run and its wait, its verify and the close of its journal: a second apply is refused in each, and the build keeps one lease throughout', async () => {
  const dir = makeTempDir('build-lease-span-');
  const tokens = new Set();
  const refused = [];
  const tryAnother = async (where) => {
    tokens.add(fs.readFileSync(buildLock(dir), 'utf8'));
    const e = await buildModelApp(spec(), { apply: true, workspaceDir: dir }, { runBuild: async () => ({ ok: true }) }).then(() => null, (err) => err);
    refused.push([where, e && e.code]);
  };
  let attempts = 0;
  const journal = { record: () => {}, close: () => { refused.push(['journal (sync)', fs.existsSync(buildLock(dir)) ? 'held' : 'free']); } };
  const r = await buildModelApp(spec(), { apply: true, workspaceDir: dir, verify: true, retryDelayMs: 0 }, {
    journal,
    // A 503 on the first attempt: the build waits and runs again.
    runBuild: async () => { attempts += 1; if (attempts === 1) throw new ConnectionError('https://contoso.crm.dynamics.com/api/data/v9.2/solutions', 503, 'Service Unavailable'); return { ok: true, dryRun: false, created: {} }; },
    sleep: async () => tryAnother('the wait before the re-run'),
    verify: async () => { await tryAnother('the verify'); return { ok: true, checks: [], missing: [] }; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(attempts, 2, 'the build ran again after the 503');
  assert.deepStrictEqual(refused, [['the wait before the re-run', 'build-locked'], ['the verify', 'build-locked'], ['journal (sync)', 'held']]);
  assert.strictEqual(tokens.size, 1, 'one lease, the same token, from the first attempt to the end');
  assert.ok(!fs.existsSync(buildLock(dir)));
});

test('a halt the build cannot run again still settles under the lease, and is thrown after the lease is let go', async () => {
  const dir = makeTempDir('build-lease-halt-');
  const halt = Object.assign(new Error('bad request'), { statusCode: 400, transient: false });
  let heldAtClose = null;
  const journal = { record: () => {}, close: () => { heldAtClose = fs.existsSync(buildLock(dir)); } };
  await assert.rejects(buildModelApp(spec(), { apply: true, workspaceDir: dir, retryDelayMs: 0 }, { journal, runBuild: async () => { throw halt; } }), (e) => e === halt);
  assert.strictEqual(heldAtClose, true, 'the journal closed while the lease was held');
  assert.ok(!fs.existsSync(buildLock(dir)), 'and the halt reached the caller after the lease was let go');
});

test('a changed-only run and a data-stage apply of the same app exclude each other, before either reads the snapshot — and a finished stage lets the next command in', async (t) => {
  const dir = makeTempDir('build-lease-stage-');
  const reads = { snapshot: 0, distrust: 0 };
  const realRead = store.readSnapshot;
  const realDistrust = store.readDistrust;
  t.mock.method(store, 'readSnapshot', (...a) => { reads.snapshot += 1; return realRead(...a); });
  t.mock.method(store, 'readDistrust', (...a) => { reads.distrust += 1; return realDistrust(...a); });
  const counted = { readContent: 0, resolveLiveIdentity: 0, buildModelApp: 0 };
  const loserDeps = {
    readContent: () => { counted.readContent += 1; return null; },
    resolveLiveIdentity: async () => { counted.resolveLiveIdentity += 1; return null; },
    buildModelApp: async () => { counted.buildModelApp += 1; return { ok: true }; },
  };
  // The data stage holds the lease: the changed-only run is refused before its first read.
  const held = gate();
  const inside = gate();
  const stage = buildModelApp(spec(), { apply: true, workspaceDir: dir, phases: ['solution', 'data-model', 'sample-data'] }, {
    runBuild: async () => { inside.open(); await held.opened; return { ok: true, dryRun: false, created: {} }; },
  });
  await inside.opened;
  const before = { ...reads };
  await assert.rejects(flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true }, deps: loserDeps }), isBuildLocked(dir));
  assert.deepStrictEqual(reads, before, 'no snapshot or distrust read');
  assert.deepStrictEqual(counted, { readContent: 0, resolveLiveIdentity: 0, buildModelApp: 0 }, 'no content read, no WhoAmI, no build');
  held.open();
  assert.strictEqual((await stage).ok, true);
  // The changed-only run holds it: the data stage is refused before it reads its approval record or runs.
  const heldFlow = gate();
  const insideFlow = gate();
  const changed = flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true }, deps: {
    readContent: () => null,
    resolveLiveIdentity: async () => { insideFlow.open(); await heldFlow.opened; return null; },
    buildModelApp: async () => ({ ok: true, dryRun: false, created: {} }),
    log: () => {},
  } });
  await insideFlow.opened;
  let ran = 0;
  await assert.rejects(buildModelApp(spec(), { apply: true, workspaceDir: dir, phases: ['solution', 'data-model', 'sample-data'] }, { runBuild: async () => { ran += 1; return { ok: true }; } }), isBuildLocked(dir));
  assert.strictEqual(ran, 0);
  heldFlow.open();
  await changed;
  // Once it has finished, the next stage runs.
  assert.strictEqual((await buildModelApp(spec(), { apply: true, workspaceDir: dir, phases: ['solution', 'data-model', 'sample-data'] }, { runBuild: async () => ({ ok: true, dryRun: false, created: {} }) })).ok, true);
  assert.ok(!fs.existsSync(buildLock(dir)));
});

test('a build lock whose owner is proven gone is taken over and said; one whose owner runs, or cannot be judged, is never taken — however old — and is refused in the same words, untouched', async () => {
  const gone = deadPid();
  const stamp = (overrides) => JSON.stringify({ ...ownerStamp({ pid: gone }), ...overrides, rnd: 'held' });
  for (const [what, content] of [
    ['this process, which is running, by a record ten minutes old', JSON.stringify({ ...ownerStamp({ now: () => Date.now() - 10 * 60 * 1000 }), rnd: 'held' })],
    ['a record from another machine', stamp({ host: 'some-other-machine' })],
    ['a lock of a release that recorded only { pid, at }', JSON.stringify({ pid: gone, at: Date.now() - 10 * 60 * 1000 })],
    ['an empty file', ''],
    ['text that is not JSON', 'not json'],
  ]) {
    const dir = makeTempDir('build-lease-owner-');
    fs.writeFileSync(buildLock(dir), content);
    const warnings = [];
    const sdk = solutionDouble();
    await assert.rejects(engineBuild(spec(), dir, { sdk: sdk.sdk, warn: (m) => warnings.push(m) }), isBuildLocked(dir), what);
    assert.strictEqual(fs.readFileSync(buildLock(dir), 'utf8'), content, `${what}: untouched`);
    assert.deepStrictEqual(warnings, [], what);
    assert.deepStrictEqual(sdk.reads, [], `${what}: nothing read`);
  }
  const dir = makeTempDir('build-lease-owner-');
  fs.writeFileSync(buildLock(dir), stamp({}));
  const warnings = [];
  assert.strictEqual((await engineBuild(spec(), dir, { sdk: solutionDouble().sdk, warn: (m) => warnings.push(m) })).ok, true);
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.ok(warnings[0].startsWith(`released the build lock for '${APP}': the build that held it (pid ${gone} on `) && warnings[0].endsWith(') is no longer running'), warnings[0]);
  assert.ok(!fs.existsSync(buildLock(dir)));
  // A take-over that another build is making at the same moment: refused, with the reason added.
  const racing = makeTempDir('build-lease-owner-');
  fs.writeFileSync(buildLock(racing), stamp({}));
  fs.writeFileSync(`${buildLock(racing)}.reclaim`, JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'taking-over' }));
  await assert.rejects(engineBuild(spec(), racing, { sdk: solutionDouble().sdk }), (e) => e.code === 'build-locked' && e.message === `${REFUSAL(racing)} The build that held it is no longer running, but its lock could not be released: lease being reclaimed by another writer.`);
});

test('a refused apply\'s halt is never run again by the build, whatever its folder or app is called', async () => {
  const root = makeTempDir('build-lease-policy-');
  const dir = path.join(root, 'SQL Timeout 503 try again later');
  const held = gate();
  const inside = gate();
  const running = engineBuild(spec(), dir, { sdk: solutionDouble(async () => { inside.open(); await held.opened; }).sdk });
  await inside.opened;
  const halt = await engineBuild(spec(), dir, { sdk: solutionDouble().sdk }).catch((e) => e);
  held.open();
  await running;
  assert.ok(isBuildLocked(dir)(halt));
  assert.ok(halt.message.includes('SQL Timeout 503 try again later'), 'control: the refusal quotes the folder');
  assert.strictEqual(isTransientHalt(halt, { spec: spec() }), false);
});

test('a late release leaves a lock another build holds now as it is, without a word; a removal it cannot confirm is said, and the result stands', async () => {
  const dir = makeTempDir('build-lease-release-');
  const warnings = [];
  const theirs = JSON.stringify({ ...ownerStamp(), pid: process.pid + 1, rnd: 'theirs' });
  const r = await engineBuild(spec(), dir, { sdk: solutionDouble(async () => { fs.writeFileSync(buildLock(dir), theirs); }).sdk, warn: (m) => warnings.push(m) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(buildLock(dir), 'utf8'), theirs, 'the other build\'s lock stays');
  assert.deepStrictEqual(warnings, []);
  fs.rmSync(buildLock(dir));

  const stuck = makeTempDir('build-lease-release-');
  const said = [];
  const rmSync = fs.rmSync;
  fs.rmSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(buildLock(stuck))) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return rmSync.call(fs, target, ...rest);
  };
  let result;
  try {
    result = await engineBuild(spec(), stuck, { sdk: solutionDouble().sdk, warn: (m) => said.push(m) });
  } finally {
    fs.rmSync = rmSync;
  }
  assert.strictEqual(result.ok, true, 'the build\'s result is what it was');
  assert.deepStrictEqual(said, [`could not confirm removal of the build lock for '${APP}': ${buildLock(stuck)}. This run has finished; keep the workspace and its recovery records. If a later run still stops here, confirm no build is running before removing only this lock.`]);
  fs.rmSync(buildLock(stuck));
});

test('a warning callback that throws never leaves the lease behind: one that throws while a take-over is said lets the lock go, and is what the build throws; one that throws while the lock is let go changes nothing the build answers', async () => {
  const logger = () => { throw new Error('logger unavailable'); };
  // The take-over of a lock whose build is gone, said to a callback that throws.
  const dir = makeTempDir('build-lease-warn-');
  fs.writeFileSync(buildLock(dir), JSON.stringify({ ...ownerStamp({ pid: deadPid() }), rnd: 'held' }));
  const first = solutionDouble();
  await assert.rejects(engineBuild(spec(), dir, { sdk: first.sdk, warn: logger }), /^Error: logger unavailable$/);
  assert.deepStrictEqual(first.reads, [], 'the build did not run');
  assert.ok(!fs.existsSync(buildLock(dir)), 'and the lock it took over was let go — not left stamped with this process, which runs');
  assert.strictEqual((await engineBuild(spec(), dir, { sdk: solutionDouble().sdk })).ok, true, 'the next apply proceeds');
  // A release it cannot confirm, said to a callback that throws: the build's own result — or its own error — is what it answers.
  for (const [what, sdk, outcome] of [
    ['a build that succeeded', solutionDouble().sdk, (settled) => settled.value && settled.value.ok === true],
    ['a build that failed', { queryRecords: async () => { throw new Error('the solution read failed'); } }, (settled) => settled.error && /the solution read failed/.test(settled.error.message)],
  ]) {
    const stuck = makeTempDir('build-lease-warn-');
    const rmSync = fs.rmSync;
    fs.rmSync = (target, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(buildLock(stuck))) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return rmSync.call(fs, target, ...rest);
    };
    let settled;
    try {
      settled = await engineBuild(spec(), stuck, { sdk, warn: logger }).then((value) => ({ value }), (error) => ({ error }));
    } finally {
      fs.rmSync = rmSync;
    }
    assert.ok(outcome(settled), `${what}: ${settled.error ? settled.error.stack : JSON.stringify(settled.value)}`);
    fs.rmSync(buildLock(stuck));
  }
});

test('a link or a folder at the lock\'s name is the file system problem it is, not another build applying — and nothing runs', async () => {
  const dir = makeTempDir('build-lease-planted-');
  fs.mkdirSync(buildLock(dir));
  const sdk = solutionDouble();
  await assert.rejects(engineBuild(spec(), dir, { sdk: sdk.sdk }), (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'not-file');
  assert.deepStrictEqual(sdk.reads, []);
  // A file where the workspace should be.
  const file = path.join(makeTempDir('build-lease-planted-'), 'not-a-folder');
  fs.writeFileSync(file, '');
  await assert.rejects(engineBuild(spec(), file, { sdk: sdk.sdk }), (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'not-directory');
});

// A claim or a lock another build is deleting while a third still has it open lingers on Windows under Node 20, and every look at it fails with EPERM
// (helpers/delete-pending.js): a lock in use, refused as one — never a file-safety error. Elsewhere the name is gone at once, and the same steps find
// what a build then finds: the first build's lock, or a free one.
const isUninspectable = (dir, name) => (e) => {
  assert.strictEqual(e && e.code, 'build-locked', String(e && e.stack));
  assert.strictEqual(e.phase, 'preflight');
  assert.strictEqual(e.retry, 'never');
  assert.strictEqual(e.message, `${REFUSAL(dir).replace(buildLock(dir), name)} Windows could not inspect ${name} (EPERM): another build may be removing it, or this user may not have access to it. If this refusal persists while no build is running, check that file's access, or remove it.`);
  return true;
};
test('a lock or a claim another build is deleting while a third has it open is a lock in use: refused, never a file-safety error', async () => {
  const dir = makeTempDir('build-lease-deleting-');
  const lingers = deletedNamesLinger(dir);
  const held = gate();
  const inside = gate();
  const running = engineBuild(spec(), dir, { sdk: solutionDouble(async () => { inside.open(); await held.opened; }).sdk });
  await inside.opened;
  const claimName = `${buildLock(dir)}.reclaim`;
  const claim = deletedWhileOpen(claimName, JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'taking-over' }));
  try {
    const second = solutionDouble();
    // Where it lingers, the refusal names the claim Windows could not inspect, and says it may be inaccessible; elsewhere the live lock refuses.
    await assert.rejects(engineBuild(spec(), dir, { sdk: second.sdk }), lingers ? isUninspectable(dir, claimName) : isBuildLocked(dir), `the claim; names deleted while open linger here: ${lingers}`);
    assert.deepStrictEqual(second.reads, []);
  } finally {
    claim.close();
  }
  held.open();
  assert.strictEqual((await running).ok, true);

  const lock = deletedWhileOpen(buildLock(dir), JSON.stringify({ ...ownerStamp(), rnd: 'letting-go' }));
  try {
    const next = engineBuild(spec(), dir, { sdk: solutionDouble().sdk });
    if (lingers) await assert.rejects(next, isUninspectable(dir, buildLock(dir)), 'the lock');
    else assert.strictEqual((await next).ok, true, 'the lock is gone: free');
  } finally {
    lock.close();
  }
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /\.lock|\.reclaim/.test(n)), [], 'nothing is left once the last handle is closed');
});
