'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runSdkBuild, planFor, resolvePhases, formDef, viewDef, appDef, PHASES } = require('../lib/sdk-build.js');

// Customer 1:N Tickets: a Choice column, sample data with $parent, a view, a Choice chart,
// and a parent form with a child sub-grid.
function makeSpec(extra = {}) {
  return Object.assign({
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', description: 'Tickets' },
    entities: [
      { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
        columns: [{ schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', options: ['Free', 'Pro'] }] },
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
        columns: [{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }] },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
    views: [{ entity: 'new_ticket', name: 'Active Tickets', columns: ['new_subject', 'new_priority'] }],
    charts: [{ entity: 'new_ticket', name: 'By Priority', chartType: 'Pie', groupBy: 'new_priority', measure: 'count' }],
    forms: [{ entity: 'new_customer', name: 'Customer', layout: 'auto', subgrids: [{ childEntity: 'new_ticket', view: 'Active Tickets', label: 'Tickets' }] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_customer', title: 'Customers' }] }] }] },
    sampleData: {
      new_customer: [{ new_name: 'Acme', new_tier: 'Pro' }],
      new_ticket: [{ new_subject: 'Down', new_priority: 'High', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }],
    },
  }, extra);
}

// `existingTables`: { logical: { entitySetName, columns:[logical...], relationships:[schema...] } }
function mockSdk(opts = {}) {
  const calls = [];
  let idc = 0;
  const ex = opts.existingTables || {};
  const sdk = {
    queryRecords: async (e, o) => { calls.push({ name: 'queryRecords', args: [e, o] }); if (e === 'solution') return opts.solutionExists ? [{ solutionid: 's' }] : []; if (e === 'webresource') return opts.existingWebResource ? [{ webresourceid: 'wr-existing' }] : []; return opts.noPublisher ? [] : [{ publisherid: 'pub-1' }]; },
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); return { id: `wr-${++idc}`, name: o.name }; },
    fetchArtifact: async (t, id) => { calls.push({ name: 'fetchArtifact', args: [t, id] }); return { id }; },
    addFormEventHandler: (id, o) => { calls.push({ name: 'addFormEventHandler', args: [id, o] }); return {}; },
    createPublisher: async (o) => { calls.push({ name: 'createPublisher', args: [o] }); return { id: 'pub-new' }; },
    createSolution: async (o) => { calls.push({ name: 'createSolution', args: [o] }); return { id: 'sol-1' }; },
    findTables: async (q, o) => { calls.push({ name: 'findTables', args: [q, o] }); const t = ex[String(q).toLowerCase()]; return t ? [{ logicalName: String(q).toLowerCase(), schemaName: q, displayName: q, entitySetName: t.entitySetName, isCustom: true }] : []; },
    findColumns: async (logical) => { calls.push({ name: 'findColumns', args: [logical] }); const t = ex[logical]; return ((t && t.columns) || []).map((c) => ({ logicalName: c, schemaName: c, displayName: c, attributeType: 'String', isCustom: true })); },
    fetchEntityMetadata: async (logical) => { calls.push({ name: 'fetchEntityMetadata', args: [logical] }); const t = ex[logical]; return { logicalName: logical, displayName: logical, entitySetName: (t && t.entitySetName) || `${logical}s`, attributes: ((t && t.columns) || []).map((c) => ({ logicalName: c })), relationships: ((t && t.relationships) || []).map((s) => ({ schemaName: s, type: 'OneToMany' })) }; },
    createTable: async (o) => { calls.push({ name: 'createTable', args: [o] }); if (opts.failTable === o.schemaName) throw new Error('boom'); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
    createColumn: async (e, o) => { calls.push({ name: 'createColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createRelationship: async (o) => { calls.push({ name: 'createRelationship', args: [o] }); return { schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }; },
    createGlobalOptionSet: async (o) => { calls.push({ name: 'createGlobalOptionSet', args: [o] }); return { name: o.name, metadataId: `gc-${o.name}` }; },
    createCustomerColumn: async (e, o) => { calls.push({ name: 'createCustomerColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    insertStatusValue: async (e, o) => { calls.push({ name: 'insertStatusValue', args: [e, o] }); if (opts.statusExists) { const err = new Error('HTTP 400: a status value with this name already exists'); err.statusCode = 400; throw err; } return 100000001; },
    createAlternateKey: async (e, o) => {
      calls.push({ name: 'createAlternateKey', args: [e, o] });
      if (opts.altKeyExists) { const err = new Error(`HTTP 400 from /Keys: An attribute or relationship with the name '${o.schemaName}' already exists`); err.statusCode = 400; throw err; }
      if (opts.altKeyError) { const err = new Error('HTTP 400 from /Keys: key attribute is not valid'); err.statusCode = 400; throw err; }
      return { logicalName: o.schemaName.toLowerCase() };
    },
    createRecordsBulk: async (e, rows) => { calls.push({ name: 'createRecordsBulk', args: [e, rows] }); return rows.map((_, i) => `${e}-${i}`); },
    createArtifact: (t, def) => { calls.push({ name: 'createArtifact', args: [t, def] }); return Object.assign({ id: `${t}-${++idc}` }, def); },
    pushArtifact: async (t, id) => { calls.push({ name: 'pushArtifact', args: [t, id] }); return { type: t, id, success: true }; },
    addSubGrid: (formId, o) => { calls.push({ name: 'addSubGrid', args: [formId, o] }); return {}; },
    addQuickViewControl: (formId, o) => { calls.push({ name: 'addQuickViewControl', args: [formId, o] }); return {}; },
    addDashboardTile: (id, o) => { calls.push({ name: 'addDashboardTile', args: [id, o] }); return {}; },
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async (t, id) => { calls.push({ name: 'publishArtifact', args: [t, id] }); },
  };
  return { sdk, calls };
}
const find = (calls, name) => calls.filter((c) => c.name === name);
const has = (calls, name) => calls.some((c) => c.name === name);

test('dry-run emits a plan and writes nothing', async () => {
  const { sdk, calls } = mockSdk();
  const events = [];
  const r = await runSdkBuild(makeSpec(), { sdk, apply: false, sampleData: true, publish: true, emit: (e) => events.push(e) });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(calls.length, 0);
  assert.ok(r.plan.some((l) => l.includes('solution ContosoSD')));
  assert.ok(events.every((e) => e.status === 'skip'));
});

test('fresh build runs phases in order and creates everything', async () => {
  const { sdk, calls } = mockSdk();
  const events = [];
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true, publish: true, emit: (e) => events.push(e) });
  // phase order: first appearance of each phase follows PHASES order
  const firstIdx = {};
  events.forEach((e, i) => { if (firstIdx[e.phase] === undefined) firstIdx[e.phase] = i; });
  const seen = PHASES.filter((p) => firstIdx[p] !== undefined);
  const sortedByAppearance = seen.slice().sort((a, b) => firstIdx[a] - firstIdx[b]);
  assert.deepStrictEqual(seen, sortedByAppearance, 'phases appear in canonical order');
  // key writes present
  assert.ok(has(calls, 'createSolution'));
  assert.strictEqual(find(calls, 'createTable').length, 2);
  assert.strictEqual(find(calls, 'createRelationship').length, 1);
  assert.strictEqual(find(calls, 'createRecordsBulk').length, 2);
  assert.ok(find(calls, 'createArtifact').length >= 4); // 1 view + 1 chart + 1 form + 1 app
});

test('Choice column passes value/label option pairs', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const tier = find(calls, 'createColumn').find((c) => c.args[1].schemaName === 'new_tier');
  assert.strictEqual(tier.args[1].type, 'choice');
  assert.deepStrictEqual(tier.args[1].options, [{ value: 100000000, label: 'Free' }, { value: 100000001, label: 'Pro' }]);
});

test('relationship schema name differs from the lookup column name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const rel = find(calls, 'createRelationship')[0].args[0];
  assert.strictEqual(rel.referencedEntity, 'new_customer');
  assert.strictEqual(rel.referencingEntity, 'new_ticket');
  assert.strictEqual(rel.lookupSchemaName, 'new_CustomerId');
  assert.strictEqual(rel.schemaName, 'new_customer_new_ticket');
});

test('sample data binds $parent via @odata.bind using the entity-set name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const ticketBulk = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_ticket');
  const body = ticketBulk.args[1][0];
  assert.strictEqual(body['new_CustomerId@odata.bind'], '/new_customers(new_customer-0)');
  assert.strictEqual(body.$parent, undefined);
  assert.strictEqual(body.new_priority, 100000001);
});

test('form sub-grid references the child view id and relationship name', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const sub = find(calls, 'addSubGrid')[0].args[1];
  assert.strictEqual(sub.entity, 'new_ticket');
  assert.strictEqual(sub.relationshipName, 'new_customer_new_ticket');
  assert.strictEqual(sub.viewId, 'view-1');
});

test('idempotent: an existing table is reused — no createTable, and only missing columns added', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customers', columns: ['new_name', 'new_tier'], relationships: [] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const tablesCreated = find(calls, 'createTable').map((c) => c.args[0].schemaName);
  assert.ok(!tablesCreated.includes('new_customer'), 'existing table not re-created');
  assert.ok(tablesCreated.includes('new_ticket'), 'missing table still created');
  // new_customer's columns already exist -> no createColumn for new_tier
  assert.ok(!find(calls, 'createColumn').some((c) => c.args[0] === 'new_customer'), 'existing columns not re-added');
});

test('idempotent: an existing relationship is skipped', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customers', columns: [], relationships: ['new_customer_new_ticket'] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  assert.strictEqual(find(calls, 'createRelationship').length, 0, 'existing relationship not re-created');
});

test('existing-table entity-set name comes from findTables (sample-data binding works)', async () => {
  const { sdk, calls } = mockSdk({ existingTables: { new_customer: { entitySetName: 'new_customerset', columns: ['new_name', 'new_tier'], relationships: [] } } });
  await runSdkBuild(makeSpec(), { sdk, apply: true, sampleData: true });
  const ticketBulk = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_ticket');
  assert.strictEqual(ticketBulk.args[1][0]['new_CustomerId@odata.bind'], '/new_customerset(new_customer-0)');
});

test('artifacts added to the solution by component type (view 26 / chart 59 / form 60 / app 80)', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true });
  const types = find(calls, 'addSolutionComponent').map((c) => c.args[0].componentType).sort((a, b) => a - b);
  assert.deepStrictEqual(types, [26, 59, 60, 80]);
});

