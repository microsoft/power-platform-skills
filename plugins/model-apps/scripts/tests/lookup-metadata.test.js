'use strict';
// Lookup discovery (lib/lookup-metadata.js and scripts/get-lookup-metadata.js): each lookup's complete target set from the SDK's
// table metadata, the concrete paths from the lookup-details relationship read, the shared paths kept apart (Owner's `ownerid`),
// and every incomplete or failed read a failure of the whole — with the SDK stubbed. The real bundle is driven in
// lookup-metadata-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { readLookupMetadata, tableLookups } = require('../lib/lookup-metadata.js');

const SCRIPT = path.resolve(__dirname, '..', 'get-lookup-metadata.js');
const ENV = 'https://contoso.crm.dynamics.com';

const attribute = (logicalName, attributeType, targets) => ({ logicalName, attributeType, ...(targets ? { targets } : {}) });
const OPPORTUNITY = {
  logicalName: 'opportunity',
  primaryIdAttribute: 'opportunityid',
  primaryNameAttribute: 'name',
  attributes: [
    attribute('opportunityid', 'Uniqueidentifier'),
    attribute('name', 'String'),
    attribute('customerid', 'Customer', ['account', 'contact']),
    attribute('parentaccountid', 'Lookup', ['account']),
    attribute('ownerid', 'Owner', ['systemuser', 'team']),
    attribute('owneridtype', 'EntityName'),
  ],
};
const relationship = (schemaName, referencedEntity, referencingAttribute, referencedAttribute, navigationProperty) => (
  { schemaName, type: 'OneToMany', referencedEntity, referencingEntity: 'opportunity', referencingAttribute, referencedAttribute, navigationProperty });
const ROWS = [
  relationship('opportunity_customer_accounts', 'account', 'customerid', 'accountid', 'customerid_account'),
  relationship('opportunity_customer_contacts', 'contact', 'customerid', 'contactid', 'customerid_contact'),
  relationship('opportunity_parent_account', 'account', 'parentaccountid', 'accountid', 'parentaccountid'),
  relationship('owner_opportunitys', 'owner', 'ownerid', 'ownerid', 'ownerid'),
];

test('a Customer lookup has a concrete path per target; Owner\'s abstract ownerid is a shared path, never a target discriminator', () => {
  const table = tableLookups(OPPORTUNITY, ROWS);
  assert.equal(table.logicalName, 'opportunity');
  assert.equal(table.primaryIdAttribute, 'opportunityid');
  assert.equal(table.primaryNameAttribute, 'name');
  assert.deepEqual(table.lookups.map((lookup) => lookup.column), ['customerid', 'ownerid', 'parentaccountid'], 'lookups only, by column');
  const [customer, owner, parent] = table.lookups;
  assert.deepEqual(customer, {
    column: 'customerid', readProperty: '_customerid_value', attributeType: 'Customer', targets: ['account', 'contact'],
    paths: [
      { target: 'account', navigationProperty: 'customerid_account', referencedKey: 'accountid', relationship: 'opportunity_customer_accounts' },
      { target: 'contact', navigationProperty: 'customerid_contact', referencedKey: 'contactid', relationship: 'opportunity_customer_contacts' },
    ],
    sharedPaths: [],
  });
  assert.deepEqual(owner.targets, ['systemuser', 'team'], 'the complete target set, from the metadata — not from a relationship');
  assert.deepEqual(owner.paths, [], 'no ownerid_systemuser or ownerid_team is manufactured');
  assert.deepEqual(owner.sharedPaths, [{ referencedEntity: 'owner', navigationProperty: 'ownerid', referencedKey: 'ownerid', relationship: 'owner_opportunitys' }]);
  assert.deepEqual(parent.paths, [{ target: 'account', navigationProperty: 'parentaccountid', referencedKey: 'accountid', relationship: 'opportunity_parent_account' }], 'a single-target lookup');
});

