'use strict';
// The data-model build with the 2.21.0 schema fields: explicit choice option values, dateTimeBehavior, isSecured and the table
// flags, driven through provisionDataModel with an SDK double that records every call it is given.
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeRunner, provisionDataModel, localizedLabelLcidsInSpec } = require('../lib/entity-provision.js');

function mockSdk({ existing = {}, columns = [], dataverseGet } = {}) {
  const calls = [];
  const gets = [];
  return {
    calls,
    gets,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
      updateTable: async (l, o) => { calls.push(['updateTable', l, o]); return {}; },
      createColumn: async (l, o) => { calls.push(['createColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
      createCustomerColumn: async (l, o) => { calls.push(['createCustomerColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      createRelationship: async (o) => { calls.push(['createRelationship', o]); return { schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }; },
      createGlobalOptionSet: async (o) => { calls.push(['createGlobalOptionSet', o]); return { metadataId: `gc-${o.name}` }; },
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: Object.assign({
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => columns,
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    }, dataverseGet ? { dataverse: { get: async (p) => { gets.push(p); return dataverseGet(p); } } } : {}),
  };
}

function specOf(columns, extra = {}) {
  return Object.assign({
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns }],
    relationships: [],
  }, extra);
}

async function run(m, spec, opts = {}) {
  const runner = makeRunner({ emit: () => {}, total: 50 });
  return provisionDataModel(Object.assign({ sdk: m.sdk, provision: m.provision, runner, spec, apply: true, preResolvedLanguageCode: 1033, warn: () => {}, inlineColumns: false }, opts));
}

// ------------------------------------------------------------------------------------------------ explicit option values (L01)

test('an explicit { value, label } option reaches createColumn as that value and label', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_priority', displayName: 'Priority', type: 'Choice', options: [{ value: 1, label: 'Low' }, 'Medium', { value: 9, label: 'High' }] }]));
  const call = m.calls.find((c) => c[0] === 'createColumn' && c[2].schemaName === 'new_priority');
  assert.deepEqual(call[2].options, [{ value: 1, label: 'Low' }, { value: 100000001, label: 'Medium' }, { value: 9, label: 'High' }]);
});

test('an explicit { value, label } option reaches createGlobalOptionSet as that value and label', async () => {
  const m = mockSdk();
  await run(m, specOf([], { globalChoices: [{ name: 'new_region', displayName: 'Region', options: [{ value: 10, label: 'North' }, { value: 20, label: 'South' }] }] }));
  const call = m.calls.find((c) => c[0] === 'createGlobalOptionSet');
  assert.deepEqual(call[1].options, [{ value: 10, label: 'North' }, { value: 20, label: 'South' }]);
});

test('plain and localized options keep the positional numbering they always had', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_state', displayName: 'State', type: 'MultiChoice', options: ['Open', { 1033: 'Closed', 3082: 'Cerrado' }] }],
    { globalChoices: [{ name: 'new_g', options: ['A', 'B'] }] }));
  assert.deepEqual(m.calls.find((c) => c[0] === 'createColumn')[2].options, [{ value: 100000000, label: 'Open' }, { value: 100000001, label: { 1033: 'Closed', 3082: 'Cerrado' } }]);
  assert.deepEqual(m.calls.find((c) => c[0] === 'createGlobalOptionSet')[1].options, [{ value: 100000000, label: 'A' }, { value: 100000001, label: 'B' }]);
});

test('the language check sees the languages an explicit option\'s localized label names', () => {
  const lcids = localizedLabelLcidsInSpec(specOf([{ schemaName: 'new_p', type: 'Choice', options: [{ value: 1, label: { 1033: 'Low', 1036: 'Bas' } }] }]));
  assert.deepEqual(lcids.map((x) => x.lcid), [1033, 1036]);
  assert.match(lcids[1].where, /column new_p option/);
});

// ------------------------------------------------------------------------------------------------ Date and Time behaviour (C11, B7d)