test('Tier 1 data model: global choices, rich column types, customer, status, alt keys, N:N', async () => {
  const spec = makeSpec();
  spec.globalChoices = [{ name: 'new_severity', displayName: 'Severity', options: ['Low', 'High'] }];
  spec.entities[0].columns.push(
    { schemaName: 'new_ref', displayName: 'Ref', type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}' },
    { schemaName: 'new_sev', displayName: 'Severity', type: 'Choice', globalChoice: 'new_severity' },
    { schemaName: 'new_owner', displayName: 'Owner', type: 'Customer' },
    { schemaName: 'new_photo', displayName: 'Photo', type: 'Image', maxSizeKb: 5120 },
    { schemaName: 'new_score', displayName: 'Score', type: 'Decimal', minValue: 0, maxValue: 100, precision: 2 }
  );
  spec.entities[0].statusReasons = [{ label: 'In Review', state: 'Active' }];
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_ticket' });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });

  assert.strictEqual(find(calls, 'createGlobalOptionSet')[0].args[0].name, 'new_severity');
  const col = (n) => find(calls, 'createColumn').find((c) => c.args[1].schemaName === n).args[1];
  assert.strictEqual(col('new_sev').globalChoiceMetadataId, 'gc-new_severity', 'choice binds the global set');
  assert.strictEqual(col('new_ref').autoNumberFormat, 'C-{SEQNUM:5}');
  assert.strictEqual(col('new_photo').maxSizeKb, 5120);
  assert.deepStrictEqual([col('new_score').minValue, col('new_score').maxValue, col('new_score').precision], [0, 100, 2]);
  assert.strictEqual(find(calls, 'createCustomerColumn')[0].args[1].schemaName, 'new_owner', 'customer via createCustomerColumn');
  assert.strictEqual(find(calls, 'insertStatusValue')[0].args[1].label, 'In Review');
  assert.strictEqual(find(calls, 'createAlternateKey')[0].args[1].schemaName, 'new_namekey');
  const nn = find(calls, 'createRelationship').find((c) => c.args[0].type === 'ManyToMany');
  assert.strictEqual(nn.args[0].entity1, 'new_customer');
  assert.strictEqual(nn.args[0].entity2, 'new_ticket');
});

