'use strict';
// The download's portable schema, over the real bundle and the strict lifecycle fake: values a second
// environment cannot infer must survive, while rebuilding in place must not re-send their writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { readDashboards, entityFromMetadata } = require('../download-model-app.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>';
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoSchema', displayName: 'Portable Schema', publisherPrefix: 'contoso' },
  app: { name: 'Schema Options', description: 'A portable schema.' },
  globalChoices: [{ name: 'contoso_workstage', displayName: 'Work Stage', options: ['Planned', 'Done'] }],
  entities: [{
    schemaName: 'contoso_item', displayName: 'Item',
    primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name', maxLength: 120 },
    vectorIcon: 'contoso_item.svg',
    statusReasons: [
      { label: 'In Review', state: 'Active' },
      { label: 'Archived', state: 'Inactive', value: 100000042, color: '#336699' },
    ],
    alternateKeys: [{ schemaName: 'contoso_itememail', displayName: 'Item Email', columns: ['contoso_email'] }],
    columns: [
      { schemaName: 'contoso_email', displayName: 'Email', type: 'Text', format: 'Email', maxLength: 160 },
      { schemaName: 'contoso_notes', displayName: 'Notes', type: 'Memo', maxLength: 9000 },
      { schemaName: 'contoso_minutes', displayName: 'Minutes', type: 'Integer', minValue: 0, maxValue: 17, integerFormat: 'Duration' },
      { schemaName: 'contoso_rate', displayName: 'Rate', type: 'Decimal', precision: 4, minValue: 0, maxValue: 500 },
      { schemaName: 'contoso_score', displayName: 'Score', type: 'Double', precision: 3, minValue: -2.5, maxValue: 10.5 },
      { schemaName: 'contoso_cost', displayName: 'Cost', type: 'Money', precision: 3, minValue: 5, maxValue: 900 },
      { schemaName: 'contoso_billable', displayName: 'Billable', type: 'Boolean', trueLabel: 'Chargeable', falseLabel: 'No charge' },
      { schemaName: 'contoso_due', displayName: 'Due', type: 'DateTime', dateFormat: 'DateOnly' },
      { schemaName: 'contoso_reference', displayName: 'Reference', type: 'AutoNumber', autoNumberFormat: 'I-{SEQNUM:6}' },
      { schemaName: 'contoso_stage', displayName: 'Stage', type: 'Choice', globalChoice: 'contoso_workstage' },
    ],
  }],
  webResources: [{ name: 'contoso_item.svg', displayName: 'Item Icon', type: 'svg', content: ICON }],
  dashboards: [{
    name: 'Item Overview', tiles: [
      { type: 'iframe', name: 'Status', url: 'https://contoso.example/status', colspan: 2, rowspan: 8 },
      { type: 'iframe', name: 'Thin', url: 'https://contoso.example/thin', rowspan: 1 },
      { type: 'iframe', name: 'Default', url: 'https://contoso.example/default' },
    ],
  }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Items', subAreas: [
    { entity: 'contoso_item', title: 'Items' }, { dashboard: 'Item Overview', title: 'Overview' },
  ] }] }] },
};

const ran = (stage, name) => {
  if (stage.error) throw stage.error;
  assert.deepEqual(stage.unexpected, [], `every request ${name} sent is modelled`);
  return stage;
};
let walkPromise;
const walk = () => walkPromise || (walkPromise = (async () => {
  const root = makeTempDir('download-schema-options-');
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, root);
  const build = ran(await harness.measure(() => harness.build(spec)), 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result));
  const downloaded = ran(await harness.measure(() => harness.download(appUniqueName(spec), path.join(root, 'download'))), 'the download');
  assert.equal(downloaded.value.emitted.ok, true, JSON.stringify(downloaded.value.emitted));
  assert.deepEqual(downloaded.writes, {}, 'download is read-only');
  return { root, org, harness, downloaded, built: schemaOf(org) };
})());

function schemaOf(org) {
  const table = org.metadata.tables.get('contoso_item');
  const fields = ['AttributeTypeName', 'FormatName', 'Format', 'MaxLength', 'MinValue', 'MaxValue', 'Precision', 'PrecisionSource', 'AutoNumberFormat'];
  return {
    columns: Object.fromEntries([...table.Attributes]
      .filter(([name, a]) => a.AttributeOf === null && a.IsBaseCurrency !== true && spec.entities[0].columns.some((c) => c.schemaName === name))
      .map(([name, a]) => [name, Object.fromEntries(fields.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))])),
    primaryLength: table.Attributes.get('contoso_name').MaxLength,
    booleanLabels: ['TrueOption', 'FalseOption'].map((k) => org.metadata.textOf(table.Attributes.get('contoso_billable').OptionSet[k].Label)),
    statusReasons: table.Attributes.get('statuscode').OptionSet.Options.map((o) => ({
      value: o.Value, label: org.metadata.textOf(o.Label), state: o.State, color: o.Color,
    })),
    keys: [...table.Keys.values()].map((k) => ({ schemaName: k.SchemaName, displayName: org.metadata.textOf(k.DisplayName), columns: k.KeyAttributes })),
    vectorIcon: table.IconVectorName,
    solution: org.find('solutions', (s) => s.uniquename === spec.solution.uniqueName).map((s) => s.friendlyname),
    globalChoice: org.metadata.textOf(org.metadata.optionSets.get('contoso_workstage').DisplayName),
  };
}