// A metadata reader that answers the reads the data-model phase makes against a table that exists with `columns`, and the typed Date and
// Time reads with `dates` (the collection body, or a function of the path), and the per-column read-back with `readBack`.
function metadataServer({ tables = {}, dates, readBack } = {}) {
  return (p) => {
    const probe = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName/.exec(p);
    if (probe) return tables[probe[1]] ? { status: 200, body: { LogicalName: probe[1], EntitySetName: `${probe[1]}s` } } : { status: 404, body: {} };
    if (/\/Attributes\?\$select=LogicalName,RequiredLevel$/.test(p)) {
      const t = /LogicalName='([^']+)'/.exec(p)[1];
      return { status: 200, body: { value: (tables[t] || []).map((n) => ({ LogicalName: n, RequiredLevel: { Value: 'None' } })) } };
    }
    if (/\/Attributes\(LogicalName='[^']+'\)\/Microsoft\.Dynamics\.CRM\.DateTimeAttributeMetadata/.test(p)) {
      return typeof readBack === 'function' ? readBack(p) : { status: 200, body: readBack };
    }
    if (/\/Attributes\/Microsoft\.Dynamics\.CRM\.DateTimeAttributeMetadata\?/.test(p)) {
      return typeof dates === 'function' ? dates(p) : { status: 200, body: dates };
    }
    if (/Relationships/.test(p)) return { status: 200, body: { value: [] } };
    return { status: 404, body: {} };
  };
}
const dateRow = (name, behavior, canChange = true) => ({ LogicalName: name, DateTimeBehavior: behavior === null ? null : { Value: behavior }, CanChangeDateTimeBehavior: { Value: canChange } });
const dateGets = (m) => m.gets.filter((p) => /DateTimeAttributeMetadata/.test(p));
const posts = (m) => m.calls.filter((c) => ['createColumn', 'createCustomerColumn', 'createRelationship'].includes(c[0]));
async function halted(promise) {
  try { await promise; } catch (err) { return err; }
  assert.fail('the build did not halt');
}
const NULL_TABLE = { tables: { new_ticket: ['new_ticketid', 'new_name', 'new_due'] }, dates: { value: [dateRow('createdon', 'UserLocal', false), dateRow('new_due', null)] } };

test('createColumn is given the declared dateTimeBehavior, and none when it is omitted', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_born', type: 'DateTime', dateTimeBehavior: 'DateOnly' }, { schemaName: 'new_at', type: 'DateTime' }]));
  const sent = (n) => m.calls.find((c) => c[0] === 'createColumn' && c[2].schemaName === n)[2];
  assert.equal(sent('new_born').dateTimeBehavior, 'DateOnly');
  assert.equal('dateTimeBehavior' in sent('new_at'), false);
});

test('preflight: a null-behaviour column on an existing table halts before any column is sent, after one typed read', async () => {
  const m = mockSdk({ dataverseGet: metadataServer(NULL_TABLE) });
  const err = await halted(run(m, specOf([{ schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true }));
  assert.equal(err.code, 'DATETIME_BEHAVIOR_MISSING');
  assert.match(err.message, /new_due/);
  assert.match(err.message, /dateTimeBehavior 'UserLocal'/);
  assert.deepEqual(posts(m), []);
  assert.deepEqual(dateGets(m), ["/EntityDefinitions(LogicalName='new_ticket')/Attributes/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=LogicalName,DateTimeBehavior,CanChangeDateTimeBehavior"]);
});

test('preflight: a row that does not state its behaviour is unverified, not null and not safe', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates: { value: [{ LogicalName: 'new_due', CanChangeDateTimeBehavior: { Value: true } }] } }) });
  const err = await halted(run(m, specOf([{ schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true }));
  assert.equal(err.code, 'DATETIME_BEHAVIOR_UNVERIFIED');
  assert.deepEqual(posts(m), []);
});

