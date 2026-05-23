const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, buildSnapshot } = require('../snapshot-dataverse-schema');

// parseArgs ------------------------------------------------------------------

test('parseArgs splits --tables into a trimmed array', () => {
  const args = parseArgs(['--tables', 'faq_article, faq_topic ,contact', '--output', 'snap.json']);
  assert.deepEqual(args.tables, ['faq_article', 'faq_topic', 'contact']);
  assert.equal(args.output, 'snap.json');
});

test('parseArgs honors --all-metadata as a shortcut for the three include flags', () => {
  const args = parseArgs(['--tables', 'x', '--output', 'y', '--all-metadata']);
  assert.equal(args.includeRelationships, true);
  assert.equal(args.includeOptionsets, true);
  assert.equal(args.includeLookups, true);
});

test('parseArgs leaves include flags false by default — keeps the snapshot cheap when only columns are needed', () => {
  const args = parseArgs(['--tables', 'x', '--output', 'y']);
  assert.equal(args.includeRelationships, false);
  assert.equal(args.includeOptionsets, false);
  assert.equal(args.includeLookups, false);
});

// buildSnapshot --------------------------------------------------------------

// `deps` is a fixture-driven stub for the dataverse-metadata helpers; lets tests assert
// exactly what was queried and in what order without spinning up HTTP.
function makeDeps(overrides = {}) {
  const calls = { listTables: 0, listTableColumns: [], listTableRelationships: [], listOptionsetValues: [], listLookupTargets: [] };
  const deps = {
    async listTables() { calls.listTables++; return overrides.tables || []; },
    async listTableColumns({ table }) {
      calls.listTableColumns.push(table);
      const fixture = (overrides.columnsByTable || {})[table];
      if (fixture === undefined) {
        const err = new Error(`Dataverse metadata not found at table ${table}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      return fixture;
    },
    async listTableRelationships({ table }) {
      calls.listTableRelationships.push(table);
      return (overrides.relationshipsByTable || {})[table] || { oneToMany: [], manyToOne: [], manyToMany: [] };
    },
    async listOptionsetValues({ table, column }) {
      calls.listOptionsetValues.push({ table, column });
      return ((overrides.optionsetsByTable || {})[table] || {})[column] || [];
    },
    async listLookupTargets({ table, column }) {
      calls.listLookupTargets.push({ table, column });
      return ((overrides.lookupsByTable || {})[table] || {})[column] || { logicalName: column, targets: [] };
    },
  };
  return { deps, calls };
}

test('buildSnapshot fetches columns once per requested table and produces a populated snapshot', async () => {
  const { deps, calls } = makeDeps({
    tables: [{ logicalName: 'faq_article', schemaName: 'faq_Article', entitySetName: 'faq_articles', isCustom: true }],
    columnsByTable: {
      faq_article: [
        {
          logicalName: 'faq_articlebody',
          schemaName: 'faq_ArticleBody',
          attributeType: 'Memo',
          isCustom: true,
          readable: true,
          creatable: true,
          writable: true,
        },
      ],
    },
  });
  const snap = await buildSnapshot({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article'],
    includeRelationships: false,
    includeOptionsets: false,
    includeLookups: false,
    deps,
  });
  assert.equal(calls.listTables, 1);
  assert.deepEqual(calls.listTableColumns, ['faq_article']);
  assert.equal(snap.errors.length, 0);
  assert.equal(snap.allTables.length, 1);
  assert.equal(snap.tables.faq_article.columns[0].logicalName, 'faq_articlebody');
  // Without --include-relationships / optionsets / lookups, those should not appear on
  // the per-table entry. The verify script relies on `undefined` here to know that
  // particular metadata kind was not requested (vs. present-but-empty).
  assert.equal(snap.tables.faq_article.relationships, undefined);
  assert.equal(snap.tables.faq_article.optionsets, undefined);
  assert.equal(snap.tables.faq_article.lookups, undefined);
});

test('buildSnapshot records a NOT_FOUND error and continues to remaining tables — does not abort the run', async () => {
  // This is the migration-critical case: when one table is misspelled, we still want to
  // capture the correctly-spelled ones so the verify script can report all problems in
  // one pass instead of one-mismatch-per-rerun.
  const { deps } = makeDeps({
    tables: [{ logicalName: 'faq_article' }, { logicalName: 'contact' }],
    columnsByTable: { faq_article: [], contact: [] }, // faq_body not present → NOT_FOUND
  });
  const snap = await buildSnapshot({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article', 'faq_body', 'contact'],
    deps,
  });
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.errors[0].scope, 'columns');
  assert.equal(snap.errors[0].table, 'faq_body');
  assert.equal(snap.errors[0].code, 'NOT_FOUND');
  // Verify the run continued past the failure.
  assert.ok(snap.tables.faq_article);
  assert.ok(snap.tables.contact);
});

test('buildSnapshot fetches optionsets ONLY for choice-typed columns when --include-optionsets is set', async () => {
  const { deps, calls } = makeDeps({
    columnsByTable: {
      faq_article: [
        { logicalName: 'faq_publishedstatus', attributeType: 'Picklist', readable: true, creatable: true, writable: true },
        { logicalName: 'faq_articlebody', attributeType: 'Memo', readable: true, creatable: true, writable: true },
        { logicalName: 'statecode', attributeType: 'State', readable: true, creatable: false, writable: false },
      ],
    },
    optionsetsByTable: {
      faq_article: {
        faq_publishedstatus: [{ value: 1, label: 'Draft', description: null }],
        statecode: [{ value: 0, label: 'Active', description: null }],
      },
    },
  });
  const snap = await buildSnapshot({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article'],
    includeOptionsets: true,
    deps,
  });
  // Exactly 2 optionset calls (Picklist + State). The Memo column must be skipped — if
  // it isn't, every text column on a large schema would emit a 404 from Dataverse.
  assert.equal(calls.listOptionsetValues.length, 2);
  assert.deepEqual(
    calls.listOptionsetValues.map((c) => c.column),
    ['faq_publishedstatus', 'statecode'],
  );
  assert.equal(snap.tables.faq_article.optionsets.faq_publishedstatus[0].label, 'Draft');
  assert.equal(snap.tables.faq_article.optionsets.statecode[0].label, 'Active');
});

test('buildSnapshot fetches lookups ONLY for Lookup/Customer/Owner columns when --include-lookups is set', async () => {
  const { deps, calls } = makeDeps({
    columnsByTable: {
      faq_article: [
        { logicalName: 'faq_topic', attributeType: 'Lookup', readable: true },
        { logicalName: 'ownerid', attributeType: 'Owner', readable: true },
        { logicalName: 'customerid', attributeType: 'Customer', readable: true },
        { logicalName: 'createdon', attributeType: 'DateTime', readable: true },
        { logicalName: 'faq_publishedstatus', attributeType: 'Picklist', readable: true },
      ],
    },
    lookupsByTable: {
      faq_article: {
        faq_topic: { logicalName: 'faq_topic', targets: ['faq_topic'] },
        ownerid: { logicalName: 'ownerid', targets: ['systemuser', 'team'] },
        customerid: { logicalName: 'customerid', targets: ['account', 'contact'] },
      },
    },
  });
  const snap = await buildSnapshot({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article'],
    includeLookups: true,
    deps,
  });
  // 3 lookup-typed columns → exactly 3 lookup calls. DateTime and Picklist columns must
  // not appear here.
  assert.equal(calls.listLookupTargets.length, 3);
  assert.deepEqual(snap.tables.faq_article.lookups.ownerid.targets, ['systemuser', 'team']);
  assert.deepEqual(snap.tables.faq_article.lookups.customerid.targets, ['account', 'contact']);
});

test('buildSnapshot collects per-relationship errors without aborting the table', async () => {
  const failingDeps = {
    async listTables() { return []; },
    async listTableColumns() { return [{ logicalName: 'x', attributeType: 'String' }]; },
    async listTableRelationships() { throw new Error('relationship API failed'); },
    async listOptionsetValues() { return []; },
    async listLookupTargets() { return { logicalName: 'x', targets: [] }; },
  };
  const snap = await buildSnapshot({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article'],
    includeRelationships: true,
    deps: failingDeps,
  });
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.errors[0].scope, 'relationships');
  // The table entry was still recorded with whatever succeeded (columns).
  assert.equal(snap.tables.faq_article.columns.length, 1);
});

test('buildSnapshot stamps version + envUrl + capturedAt on the snapshot for downstream traceability', async () => {
  const { deps } = makeDeps({ columnsByTable: { faq_article: [] } });
  const snap = await buildSnapshot({
    envUrl: 'https://target.crm.dynamics.com',
    token: 'tok',
    tables: ['faq_article'],
    deps,
  });
  assert.equal(snap.version, 1);
  assert.equal(snap.envUrl, 'https://target.crm.dynamics.com');
  // capturedAt must be a parseable ISO 8601 string — the verify script timestamps each
  // finding with this so users can tell stale snapshots from fresh ones.
  assert.match(snap.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});