test('download keeps the authored column formats, lengths, ranges, precision, labels and date format', async () => {
  const { downloaded } = await walk();
  const entity = downloaded.value.spec.entities[0];
  const byName = (a, b) => a.schemaName < b.schemaName ? -1 : a.schemaName > b.schemaName ? 1 : 0;
  assert.deepEqual(entity.columns, [...spec.entities[0].columns].sort(byName));
  assert.deepEqual(entity.primaryAttribute, spec.entities[0].primaryAttribute);
});

test('download keeps custom status reasons with their states, values and colors, without adding stock reasons', async () => {
  const { downloaded } = await walk();
  assert.deepEqual(downloaded.value.spec.entities[0].statusReasons, spec.entities[0].statusReasons);
});

test('download keeps an alternate key name, display name and column list', async () => {
  const { downloaded } = await walk();
  assert.deepEqual(downloaded.value.spec.entities[0].alternateKeys, spec.entities[0].alternateKeys);
});

test('download keeps the solution and referenced global choice display names', async () => {
  const { downloaded } = await walk();
  assert.equal(downloaded.value.spec.solution.displayName, spec.solution.displayName);
  assert.deepEqual(downloaded.value.spec.globalChoices, spec.globalChoices.map((g) => ({ ...g, existing: true })));
});

test('portable schema reads cost one per present column type and status table, not one per column', async (t) => {
  const { org, downloaded } = await walk();
  const requests = org.requests.slice(downloaded.mark, downloaded.end);
  const casts = {
    String: 'LogicalName,MaxLength,FormatName,AutoNumberFormat', Memo: 'LogicalName,MaxLength',
    Integer: 'LogicalName,MinValue,MaxValue,Format', Decimal: 'LogicalName,MinValue,MaxValue,Precision',
    Double: 'LogicalName,MinValue,MaxValue,Precision', DateTime: 'LogicalName,Format',
  };
  for (const [type, select] of Object.entries(casts)) {
    const reads = requests.filter((r) => r.method === 'GET' && r.path.endsWith(`/Microsoft.Dynamics.CRM.${type}AttributeMetadata?$select=${select}`));
    assert.equal(reads.length, 1, `${type} options take exactly one conditional cast`);
  }
  assert.equal(requests.filter((r) => /StatusAttributeMetadata\?\$select=LogicalName&/.test(r.path)).length, 2,
    'one SDK choices projection plus one portable-state read');
  assert.equal(requests.filter((r) => /MoneyAttributeMetadata\?\$select=LogicalName,IsBaseCurrency,MinValue,MaxValue,Precision,PrecisionSource$/.test(r.path)).length, 1,
    'Money options reuse the already-required currency-twin read');
  assert.equal(requests.filter((r) => /webresourceset\?.*name eq 'contoso_item\.svg'/.test(r.path)).length, 1);
  t.diagnostic(`portable download ${requests.length} GETs: 6 conditional column casts, 1 status cast; key/icon names, Money/Boolean options, display names and tile sizes reuse existing projections`);
});

test('download keeps a table vector icon only with its own unmanaged SVG resource, protected from teardown', async () => {
  const { downloaded } = await walk();
  assert.equal(downloaded.value.spec.entities[0].vectorIcon, 'contoso_item.svg');
  assert.deepEqual(downloaded.value.spec.webResources, [{
    name: 'contoso_item.svg', displayName: 'Item Icon', type: 'svg',
    contentBase64: Buffer.from(ICON).toString('base64'), external: true,
  }]);
});

test('download keeps dashboard tile sizes and omits exactly the dimensions a rebuild defaults', async () => {
  const { downloaded } = await walk();
  assert.deepEqual(downloaded.value.spec.dashboards[0].tiles, spec.dashboards[0].tiles);
});

test('all four supported dashboard tile types keep their size without any additional read', async () => {
  const calls = [];
  const id = '11111111-2222-4333-8444-555555555555';
  const viewId = '22222222-2222-4333-8444-555555555555';
  const chartId = '33333333-2222-4333-8444-555555555555';
  const sdk = {
    fetchArtifact: async (...args) => {
      calls.push(['fetchArtifact', ...args]);
      return { components: [
        { type: 'chart', name: 'Chart', colspan: 2, rowspan: 9, parameters: { TargetEntityType: 'contoso_item', ViewId: viewId, VisualizationId: chartId } },
        { type: 'list', name: 'List', colspan: 2, rowspan: 15, parameters: { TargetEntityType: 'contoso_item', ViewId: viewId } },
        { type: 'iframe', name: 'Frame', colspan: 1, rowspan: 1, parameters: { Url: 'https://contoso.example/frame' } },
        { type: 'webresource', name: 'Resource', colspan: 2, rowspan: 7, parameters: { WebResourceName: 'contoso_panel.html' } },
      ] };
    },
    queryRecords: async (...args) => { calls.push(['queryRecords', ...args]); return [{ name: 'Overview' }]; },
  };
  const result = await readDashboards(sdk, { siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'DashBoard', dashboardId: id }] }] }] } });
  assert.deepEqual(result[0].tiles.map(({ colspan, rowspan }) => ({ colspan, rowspan })), [
    { colspan: 2, rowspan: 9 }, { colspan: 2, rowspan: 15 }, { colspan: undefined, rowspan: 1 }, { colspan: 2, rowspan: 7 },
  ]);
  assert.equal(calls.length, 2);
});