// --- Tier 2: UI + logic (web resources + form event handlers) --------------------------
function specWithFormJs() {
  const spec = makeSpec();
  spec.webResources = [
    { name: 'new_ticket.js', displayName: 'Ticket Scripts', type: 'js', content: 'var Ticket={onLoad:function(){},onPriority:function(){}};' },
  ];
  // wire handlers onto the customer form (makeSpec's only form)
  spec.forms[0].events = [
    { event: 'onload', library: 'new_ticket.js', function: 'Ticket.onLoad' },
    { event: 'onchange', attribute: 'new_tier', library: 'new_ticket.js', function: 'Ticket.onPriority', enabled: true },
  ];
  return spec;
}

test('Tier 2: web resource is created, added to the solution (type 61), and its id captured', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(specWithFormJs(), { sdk, apply: true });
  const wr = find(calls, 'createWebResource')[0].args[0];
  assert.strictEqual(wr.name, 'new_ticket.js');
  assert.strictEqual(wr.type, 'js');
  assert.ok(wr.content.includes('onLoad'));
  const comps = find(calls, 'addSolutionComponent').map((c) => c.args[0].componentType);
  assert.ok(comps.includes(61), 'web resource added to solution as component type 61');
});

test('Tier 2: idempotent — an existing web resource is reused (no createWebResource)', async () => {
  const { sdk, calls } = mockSdk({ existingWebResource: true });
  const events = [];
  await runSdkBuild(specWithFormJs(), { sdk, apply: true, emit: (e) => events.push(e) });
  assert.strictEqual(find(calls, 'createWebResource').length, 0, 'existing web resource not re-created');
  assert.ok(events.some((e) => e.status === 'skip' && /web resource new_ticket\.js \(exists/.test(e.label)));
});

test('Tier 2: form events are wired (fetch -> addFormEventHandler -> push -> publish) with mapped opts', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(specWithFormJs(), { sdk, apply: true });
  const formId = find(calls, 'createArtifact').find((c) => c.args[0] === 'form').args; // ['form', def]
  assert.ok(has(calls, 'fetchArtifact'), 'form fetched before wiring handlers');
  const handlers = find(calls, 'addFormEventHandler').map((c) => c.args[1]);
  assert.strictEqual(handlers.length, 2);
  const onload = handlers.find((h) => h.event === 'onload');
  assert.strictEqual(onload.libraryName, 'new_ticket.js');
  assert.strictEqual(onload.functionName, 'Ticket.onLoad');
  assert.strictEqual(onload.passExecutionContext, true);
  const onchange = handlers.find((h) => h.event === 'onchange');
  assert.strictEqual(onchange.attribute, 'new_tier', 'onchange attribute lower-cased');
  // a form with events publishes itself after the re-push
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'form'), 'form published after wiring');
  assert.ok(formId, 'form artifact created');
});

