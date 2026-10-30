'use strict';
// The data-model phase's 2.21.0 schema work driven through the REAL vendored SDK over a recording HTTP client: what reaches the wire
// for a declared secured column the build could not see, and for the Date and Time preflight. The doubles in
// schema-features-provision.test.js pin the decisions; these pin that the SDK's requests and answers carry them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ORIGIN = 'https://contoso.crm.dynamics.com';

// `route(verb, path, body)` answers a request by its decoded path below the API root (e.g. `/EntityDefinitions(...)`), or returns
// undefined for a 404. Every request is recorded as `[VERB, path, body]`.
function realSdk(route) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-real-'));
  const requests = [];
  const handle = (verb) => async (url, body) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname + u.search).replace(/^\/api\/data\/v9\.\d+/, '');
    requests.push([verb, p, body]);
    return (await route(verb, p, body)) || { status: 404, headers: {}, body: { error: { code: '0x80060888', message: 'Not found' } } };
  };
  const B = require(BUNDLE);
  const sdk = B.createMakerSdk({
    workspaceStorage: B.createNodeWorkspaceStorage(dir),
    instanceUrl: ORIGIN,
    httpClient: { get: handle('GET'), post: handle('POST'), put: handle('PUT'), patch: handle('PATCH'), delete: handle('DELETE') },
  });
  return { sdk, requests, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const specOf = (columns) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns }],
  relationships: [],
});

async function provision(r, spec, opts = {}) {
  await r.sdk.initWorkspace();
  return provisionDataModel(Object.assign({
    sdk: r.sdk, provision: r.sdk, runner: makeRunner({ emit: () => {}, total: 50 }), spec, apply: true, preResolvedLanguageCode: 1033,
    warn: () => {}, inlineColumns: false,
  }, opts));
}

const ok = (body, headers = {}) => ({ status: 200, headers, body });
const TABLE = ok({ LogicalName: 'new_ticket', EntitySetName: 'new_tickets', MetadataId: '66666666-6666-6666-6666-666666666666' });
const SALARY = {
  '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
  MetadataId: '77777777-7777-7777-7777-777777777777',
  LogicalName: 'new_salary',
  SchemaName: 'new_salary',
  AttributeType: 'String',
  IsSecured: false,
  MaxLength: 100,
};

// ------------------------------------------------------------------------------------------------ a secured column the build could not see

