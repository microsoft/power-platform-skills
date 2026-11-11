'use strict';
// The managed download's restore of declared views and charts end to end, on the strict lifecycle org (helpers/fake-lifecycle-org.js,
// which answers 501 to anything it does not model): a stable build, the CLI's own download main with --include-managed, a complete
// rebuild of what it wrote (every phase, publish and verify included), and a second download. A restored view or chart must cost a
// rebuild nothing a download without them does not cost: the comparison is with the plain download's spec, rebuilt the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName, publishesOf } = require('./helpers/lifecycle-harness.js');
const { main } = require('../download-model-app.js');
const { PREFIX } = require('../lib/managed-bindings.js');

const roots = [];
test.after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

function stableSpec() {
  return {
    schemaVersion: 2, minimumPluginVersion: '2.21.0', createIdentity: 'stable-v1',
    solution: { uniqueName: 'ContosoReview', displayName: 'Review', publisherPrefix: 'contoso' },
    app: { name: 'Review', uniqueName: 'contoso_review' },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_kind', displayName: 'Kind', type: 'Choice', options: ['A', 'B'] }],
    }],
    views: [{ entity: 'contoso_item', name: 'Items', reconcile: 'declared', activeOnly: false, columns: ['contoso_name', 'contoso_kind'] }],
    charts: [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

// A built app and the CLI's download main over the same org. `gated`: the build's client goes through its publication barrier, as the
// CLI's does — a stable build refuses to create without it.
async function builtLifecycle(spec, orgOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-managed-life-'));
  roots.push(root);
  const org = createLifecycleOrg(orgOptions);
  const harness = createLifecycleHarness(org, root);
  const built = await harness.measure(() => harness.build(spec, { gated: true }));
  assert.equal(built.error, undefined, built.error && built.error.stack);
  assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.steps || built.value.result));
  const store = path.join(harness.workspaceDir, fs.readdirSync(harness.workspaceDir).find((f) => f.startsWith(PREFIX)));
  let n = 0;
  async function download({ managed }) {
    const out = path.join(root, `download-${n += 1}`);
    let emitted = null;
    const said = [];
    // Some notes go to the process's own streams, not to the injected one: both are captured for the run, so a test can read
    // everything the download printed.
    const streams = [process.stdout, process.stderr].map((s) => ({ s, write: s.write }));
    for (const x of streams) x.s.write = (t) => { said.push(String(t)); return true; };
    try {
      await main({
        argv: ['--env', org.origin, '--app', appUniqueName(spec), '--out', out, ...(managed ? ['--include-managed', '--managed-manifest', store] : [])],
        stderr: { write: (t) => { said.push(String(t)); return true; } }, exit: () => {}, emitResult: (ok, payload) => { emitted = { ok, payload }; },
        preflightAuth: async () => ({ ok: true }), httpClient: harness.client,
      });
    } finally {
      for (const x of streams) x.s.write = x.write;
    }
    assert.equal(emitted && emitted.ok, true, JSON.stringify(emitted) + said.join(''));
    const text = fs.readFileSync(path.join(out, 'app-spec.json'), 'utf8');
    return { out, text, spec: JSON.parse(text), payload: emitted.payload, said: said.join('') };
  }
  async function rebuild(downloaded) {
    const step = await harness.measure(() => harness.build(downloaded.spec, { appFolder: downloaded.out, gated: true }));
    assert.equal(step.error, undefined, step.error && step.error.stack);
    assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.steps || step.value.result));
    return step;
  }
  return { org, harness, download, rebuild };
}

const familyWrites = (org, step) => org.requests.slice(step.mark, step.end)
  .flatMap((r) => (r.operations ? r.operations : [r]))
  .filter((r) => r.method !== 'GET' && /savedquer|AddSolutionComponent|solutioncomponent|_association/i.test(r.path));

test('a complete rebuild of a managed download that restored a view and a chart sends what a rebuild of the plain download sends, and nothing to either', async () => {
  const app = await builtLifecycle(stableSpec());
  const managed = await app.download({ managed: true });
  assert.deepEqual(managed.payload.managedViews, { restored: ['contoso_item/Items'], omitted: [] });
  assert.deepEqual(managed.payload.managedCharts, { restored: ['contoso_item/By Kind'], omitted: [] });
  assert.equal(managed.spec.views.length, 1);
  assert.equal(managed.spec.charts.length, 1);

  const restoredRebuild = await app.rebuild(managed);
  assert.deepEqual(familyWrites(app.org, restoredRebuild), [], 'no write to a view, a chart or a solution membership');
  const plain = await app.download({ managed: false });
  assert.deepEqual(plain.spec.views || [], []);
  const plainRebuild = await app.rebuild(plain);
  // The same publishes, in the same order, and the same writes: the restored view and chart add none — no publish of their table
  // above the ones the rest of the app's rebuild sends anyway (its forms, the app).
  assert.deepEqual(publishesOf(app.org, restoredRebuild), publishesOf(app.org, plainRebuild));
  assert.deepEqual(restoredRebuild.writes, plainRebuild.writes);

  const again = await app.download({ managed: true });
  assert.equal(again.text, managed.text, 'a second managed download writes the same spec, byte for byte');
  assert.deepEqual(app.org.unexpected, []);
});