test('Tier 2: planFor and totals account for web resources and event wiring', async () => {
  const labels = planFor(specWithFormJs(), { phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => /web resource new_ticket\.js/.test(l)));
  assert.ok(labels.some((l) => /wire 2 event handler\(s\) on new_customer/.test(l)));
  // web-resources phase only runs when selected
  const onlyWr = planFor(specWithFormJs(), { phases: ['web-resources'] }).map((p) => p.phase);
  assert.ok(onlyWr.length && onlyWr.every((p) => p === 'web-resources'));
});

// --- Tier 2.x: SDK fix uptake (AutoNumber primary, N:N sub-grids) + folded build steps ----
test('AutoNumber primary column flows to createTable.primaryColumnAutoNumberFormat', async () => {
  const spec = makeSpec();
  spec.entities[1].primaryAttribute.autoNumberFormat = 'WO-{SEQNUM:5}';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const ct = find(calls, 'createTable').find((c) => c.args[0].schemaName === 'new_ticket');
  assert.strictEqual(ct.args[0].primaryColumnAutoNumberFormat, 'WO-{SEQNUM:5}');
  // a table without the format doesn't carry the option
  const other = find(calls, 'createTable').find((c) => c.args[0].schemaName === 'new_customer');
  assert.strictEqual(other.args[0].primaryColumnAutoNumberFormat, undefined);
});

test('an N:N sub-grid uses the ManyToMany relationship schema name', async () => {
  const spec = makeSpec();
  spec.entities.push({ schemaName: 'new_tag', displayName: 'Tag', primaryAttribute: { schemaName: 'new_label', displayName: 'Label' }, columns: [] });
  spec.relationships.push({ type: 'ManyToMany', entity1: 'new_customer', entity2: 'new_tag' });
  spec.views.push({ entity: 'new_tag', name: 'All Tags', columns: ['new_label'] });
  spec.forms[0].subgrids.push({ childEntity: 'new_tag', view: 'All Tags', label: 'Tags' });
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const sub = find(calls, 'addSubGrid').map((c) => c.args[1]).find((s) => s.entity === 'new_tag');
  assert.ok(sub, 'N:N sub-grid is placed on the form');
  assert.strictEqual(sub.relationshipName, 'new_customer_new_tag');
});

