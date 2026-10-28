'use strict';
// get-lookup-metadata.js over the REAL vendored SDK (lib/maker-sdk.js, the throwaway workspace) and a stub HTTP transport answering the
// raw Web API shapes: the SDK's own table metadata read (the main read, the attribute casts — LookupAttributeMetadata carries each
// lookup's Targets — and its own relationship reads), then the plugin's lookup-details ManyToOne read, paged with an absolute
// @odata.nextLink. A mock of the SDK would keep passing against a bundle whose projection no longer carried `targets`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readLookups } = require(path.join(__dirname, '..', 'get-lookup-metadata.js'));
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const ENV = 'https://contoso.crm.dynamics.com';
const label = (text) => ({ UserLocalizedLabel: { Label: text }, LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const ATTRIBUTES = [
  { LogicalName: 'opportunityid', AttributeType: 'Uniqueidentifier', AttributeTypeName: { Value: 'UniqueidentifierType' } },
  { LogicalName: 'name', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' } },
  { LogicalName: 'customerid', AttributeType: 'Customer', AttributeTypeName: { Value: 'CustomerType' } },
  { LogicalName: 'ownerid', AttributeType: 'Owner', AttributeTypeName: { Value: 'OwnerType' } },
].map((a) => ({ DisplayName: label(a.LogicalName), Description: label(''), IsCustomAttribute: false, IsValidForUpdate: true, IsValidForRead: true, AttributeOf: null, ...a }));
const TARGETS = [{ LogicalName: 'customerid', Targets: ['account', 'contact'] }, { LogicalName: 'ownerid', Targets: ['systemuser', 'team'] }];
const DETAILS = 'SchemaName,ReferencedEntity,ReferencingAttribute,ReferencedAttribute,ReferencingEntityNavigationPropertyName';
const NEXT = `${ENV}/api/data/v9.2/EntityDefinitions(LogicalName='opportunity')/ManyToOneRelationships?$select=${DETAILS}&$skiptoken=page2`;
// How Dataverse answers a read of a table the environment does not have (measured live, for the SDK's own read of the table, the first request
// made for one: `GET …/api/data/v9.0/EntityDefinitions(LogicalName='opportunity')?$select=…&$expand=Attributes(…)`).
const NOT_FOUND = (table) => ({ status: 404, headers: {}, body: { error: { code: '0x80060888', message: `EntityMetadata With Id = LogicalName='${table}' does not exist.` } } });

// `tableRead` and `firstPage`, when given, answer opportunity's own metadata read and the first page of its lookup-details read.
function transport({ main = (body) => body, tableRead = null, lookupTargets = TARGETS, firstPage = null, secondPage = { status: 200, body: { value: [
  { SchemaName: 'opportunity_customer_contacts', ReferencedEntity: 'contact', ReferencingAttribute: 'customerid', ReferencedAttribute: 'contactid', ReferencingEntityNavigationPropertyName: 'customerid_contact' },
  { SchemaName: 'owner_opportunitys', ReferencedEntity: 'owner', ReferencingAttribute: 'ownerid', ReferencedAttribute: 'ownerid', ReferencingEntityNavigationPropertyName: 'ownerid' },
] } } } = {}) {
  const reads = [];
  const answer = (url) => {
    const u = decodeURIComponent(url);
    reads.push(u);
    if (u === decodeURIComponent(NEXT)) return secondPage;
    const route = /\/api\/data\/v9\.\d\/EntityDefinitions\(LogicalName='([^']+)'\)(\/[^?]*)?(?:\?(.*))?$/.exec(u);
    if (!route) return { status: 404, headers: {}, body: { error: { code: '0x80060888', message: `no route for ${u}` } } };
    const [, table, sub = '', query = ''] = route;
    if (table !== 'opportunity') return NOT_FOUND(table);
    if (sub === '') {
      return tableRead || { status: 200, headers: {}, body: main({
        LogicalName: 'opportunity', SchemaName: 'Opportunity', DisplayName: label('Opportunity'), Description: label(''), EntitySetName: 'opportunities',
        IsCustomEntity: false, PrimaryNameAttribute: 'name', PrimaryIdAttribute: 'opportunityid', PrimaryImageAttribute: null, Attributes: ATTRIBUTES,
      }) };
    }
    if (sub === '/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata') return lookupTargets instanceof Object && !Array.isArray(lookupTargets) ? lookupTargets : { status: 200, headers: {}, body: { value: lookupTargets } };
    if (sub === '/ManyToOneRelationships' && query.includes('ReferencingEntityNavigationPropertyName')) {
      return firstPage || { status: 200, headers: {}, body: { value: [
        { SchemaName: 'opportunity_customer_accounts', ReferencedEntity: 'account', ReferencingAttribute: 'customerid', ReferencedAttribute: 'accountid', ReferencingEntityNavigationPropertyName: 'customerid_account' },
      ], '@odata.nextLink': NEXT } };
    }
    return { status: 200, headers: {}, body: { value: [] } };
  };
  return {
    reads,
    get: async (url) => answer(url),
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
}

test('REAL BUNDLE: the complete targets from the SDK\'s metadata read, the concrete paths from every page of the lookup-details read', async () => {
  const http = transport();
  const answer = await readLookups(ENV, { tables: ['opportunity'] }, http);
  assert.equal(answer.ok, true);
  const [table] = answer.tables;
  assert.equal(table.primaryIdAttribute, 'opportunityid');
  assert.equal(table.primaryNameAttribute, 'name');
  const customer = table.lookups.find((lookup) => lookup.column === 'customerid');
  assert.deepEqual(customer.targets, ['account', 'contact']);
  assert.deepEqual(customer.paths.map((entry) => [entry.target, entry.navigationProperty, entry.referencedKey]), [['account', 'customerid_account', 'accountid'], ['contact', 'customerid_contact', 'contactid']]);
  const owner = table.lookups.find((lookup) => lookup.column === 'ownerid');
  assert.deepEqual(owner.targets, ['systemuser', 'team']);
  assert.deepEqual(owner.paths, []);
  assert.deepEqual(owner.sharedPaths.map((entry) => entry.navigationProperty), ['ownerid']);
  assert.ok(http.reads.includes(decodeURIComponent(NEXT)), 'the second page was followed, through the absolute link');
  assert.ok(!http.reads.some((u) => /ManyToOneRelationships/.test(u) && /DisplayName|LocalizedLabels/.test(u.split('?')[1] || '')), 'the relationship reads are label-free');
});

test('REAL BUNDLE: an incomplete main metadata answer fails the whole discovery, never a smaller lookup inventory', async () => {
  const drop = (key) => (body) => { const copy = { ...body }; delete copy[key]; return copy; };
  for (const [label, main] of [
    ['no Attributes expansion, which the SDK reads as []', drop('Attributes')],
    ['no PrimaryIdAttribute, which the SDK reads as \'\'', drop('PrimaryIdAttribute')],
    ['a first page of attributes with its continuation, which the SDK does not follow', (body) => ({ ...body,
      Attributes: ATTRIBUTES.filter((entry) => !['customerid', 'ownerid'].includes(entry.LogicalName)),
      'Attributes@odata.nextLink': `${ENV}/api/data/v9.2/EntityDefinitions(LogicalName='opportunity')/Attributes?$skiptoken=rest` })],
  ]) {
    const http = transport({ main });
    await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, http), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE', label);
  }
});

test('REAL BUNDLE: a relationship column the read does not classify, or classifies against its Targets, fails the whole discovery', async () => {
  const retype = (change) => (body) => ({ ...body, Attributes: ATTRIBUTES.map((entry) => (entry.LogicalName === 'customerid' ? change({ ...entry }) : entry)) });
  const untyped = retype((entry) => { delete entry.AttributeType; return entry; });
  for (const [label, options] of [
    ['the Customer attribute without its AttributeType, which the SDK reads as Unknown', { main: untyped }],
    ['the same, and the Targets cast silent about it', { main: untyped, lookupTargets: TARGETS.filter((entry) => entry.LogicalName !== 'customerid') }],
    ['the Customer attribute typed String while the cast states its Targets', { main: retype((entry) => ({ ...entry, AttributeType: 'String' })) }],
  ]) {
    await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, transport(options)), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE', label);
  }
});

test('REAL BUNDLE: a refused targets read, a refused second page, or a missing table fails the whole discovery', async () => {
  for (const [label, options, tables, code] of [
    ['the SDK\'s targets read refused', { lookupTargets: { status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'Service unavailable.' } } } }, ['opportunity'], 'LOOKUP_METADATA_INCOMPLETE'],
    ['the second relationship page refused', { secondPage: { status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'Service unavailable.' } } } }, ['opportunity'], 'LOOKUP_RELATIONSHIPS_UNREADABLE'],
    ['a table the environment does not have', {}, ['nosuch'], 'LOOKUP_TABLE_NOT_FOUND'],
  ]) {
    await assert.rejects(readLookups(ENV, { tables }, transport(options)), (err) => err.code === code, label);
  }
});