test('a navigation property two targets share, or a target reached twice, is shared — never a concrete path', () => {
  const shared = tableLookups(OPPORTUNITY, [
    relationship('a', 'account', 'customerid', 'accountid', 'customerid'),
    relationship('b', 'contact', 'customerid', 'contactid', 'customerid'),
  ]).lookups[0];
  assert.deepEqual(shared.paths, []);
  assert.equal(shared.sharedPaths.length, 2);
  const twice = tableLookups(OPPORTUNITY, [
    relationship('a', 'account', 'customerid', 'accountid', 'customerid_account'),
    relationship('a2', 'account', 'customerid', 'accountid', 'customerid_account2'),
    relationship('b', 'contact', 'customerid', 'contactid', 'customerid_contact'),
  ]).lookups[0];
  assert.deepEqual(twice.paths.map((entry) => entry.target), ['contact']);
  assert.deepEqual(twice.sharedPaths.map((entry) => entry.navigationProperty), ['customerid_account', 'customerid_account2']);
});

test('a lookup whose targets the metadata did not state fails the read — it is never a lookup with no targets', () => {
  for (const targets of [undefined, [], [''], [7], ['sales orders']]) {
    const metadata = { ...OPPORTUNITY, attributes: OPPORTUNITY.attributes.map((entry) => (entry.logicalName === 'customerid' ? attribute('customerid', 'Customer', targets) : entry)) };
    assert.throws(() => tableLookups(metadata, ROWS), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE' && /customerid/.test(err.message), JSON.stringify(targets));
  }
});

test('an attribute inventory that cannot be complete fails the read: no primary id, or a relationship column it does not list', () => {
  const without = (column) => ({ ...OPPORTUNITY, attributes: OPPORTUNITY.attributes.filter((entry) => entry.logicalName !== column) });
  for (const [label, metadata] of [
    ['an absent attribute inventory, which the SDK reads as []', { ...OPPORTUNITY, attributes: [] }],
    ['no primary id column stated', { ...OPPORTUNITY, primaryIdAttribute: '' }],
    ['a primary id column the inventory does not list', without('opportunityid')],
    ['a Customer lookup its relationships name but the inventory does not list', without('customerid')],
    ['an Owner lookup its relationship names but the inventory does not list', without('ownerid')],
  ]) {
    assert.throws(() => tableLookups(metadata, ROWS), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE', label);
  }
  // A relationship column the read does not classify, or classifies against its Targets, is incomplete — never "not a lookup".
  const typed = (column, attributeType, targets) => ({ ...OPPORTUNITY, attributes: OPPORTUNITY.attributes
    .map((entry) => (entry.logicalName === column ? { logicalName: column, ...(attributeType === undefined ? {} : { attributeType }), ...(targets ? { targets } : {}) } : entry)) });
  for (const [label, metadata] of [
    ['a Customer lookup whose type the read did not state (the SDK says Unknown)', typed('customerid', 'Unknown', ['account', 'contact'])],
    ['a lookup with no type at all', typed('customerid', undefined, ['account', 'contact'])],
    ['an unclassified column with no Targets either', typed('customerid', 'Unknown')],
    ['a type that is not a name', typed('parentaccountid', 7, ['account'])],
    ['a String column with lookup targets', typed('customerid', 'String', ['account', 'contact'])],
  ]) {
    assert.throws(() => tableLookups(metadata, ROWS), (err) => err.code === 'LOOKUP_METADATA_INCOMPLETE', label);
  }
  // A known non-lookup relationship column without Targets, and a party list with its Targets, stay out of the lookups as before.
  const withExtra = { ...OPPORTUNITY, attributes: [...OPPORTUNITY.attributes, attribute('requiredattendees', 'PartyList', ['contact'])] };
  const extraRows = [...ROWS, relationship('opportunity_owneridtype', 'account', 'owneridtype', 'accountid', 'owneridtype_account'),
    relationship('opportunity_attendees', 'contact', 'requiredattendees', 'contactid', 'requiredattendees_contact')];
  assert.deepEqual(tableLookups(withExtra, extraRows).lookups.map((lookup) => lookup.column), ['customerid', 'ownerid', 'parentaccountid']);
  // Neighbour: a table with no lookups and no relationships is a complete, empty answer.
  assert.deepEqual(tableLookups({ ...OPPORTUNITY, attributes: [attribute('opportunityid', 'Uniqueidentifier'), attribute('name', 'String')] }, []).lookups, []);
});

function fakeSdk({ metadata = { opportunity: OPPORTUNITY }, pages } = {}) {
  const reads = [];
  const detailPath = (table) => `/EntityDefinitions(LogicalName='${table}')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute,ReferencedAttribute,ReferencingEntityNavigationPropertyName`;
  const raw = (row) => ({ SchemaName: row.schemaName, ReferencedEntity: row.referencedEntity, ReferencingAttribute: row.referencingAttribute, ReferencedAttribute: row.referencedAttribute, ReferencingEntityNavigationPropertyName: row.navigationProperty });
  const answers = pages || { [detailPath('opportunity')]: { status: 200, body: { value: ROWS.map(raw) } } };
  return {
    reads,
    initWorkspace: async () => { reads.push('initWorkspace'); },
    fetchEntityMetadata: async (table) => {
      reads.push(`metadata ${table}`);
      if (metadata[table] instanceof Error) throw metadata[table];
      return metadata[table];
    },
    dataverse: {
      get: async (p) => {
        reads.push(p);
        return answers[p] || { status: 404, body: { error: { code: '0x80060888', message: `EntityMetadata With Id = LogicalName='${p}' does not exist.` } } };
      },
    },
  };
}

test('readLookupMetadata composes the SDK metadata with the lookup-details read, table by table', async () => {
  const sdk = fakeSdk();
  const answer = await readLookupMetadata(sdk, ['opportunity']);
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.tables.map((table) => table.logicalName), ['opportunity']);
  assert.deepEqual(sdk.reads[0], 'metadata opportunity');
  assert.match(sdk.reads[1], /ManyToOneRelationships\?\$select=SchemaName,ReferencedEntity,ReferencingAttribute,ReferencedAttribute,ReferencingEntityNavigationPropertyName$/);
});

test('any failed or incomplete part fails the whole discovery, with a code', async () => {
  const sdkError = Object.assign(new Error('Could not find entity nosuch'), { code: 'NOT_FOUND' });
  for (const [label, sdk, tables, code] of [
    ['no table named', fakeSdk(), [], 'LOOKUP_TABLES_REQUIRED'],
    ['a name that is not a logical name', fakeSdk(), ['Opportunities!'], 'LOOKUP_TABLE_NAME_INVALID'],
    ['the SDK cannot read the table', fakeSdk({ metadata: { nosuch: sdkError } }), ['nosuch'], 'NOT_FOUND'],
    ['metadata for another table', fakeSdk({ metadata: { opportunity: { ...OPPORTUNITY, logicalName: 'quote' } } }), ['opportunity'], 'LOOKUP_METADATA_INCOMPLETE'],
    ['the relationship read finds no table', fakeSdk({ pages: {} }), ['opportunity'], 'LOOKUP_TABLE_NOT_FOUND'],
    ['a refused relationship read', fakeSdk({ pages: { "/EntityDefinitions(LogicalName='opportunity')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute,ReferencedAttribute,ReferencingEntityNavigationPropertyName": { status: 429, body: { error: { code: '0x80072322', message: 'Too many requests.' } } } } }), ['opportunity'], 'LOOKUP_RELATIONSHIPS_UNREADABLE'],
    ['a second table that fails after the first succeeded', fakeSdk({ metadata: { opportunity: OPPORTUNITY, quote: sdkError } }), ['opportunity', 'quote'], 'NOT_FOUND'],
  ]) {
    await assert.rejects(readLookupMetadata(sdk, tables), (err) => err.code === code, label);
  }
});

// The SDK's ConnectionError, as its own read of a table throws it (the real bundle is driven in lookup-metadata-real-bundle.test.js):
//   code CONNECTION_ERROR, statusCode the answer's (0 for a transport failure, such as no token), url the request's, and the message
//   `HTTP 404 from <url>: EntityMetadata With Id = LogicalName='nosuch' does not exist.`
const tableRead = (table) => `${ENV}/api/data/v9.0/EntityDefinitions(LogicalName='${table}')?$select=LogicalName,PrimaryIdAttribute&$expand=Attributes($select=LogicalName)`;
const sdkHttpError = (statusCode, url, words = 'Refused.') => Object.assign(new Error(statusCode ? `HTTP ${statusCode} from ${url}: ${words}` : `Transport failure reaching ${url}: ${words}`), { code: 'CONNECTION_ERROR', statusCode, url });

test('a 404 of the SDK\'s own read of a table names the table missing; every other SDK failure keeps its own code', async () => {
  const missing = sdkHttpError(404, tableRead('nosuch'), "EntityMetadata With Id = LogicalName='nosuch' does not exist.");
  for (const [label, metadata, tables, code] of [
    ['the table\'s own read answers 404', { nosuch: missing }, ['nosuch'], 'LOOKUP_TABLE_NOT_FOUND'],
    ['the second table\'s own read answers 404, after the first was read', { opportunity: OPPORTUNITY, nosuch: missing }, ['opportunity', 'nosuch'], 'LOOKUP_TABLE_NOT_FOUND'],
    ['the table\'s own read refused with another status', { opportunity: sdkHttpError(403, tableRead('opportunity')) }, ['opportunity'], 'CONNECTION_ERROR'],
    ['no token, so nothing was sent', { opportunity: sdkHttpError(0, tableRead('opportunity'), "Failed to get Azure CLI token. Run 'az login' first.") }, ['opportunity'], 'CONNECTION_ERROR'],
    ['a 404 of a read below the table', { opportunity: sdkHttpError(404, `${ENV}/api/data/v9.0/EntityDefinitions(LogicalName='opportunity')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`) }, ['opportunity'], 'CONNECTION_ERROR'],
    ['a 404 of another table\'s read', { opportunity: sdkHttpError(404, tableRead('account')) }, ['opportunity'], 'CONNECTION_ERROR'],
  ]) {
    const sdk = fakeSdk({ metadata });
    await assert.rejects(readLookupMetadata(sdk, tables), (err) => err.code === code, label);
    assert.equal(sdk.reads.at(-1), `metadata ${tables.at(-1)}`, `${label}: nothing is read after the failed table read`);
  }
  await assert.rejects(readLookupMetadata(fakeSdk({ metadata: { nosuch: missing } }), ['nosuch']),
    (err) => err.message === `nosuch: the environment has no table with this logical name — ${missing.message}`);
});

// --- the command line, through main(), with the SDK stubbed (lib/throwaway-sdk.js's own lifecycle) ---------------------------------

async function run(argv, sdk = fakeSdk()) {
  const events = [];
  const emitted = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload, options) => {
        emitted.push({ ok, payload, options });
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    './lib/throwaway-sdk.js': {
      withThrowawaySdk: (options, runWith) => withThrowawaySdk({
        ...options,
        deps: {
          createAzHttpClient: (env) => { events.push({ type: 'client', env }); return { marker: 'az-client' }; },
          makerSdk: {
            createNodeWorkspaceStorage: (dir) => ({ dir }),
            createMakerSdk: (cfg) => { events.push({ type: 'sdk', cfg }); return sdk; },
          },
        },
      }, runWith),
    },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  const made = events.find((e) => e.type === 'sdk');
  return { events, emitted, exitCode, stderr: cli.stderrText(), stdout: cli.stdoutText(), workspaceDir: made && made.cfg.workspaceStorage.dir };
}

test('a usage error prints nothing on stdout, names the flag and the usage on stderr, and reads nothing', async () => {
  for (const [argv, message] of [
    [[], /--env is required/],
    [['--env', ENV], /--tables is required/],
    [['--env', ENV, '--table', 'opportunity'], /unknown flag\(s\): --table \(did you mean --tables\?\)/],
    [['--env', ENV, '--tables'], /--tables requires a value/],
    [['--env', ENV, '--tables', ' , '], /--tables ' , ' names no table/],
    [['--env', ENV, '--tables', 'opportunity,Sales Orders'], /'sales orders' is not a table logical name/],
    [['--env', 'https://example.com', '--tables', 'opportunity'], /is not a Dataverse environment URL/],
    [['--env', ENV, '--tables', 'opportunity', 'extra'], /unexpected argument 'extra'/],
  ]) {
    const r = await run(argv);
    assert.equal(r.exitCode, 1, argv.join(' '));
    assert.equal(r.stdout, '', argv.join(' '));
    assert.match(r.stderr, message, argv.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/get-lookup-metadata\.js --env <envUrl> --tables '<table1>,<table2>'/);
    assert.deepEqual(r.events, [], `${argv.join(' ')}: no client, no SDK`);
  }
});

test('a complete read prints one ASCII JSON answer; a failed one exits 1 with its code and no tables; the workspace is removed', async () => {
  const fs = require('node:fs');
  const ok = await run(['--env', ENV, '--tables', ' Opportunity , opportunity ']);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.emitted.length, 1);
  assert.deepEqual(ok.emitted[0].options, { ascii: true });
  assert.equal(ok.emitted[0].payload.ok, true);
  assert.deepEqual(ok.emitted[0].payload.tables.map((table) => table.logicalName), ['opportunity'], 'one read per table, a name given twice once');
  assert.equal(fs.existsSync(ok.workspaceDir), false);
  const failed = await run(['--env', ENV, '--tables', 'opportunity'], fakeSdk({ pages: {} }));
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(Object.keys(failed.emitted[0].payload).sort(), ['code', 'error', 'ok']);
  assert.equal(failed.emitted[0].payload.code, 'LOOKUP_TABLE_NOT_FOUND');
  assert.equal(fs.existsSync(failed.workspaceDir), false);
});