test('a junction sample row binds multiple parents via $parents', async () => {
  const spec = {
    solution: { uniqueName: 'J', displayName: 'J', publisherPrefix: 'new' }, app: { name: 'J', description: '' },
    entities: [
      { schemaName: 'new_wo', displayName: 'WO', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
      { schemaName: 'new_tech', displayName: 'Tech', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
      { schemaName: 'new_assign', displayName: 'Assign', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_wo', referencing: 'new_assign', lookup: { schemaName: 'new_woid', displayName: 'WO' } },
      { type: 'OneToMany', referenced: 'new_tech', referencing: 'new_assign', lookup: { schemaName: 'new_techid', displayName: 'Tech' } },
    ],
    views: [], charts: [], forms: [], appShell: { areas: [] },
    sampleData: {
      new_wo: [{ new_name: 'WO1' }], new_tech: [{ new_name: 'T1' }],
      new_assign: [{ new_name: 'A1', $parents: [{ entity: 'new_wo', match: { new_name: 'WO1' } }, { entity: 'new_tech', match: { new_name: 'T1' } }] }],
    },
  };
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const body = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_assign').args[1][0];
  assert.strictEqual(body['new_woid@odata.bind'], '/new_wos(new_wo-0)');
  assert.strictEqual(body['new_techid@odata.bind'], '/new_techs(new_tech-0)');
  assert.strictEqual(body.$parents, undefined);
});

test('a sample row sets a custom status reason (statecode + captured statuscode value)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const body = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_ticket').args[1][0];
  assert.strictEqual(body.statuscode, 100000001, 'value captured from insertStatusValue');
  assert.strictEqual(body.statecode, 0, 'Active state');
  assert.strictEqual(body.statusReason, undefined, 'sentinel stripped from the body');
});

// --- Live-build hardening: global-choice sample labels, alt-key idempotency, status guard ---

test('a global-choice sample value is resolved from its label to the option int', async () => {
  const spec = makeSpec();
  spec.globalChoices = [{ name: 'new_tierset', displayName: 'Tier', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] }];
  // make new_customer.new_tier a GLOBAL choice (makeSpec ships it inline) and set a label.
  spec.entities[0].columns[0] = { schemaName: 'new_tier', displayName: 'Tier', type: 'Choice', globalChoice: 'new_tierset' };
  spec.sampleData.new_customer[0].new_tier = 'Silver';
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true });
  const body = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_customer').args[1][0];
  assert.strictEqual(body.new_tier, 100000002, 'global-choice label resolved to 100000000+index');
});

test('alt-key creation is idempotent: an already-exists error is a skip, not a halt', async () => {
  const spec = makeSpec();
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  const { sdk, calls } = mockSdk({ altKeyExists: true });
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, emit: (e) => events.push(e) }); // must NOT throw
  assert.ok(has(calls, 'createAlternateKey'), 'createAlternateKey was attempted');
  assert.ok(events.some((e) => e.status === 'skip' && /alt key new_customer\.new_namekey \(exists\)/.test(e.label)), 'duplicate alt key emits a skip');
  assert.ok(has(calls, 'createArtifact'), 'the build continued past the duplicate alt key');
});

test('status reasons are idempotent: an already-exists insert is skipped (no halt), value still captured', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk, calls } = mockSdk({ statusExists: true });
  const events = [];
  await runSdkBuild(spec, { sdk, apply: true, sampleData: true, emit: (e) => events.push(e) }); // must NOT throw
  assert.ok(events.some((e) => e.status === 'skip' && /status reason new_ticket: Escalated \(exists\)/.test(e.label)), 'duplicate status reason emits a skip');
  const body = find(calls, 'createRecordsBulk').find((c) => c.args[0] === 'new_ticket').args[1][0];
  assert.strictEqual(body.statuscode, 100000000, 'pinned value captured even when the insert was skipped');
  assert.strictEqual(body.statecode, 0);
});

test('status reasons pin a deterministic value (passed explicitly so re-runs are idempotent)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }, { label: 'On Hold', state: 'Active' }];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const vals = find(calls, 'insertStatusValue').map((c) => c.args[1].value);
  assert.deepStrictEqual(vals, [100000000, 100000001], 'explicit publisher-range values, indexed per entity');
});

test('quick-create / quick-view forms build with their formType; Notes stays on Main only', async () => {
  const spec = makeSpec();
  spec.entities[1].hasNotes = true; // new_ticket
  spec.forms.push(
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto' },
    { entity: 'new_ticket', name: 'Ticket Quick Create', formType: 'QuickCreate', layout: 'auto' },
    { entity: 'new_ticket', name: 'Ticket Card', formType: 'QuickView', layout: 'auto' }
  );
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const formDefs = find(calls, 'createArtifact').filter((c) => c.args[0] === 'form').map((c) => c.args[1]);
  const byName = (n) => formDefs.find((d) => d.name === n);
  assert.strictEqual(byName('Customer').formType, 'Main', 'default form type is Main');
  assert.strictEqual(byName('Ticket Quick Create').formType, 'QuickCreate');
  assert.strictEqual(byName('Ticket Card').formType, 'QuickView');
  const hasNotes = (d) => d.tabs.some((t) => t.sections.some((s) => s.name === 'section_notes'));
  assert.ok(hasNotes(byName('Ticket')), 'Main form carries the Notes section');
  assert.ok(!hasNotes(byName('Ticket Quick Create')), 'QuickCreate form has no Notes section');
  assert.ok(!hasNotes(byName('Ticket Card')), 'QuickView form has no Notes section');
});

