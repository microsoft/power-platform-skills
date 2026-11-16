'use strict';
// A view written with a key the build does not read (`filter` for `filters`, #827) is refused by every build, and a refusal sends NOTHING:
//   * over the REAL vendored SDK, the plugin's own HTTP client and the stateful fake Dataverse (helpers/fake-lifecycle-org.js), counted at the
//     transport — every request the build sends, not only the ones a double chooses to log;
//   * through the command, where a --changed-only apply could otherwise end in a no-op that certifies the spec without building it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');
const { appFolder, command, settle, ENV } = require('./helpers/build-command-harness.js');
const { migrateAppSpec } = require('../lib/app-spec.js');
const { appUniqueName } = require('../lib/sdk-build.js');
const { annotateContentHashes } = require('../lib/content-hash.js');
const flow = require('../lib/changed-only-flow.js');
const store = require('../lib/apply-snapshot-store.js');

const viewSpec = (key) => ({
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoViewKeys', publisherPrefix: 'contoso' },
  app: { name: 'View Keys' },
  entities: [{ schemaName: 'contoso_order', displayName: 'Order', pluralName: 'Orders', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  views: [{ entity: 'contoso_order', name: 'Red orders', columns: ['contoso_name'], [key]: [{ attr: 'contoso_name', op: 'eq', value: 'red' }] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Orders', subAreas: [{ entity: 'contoso_order', title: 'Orders' }] }] }] },
});

test('over the real SDK, a build of a view written with `filter` sends no request at all, and the same view written with `filters` is written with its condition', async () => {
  for (const [key, built] of [['filter', false], ['filters', true]]) {
    const root = makeTempDir('view-key-refusal-');
    const org = createLifecycleOrg();
    const harness = createLifecycleHarness(org, root);
    const { result } = await harness.build(viewSpec(key), { publish: false, sampleData: false, verify: false });
    const views = org.find('savedqueries', (row) => row.name === 'Red orders');
    if (!built) {
      assert.equal(result.ok, false, key);
      assert.ok(result.errors.some((e) => /^view 'Red orders': unknown key 'filter' — did you mean 'filters'\?/.test(e)), JSON.stringify(result.errors));
      assert.equal(org.requests.length, 0, `a refused build sent ${org.requests.map((r) => `${r.method} ${r.path}`).join(', ')}`);
      assert.equal(views.length, 0);
    } else {
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.ok(org.requests.some((r) => r.method !== 'GET'), 'the control spec is written');
      assert.equal(views.length, 1);
      assert.match(views[0].fetchxml, /attribute=["']contoso_name["']/);
      assert.match(views[0].fetchxml, /value=["']red["']/);
    }
  }
});

// What the command does with an app whose last build is recorded as an ELIGIBLE baseline: the spec the earlier release built, now carrying the
// key that release dropped. The baseline is what a --changed-only run trusts to skip the build, so an unchanged spec would be a no-op.
function eligibleBaseline(spec) {
  const folder = appFolder(spec);
  const live = { orgId: 'org-contoso', envUrl: ENV, appUniqueName: appUniqueName(spec), appId: 'app-contoso' };
  fs.mkdirSync(folder.workspaceDir, { recursive: true });
  const envelope = flow.assembleBaselineSnapshot({ annotatedSpec: annotateContentHashes(migrateAppSpec(spec), () => null), created: { app: live.appId }, live, prior: null });
  assert.equal(envelope.eligible, true, 'the baseline is one a no-op may trust');
  store.writeSnapshotAtomic(folder.workspaceDir, envelope);
  return { folder, live };
}

test('a --changed-only apply of an unchanged spec holding `filter` is refused as a build refuses it: exit 1, the error once, nothing sent, no baseline written', async () => {
  const { folder, live } = eligibleBaseline(viewSpec('filter'));
  const before = fs.readFileSync(store.snapshotPath(folder.workspaceDir), 'utf8');
  const run = command(folder, { argv: ['--changed-only'], live });
  const outcome = await settle(run);
  const printed = run.authCli.stdoutText();
  assert.equal(outcome.exitCode, 1, printed);
  assert.equal(run.printed.ok, false);
  assert.equal(printed.split("unknown key 'filter'").length - 1, 1, `the finding is printed once: ${printed}`);
  assert.match(printed, /view 'Red orders': unknown key 'filter' — did you mean 'filters'\?/);
  assert.equal(JSON.parse(printed).changedOnly, undefined, 'the refusal is the build\'s own, with no changed-only decision');
  assert.deepEqual(run.calls.filter((c) => c === 'engine' || c === 'baseline'), [], 'nothing was built and no baseline was written');
  assert.equal(fs.readFileSync(store.snapshotPath(folder.workspaceDir), 'utf8'), before, 'the recorded baseline is as it was');
});

test('a --changed-only apply of the same spec written with `filters` is still a no-op, and with no baseline it is still the full build', async () => {
  const { folder, live } = eligibleBaseline(viewSpec('filters'));
  const noop = command(folder, { argv: ['--changed-only'], live });
  const outcome = await settle(noop);
  assert.equal(outcome.exitCode, 0, noop.authCli.stdoutText());
  const payload = JSON.parse(noop.authCli.stdoutText());
  assert.equal(payload.noop, true);
  assert.equal(payload.changedOnly.decision, 'noop');
  assert.equal(noop.calls.includes('engine'), false, 'nothing was built');

  const fresh = appFolder(viewSpec('filters'));
  const full = command(fresh, { argv: ['--changed-only'], live });
  assert.equal((await settle(full)).exitCode, 0, full.authCli.stdoutText());
  assert.equal(JSON.parse(full.authCli.stdoutText()).changedOnly.decision, 'full');
  assert.equal(full.calls.filter((c) => c === 'engine').length, 1, 'the full build ran once');
});
