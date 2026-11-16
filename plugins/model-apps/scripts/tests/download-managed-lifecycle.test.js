'use strict';
// The managed download's restore of declared views and charts, and of protected configuration, end to end, on the strict lifecycle org (helpers/fake-lifecycle-org.js,
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
const { readDeploymentBindings } = require('../lib/configuration-artifacts.js');
const { validateAppSpec } = require('../lib/app-spec.js');

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
async function builtLifecycle(spec, orgOptions = {}, buildOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-managed-life-'));
  roots.push(root);
  const org = createLifecycleOrg(orgOptions);
  const harness = createLifecycleHarness(org, root);
  const built = await harness.measure(() => harness.build(spec, { gated: true, ...buildOptions }));
  assert.equal(built.error, undefined, built.error && `${built.error.stack}\nunexpected: ${JSON.stringify(org.unexpected)}`);
  assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.steps || built.value.result));
  const store = path.join(harness.workspaceDir, fs.readdirSync(harness.workspaceDir).find((f) => f.startsWith(PREFIX)));
  let n = 0;
  // `connections`: the environment's connections the download may prove a page's reference bound against (main's `connections` seam,
  // rows as list-connections.js answers them). Read at call time, so a test can change them between downloads.
  async function download({ managed, connections }) {
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
        ...(connections ? { connections: async () => connections.map((c) => ({ ...c })) } : {}),
      });
    } finally {
      for (const x of streams) x.s.write = x.write;
    }
    assert.equal(emitted && emitted.ok, true, JSON.stringify(emitted) + said.join(''));
    const text = fs.readFileSync(path.join(out, 'app-spec.json'), 'utf8');
    return { out, text, spec: JSON.parse(text), payload: emitted.payload, said: said.join('') };
  }
  async function rebuild(downloaded, options = {}) {
    const step = await harness.measure(() => harness.build(downloaded.spec, { appFolder: downloaded.out, gated: true, ...options }));
    assert.equal(step.error, undefined, step.error && step.error.stack);
    assert.equal(step.value.result.ok, true, JSON.stringify(step.value.result.steps || step.value.result));
    return step;
  }
  return { org, harness, store, built, download, rebuild };
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
// Protected configuration (configurationIdentity "stable-v1") end to end on the strict lifecycle org made with its configuration tables:
// the gated build binds canary values and a connection from deployment settings; the CLI's own download main — its real producer, not a
// stand-in — restores each proved item; the downloaded spec reloads, validates and rebuilds completely (every phase, publish and
// verify); and a second download writes the same bytes. The rebuild sends no write to a configuration row or a solution membership, the
// download leaves the binding store and the build's folder as they were, and no value, default, value schema or connection appears in
// anything either download wrote or printed.
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const CONFIG_CANARY = {
  value: 'canary-life-value-5d2a',
  siteValue: 'canary-life-site-7c31',
  default: 'canary-life-default-0e94',
  jsonDefault: 'canary-life-jsondefault-61bf',
  schema: 'canary-life-schema-a83e',
  connection: 'canary-life-conn-4b07',
};
function configuredSpec() {
  return {
    ...stableSpec(), minimumPluginVersion: '2.25.0', configurationIdentity: 'stable-v1',
    environmentVariables: [
      { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', description: 'Base address', defaultValue: `https://${CONFIG_CANARY.default}.contoso.example`, isRequired: true },
      { schemaName: 'contoso_Shape', type: 'json', defaultValue: `{"k":"${CONFIG_CANARY.jsonDefault}"}`, valueSchema: `{"type":"object","title":"${CONFIG_CANARY.schema}"}` },
      { schemaName: 'contoso_Site', type: 'dataSource', connectorId: SP, parameterKey: 'dataset' },
      { schemaName: 'contoso_List', type: 'dataSource', connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    ],
    connectionReferences: [{ logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint', description: 'Lists' }],
    customApis: [{ uniqueName: 'contoso_Ping', binding: 'global', requestParameters: [{ uniqueName: 'In', type: 'string' }], responseProperties: [{ uniqueName: 'Out', type: 'string' }] }],
  };
}
const CONFIG_SETS = ['environmentvariabledefinitions', 'environmentvariablevalues', 'connectionreferences', 'customapis', 'customapirequestparameters', 'customapiresponseproperties'];
const walkFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const folderBytes = (dir) => Object.fromEntries(walkFiles(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f).toString('base64')]));

const CONFIG_REGEX = /environmentvariable|connectionreference|customapi|duplicaterule|AddSolutionComponent|solutioncomponent/i;
const configurationWrites = (org, step) => org.requests.slice(step.mark, step.end)
  .flatMap((r) => (r.operations ? r.operations : [r]))
  .filter((r) => r.method !== 'GET' && CONFIG_REGEX.test(r.path));
// Everything one request carried, as text: its path, its body and, for a batch, each of its operations.
const sentText = (r) => JSON.stringify([r.path, Buffer.isBuffer(r.body) ? r.body.toString('latin1') : r.body, r.operations || null]);
const UNPROVEN = ['configuration:customApi contoso_Ping: implementation (CUSTOM_API_IMPLEMENTATION_UNPROVEN)'];

test('protected configuration restored by a managed download rebuilds completely with no configuration write, downloads again byte for byte, and writes no value, default, value schema or connection anywhere', async () => {
  const spec = configuredSpec();
  const settings = {
    EnvironmentVariables: [
      { SchemaName: 'contoso_ApiBase', Value: `https://${CONFIG_CANARY.value}.contoso.example` },
      { SchemaName: 'contoso_Site', Value: `https://${CONFIG_CANARY.siteValue}.sharepoint.example/sites/a` },
    ],
    ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: CONFIG_CANARY.connection, ConnectorId: SP }],
  };
  const bindings = readDeploymentBindings(settings, spec);
  assert.deepEqual(bindings.errors, []);
  const app = await builtLifecycle(spec, { configuration: true }, { configurationBindings: bindings, connections: [{ connectionId: CONFIG_CANARY.connection, connectorId: SP, displayName: 'SharePoint' }] });
  const { org, harness } = app;
  // The build verified every item it could, and a Custom API's implementation is reported unverified, not failed: no plug-in is
  // declared for it, and nothing a build reads can prove one.
  assert.equal(app.built.value.result.verify.ok, true);
  assert.deepEqual(app.built.value.result.verify.missing, []);
  assert.deepEqual(app.built.value.result.verify.unverified, UNPROVEN);
  // The rows the build made, and the canaries it sent there: the test's own proof that each canary reached the org.
  const rowId = (set, column, name) => {
    const rows = [...org.rowsOf(set).values()].filter((r) => String(r.data[column]).toLowerCase() === name.toLowerCase());
    assert.equal(rows.length, 1, `one ${set} row named ${name}`);
    return rows[0].id;
  };
  const ids = {
    contoso_apibase: rowId('environmentvariabledefinitions', 'schemaname', 'contoso_ApiBase'),
    contoso_shape: rowId('environmentvariabledefinitions', 'schemaname', 'contoso_Shape'),
    contoso_site: rowId('environmentvariabledefinitions', 'schemaname', 'contoso_Site'),
    contoso_sp: rowId('connectionreferences', 'connectionreferencelogicalname', 'contoso_sp'),
  };
  // The filter below sees what a configuration create sends: the build's own writes are caught by it.
  assert.ok(configurationWrites(org, app.built).length > 0);
  const orgText = JSON.stringify(CONFIG_SETS.flatMap((set) => [...org.rowsOf(set).values()].map((r) => r.data)));
  for (const canary of Object.values(CONFIG_CANARY)) assert.ok(orgText.includes(canary), `the build stored ${canary}`);

  const before = folderBytes(harness.appDir);
  const fromDownload = org.mark();
  const managed = await app.download({ managed: true });
  assert.deepEqual(folderBytes(harness.appDir), before, 'the download leaves the binding store and the build folder as they were');
  assert.deepEqual(org.writeCounts(fromDownload), {}, 'the download sends no write');
  // The file reloads as an App Spec the build accepts, as a maker's next build reads it.
  const reloaded = validateAppSpec(JSON.parse(fs.readFileSync(path.join(managed.out, 'app-spec.json'), 'utf8')), { profile: 'deploy' });
  assert.deepEqual(reloaded.errors, []);
  assert.equal(reloaded.ok, true);
  assert.equal(managed.spec.configurationIdentity, 'stable-v1');
  assert.equal(managed.spec.minimumPluginVersion, '2.25.0');
  assert.deepEqual(managed.spec.environmentVariables, [
    { schemaName: 'contoso_ApiBase', type: 'string', name: 'API base', description: 'Base address', isRequired: true },
    { schemaName: 'contoso_Site', type: 'dataSource', name: 'contoso_Site', isRequired: false, connectorId: SP, parameterKey: 'dataset' },
    { schemaName: 'contoso_List', type: 'dataSource', name: 'contoso_List', isRequired: false, connectorId: SP, parameterKey: 'table', parentSchemaName: 'contoso_Site' },
    { schemaName: 'contoso_Shape', type: 'json', name: 'contoso_Shape', isRequired: false },
  ]);
  assert.deepEqual(managed.spec.connectionReferences, [{ logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint', description: 'Lists' }]);
  assert.deepEqual(managed.spec.customApis, [{
    uniqueName: 'contoso_Ping', name: 'contoso_Ping', displayName: 'contoso_Ping', description: 'contoso_Ping', binding: 'global', isFunction: false, isPrivate: false, allowedProcessingSteps: 'none', enabledForWorkflow: false,
    requestParameters: [{ uniqueName: 'In', type: 'string', name: 'contoso_Ping.In', displayName: 'In', description: 'In', isOptional: false }],
    responseProperties: [{ uniqueName: 'Out', type: 'string', name: 'contoso_Ping.Out', displayName: 'Out', description: 'Out' }],
  }]);
  const withheld = (report) => report.withheld.map((w) => ({ kind: w.kind, id: w.id, key: w.key, fields: w.fields, code: w.code }));
  assert.deepEqual({ restored: managed.payload.managedEnvironmentVariables.restored, omitted: managed.payload.managedEnvironmentVariables.omitted }, { restored: ['contoso_apibase', 'contoso_site', 'contoso_list', 'contoso_shape'], omitted: [] });
  assert.deepEqual(withheld(managed.payload.managedEnvironmentVariables), [
    { kind: 'environment variable', id: ids.contoso_apibase, key: 'contoso_apibase', fields: ['defaultValue', 'value'], code: 'fields-withheld' },
    { kind: 'environment variable', id: ids.contoso_site, key: 'contoso_site', fields: ['value'], code: 'fields-withheld' },
    { kind: 'environment variable', id: ids.contoso_shape, key: 'contoso_shape', fields: ['defaultValue', 'valueSchema'], code: 'fields-withheld' },
  ]);
  assert.deepEqual({ restored: managed.payload.managedConnectionReferences.restored, omitted: managed.payload.managedConnectionReferences.omitted }, { restored: ['contoso_sp'], omitted: [] });
  assert.deepEqual(withheld(managed.payload.managedConnectionReferences), [{ kind: 'connection reference', id: ids.contoso_sp, key: 'contoso_sp', fields: ['connection'], code: 'fields-withheld' }]);
  assert.deepEqual(managed.payload.managedCustomApis, { restored: ['contoso_ping'], omitted: [] });

  // The complete rebuild of what the download wrote: every phase, publish and verify, with no deployment settings. The values the
  // download left out stay as they are in the service, and the Custom API's implementation is still unverified, not failed.
  const restoredRebuild = await app.rebuild(managed);
  assert.deepEqual(configurationWrites(org, restoredRebuild), [], 'no write to a configuration row or a solution membership');
  assert.deepEqual(restoredRebuild.value.result.verify.missing, []);
  assert.deepEqual(restoredRebuild.value.result.verify.unverified, UNPROVEN);
  // A rebuild of the plain download of the same app over the same workspace is the baseline: the restored items add no write to it.
  const plain = await app.download({ managed: false });
  assert.equal(plain.spec.environmentVariables, undefined);
  const plainRebuild = await app.rebuild(plain);
  assert.deepEqual(restoredRebuild.writes, plainRebuild.writes);
  assert.deepEqual(publishesOf(org, restoredRebuild), publishesOf(org, plainRebuild));

  const beforeAgain = folderBytes(harness.appDir);
  const again = await app.download({ managed: true });
  assert.deepEqual(folderBytes(harness.appDir), beforeAgain);
  assert.equal(again.text, managed.text, 'a second managed download writes the same spec, byte for byte');

  // No canary in anything either managed download wrote or printed, or in anything sent from the first download on (the rebuilds).
  const written = [
    ['managed stream', managed.said], ['managed result', JSON.stringify(managed.payload)], ['second stream', again.said], ['second result', JSON.stringify(again.payload)],
    ...[managed.out, again.out].flatMap((dir) => walkFiles(dir).map((f) => [f, fs.readFileSync(f, 'latin1')])),
    ...org.requests.slice(fromDownload).map((r, n) => [`request ${n} ${r.method} ${r.path}`, sentText(r)]),
  ];
  for (const [where, text] of written) for (const canary of Object.values(CONFIG_CANARY)) assert.ok(!text.includes(canary), `${canary} in ${where}`);
  assert.deepEqual(org.unexpected, []);
});

// A page that names a connection reference makes a rebuild gate the page on the reference's binding, proven against the environment's
// connections (configuration-artifacts.js observe): the connection must be there and be one of the connector the reference names. A
// connection id on the row is not that proof. So a managed download restores a reference a page names only when the same proof holds
// as it downloads; otherwise it names it `page-unready` and leaves it out, as a plain download does, and the rebuild writes the page.
test('a reference a page names is restored only when the connections prove it bound to its connector; with none, or a connection of another connector, it is left out and the rebuild writes the page', async () => {
  const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';
  const spec = configuredSpec();
  spec.pages = [{ key: 'preview', name: 'Preview', purpose: 'Preview items', dataSources: ['contoso_item'], source: { kind: 'tsx', codeFile: 'KitchenPage.tsx' }, connectorBindings: [{ logicalName: 'contoso_sp', connectorId: SP }] }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'preview', title: 'Preview' });
  const usable = [{ connectionId: CONFIG_CANARY.connection, connectorId: SP, displayName: 'SharePoint' }];
  const bindings = readDeploymentBindings({ ConnectionReferences: [{ LogicalName: 'contoso_sp', ConnectionId: CONFIG_CANARY.connection, ConnectorId: SP }] }, spec);
  assert.deepEqual(bindings.errors, []);
  const app = await builtLifecycle(spec, { configuration: true }, { configurationBindings: bindings, connections: usable });
  const { org } = app;
  const referenceRows = () => JSON.stringify([...org.rowsOf('connectionreferences').values()].map((r) => r.data));
  const rowsBefore = referenceRows();
  const fromDownload = org.mark();
  const reason = require('../lib/managed-restore-report.js').REASONS['page-unready'];
  const left = (dl) => dl.payload.managedConnectionReferences.omitted.map((o) => [o.key, o.code, o.reason]);

  // The connection is there and is one of the reference's connector: restored, and its rebuild writes the page through the gate.
  const bound = await app.download({ managed: true, connections: usable });
  assert.deepEqual(bound.payload.managedConnectionReferences.restored, ['contoso_sp']);
  assert.deepEqual(left(bound), []);
  assert.deepEqual(bound.spec.connectionReferences, [{ logicalName: 'contoso_sp', connectorId: SP, name: 'SharePoint', description: 'Lists' }]);
  const boundRebuild = await app.rebuild(bound, { connections: usable });
  assert.deepEqual(configurationWrites(org, boundRebuild), []);

  // The connection is gone before the download begins, while the row still holds its id: left out, and the complete rebuild of what
  // the download wrote, against the same (empty) connections, writes the page as the rebuild of the plain download does.
  const none = [];
  const unready = await app.download({ managed: true, connections: none });
  assert.deepEqual(unready.payload.managedConnectionReferences.restored, []);
  assert.deepEqual(left(unready), [['contoso_sp', 'page-unready', reason]]);
  assert.equal(unready.spec.connectionReferences, undefined);
  assert.match(unready.said, /WARNING: managed connection reference contoso_sp was not restored: a page of the app names it/);
  assert.deepEqual(unready.payload.managedCustomApis, { restored: ['contoso_ping'], omitted: [] });
  const unreadyRebuild = await app.rebuild(unready, { connections: none });
  assert.deepEqual(configurationWrites(org, unreadyRebuild), []);
  const plain = await app.download({ managed: false });
  await app.rebuild(plain, { connections: none });

  // The connection id on the row is a connection of another connector: not a binding the page can use.
  const other = await app.download({ managed: true, connections: [{ connectionId: CONFIG_CANARY.connection, connectorId: SQL, displayName: 'SQL' }] });
  assert.deepEqual(other.payload.managedConnectionReferences.restored, []);
  assert.deepEqual(left(other), [['contoso_sp', 'page-unready', reason]]);
  assert.equal(other.spec.connectionReferences, undefined);

  assert.equal(referenceRows(), rowsBefore, 'the reference row is as the build left it');
  const written = [
    ...[bound, other, unready].flatMap((dl) => [[`${dl.out} stream`, dl.said], [`${dl.out} result`, JSON.stringify(dl.payload)], ...walkFiles(dl.out).map((f) => [f, fs.readFileSync(f, 'latin1')])]),
    ...org.requests.slice(fromDownload).map((r, n) => [`request ${n} ${r.method} ${r.path}`, sentText(r)]),
  ];
  for (const [where, text] of written) for (const canary of Object.values(CONFIG_CANARY)) assert.ok(!text.includes(canary), `${canary} in ${where}`);
  assert.deepEqual(org.unexpected, []);
});