for (const [what, dates] of [
  ['an answer that advertises a next page', { value: [dateRow('createdon', 'UserLocal')], '@odata.nextLink': 'https://contoso.crm.dynamics.com/next' }],
  ['an answer with no attribute list', {}],
  ['a behaviour that is not one of the three', { value: [{ LogicalName: 'new_due', DateTimeBehavior: { Value: 'Local' } }] }],
  ['a refused read', () => ({ status: 403, body: {} })],
]) {
  test(`preflight: ${what} halts as unverified within the one added read`, async () => {
    const m = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates }) });
    const err = await halted(run(m, specOf([{ schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true }));
    assert.equal(err.code, 'DATETIME_BEHAVIOR_UNVERIFIED');
    assert.match(err.message, /Run the build again once the environment answers metadata reads/);
    assert.equal(dateGets(m).length, 1);
    assert.deepEqual(posts(m), []);
  });
}

test('preflight: a table whose Date and Time columns all have a behaviour, or that has none, takes the new column', async () => {
  for (const dates of [{ value: [dateRow('createdon', 'UserLocal', false)] }, { value: [] }]) {
    const m = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates }) });
    await run(m, specOf([{ schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true });
    assert.deepEqual(posts(m).map((c) => c[2].schemaName), ['new_note']);
    assert.equal(dateGets(m).length, 1);
  }
});

test('preflight: no typed read for a table the build creates, nor for a rebuild that adds no column', async () => {
  const fresh = mockSdk({ dataverseGet: metadataServer({ dates: () => assert.fail('read') }) });
  await run(fresh, specOf([{ schemaName: 'new_note', type: 'Text' }, { schemaName: 'new_due', type: 'DateTime' }]), { dateBehaviorPreflight: true });
  assert.equal(dateGets(fresh).length, 0);
  const rebuild = mockSdk({ dataverseGet: metadataServer({ tables: { new_ticket: ['new_ticketid', 'new_name', 'new_note'] }, dates: () => assert.fail('read') }) });
  await run(rebuild, specOf([{ schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true });
  assert.equal(dateGets(rebuild).length, 0);
  assert.deepEqual(posts(rebuild), []);
});

test('without the preflight the build adds the column as it always did, with no typed read', async () => {
  const m = mockSdk({ dataverseGet: metadataServer(NULL_TABLE) });
  await run(m, specOf([{ schemaName: 'new_note', type: 'Text' }]));
  assert.equal(dateGets(m).length, 0);
  assert.deepEqual(posts(m).map((c) => c[2].schemaName), ['new_note']);
});

test('preflight: a Customer column and a relationship lookup added to an existing table are guarded too; an N:N is not', async () => {
  const customer = mockSdk({ dataverseGet: metadataServer(NULL_TABLE) });
  const err = await halted(run(customer, specOf([{ schemaName: 'new_customer', type: 'Customer' }]), { dateBehaviorPreflight: true }));
  assert.equal(err.code, 'DATETIME_BEHAVIOR_MISSING');
  assert.deepEqual(posts(customer), []);

  const lookup = mockSdk({ dataverseGet: metadataServer(NULL_TABLE) });
  const rel = { type: 'OneToMany', referenced: 'account', referencing: 'new_ticket', lookup: { schemaName: 'new_accountid', displayName: 'Account' } };
  const err2 = await halted(run(lookup, specOf([], { relationships: [rel] }), { dateBehaviorPreflight: true }));
  assert.equal(err2.code, 'DATETIME_BEHAVIOR_MISSING');
  assert.deepEqual(posts(lookup), []);
  assert.equal(dateGets(lookup).length, 1);

  const nn = mockSdk({ dataverseGet: metadataServer(NULL_TABLE) });
  await run(nn, specOf([], { relationships: [{ type: 'ManyToMany', entity1: 'new_ticket', entity2: 'account', schemaName: 'new_ticket_account' }] }), { dateBehaviorPreflight: true });
  assert.equal(dateGets(nn).length, 0);
  assert.equal(posts(nn).length, 1);
});

test('a lookup added to a table this build created is not read; the existing table it points from is read once for both of its adds', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ tables: { new_ticket: ['new_ticketid', 'new_name'] }, dates: { value: [dateRow('createdon', 'UserLocal', false)] } }) });
  const spec = specOf([{ schemaName: 'new_note', type: 'Text' }], {
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [{ schemaName: 'new_note', type: 'Text' }] },
      { schemaName: 'new_step', displayName: 'Step', primaryAttribute: { schemaName: 'new_name' }, columns: [] },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'new_ticket', referencing: 'new_step', lookup: { schemaName: 'new_ticketid2', displayName: 'Ticket' } },
      { type: 'OneToMany', referenced: 'account', referencing: 'new_ticket', lookup: { schemaName: 'new_accountid', displayName: 'Account' } },
    ],
  });
  await run(m, spec, { dateBehaviorPreflight: true });
  assert.deepEqual(dateGets(m), ["/EntityDefinitions(LogicalName='new_ticket')/Attributes/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=LogicalName,DateTimeBehavior,CanChangeDateTimeBehavior"]);
  assert.equal(m.calls.filter((c) => c[0] === 'createRelationship').length, 2);
});