// The SDK's own read of a table is the first request made for it, so a table the environment does not have fails THERE — before the lookup-details
// read could say so — and the SDK throws the 404 as its ConnectionError (CONNECTION_ERROR, statusCode 404), which named a sign-in problem, not the table.
test('REAL BUNDLE: a table the environment does not have is LOOKUP_TABLE_NOT_FOUND — the 404 of its own metadata read — with no list, and nothing read after it', async () => {
  for (const [label, tables] of [['the one table named', ['nosuch']], ['the second table named, after the first was read whole', ['opportunity', 'nosuch']]]) {
    const http = transport();
    await assert.rejects(readLookups(ENV, { tables }, http), (err) => {
      assert.equal(err.code, 'LOOKUP_TABLE_NOT_FOUND', label);
      assert.match(err.message, /^nosuch: the environment has no table with this logical name/, label);
      assert.match(err.message, /HTTP 404 from .*EntityMetadata With Id = LogicalName='nosuch' does not exist\.$/, `${label}: the SDK's words, the platform's message in them`);
      return true;
    });
    const own = http.reads.filter((u) => /EntityDefinitions\(LogicalName='nosuch'\)/.test(u));
    assert.deepEqual(own.map((u) => /EntityDefinitions\(LogicalName='nosuch'\)\?\$select=LogicalName,/.test(u)), [true], `${label}: the table's own read, once`);
    assert.equal(http.reads.at(-1), own[0], `${label}: and nothing read after it`);
  }
});