// Column security a download cannot prove is the app's own: a custom profile in the app's solution, and System Administrator, each
// with a permission on the app's secured column and given to a user and a team. Both downloads name the custom profile and leave it
// out of the spec; nothing in the download, the complete rebuild of what it wrote, or a second download writes to a profile, a
// permission or a profile's links, and nothing it writes or prints names who holds a profile or which permission it is.
test('a profile on a secured column is named and left out by a managed download, and its rebuild and a second download leave every profile, permission and holder as they were', async () => {
  const spec = stableSpec();
  spec.entities[0].columns.push({ schemaName: 'contoso_salary', displayName: 'Salary', type: 'Text', isSecured: true });
  const app = await builtLifecycle(spec, { fieldSecurity: true });
  const { org } = app;
  const CANARY = {
    user: '7a1c0e55-0000-4000-8000-00000000c0a1', userName: 'Canary Holder Person', team: '7a1c0e55-0000-4000-8000-00000000c0a2',
    customPermission: '7a1c0e55-0000-4000-8000-00000000c0a3', adminPermission: '7a1c0e55-0000-4000-8000-00000000c0a4',
  };
  const custom = '7a1c0e55-0000-4000-8000-00000000c0a5';
  const admin = '572329c1-a042-4e22-be47-367c6374ea45';
  org.seedRow('systemusers', { systemuserid: CANARY.user, fullname: CANARY.userName, domainname: 'holder@contoso.onmicrosoft.com', _businessunitid_value: org.IDS.businessUnit });
  org.seedRow('fieldsecurityprofiles', { fieldsecurityprofileid: custom, name: 'Contoso Reviewers', ismanaged: false });
  org.seedRow('fieldsecurityprofiles', { fieldsecurityprofileid: admin, name: 'System Administrator', ismanaged: true });
  org.seedComponent('ContosoReview', { objectid: custom, componenttype: 70 });
  for (const [id, profile] of [[CANARY.customPermission, custom], [CANARY.adminPermission, admin]]) {
    org.seedRow('fieldpermissions', { fieldpermissionid: id, _fieldsecurityprofileid_value: profile, entityname: 'contoso_item', attributelogicalname: 'contoso_salary', canread: 4, cancreate: 0, canupdate: 0 });
  }
  for (const profile of [custom, admin]) {
    org.associations.push({ set: 'fieldsecurityprofiles', id: profile, nav: 'systemuserprofiles_association', toSet: 'systemusers', toId: CANARY.user });
    org.associations.push({ set: 'fieldsecurityprofiles', id: profile, nav: 'teamprofiles_association', toSet: 'teams', toId: CANARY.team });
  }
  const columnSecurity = () => JSON.stringify({
    profiles: [...org.rowsOf('fieldsecurityprofiles').values()].map((r) => r.data),
    permissions: [...org.rowsOf('fieldpermissions').values()].map((r) => r.data),
    holders: org.associations.filter((a) => a.set === 'fieldsecurityprofiles'),
    components: org.solutionComponents().filter((c) => c.componenttype === 70),
  });
  const before = columnSecurity();
  const start = org.mark();

  const managed = await app.download({ managed: true });
  assert.deepEqual(((managed.payload.fieldSecurityProfiles || {}).omitted || []).map((o) => [o.kind, o.id, o.name, o.code]), [['fieldSecurityProfile', custom, 'Contoso Reviewers', 'ownership-unproven']]);
  assert.match(managed.said, /NOTE: 1 field security profile \(Contoso Reviewers\) is not declared in fieldSecurityProfiles\[\]/);
  assert.equal(managed.spec.fieldSecurityProfiles, undefined);
  assert.equal(managed.spec.entities[0].columns.find((c) => c.schemaName === 'contoso_salary').isSecured, true);

  await app.rebuild(managed);
  const again = await app.download({ managed: true });
  assert.equal(again.text, managed.text, 'a second managed download writes the same spec, byte for byte');
  assert.deepEqual(again.payload.fieldSecurityProfiles, managed.payload.fieldSecurityProfiles);

  const touched = org.requests.slice(start)
    .flatMap((r) => (r.operations ? r.operations : [r]))
    .filter((r) => r.method !== 'GET' && /fieldsecurityprofile|fieldpermission|profiles_association|\$ref/i.test(r.path));
  assert.deepEqual(touched, [], 'no write to a profile, a permission or who holds a profile');
  assert.equal(columnSecurity(), before, 'every profile, permission, holder and solution membership is as it was');

  const written = [managed, again].flatMap((d) => fs.readdirSync(d.out, { recursive: true }).map((f) => path.join(d.out, f)))
    .filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8'));
  const printed = [managed, again].flatMap((d) => [d.said, JSON.stringify(d.payload)]);
  for (const [what, canary] of Object.entries(CANARY)) {
    for (const text of [...written, ...printed]) assert.equal(text.toLowerCase().includes(canary.toLowerCase()), false, `${what} appears in what the download wrote or printed`);
  }
  assert.deepEqual(org.unexpected, []);
});