test('a column at the build defaults gains no invented type options on download', () => {
  const entity = entityFromMetadata({
    schemaName: 'contoso_item', primaryNameAttribute: 'contoso_name',
    attributes: [
      { logicalName: 'contoso_name', displayName: 'Name', attributeType: 'String', maxLength: 100 },
      { logicalName: 'contoso_text', displayName: 'Text', attributeType: 'String', maxLength: 100, FormatName: { Value: 'Text' } },
      { logicalName: 'contoso_flag', displayName: 'Flag', attributeType: 'Boolean', choices: [{ value: 0, label: 'No' }, { value: 1, label: 'Yes' }] },
    ],
  }, 'contoso_item');
  assert.deepEqual(entity.primaryAttribute, { schemaName: 'contoso_name', displayName: 'Name', maxLength: 100 });
  assert.deepEqual(entity.columns, [
    { schemaName: 'contoso_text', displayName: 'Text', type: 'Text' },
    { schemaName: 'contoso_flag', displayName: 'Flag', type: 'Boolean' },
  ]);
});

test('rebuilding the downloaded spec in place sends no column, status-reason, key or table-icon write', async () => {
  const { root, org, harness, downloaded, built } = await walk();
  const dir = path.join(root, 'download');
  const rebuild = ran(await harness.measure(() => harness.build(downloaded.value.spec, {
    appFolder: dir, workspace: path.join(dir, '.maker-workspace'),
  })), 'the same-environment rebuild');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result));
  const schemaWrites = Object.fromEntries(Object.entries(rebuild.writes).filter(([key]) =>
    /EntityDefinitions|InsertStatusValue|GlobalOptionSetDefinitions|webresourceset/.test(key)));
  assert.deepEqual(schemaWrites, {});
  assert.deepEqual(schemaOf(org), built, 'every schema option stays unchanged');
  assert.deepEqual(validateAppSpec(downloaded.value.spec, { profile: 'plan', reconstructed: true }).errors, []);
});

test('building the downloaded spec in another environment recreates the same schema options', async () => {
  const { root, downloaded, built } = await walk();
  const fresh = createLifecycleOrg();
  const freshHarness = createLifecycleHarness(fresh, path.join(root, 'fresh'));
  const portable = structuredClone(downloaded.value.spec);
  // Dashboard ids pin an edit in the source environment, not an artifact to create in another one.
  for (const d of portable.dashboards) delete d.dashboardId;
  const create = ran(await freshHarness.measure(() => freshHarness.build(portable, { appFolder: path.join(root, 'download') })), 'the cross-environment build');
  assert.equal(create.value.result.ok, true, JSON.stringify(create.value.result));
  assert.deepEqual(schemaOf(fresh), built);
  assert.equal(fresh.find('webresourceset', (w) => w.name === 'contoso_item.svg')[0].content, Buffer.from(ICON).toString('base64'));
  const dashboard = fresh.find('systemforms', (f) => f.name === 'Item Overview')[0];
  assert.match(dashboard.formxml, /colspan="2" rowspan="8"|rowspan="8" colspan="2"/);
});

test('no-op proofs do not suppress a missing status, key, icon or a real Whole Number format edit', async () => {
  const { org, root, harness, downloaded, built } = await walk();
  const table = org.metadata.tables.get('contoso_item');
  table.Keys.delete('contoso_itememail');
  table.IconVectorName = null;
  table.Attributes.get('contoso_minutes').Format = 'None';
  const status = table.Attributes.get('statuscode').OptionSet;
  status.Options = status.Options.filter((o) => o.Value !== 100000042);
  const dir = path.join(root, 'download');
  const rebuild = ran(await harness.measure(() => harness.build(downloaded.value.spec, {
    appFolder: dir, workspace: path.join(dir, '.maker-workspace'),
  })), 'the repair rebuild');
  assert.equal(rebuild.value.result.ok, true, JSON.stringify(rebuild.value.result));
  assert.equal(rebuild.writes['POST InsertStatusValue'], 1);
  assert.equal(rebuild.writes['POST EntityDefinitions/Keys'], 1);
  assert.equal(rebuild.writes['PUT EntityDefinitions'], 1);
  assert.equal(rebuild.writes['PUT EntityDefinitions/Attributes'], 1);
  assert.deepEqual(schemaOf(org), built);
});