test('REAL BUNDLE: any other failure of a table\'s own read keeps the SDK\'s code — another status, or no token — and a 404 below the table is no missing table', async () => {
  for (const status of [400, 403, 500, 503]) {
    const http = transport({ tableRead: { status, headers: {}, body: { error: { code: '0x80040216', message: 'Refused.' } } } });
    await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, http), (err) => err.code === 'CONNECTION_ERROR' && err.statusCode === status, `HTTP ${status}`);
    assert.equal(http.reads.length, 1, `HTTP ${status}: nothing read after it`);
  }
  // No token: the real client refuses before it sends anything, and the SDK names that a transport failure (statusCode 0).
  let sent = 0;
  const noToken = createAzHttpClient(ENV, { getToken: () => null, request: async () => { sent += 1; throw new Error('nothing may be sent without a token'); } });
  await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, noToken), (err) => err.code === 'CONNECTION_ERROR' && err.statusCode === 0, 'no token');
  assert.equal(sent, 0, 'no token: nothing was sent');
  // A 404 of a read BELOW the table — the SDK's targets cast — is a column read that failed: the answer is incomplete, the table is there.
  await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, transport({ lookupTargets: NOT_FOUND('opportunity') })), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE', 'the targets cast');
  // The lookup-details read's own 404 for the table stays LOOKUP_TABLE_NOT_FOUND, as it was.
  await assert.rejects(readLookups(ENV, { tables: ['opportunity'] }, transport({ firstPage: NOT_FOUND('opportunity') })), (err) => err.code === 'LOOKUP_TABLE_NOT_FOUND', 'the lookup-details read');
});