test('an explicit UserLocal on the null-behaviour column repairs it, reads it back and then adds the column', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...NULL_TABLE, readBack: dateRow('new_due', 'UserLocal') }) });
  m.provision.dataverse.post = async (p, body) => { m.calls.push(['post', p, body]); return { status: 204, body: {} }; };
  await run(m, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'UserLocal' }, { schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true });
  const order = m.calls.filter((c) => c[0] !== 'post' || /PublishXml/.test(c[1])).map((c) => c[0]);
  assert.deepEqual(order.filter((x) => x !== 'createTable'), ['updateColumn', 'createColumn', 'post']);
  assert.deepEqual(m.calls.find((c) => c[0] === 'updateColumn').slice(1), ['new_ticket', 'new_due', { dateTimeBehavior: 'UserLocal' }]);
  assert.equal(dateGets(m).length, 2, 'the collection read and the one column read-back');
  assert.match(JSON.stringify(m.calls.find((c) => c[0] === 'post')[2]), /<entity>new_ticket<\/entity>/);
});

test('a repair whose read-back does not show the declared behaviour halts as unconfirmed, before the column is added', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...NULL_TABLE, readBack: dateRow('new_due', null) }) });
  const err = await halted(run(m, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'UserLocal' }, { schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true }));
  assert.equal(err.code, 'DATETIME_BEHAVIOR_UNCONFIRMED');
  assert.deepEqual(posts(m), []);
});

test('an explicit behaviour on an existing column is reconciled without the preflight, and an equal one writes nothing', async () => {
  const equal = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates: { value: [dateRow('new_due', 'UserLocal')] } }) });
  await run(equal, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'UserLocal' }]));
  assert.equal(dateGets(equal).length, 1);
  assert.equal(equal.calls.filter((c) => c[0] === 'updateColumn').length, 0);
});

test('a forbidden change is refused before any write: permanent, not changeable, or one-way without consent', async () => {
  const cases = [
    [dateRow('new_due', 'DateOnly'), 'UserLocal', 'DATETIME_BEHAVIOR_PERMANENT'],
    [dateRow('new_due', 'UserLocal', false), 'DateOnly', 'DATETIME_BEHAVIOR_NOT_CHANGEABLE'],
    [dateRow('new_due', 'UserLocal'), 'TimeZoneIndependent', 'DESTRUCTIVE_NOT_AUTHORIZED'],
    [dateRow('new_due', null), 'DateOnly', 'DESTRUCTIVE_NOT_AUTHORIZED'],
  ];
  for (const [row, want, code] of cases) {
    const m = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates: { value: [row] } }) });
    const err = await halted(run(m, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: want }])));
    assert.equal(err.code, code, `${JSON.stringify(row.DateTimeBehavior)} -> ${want}`);
    assert.equal(m.calls.filter((c) => c[0] === 'updateColumn').length, 0);
  }
});

test('a one-way change is made when it is authorized for that column', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates: { value: [dateRow('new_due', 'UserLocal')] }, readBack: dateRow('new_due', 'DateOnly') }) });
  await run(m, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'DateOnly' }]), { authorizedDestructive: ['dateTimeBehavior:new_ticket.new_due'] });
  assert.deepEqual(m.calls.find((c) => c[0] === 'updateColumn').slice(1), ['new_ticket', 'new_due', { dateTimeBehavior: 'DateOnly' }]);
});