test('a table the SDK\'s own read finds missing prints LOOKUP_TABLE_NOT_FOUND with no tables and exits 1; another refusal of that read prints CONNECTION_ERROR', async () => {
  const fs = require('node:fs');
  const missing = await run(['--env', ENV, '--tables', 'opportunity'], fakeSdk({ metadata: { opportunity: sdkHttpError(404, tableRead('opportunity'), "EntityMetadata With Id = LogicalName='opportunity' does not exist.") } }));
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.emitted.length, 1);
  assert.deepEqual(missing.emitted[0].options, { ascii: true });
  assert.deepEqual(Object.keys(missing.emitted[0].payload).sort(), ['code', 'error', 'ok']);
  assert.equal(missing.emitted[0].payload.ok, false);
  assert.equal(missing.emitted[0].payload.code, 'LOOKUP_TABLE_NOT_FOUND');
  assert.match(missing.emitted[0].payload.error, /^opportunity: the environment has no table with this logical name — HTTP 404 from https:\/\/contoso\.crm\.dynamics\.com\/api\/data\/v9\.0\/EntityDefinitions\(LogicalName='opportunity'\)\?/);
  assert.equal(fs.existsSync(missing.workspaceDir), false);
  const refused = await run(['--env', ENV, '--tables', 'opportunity'], fakeSdk({ metadata: { opportunity: sdkHttpError(503, tableRead('opportunity'), 'Service unavailable.') } }));
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.emitted[0].payload, { ok: false, error: `HTTP 503 from ${tableRead('opportunity')}: Service unavailable.`, code: 'CONNECTION_ERROR' });
});