test('commands: a functional button is built with a JS on-click action + static visibility', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'var T={escalate:function(){}};' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'Escalate', location: 'MainTab', library: 'new_ticket.js', function: 'T.escalate', disabled: true },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const cmd = find(calls, 'createArtifact').find((c) => c.args[0] === 'command');
  assert.ok(cmd, 'command artifact created');
  const def = cmd.args[1];
  assert.strictEqual(def.entityLogicalName, 'new_ticket');
  const ctrl = def.commandBars[0].groups[0].controls[0];
  assert.strictEqual(def.commandBars[0].location, 'MainTab');
  assert.strictEqual(def.commandBars[0].groups[0].title, '', 'loose-controls group (empty title) — no parentless group row');
  assert.strictEqual(def.commandBars[0].groups[0].id, '', 'loose group carries an empty id (emitted as loose controls)');
  assert.strictEqual(ctrl.label, 'Escalate');
  assert.strictEqual(ctrl.command, ctrl.id, 'command references its own appactionid');
  assert.strictEqual(ctrl.action.type, 'javascript');
  assert.strictEqual(ctrl.action.functionName, 'T.escalate');
  assert.ok(ctrl.action.webResourceId, 'on-click resolved to the created web-resource id');
  assert.strictEqual(ctrl.disabled, true);
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'command'), 'command pushed');
});

test('dashboards: chart + list tiles resolve the created view/visualization ids', async () => {
  const spec = makeSpec(); // has view "Active Tickets" + chart "By Priority" on new_ticket
  spec.dashboards = [
    { name: 'Ops', tiles: [
      { type: 'chart', chart: 'By Priority', view: 'Active Tickets' },
      { type: 'list', view: 'Active Tickets', name: 'Recent' },
    ] },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const dash = find(calls, 'createArtifact').find((c) => c.args[0] === 'dashboard');
  assert.ok(dash && dash.args[1].name === 'Ops', 'dashboard artifact created');
  const tiles = find(calls, 'addDashboardTile').map((c) => c.args[1]);
  assert.strictEqual(tiles.length, 2);
  const chart = tiles.find((t) => t.type === 'chart');
  assert.strictEqual(chart.targetEntity, 'new_ticket', 'entity derived from the view');
  assert.ok(chart.viewId, 'view id resolved');
  assert.ok(chart.visualizationId, 'chart visualization id resolved');
  const list = tiles.find((t) => t.type === 'list');
  assert.strictEqual(list.name, 'Recent');
  assert.ok(list.viewId);
  // added to the solution as a systemform (60) and pushed
  assert.ok(find(calls, 'pushArtifact').some((c) => c.args[0] === 'dashboard'));
  assert.ok(find(calls, 'addSolutionComponent').some((c) => c.args[0].componentType === 60));
});

test('commands: planFor lists a command bar per entity', () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'A', library: 'new_ticket.js', function: 'X.a' },
    { entity: 'new_ticket', label: 'B', library: 'new_ticket.js', function: 'X.b' },
  ];
  const labels = planFor(spec, { phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => /command bar for new_ticket \(2 button\(s\)\)/.test(l)));
});

test('quick-view placement: a QuickView form is embedded on a host form via a lookup (addQuickViewControl)', async () => {
  const spec = makeSpec();
  spec.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto',
      quickViews: [{ lookup: 'new_CustomerId', targetEntity: 'new_customer', form: 'Customer QV', label: 'Customer' }] },
    { entity: 'new_customer', name: 'Customer QV', formType: 'QuickView', layout: 'auto' },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const qv = find(calls, 'addQuickViewControl');
  assert.strictEqual(qv.length, 1, 'one quick-view control placed');
  const [hostId, o] = qv[0].args;
  assert.strictEqual(o.lookupFieldName, 'new_customerid', 'lookup lower-cased');
  assert.strictEqual(o.targetEntity, 'new_customer');
  assert.ok(o.quickViewFormId && o.quickViewFormId !== hostId, 'resolved to the QuickView form id (not the host)');
  assert.ok(find(calls, 'fetchArtifact').some((c) => c.args[0] === 'form'), 'host form fetched before placement');
  assert.ok(find(calls, 'publishArtifact').some((c) => c.args[0] === 'form'), 'host form published after placement');
  assert.ok(planFor(spec, { phases: PHASES }).some((p) => /place 1 quick-view\(s\) on new_ticket/.test(p.label)), 'plan lists the placement step');
});

