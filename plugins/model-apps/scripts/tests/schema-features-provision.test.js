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

// ------------------------------------------------------------------------------------------------ explicit option values

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

// ------------------------------------------------------------------------------------------------ Date and Time behaviour

// A metadata reader that answers the reads the data-model phase makes against a table that exists with `columns`, and the typed Date and
// Time reads with `dates` (the collection body, or a function of the path), and the per-column read-back with `readBack`.
function metadataServer({ tables = {}, dates, readBack, secured, flags } = {}) {
  return (p) => {
    const probe = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName/.exec(p);
    if (probe) return tables[probe[1]] ? { status: 200, body: { LogicalName: probe[1], EntitySetName: `${probe[1]}s` } } : { status: 404, body: {} };
    if (/\/Attributes\?\$select=LogicalName,IsSecured$/.test(p)) return typeof secured === 'function' ? secured(p) : { status: 200, body: secured };
    if (/\?\$select=IsDuplicateDetectionEnabled,/.test(p)) return typeof flags === 'function' ? flags(p) : { status: 200, body: flags };
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

// A table the first lookup misses, whose create is then answered "already exists" (the create of an earlier, lost answer, or another writer's),
// is found by a second lookup. Its columns are read then, as a table the first lookup found has them read, so its Date and Time columns are
// guarded, and an authorized declared repair made, BEFORE the build adds a column to it — in the same build, not the next one.
//   POST EntityDefinitions -> HTTP 400 {"error":{"code":"0x8009050d","message":"Entities already exist: new_ticket."}}
function foundAfterCreate({ dates = NULL_TABLE.dates, readBack, columns = NULL_TABLE.tables.new_ticket, columnsRead } = {}) {
  let probes = 0;
  const server = metadataServer({ tables: { new_ticket: columns }, dates, readBack });
  const m = mockSdk({
    dataverseGet: (p) => {
      if (/\?\$select=LogicalName,EntitySetName/.test(p) && (probes += 1) === 1) return { status: 404, body: {} };
      if (columnsRead && /\/Attributes\?\$select=LogicalName,RequiredLevel$/.test(p)) return columnsRead(p);
      return server(p);
    },
  });
  m.sdk.createTable = async (o) => {
    m.calls.push(['createTable', o]);
    throw Object.assign(new Error('HTTP 400: Entities already exist: new_ticket.'), { statusCode: 400, cause: { error: { code: '0x8009050d', message: 'Entities already exist: new_ticket.' } } });
  };
  // The platform's answer to the create of a column the table has (ALREADY_EXISTS_CODES.column).
  m.sdk.createColumn = async (l, o) => {
    m.calls.push(['createColumn', l, o]);
    if (columns.includes(o.schemaName.toLowerCase())) {
      throw Object.assign(new Error(`HTTP 400: An attribute with the specified name ${o.schemaName} already exists for entity ${l}.`), { statusCode: 400, cause: { error: { code: '0x80047013' } } });
    }
    return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` };
  };
  m.provision.dataverse.post = async (p, body) => { m.calls.push(['post', p, body]); return { status: 204, body: {} }; };
  return m;
}
const DUE_AND_NOTE = [{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'UserLocal' }, { schemaName: 'new_note', type: 'Text' }];
const writesOf = (m) => m.calls.filter((c) => ['updateColumn', 'createColumn'].includes(c[0])).map((c) => `${c[0]} ${c[0] === 'updateColumn' ? c[2] : c[2].schemaName}`);

test('a table found after its create was answered "already exists" has its declared Date and Time repair made and read back before a column is added, in the same build', async () => {
  for (const preflight of [true, false]) {
    const m = foundAfterCreate({ readBack: dateRow('new_due', 'UserLocal') });
    await run(m, specOf(DUE_AND_NOTE), { dateBehaviorPreflight: preflight });
    assert.equal(m.calls.filter((c) => c[0] === 'createTable').length, 1, `preflight ${preflight}`);
    assert.deepEqual(writesOf(m), ['updateColumn new_due', 'createColumn new_note'], `preflight ${preflight}: the repair, then only the new column`);
    assert.deepEqual(m.calls.find((c) => c[0] === 'updateColumn').slice(1), ['new_ticket', 'new_due', { dateTimeBehavior: 'UserLocal' }]);
    assert.equal(dateGets(m).length, 2, `preflight ${preflight}: the collection read and the one column read-back`);
  }
});

test('a table found after its create keeps every rule of a table the first lookup found: no consent, no repair; unreadable columns, the old path', async () => {
  // A one-way change without its consent is refused before any column is sent, as for a table the first lookup found.
  const refused = foundAfterCreate({ dates: { value: [dateRow('new_due', 'UserLocal')] } });
  const err = await halted(run(refused, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'DateOnly' }, { schemaName: 'new_note', type: 'Text' }]), { dateBehaviorPreflight: true }));
  assert.equal(err.code, 'DESTRUCTIVE_NOT_AUTHORIZED');
  assert.deepEqual(writesOf(refused), []);
  // With it, the change is made before the new column.
  const consented = foundAfterCreate({ dates: { value: [dateRow('new_due', 'UserLocal')] }, readBack: dateRow('new_due', 'DateOnly') });
  await run(consented, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'DateOnly' }, { schemaName: 'new_note', type: 'Text' }]),
    { dateBehaviorPreflight: true, authorizedDestructive: ['dateTimeBehavior:new_ticket.new_due'] });
  assert.deepEqual(writesOf(consented), ['updateColumn new_due', 'createColumn new_note']);
  // Columns that cannot be read leave the build where it was: every declared column looks new, and the preflight stops on the column with
  // no behaviour before anything is sent.
  const unread = foundAfterCreate({ readBack: dateRow('new_due', 'UserLocal'), columnsRead: () => ({ status: 503, body: {} }) });
  const err2 = await halted(run(unread, specOf(DUE_AND_NOTE), { dateBehaviorPreflight: true }));
  assert.equal(err2.code, 'DATETIME_BEHAVIOR_MISSING');
  assert.deepEqual(writesOf(unread), []);
});

test('an existing column declared secured on a table found after its create is still secured', async () => {
  const m = foundAfterCreate({ columns: ['new_ticketid', 'new_name', 'new_salary'], dates: { value: [] } });
  m.provision.dataverse.get = ((get) => async (p) => (/\$select=LogicalName,IsSecured$/.test(p) ? { status: 200, body: securedRowsOf(false) } : get(p)))(m.provision.dataverse.get);
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }, { schemaName: 'new_note', type: 'Text' }]));
  assert.deepEqual(m.calls.filter((c) => c[0] === 'updateColumn').map((c) => c.slice(1)), [['new_ticket', 'new_salary', { isSecured: true }]]);
  assert.deepEqual(writesOf(m).filter((w) => w.startsWith('createColumn')), ['createColumn new_note'], 'the column the table has is not sent');
});
const securedRowsOf = (salary) => ({ value: [{ LogicalName: 'new_name', IsSecured: false }, { LogicalName: 'new_salary', IsSecured: salary }] });
// ------------------------------------------------------------------------------------------------ column security

const SECURE_TABLE = { tables: { new_ticket: ['new_ticketid', 'new_name', 'new_salary'] } };
const securedRows = (salary) => ({ value: [{ LogicalName: 'new_name', IsSecured: false }, { LogicalName: 'new_salary', IsSecured: salary }] });
const securityGets = (m) => m.gets.filter((p) => /\$select=LogicalName,IsSecured$/.test(p));
const updates = (m) => m.calls.filter((c) => c[0] === 'updateColumn');

test('createColumn is given isSecured only for an explicit true', async () => {
  const m = mockSdk();
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }, { schemaName: 'new_bonus', type: 'Money', isSecured: false }, { schemaName: 'new_note', type: 'Text' }]));
  const sent = (n) => m.calls.find((c) => c[0] === 'createColumn' && c[2].schemaName === n)[2];
  assert.equal(sent('new_salary').isSecured, true);
  assert.equal('isSecured' in sent('new_bonus'), false);
  assert.equal('isSecured' in sent('new_note'), false);
});

test('an existing column declared secured is secured with one read and one update; an already secured one is left alone', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(false) }) });
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]));
  assert.deepEqual(updates(m).map((c) => c.slice(1)), [['new_ticket', 'new_salary', { isSecured: true }]]);
  assert.deepEqual(securityGets(m), ["/EntityDefinitions(LogicalName='new_ticket')/Attributes?$select=LogicalName,IsSecured"]);

  const same = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(true) }) });
  await run(same, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]));
  assert.deepEqual(updates(same), []);
});

test('no security read when no column the table already has declares isSecured', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: () => assert.fail('read') }) });
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money' }, { schemaName: 'new_tax', type: 'Money', isSecured: true }]));
  assert.equal(securityGets(m).length, 0);
  assert.equal(m.calls.find((c) => c[0] === 'createColumn' && c[2].schemaName === 'new_tax')[2].isSecured, true);
});

test('unsecuring a secured column halts without consent, and is made with consent for that column', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(true) }) });
  const err = await halted(run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }])));
  assert.equal(err.code, 'DESTRUCTIVE_NOT_AUTHORIZED');
  // The refusal names the exact consent the build command takes, so the maker can repeat the run with it.
  assert.match(err.message, /run the build again with --authorize isSecured:new_ticket\.new_salary\b/);
  assert.deepEqual(updates(m), []);

  const ok = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(true) }) });
  await run(ok, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }]), { authorizedDestructive: new Set(['isSecured:new_ticket.new_salary']) });
  assert.deepEqual(updates(ok).map((c) => c.slice(1)), [['new_ticket', 'new_salary', { isSecured: false }]]);
});

test('an explicit false on a column that is not secured writes nothing', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(false) }) });
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }]));
  assert.deepEqual(updates(m), []);
});

test('a profile that still holds a permission on the column halts the unsecure as in use', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(true) }) });
  m.sdk.updateColumn = async () => { const e = new Error('in use'); e.name = 'ArtifactInUseError'; e.code = 'ARTIFACT_IN_USE'; throw e; };
  const err = await halted(run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }]), { authorizedDestructive: true }));
  assert.equal(err.code, 'FIELD_SECURITY_COLUMN_IN_USE');
});

test('the required update of an existing column never carries isSecured', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: securedRows(true) }) });
  await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', required: true, isSecured: true }]));
  const sent = updates(m).map((c) => c[3]);
  assert.ok(sent.some((o) => o.required === 'ApplicationRequired'), 'the required update ran');
  assert.ok(sent.every((o) => !('isSecured' in o)), JSON.stringify(sent));
});

// The table exists, its columns could not be read, and the create of each declared column is answered "already exists" — the column
// is there, created without what the spec declares on it.
const exists = () => Object.assign(new Error('Attribute already exists.'), { statusCode: 400, cause: { error: { code: '0x80047013', message: 'Attribute already exists.' } } });
function unreadColumnsServer(over = {}) {
  const base = metadataServer({ tables: { new_ticket: ['new_ticketid', 'new_name'] }, ...over });
  return (p) => (/\/Attributes\?\$select=LogicalName,RequiredLevel$/.test(p) ? { status: 500, body: {} } : base(p));
}
const alreadyThere = (m) => { m.sdk.createColumn = async (l, o) => { m.calls.push(['createColumn', l, o]); throw exists(); }; return m; };

test('a declared secured column whose create is skipped as existing is secured, whether or not the security read answers', async () => {
  for (const secured of [{ value: [{ LogicalName: 'new_salary', IsSecured: false }] }, () => ({ status: 503, body: {} })]) {
    const m = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ secured }) }));
    await run(m, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]));
    assert.deepEqual(updates(m).map((c) => c.slice(1)), [['new_ticket', 'new_salary', { isSecured: true }]]);
    assert.equal(securityGets(m).length, 1);
  }
  // Already secured: read, nothing written.
  const same = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ secured: { value: [{ LogicalName: 'new_salary', IsSecured: true }] } }) }));
  await run(same, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]));
  assert.deepEqual(updates(same), []);
  // Also on a table this build did not find: a create skipped as existing is the same column the spec declares.
  const fresh = alreadyThere(mockSdk({ dataverseGet: metadataServer({ secured: { value: [{ LogicalName: 'new_salary', IsSecured: false }] } }) }));
  await run(fresh, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]));
  assert.deepEqual(updates(fresh).map((c) => c.slice(1)), [['new_ticket', 'new_salary', { isSecured: true }]]);
});

test('an explicit isSecured: false that cannot be read halts, on a column found or skipped as existing; omitted reads nothing', async () => {
  const found = mockSdk({ dataverseGet: metadataServer({ ...SECURE_TABLE, secured: () => ({ status: 403, body: {} }) }) });
  const err = await halted(run(found, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }])));
  assert.equal(err.code, 'COLUMN_SECURITY_UNREAD');
  assert.match(err.message, /new_ticket\.new_salary/);
  assert.deepEqual(updates(found), []);

  const skipped = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ secured: () => ({ status: 403, body: {} }) }) }));
  assert.equal((await halted(run(skipped, specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: false }])))).code, 'COLUMN_SECURITY_UNREAD');

  const omitted = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ secured: () => assert.fail('read') }) }));
  await run(omitted, specOf([{ schemaName: 'new_salary', type: 'Money' }]));
  assert.deepEqual([securityGets(omitted).length, updates(omitted)], [0, []]);
});

test('an explicit behaviour that cannot be read halts; one on a column skipped as existing is reconciled; omitted reads nothing', async () => {
  const unread = mockSdk({ dataverseGet: metadataServer({ tables: NULL_TABLE.tables, dates: () => ({ status: 503, body: {} }) }) });
  const err = await halted(run(unread, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'DateOnly' }])));
  assert.equal(err.code, 'DATETIME_BEHAVIOR_UNVERIFIED');
  assert.match(err.message, /new_ticket\.new_due/);
  assert.deepEqual(updates(unread), []);

  const skipped = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ dates: { value: [dateRow('new_due', 'UserLocal')] }, readBack: dateRow('new_due', 'UserLocal') }) }));
  const repaired = await halted(run(skipped, specOf([{ schemaName: 'new_due', type: 'DateTime', dateTimeBehavior: 'DateOnly' }])));
  assert.equal(repaired.code, 'DESTRUCTIVE_NOT_AUTHORIZED');
  assert.equal(dateGets(skipped).length, 1);

  const omitted = alreadyThere(mockSdk({ dataverseGet: unreadColumnsServer({ dates: () => assert.fail('read') }) }));
  await run(omitted, specOf([{ schemaName: 'new_due', type: 'DateTime' }]));
  assert.deepEqual([dateGets(omitted).length, updates(omitted)], [0, []]);
});

// ------------------------------------------------------------------------------------------------ table flags

const flagRow = ({ dup = false, ct = false, search = false, canSearch = true } = {}) => ({ IsDuplicateDetectionEnabled: { Value: dup, CanBeChanged: true }, ChangeTrackingEnabled: ct, SyncToExternalSearchIndex: search, CanEnableSyncToExternalSearchIndex: { Value: canSearch } });
const flagSpec = (flags) => specOf([], { entities: [Object.assign({ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns: [] }, flags)] });
const flagGets = (m) => m.gets.filter((p) => /IsDuplicateDetectionEnabled/.test(p));
const tableUpdates = (m) => m.calls.filter((c) => c[0] === 'updateTable');

test('search on an untracked table is written with change tracking, in one updateTable after one read', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ flags: flagRow() }) });
  await run(m, flagSpec({ searchEnabled: true, changeTrackingEnabled: true }));
  assert.deepEqual(tableUpdates(m).map((c) => c.slice(1)), [['new_ticket', { searchEnabled: true, changeTrackingEnabled: true }]]);
  assert.equal(flagGets(m).length, 1);
});

test('flags already as declared write nothing; a table that declares none is not read', async () => {
  const same = mockSdk({ dataverseGet: metadataServer({ flags: flagRow({ ct: true, search: true }) }) });
  await run(same, flagSpec({ searchEnabled: true, changeTrackingEnabled: true }));
  assert.deepEqual(tableUpdates(same), []);
  const none = mockSdk({ dataverseGet: metadataServer({ flags: () => assert.fail('read') }) });
  await run(none, flagSpec({}));
  assert.equal(flagGets(none).length, 0);
});

test('duplicate detection on is written and its table published once at the end of the phase', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ flags: flagRow() }) });
  m.provision.dataverse.post = async (p, body) => { m.calls.push(['post', p, body]); return { status: 204, body: {} }; };
  await run(m, flagSpec({ duplicateDetectionEnabled: true }));
  assert.deepEqual(tableUpdates(m).map((c) => c[2]), [{ duplicateDetectionEnabled: true }]);
  const publishes = m.calls.filter((c) => c[0] === 'post' && /PublishXml/.test(c[1]));
  assert.equal(publishes.length, 1);
  assert.match(JSON.stringify(publishes[0][2]), /<entity>new_ticket<\/entity>/);
});

test('duplicate detection off halts without consent; search the table forbids halts; neither writes', async () => {
  for (const [row, flags, code] of [
    [flagRow({ dup: true }), { duplicateDetectionEnabled: false }, 'DESTRUCTIVE_NOT_AUTHORIZED'],
    [flagRow({ canSearch: false }), { searchEnabled: true, changeTrackingEnabled: true }, 'TABLE_SEARCH_NOT_ALLOWED'],
  ]) {
    const m = mockSdk({ dataverseGet: metadataServer({ flags: row }) });
    const err = await halted(run(m, flagSpec(flags)));
    assert.equal(err.code, code);
    assert.deepEqual(tableUpdates(m), []);
  }
  const ok = mockSdk({ dataverseGet: metadataServer({ flags: flagRow({ dup: true }) }) });
  await run(ok, flagSpec({ duplicateDetectionEnabled: false }), { authorizedDestructive: ['tableFlags:new_ticket'] });
  assert.deepEqual(tableUpdates(ok).map((c) => c[2]), [{ duplicateDetectionEnabled: false }]);
});

test('unreadable flags are written as declared, with a warning', async () => {
  const warnings = [];
  const m = mockSdk({ dataverseGet: metadataServer({ flags: () => ({ status: 500, body: {} }) }) });
  await run(m, flagSpec({ changeTrackingEnabled: true }), { warn: (w) => warnings.push(w) });
  assert.deepEqual(tableUpdates(m).map((c) => c[2]), [{ changeTrackingEnabled: true }]);
  assert.ok(warnings.some((w) => /could not read the current table flags of new_ticket/.test(w)));
});
test('a secured column of a new table goes in the post-table change set with isSecured, never in the table create', async () => {
  const created = [];
  const together = [];
  const sdk = {
    createTable: async (o) => { created.push(o); return { logicalName: 'new_ticket', entitySetName: 'new_tickets', metadataId: '66666666-6666-6666-6666-666666666666' }; },
    createColumns: async (l, options) => { together.push(options); },
    createColumn: async (l, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: '77777777-7777-7777-7777-777777777777' }),
  };
  const provision = { findTables: async () => [], findColumns: async () => [], dataverse: { get: async (url) => {
    if (/Attributes\?\$select=MetadataId,LogicalName$/.test(url)) return { status: 200, body: { value: [{ LogicalName: 'new_salary', MetadataId: '88888888-8888-8888-8888-888888888888' }] } };
    return { status: 404, body: null };
  } } };
  await provisionDataModel({ sdk, provision, runner: makeRunner({ emit: () => {}, total: 50 }), spec: specOf([{ schemaName: 'new_salary', type: 'Money', isSecured: true }]), apply: true, preResolvedLanguageCode: 1033, sleep: async () => {} });
  assert.ok(!('columns' in created[0]));
  assert.deepEqual(together.map((set) => set.map((c) => [c.schemaName, c.isSecured])), [[['new_salary', true]]]);
});

// ------------------------------------------------------------------------------------------------ Customer columns

test('a Customer column the table already has is never updated, even when it declares isSecured or a capability', async () => {
  const m = mockSdk({ dataverseGet: metadataServer({ tables: { new_ticket: ['new_ticketid', 'new_name', 'new_customer'] }, secured: () => assert.fail('read') }) });
  await run(m, specOf([{ schemaName: 'new_customer', type: 'Customer', isSecured: true, isValidForUpdate: false }]));
  assert.deepEqual(updates(m), []);
  assert.equal(securityGets(m).length, 0);
});