test('REAL BUNDLE: a declared secured column whose columns read failed and whose create is answered "already exists" is secured', async () => {
  for (const securityRead of [ok({ value: [{ LogicalName: 'new_salary', IsSecured: false }] }), { status: 500, headers: {}, body: {} }]) {
    let put = null;
    const r = realSdk((verb, p, body) => {
      if (verb === 'GET' && /^\/EntityDefinitions\(LogicalName='new_ticket'\)\?\$select=LogicalName,EntitySetName/.test(p)) return TABLE;
      if (verb === 'GET' && p.endsWith('/Attributes?$select=LogicalName,RequiredLevel')) return { status: 500, headers: {}, body: {} };
      if (verb === 'GET' && p.endsWith('/Attributes?$select=LogicalName,IsSecured')) return securityRead;
      if (verb === 'GET' && /\/Attributes\((?:LogicalName='new_salary'|77777777-[0-9-]+)\)/.test(p)) return ok({ ...SALARY, IsSecured: put ? put.IsSecured : false });
      if (verb === 'POST' && /\/Attributes$/.test(p)) return { status: 400, headers: {}, body: { error: { code: '0x80047013', message: 'Attribute new_salary already exists.' } } };
      if (verb === 'PUT' && /\/Attributes\(/.test(p)) { put = body; return { status: 204, headers: {}, body: {} }; }
      return undefined;
    });
    try {
      await provision(r, specOf([{ schemaName: 'new_salary', displayName: 'Salary', type: 'Text', isSecured: true }]));
      assert.ok(put, `no secure write was sent: ${JSON.stringify(r.requests.map((x) => x.slice(0, 2)))}`);
      assert.equal(put.IsSecured, true);
      assert.equal(r.requests.filter((x) => x[1].endsWith('$select=LogicalName,IsSecured')).length, 1);
    } finally {
      r.cleanup();
    }
  }
});

// ------------------------------------------------------------------------------------------------ column types from the existing read

test('REAL BUNDLE: the findColumns rows verification already reads carry the type the column-type check needs, with no other request', async () => {
  const { columnTypeChecks } = require('../lib/schema-feature-contract.js');
  const r = realSdk((verb, p) => {
    if (verb === 'GET' && /\/Attributes\?\$select=LogicalName,SchemaName,DisplayName,AttributeType,IsCustomAttribute$/.test(p)) {
      return ok({ value: [
        { LogicalName: 'new_amount', SchemaName: 'new_Amount', DisplayName: { UserLocalizedLabel: { Label: 'Amount' } }, AttributeType: 'Money', IsCustomAttribute: true },
        { LogicalName: 'new_photo', SchemaName: 'new_Photo', DisplayName: { UserLocalizedLabel: { Label: 'Photo' } }, AttributeType: 'Virtual', IsCustomAttribute: true },
        { LogicalName: 'new_odd', SchemaName: 'new_Odd', DisplayName: { UserLocalizedLabel: { Label: 'Odd' } }, IsCustomAttribute: true },
      ] });
    }
    return undefined;
  });
  try {
    await r.sdk.initWorkspace();
    const rows = await r.sdk.findColumns('new_ticket');
    const entity = { schemaName: 'new_ticket', columns: [{ schemaName: 'new_amount', type: 'Decimal' }, { schemaName: 'new_photo', type: 'Image' }, { schemaName: 'new_odd', type: 'Integer' }] };
    assert.deepEqual(columnTypeChecks(entity, rows), {
      failed: [{ name: 'new_ticket.new_amount', detail: 'declared Decimal, deployed Money: a column\'s type cannot be changed in place' }],
      unverified: ['column-type:new_ticket.new_odd (declared Integer; the deployed type was not stated by the read)'],
    });
    assert.deepEqual(r.requests.map((x) => x[0]), ['GET']);
  } finally {
    r.cleanup();
  }
});
// ------------------------------------------------------------------------------------------------ the Date and Time preflight

const TYPED = "/EntityDefinitions(LogicalName='new_ticket')/Attributes/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata?$select=LogicalName,DateTimeBehavior,CanChangeDateTimeBehavior";
const dateRow = (name, behavior, canChange = true) => ({ LogicalName: name, DateTimeBehavior: behavior === null ? null : { Value: behavior }, CanChangeDateTimeBehavior: { Value: canChange } });
const attrId = (name) => `0000${Buffer.from(name).toString('hex').padEnd(28, '0').slice(0, 28)}`.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');

// An environment where new_ticket exists with `columns` (and `account` exists, for a lookup), the typed Date and Time read answers
// `dates` (a body, or a function returning a whole answer), and every create and update succeeds. `due` is the stored state of
// new_due, which an update changes and the read-back then shows.
function preflightServer({ columns = ['new_ticketid', 'new_name', 'new_due'], dates, tables = ['new_ticket', 'account'], due = null } = {}) {
  const state = { due };
  return { state, route: (verb, p, body) => {
    const probe = /^\/EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName/.exec(p);
    if (verb === 'GET' && probe) return tables.includes(probe[1]) ? ok({ LogicalName: probe[1], EntitySetName: `${probe[1]}s`, MetadataId: attrId(probe[1]) }) : undefined;
    if (verb === 'GET' && p.endsWith('/Attributes?$select=LogicalName,RequiredLevel')) return ok({ value: columns.map((n) => ({ LogicalName: n, RequiredLevel: { Value: 'None' } })) });
    if (verb === 'GET' && p === TYPED) return typeof dates === 'function' ? dates() : ok(dates);
    if (verb === 'GET' && /\/Attributes\((?:LogicalName='new_due'|[0-9a-f-]{36})\)\/Microsoft\.Dynamics\.CRM\.DateTimeAttributeMetadata\?/.test(p)) return ok(dateRow('new_due', state.due));
    if (verb === 'GET' && /\/Attributes\((?:LogicalName='new_due'|[0-9a-f-]{36})\)/.test(p)) {
      return ok({ '@odata.type': '#Microsoft.Dynamics.CRM.DateTimeAttributeMetadata', MetadataId: attrId('new_due'), LogicalName: 'new_due', SchemaName: 'new_due', AttributeType: 'DateTime', DateTimeBehavior: state.due === null ? null : { Value: state.due }, CanChangeDateTimeBehavior: { Value: true }, Format: 'DateAndTime' });
    }
    if (verb === 'PUT' && /\/Attributes\(/.test(p)) { if (body && body.DateTimeBehavior) state.due = body.DateTimeBehavior.Value; return { status: 204, headers: {}, body: {} }; }
    if (verb === 'POST' && /\/Attributes$/.test(p)) return { status: 204, headers: { 'OData-EntityId': `${ORIGIN}/api/data/v9.2${p}(${attrId(body.SchemaName)})` }, body: {} };
    if (verb === 'POST' && /RelationshipDefinitions$|CreateCustomerRelationships$/.test(p)) return { status: 204, headers: { 'OData-EntityId': `${ORIGIN}/api/data/v9.2/RelationshipDefinitions(${attrId('rel')})` }, body: { RelationshipIds: [attrId('rel')], AttributeId: attrId('cust') } };
    if (verb === 'GET' && /RelationshipDefinitions|Relationships/.test(p)) return ok({ value: [] });
    if (verb === 'POST' && /PublishXml$/.test(p)) return { status: 204, headers: {}, body: {} };
    return undefined;
  } };
}
const typedReads = (r) => r.requests.filter((x) => x[0] === 'GET' && x[1] === TYPED).length;
const columnPosts = (r) => r.requests.filter((x) => x[0] === 'POST' && /\/Attributes$|RelationshipDefinitions$|CreateCustomerRelationships$/.test(x[1]));
async function haltOf(promise) {
  try { await promise; } catch (err) { return err; }
  assert.fail('the build did not halt');
}

test('REAL BUNDLE: preflight on — a column with no behaviour halts after one typed read and before any column is sent', async () => {
  const s = preflightServer({ dates: { value: [dateRow('createdon', 'UserLocal', false), dateRow('new_due', null)] } });
  const r = realSdk(s.route);
  try {
    const err = await haltOf(provision(r, specOf([{ schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { dateBehaviorPreflight: true }));
    assert.equal(err.code, 'DATETIME_BEHAVIOR_MISSING');
    assert.equal(typedReads(r), 1);
    assert.deepEqual(columnPosts(r), []);
  } finally { r.cleanup(); }
});

test('REAL BUNDLE: preflight on — an unstated behaviour, a continued answer or a refused read halts as unverified within the one read', async () => {
  for (const dates of [
    { value: [{ LogicalName: 'new_due', CanChangeDateTimeBehavior: { Value: true } }] },
    { value: [dateRow('createdon', 'UserLocal')], '@odata.nextLink': `${ORIGIN}/api/data/v9.2/next` },
    () => ({ status: 503, headers: {}, body: {} }),
  ]) {
    const r = realSdk(preflightServer({ dates }).route);
    try {
      const err = await haltOf(provision(r, specOf([{ schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { dateBehaviorPreflight: true }));
      assert.equal(err.code, 'DATETIME_BEHAVIOR_UNVERIFIED');
      assert.equal(typedReads(r), 1);
      assert.deepEqual(columnPosts(r), []);
    } finally { r.cleanup(); }
  }
});

test('REAL BUNDLE: preflight on — a sound table takes the column with both of its language labels, after exactly one typed read', async () => {
  const r = realSdk(preflightServer({ dates: { value: [dateRow('createdon', 'UserLocal', false)] } }).route);
  try {
    await provision(r, specOf([{ schemaName: 'new_note', displayName: { 1033: 'Note', 1036: 'Remarque' }, type: 'Text' }]), { dateBehaviorPreflight: true, provisionedLanguages: [1033, 1036] });
    assert.equal(typedReads(r), 1);
    const sent = columnPosts(r).map((x) => x[2]);
    assert.deepEqual(sent.map((b) => b.SchemaName), ['new_note']);
    assert.deepEqual(sent[0].DisplayName.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]).sort(), [[1033, 'Note'], [1036, 'Remarque']]);
  } finally { r.cleanup(); }
});

test('REAL BUNDLE: preflight on — a Customer column and a lookup added to the existing table are guarded by the same one read', async () => {
  const dates = { value: [dateRow('new_due', null)] };
  const customer = realSdk(preflightServer({ dates }).route);
  try {
    const err = await haltOf(provision(customer, specOf([{ schemaName: 'new_customer', displayName: 'Customer', type: 'Customer' }]), { dateBehaviorPreflight: true }));
    assert.equal(err.code, 'DATETIME_BEHAVIOR_MISSING');
    assert.equal(typedReads(customer), 1);
    assert.deepEqual(columnPosts(customer), []);
  } finally { customer.cleanup(); }
  const lookup = realSdk(preflightServer({ dates }).route);
  try {
    const rel = { type: 'OneToMany', referenced: 'account', referencing: 'new_ticket', lookup: { schemaName: 'new_accountid', displayName: 'Account' } };
    const err = await haltOf(provision(lookup, Object.assign(specOf([{ schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { relationships: [rel] }), { dateBehaviorPreflight: true }));
    assert.equal(err.code, 'DATETIME_BEHAVIOR_MISSING');
    assert.equal(typedReads(lookup), 1, 'the column and the lookup share the one read');
    assert.deepEqual(columnPosts(lookup), []);
  } finally { lookup.cleanup(); }
});

test('REAL BUNDLE: preflight on — an explicit behaviour repairs the column, is read back, and the new column follows; the collection is read once', async () => {
  const s = preflightServer({ dates: { value: [dateRow('new_due', null)] } });
  const r = realSdk(s.route);
  try {
    await provision(r, specOf([{ schemaName: 'new_due', displayName: 'Due', type: 'DateTime', dateTimeBehavior: 'UserLocal' }, { schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { dateBehaviorPreflight: true });
    assert.equal(s.state.due, 'UserLocal');
    assert.equal(typedReads(r), 1);
    const verbs = r.requests.map((x) => `${x[0]} ${/\/Attributes\(/.test(x[1]) ? 'attribute' : /\/Attributes$/.test(x[1]) ? 'attributes' : ''}`);
    assert.ok(verbs.indexOf('PUT attribute') >= 0 && verbs.indexOf('PUT attribute') < verbs.indexOf('POST attributes'), verbs.join(', '));
    assert.deepEqual(columnPosts(r).map((x) => x[2].SchemaName), ['new_note']);
  } finally { r.cleanup(); }
});

test('REAL BUNDLE: preflight on — no typed read for a table the build creates, nor for a rebuild that adds no column', async () => {
  const fresh = realSdk(preflightServer({ tables: ['account'], dates: () => assert.fail('typed read') }).route);
  try {
    await provision(fresh, specOf([{ schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { dateBehaviorPreflight: true });
  } catch (_) { /* the table's own create is not answered in full here; what matters is that it was reached, with no typed read */ } finally { fresh.cleanup(); }
  assert.ok(fresh.requests.some((x) => x[0] === 'POST' && x[1] === '/EntityDefinitions'), 'the table create was reached');
  assert.equal(typedReads(fresh), 0);
  const rebuild = realSdk(preflightServer({ columns: ['new_ticketid', 'new_name', 'new_note'], dates: () => assert.fail('typed read') }).route);
  try {
    await provision(rebuild, specOf([{ schemaName: 'new_note', displayName: 'Note', type: 'Text' }]), { dateBehaviorPreflight: true });
    assert.equal(typedReads(rebuild), 0);
    assert.deepEqual(columnPosts(rebuild), []);
  } finally { rebuild.cleanup(); }
});