test('quick-view placement halts clearly when the referenced form was not built', async () => {
  const spec = makeSpec();
  spec.forms = [
    { entity: 'new_ticket', name: 'Ticket', formType: 'Main', layout: 'auto',
      quickViews: [{ lookup: 'new_CustomerId', targetEntity: 'new_customer', form: 'Nope' }] },
  ];
  const { sdk } = mockSdk();
  await assert.rejects(runSdkBuild(spec, { sdk, apply: true }), /quick-view references form 'Nope' which wasn't built/);
});

test('commands: loose buttons + a flyout with children build to the right shape (one loose group)', async () => {
  const spec = makeSpec();
  spec.webResources = [{ name: 'new_ticket.js', type: 'js', content: 'x' }];
  spec.commands = [
    { entity: 'new_ticket', label: 'Loose', library: 'new_ticket.js', function: 'T.loose' },
    { entity: 'new_ticket', label: 'More', type: 'FlyoutAnchor', children: [
      { label: 'Child A', library: 'new_ticket.js', function: 'T.a' },
      { label: 'Child B', library: 'new_ticket.js', function: 'T.b' },
    ] },
  ];
  const { sdk, calls } = mockSdk();
  await runSdkBuild(spec, { sdk, apply: true });
  const def = find(calls, 'createArtifact').find((c) => c.args[0] === 'command').args[1];
  const groups = def.commandBars[0].groups;
  assert.strictEqual(groups.length, 1, 'one loose group per location (no parentless titled groups)');
  assert.strictEqual(groups[0].title, '', 'loose group: empty title');
  assert.strictEqual(groups[0].id, '', 'loose group: empty id');
  const flyout = groups[0].controls.find((c) => c.type === 'FlyoutAnchor');
  assert.ok(flyout, 'flyout control built');
  assert.strictEqual(flyout.children.length, 2, 'flyout carries its child buttons (adapter synthesizes the intervening group)');
  assert.ok(!flyout.action, 'flyout container has no on-click of its own');
  assert.strictEqual(flyout.children[0].action.functionName, 'T.a', 'child button carries the JS on-click');
  assert.strictEqual(flyout.children[0].command, flyout.children[0].id, 'child references its own appactionid');
});

test('app-shell: a DashBoard subarea references a built dashboard (the SDK auto-pins it as a component)', () => {
  const spec = makeSpec();
  spec.dashboards = [{ name: 'Ops', tiles: [{ type: 'list', view: 'Active Tickets', name: 'Recent' }] }];
  spec.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Ops', title: 'Overview' });
  const def = appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: { Ops: 'dash-123' } });
  const subs = def.siteMap.areas[0].groups[0].subAreas;
  const dash = subs.find((s) => s.type === 'DashBoard');
  assert.ok(dash, 'DashBoard subarea emitted');
  assert.strictEqual(dash.dashboardId, 'dash-123', 'resolved to the built dashboard id');
  assert.strictEqual(subs.find((s) => s.type === 'Entity').entity, 'new_customer', 'entity subarea still works alongside');
});

test('app-shell: a DashBoard subarea for an unbuilt dashboard throws a clear error', () => {
  const spec = makeSpec();
  spec.appShell.areas[0].groups[0].subAreas.push({ dashboard: 'Missing', title: 'X' });
  assert.throws(() => appDef(spec, { forms: {}, views: {}, charts: {}, dashboards: {} }), /references dashboard 'Missing' which wasn't built/);
});

test('alt-key creation still halts on a genuine (non-duplicate) error', async () => {
  const spec = makeSpec();
  spec.entities[0].alternateKeys = [{ schemaName: 'new_namekey', displayName: 'Name Key', columns: ['new_name'] }];
  const { sdk } = mockSdk({ altKeyError: true });
  await assert.rejects(runSdkBuild(spec, { sdk, apply: true }), /data-model failed/);
});

test('statusReason without the data-model phase halts loudly (no silent default status)', async () => {
  const spec = makeSpec();
  spec.entities[1].statusReasons = [{ label: 'Escalated', state: 'Active' }];
  spec.sampleData.new_ticket[0].statusReason = 'Escalated';
  const { sdk } = mockSdk();
  // skip data-model -> the status value is never captured; the guard must halt.
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, sampleData: true, phases: resolvePhases({ skip: ['data-model'] }) }),
    /status value wasn't captured/
  );
});

test('view filters: no-value ops, in/not-in groups, and Choice-label resolution', () => {
  const spec = makeSpec();
  const def = viewDef(spec, { entity: 'new_ticket', name: 'My Open', columns: ['new_subject'], activeOnly: true,
    filters: [
      { attr: 'ownerid', op: 'eq-userid' },
      { attr: 'new_priority', op: 'not-in', values: ['Low'] },
      { attr: 'modifiedon', op: 'this-week' },
    ] });
  const conds = def.filters.conditions;
  assert.ok(conds.some((c) => c.attribute === 'statecode' && c.value === '0'), 'activeOnly retained');
  const owner = conds.find((c) => c.attribute === 'ownerid');
  assert.strictEqual(owner.operator, 'eq-userid');
  assert.strictEqual(owner.value, undefined, 'no-value operator omits value');
  assert.ok(conds.some((c) => c.attribute === 'modifiedon' && c.operator === 'this-week' && c.value === undefined));
  const grp = def.filters.groups.find((g) => g.type === 'and');
  assert.ok(grp, 'not-in becomes a nested AND group');
  assert.strictEqual(grp.conditions[0].operator, 'ne');
  assert.strictEqual(grp.conditions[0].value, '100000000', "'Low' resolved to its option int");
});

