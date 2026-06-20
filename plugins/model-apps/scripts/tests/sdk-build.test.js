'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runSdkBuild, planFor, formDef } = require('../lib/sdk-build.js');

// A representative relational spec: Customer 1:N Tickets, a Choice column, sample data
// with $parent, a view, a Choice chart, and a parent form with a child sub-grid.
function makeSpec() {
  return {
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', description: 'Tickets' },
    entities: [
      {
        schemaName: 'new_customer',
        displayName: 'Customer',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [{ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', options: ['Free', 'Pro'] }],
      },
      {
        schemaName: 'new_ticket',
        displayName: 'Ticket',
        primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
        columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }],
      },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } },
    ],
    views: [{ entity: 'new_ticket', name: 'Active Tickets', columns: ['new_subject', 'new_priority'] }],
    charts: [{ entity: 'new_ticket', name: 'By Priority', chartType: 'Pie', groupBy: 'new_priority', measure: 'count' }],
    forms: [{ entity: 'new_customer', name: 'Customer', layout: 'auto', subgrids: [{ childEntity: 'new_ticket', view: 'Active Tickets', label: 'Tickets' }] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_customer', title: 'Customers' }] }] }] },
    sampleData: {
      new_customer: [{ new_name: 'Acme', new_tier: 'Pro' }],
      new_ticket: [{ new_subject: 'Down', new_priority: 'High', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }],
    },
  };
}

function mockSdk(opts = {}) {
  const calls = [];
  let idc = 0;
  const sdk = {
    queryRecords: async (e, o) => { calls.push({ name: 'queryRecords', args: [e, o] }); return opts.noPublisher ? [] : [{ publisherid: 'pub-1' }]; },
    createPublisher: async (o) => { calls.push({ name: 'createPublisher', args: [o] }); return { id: 'pub-new' }; },
    createSolution: async (o) => { calls.push({ name: 'createSolution', args: [o] }); return { id: 'sol-1' }; },
    createTable: async (o) => { calls.push({ name: 'createTable', args: [o] }); if (opts.failTable === o.schemaName) throw new Error('table exists'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => { calls.push({ name: 'createColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase() }; },
    createRelationship: async (o) => { calls.push({ name: 'createRelationship', args: [o] }); return { schemaName: o.schemaName, lookupLogicalName: o.lookupSchemaName.toLowerCase() }; },
    resolveEntitySetName: async (l) => `${l}s`,
    createRecordsBulk: async (e, rows) => { calls.push({ name: 'createRecordsBulk', args: [e, rows] }); return rows.map((_, i) => `${e}-${i}`); },
    createArtifact: (t, def) => { calls.push({ name: 'createArtifact', args: [t, def] }); return Object.assign({ id: `${t}-${++idc}` }, def); },
    pushArtifact: async (t, id) => { calls.push({ name: 'pushArtifact', args: [t, id] }); return { type: t, id, success: true }; },
    addSubGrid: (formId, o) => { calls.push({ name: 'addSubGrid', args: [formId, o] }); return {}; },
    publishArtifact: async (t, id) => { calls.push({ name: 'publishArtifact', args: [t, id] }); },
  };
  return { sdk, calls };
}
const names = (calls) => calls.map((c) => c.name);
const find = (calls, name) => calls.filter((c) => c.name === name);

test('dry-run emits a plan and writes nothing', async () => {
  const { sdk, calls } = mockSdk();
  const events = [];
  const r = await runSdkBuild(makeSpec(), { sdk, apply: false, sampleData: true, publish: true, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(calls.length, 0, 'no SDK calls in dry-run');
  assert.ok(r.plan.some((l) => l.includes('create-solution ContosoSD')));
  assert.ok(r.plan.some((l) => l.includes('create-relationship 1:N')));
  assert.ok(events.every((e) => e.status === 'skip'));
});

test('apply runs phases in the correct order', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const seq = names(calls).filter((n) => n !== 'queryRecords');
  // solution -> tables/columns -> relationship -> sample data -> view -> chart -> form(+subgrid) -> app
  assert.deepStrictEqual(seq, [
    'createSolution',
    'createTable', 'createColumn', // customer
    'createTable', 'createColumn', // ticket
    'createRelationship',
    'createRecordsBulk', 'createRecordsBulk', // customer then ticket (topological)
    'createArtifact', 'pushArtifact', // view
    'createArtifact', 'pushArtifact', // chart
    'createArtifact', 'addSubGrid', 'pushArtifact', // form
    'createArtifact', 'pushArtifact', // app
  ]);
});

test('Choice column passes value/label option pairs', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const tierCol = find(calls, 'createColumn').find((c) => c.args[1].schemaName === 'new_tier');
  assert.strictEqual(tierCol.args[1].type, 'choice');
  assert.deepStrictEqual(tierCol.args[1].options, [{ value: 100000000, label: 'Free' }, { value: 100000001, label: 'Pro' }]);
});

test('relationship schema name differs from the lookup column name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const rel = find(calls, 'createRelationship')[0].args[0];
  assert.strictEqual(rel.type, 'OneToMany');
  assert.strictEqual(rel.referencedEntity, 'new_customer');
  assert.strictEqual(rel.referencingEntity, 'new_ticket');
  assert.strictEqual(rel.lookupSchemaName, 'new_CustomerId');
  assert.strictEqual(rel.schemaName, 'new_customer_new_ticket');
  assert.notStrictEqual(rel.schemaName, rel.lookupSchemaName);
});

test('sample data binds $parent via @odata.bind on the lookup nav property', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const ticketBulk = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_ticket');
  const body = ticketBulk.args[1][0];
  assert.strictEqual(body['new_CustomerId@odata.bind'], '/new_customers(new_customer-0)');
  assert.strictEqual(body.$parent, undefined, '$parent directive is never sent');
  assert.strictEqual(body.new_priority, 100000001, 'choice label High -> int');
});

test('form sub-grid references the child view id and the relationship name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const view = find(calls, 'createArtifact').find((c) => c.args[0] === 'view');
  const viewId = `view-1`;
  assert.strictEqual(view.args[1].name, 'Active Tickets');
  const sub = find(calls, 'addSubGrid')[0].args[1];
  assert.strictEqual(sub.entity, 'new_ticket');
  assert.strictEqual(sub.relationshipName, 'new_customer_new_ticket');
  assert.strictEqual(sub.viewId, viewId);
});

test('formDef lays out the primary + scalar columns as bound field cells', () => {
  const def = formDef(makeSpec(), { entity: 'new_customer', name: 'Customer' });
  assert.strictEqual(def.formType, 'Main');
  const fields = def.tabs[0].sections[0].rows.map((r) => r.cells[0].control.fieldName);
  assert.deepStrictEqual(fields, ['new_name', 'new_tier']);
  const primary = def.tabs[0].sections[0].rows[0].cells[0].control;
  assert.strictEqual(primary.isRequired, true);
  assert.strictEqual(primary.label, 'Name');
});

test('view def includes the requested columns + active-only filter', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const def = find(calls, 'createArtifact').find((c) => c.args[0] === 'view').args[1];
  assert.deepStrictEqual(def.columns.map((c) => c.name), ['new_subject', 'new_priority']);
  assert.strictEqual(def.filters.conditions[0].attribute, 'statecode');
});

test('chart def maps groupBy to a category and count to a series', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const def = find(calls, 'createArtifact').find((c) => c.args[0] === 'chart').args[1];
  assert.strictEqual(def.chartType, 'Pie');
  assert.strictEqual(def.categories[0].attribute, 'new_priority');
  assert.strictEqual(def.series[0].aggregate, 'count');
});