test('formDef honors explicit tabs/sections/columns', () => {
  const def = formDef(makeSpec(), { entity: 'new_customer', name: 'C', tabs: [{ label: 'Main', sections: [{ label: 'Details', columns: 2, fields: ['new_name', 'new_tier'] }] }] });
  const sec = def.tabs[0].sections[0];
  assert.strictEqual(sec.label, 'Details');
  assert.strictEqual(sec.columns, 2);
  assert.strictEqual(sec.rows[0].cells.length, 2, '2-column section packs 2 cells per row');
  assert.strictEqual(sec.rows[0].cells[0].control.fieldName, 'new_name');
});

test('data-model + sample-data emit a stable phase/label sequence (parity anchor)', async () => {
  const { sdk } = mockSdk();
  const events = [];
  const desk = makeSpec();
  await runSdkBuild(desk, { sdk, apply: true, sampleData: true, emit: (e) => events.push(e) });
  const terminal = events.filter((e) => e.status !== 'start');
  // one monotonic counter across all phases
  const ns = terminal.map((e) => e.n);
  assert.deepStrictEqual(ns, [...ns].sort((a, b) => a - b));
  assert.strictEqual(new Set(ns).size, ns.length);
  // data-model creates the three tables + their columns; sample-data creates 3 record steps
  assert.ok(terminal.some((e) => e.phase === 'data-model' && /table new_ticket/.test(e.label)));
  assert.ok(terminal.filter((e) => e.phase === 'sample-data').length >= 1);
});

test('formDef auto lays out primary + columns; adds Notes when the entity has notes', () => {
  const spec = makeSpec();
  spec.entities[0].hasNotes = true;
  const def = formDef(spec, { entity: 'new_customer', name: 'C', layout: 'auto' });
  const fields = def.tabs[0].sections[0].rows.flatMap((r) => r.cells).map((c) => c.control.fieldName);
  assert.deepStrictEqual(fields, ['new_name', 'new_tier']);
  assert.ok(def.tabs[0].sections.some((s) => s.name === 'section_notes'), 'a Notes section is added');
});

test('publish (opt-in) publishes one artifact per entity + the app', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, publish: true });
  const pubs = find(calls, 'publishArtifact').map((c) => c.args[0]);
  assert.ok(pubs.includes('app'));
  assert.ok(pubs.includes('form') || pubs.includes('view'), 'entity customizations published');
});

test('resolvePhases honors only/skip/from/to', () => {
  assert.deepStrictEqual(resolvePhases({ only: ['views', 'charts'] }), ['views', 'charts']);
  assert.deepStrictEqual(resolvePhases({ skip: ['data-model', 'sample-data', 'publish'] }), ['solution', 'web-resources', 'views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell']);
  assert.deepStrictEqual(resolvePhases({ from: 'views' }), ['views', 'charts', 'forms', 'commands', 'dashboards', 'app-shell', 'publish']);
  assert.deepStrictEqual(resolvePhases({ to: 'data-model' }), ['solution', 'data-model']);
});

test('phase selection: --only views,charts,forms,app-shell skips the data model', async () => {
  const { sdk, calls } = mockSdk();
  await runSdkBuild(makeSpec(), { sdk, apply: true, phases: resolvePhases({ only: ['views', 'charts', 'forms', 'app-shell'] }) });
  assert.strictEqual(find(calls, 'createTable').length, 0);
  assert.strictEqual(find(calls, 'createSolution').length, 0);
  assert.ok(find(calls, 'createArtifact').length >= 4, 'artifacts still built');
});

test('an SDK failure halts with a BuildHalt carrying the phase', async () => {
  const { sdk } = mockSdk({ failTable: 'new_customer' });
  await assert.rejects(
    () => runSdkBuild(makeSpec(), { sdk, apply: true }),
    (err) => { assert.strictEqual(err.name, 'BuildHalt'); assert.strictEqual(err.phase, 'data-model'); return true; }
  );
});

test('planFor reflects the selected phases', () => {
  const labels = planFor(makeSpec(), { sampleData: true, publish: true, phases: PHASES }).map((p) => p.label);
  assert.ok(labels.some((l) => l.includes('table new_customer')));
  assert.ok(labels.some((l) => l.includes('form for new_customer (sub-grids: new_ticket)')));
  const onlyViews = planFor(makeSpec(), { phases: ['views'] }).map((p) => p.phase);
  assert.ok(onlyViews.every((p) => p === 'views'));
});