test('creates a publisher when none matches the prefix', async () => {
  const { sdk, calls } = mockSdk({ noPublisher: true });
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  assert.strictEqual(find(calls, 'createPublisher').length, 1);
  assert.strictEqual(find(calls, 'createSolution')[0].args[0].publisherId, 'pub-new');
});

test('an SDK failure halts with a BuildHalt carrying the phase', async () => {
  const { sdk } = mockSdk({ failTable: 'new_ticket' });
  const events = [];
  await assert.rejects(
    () => runSdkBuild(makeSpec(), { sdk, apply: true, emit: (e) => events.push(e) }),
    (err) => {
      assert.strictEqual(err.name, 'BuildHalt');
      assert.strictEqual(err.phase, 'data-model');
      return true;
    }
  );
  assert.ok(events.some((e) => e.status === 'error'), 'an error event was emitted');
});

test('publish phase publishes each artifact + the app when opted in', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, publish: true });
  const pubs = find(calls, 'publishArtifact').map((c) => c.args[0]);
  assert.ok(pubs.includes('form'));
  assert.ok(pubs.includes('view'));
  assert.ok(pubs.includes('chart'));
  assert.ok(pubs.includes('app'));
});

test('planFor counts every phase item', () => {
  const plan = planFor(makeSpec(), { sampleData: true, publish: true });
  const labels = plan.map((p) => p.label);
  assert.ok(labels.some((l) => l.includes('create-table new_customer')));
  assert.ok(labels.some((l) => l.includes('sample record(s) -> new_customer')));
  assert.ok(labels.some((l) => l.includes('main form for new_customer (sub-grids: new_ticket)')));
});
