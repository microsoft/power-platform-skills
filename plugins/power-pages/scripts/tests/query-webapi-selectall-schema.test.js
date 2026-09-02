'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const schema = require(
  '../../skills/migrate-webapi-selectall/scripts/query-table-schema'
);

const ENVIRONMENT_URL_1 = 'https://placeholder.crm.dynamics.com';
const TABLE_LOGICAL_NAME_1 = 'table_1';
const TABLE_ENTITY_SET_NAME_1 = 'table_1_set';
const TABLE_PRIMARY_ID_1 = 'column_name_1_id';
const TABLE_LOGICAL_NAME_2 = 'table_2';
const TABLE_ENTITY_SET_NAME_2 = 'table_2_set';
const TABLE_PRIMARY_ID_2 = 'column_name_2_id';
const COLUMN_NAME_1 = 'column_name_1';
const LOOKUP_COLUMN_NAME_1 = 'lookup_column_name_1';
const LOOKUP_SCHEMA_NAME_1 = 'Lookup_Column_Name_1';
const RELATIONSHIP_NAME_1 = 'relationship_1';

test('builds bounded metadata URLs for one table', () => {
  const urls = schema.buildMetadataUrls(
    ENVIRONMENT_URL_1,
    TABLE_LOGICAL_NAME_1
  );

  assert.ok(urls.attributes.includes(
    `EntityDefinitions(LogicalName='${TABLE_LOGICAL_NAME_1}')/Attributes`
  ));
  assert.match(urls.attributes, /%24select=/);
  assert.match(urls.attributes, /SchemaName/);
  assert.match(urls.manyToMany, /ManyToManyRelationships/);
});

test('resolves both logical names and entity sets', () => {
  const definitions = [{
    LogicalName: TABLE_LOGICAL_NAME_1,
    EntitySetName: TABLE_ENTITY_SET_NAME_1,
    PrimaryIdAttribute: TABLE_PRIMARY_ID_1,
  }];

  assert.deepEqual(
    schema.resolveRequestedTables(
      definitions,
      [TABLE_LOGICAL_NAME_1, TABLE_ENTITY_SET_NAME_1]
    ),
    definitions
  );
});

test('rejects project root as schema output', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webapi-schema-root-'));
  try {
    assert.throws(
      () => schema.validateOptions({
        environmentUrl: ENVIRONMENT_URL_1,
        projectRoot,
        output: projectRoot,
        tables: [TABLE_LOGICAL_NAME_1],
      }),
      /file inside the project root/
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('rejects output through an escaping junction', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webapi-schema-link-'));
  const projectRoot = path.join(workspace, 'project');
  const outside = path.join(workspace, 'outside');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, 'tables.txt'),
    `${TABLE_LOGICAL_NAME_1}\n`,
    'utf8'
  );

  try {
    fs.symlinkSync(
      outside,
      path.join(projectRoot, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => schema.validateOptions({
      environmentUrl: ENVIRONMENT_URL_1,
      projectRoot,
      output: path.join(projectRoot, 'linked', 'schema.json'),
      tables: [TABLE_LOGICAL_NAME_1],
    }),
    /inside the project root/
  );
  assert.throws(
    () => schema.validateOptions({
      environmentUrl: ENVIRONMENT_URL_1,
      projectRoot,
      output: path.join(projectRoot, 'schema.json'),
      tables: [],
      tablesFile: path.join(projectRoot, 'linked', 'tables.txt'),
    }),
    /Tables file must exist inside the project root/
  );
});

test('normalizes attributes and navigation metadata', () => {
  const normalized = schema.normalizeTableMetadata(
    {
      LogicalName: TABLE_LOGICAL_NAME_1,
      EntitySetName: TABLE_ENTITY_SET_NAME_1,
      PrimaryIdAttribute: TABLE_PRIMARY_ID_1,
    },
    [{
      LogicalName: LOOKUP_COLUMN_NAME_1,
      SchemaName: LOOKUP_SCHEMA_NAME_1,
      AttributeType: 'Lookup',
      IsValidForRead: true,
      IsValidForCreate: { Value: true },
      IsValidForUpdate: false,
    }],
    [{
      SchemaName: RELATIONSHIP_NAME_1,
      ReferencingEntity: TABLE_LOGICAL_NAME_1,
      ReferencedEntity: TABLE_LOGICAL_NAME_2,
      ReferencingAttribute: LOOKUP_COLUMN_NAME_1,
      ReferencingEntityNavigationPropertyName: LOOKUP_COLUMN_NAME_1,
      ReferencedEntityNavigationPropertyName: RELATIONSHIP_NAME_1,
    }],
    []
  );

  assert.deepEqual(
    normalized.lookupReadProperties,
    [`_${LOOKUP_COLUMN_NAME_1}_value`]
  );
  assert.deepEqual(normalized.navigationProperties, [{
    name: LOOKUP_COLUMN_NAME_1,
    targetLogicalName: TABLE_LOGICAL_NAME_2,
    lookupAttribute: LOOKUP_COLUMN_NAME_1,
    relationship: RELATIONSHIP_NAME_1,
  }]);
  assert.equal(normalized.attributes[0].isValidForCreate, true);
  assert.equal(normalized.attributes[0].schemaName, LOOKUP_SCHEMA_NAME_1);
});

test('queries only resolved requested tables', async () => {
  const calls = [];
  const getAll = async (url) => {
    calls.push(url);
    if (/EntityDefinitions\?/.test(url)) {
      return [{
        LogicalName: TABLE_LOGICAL_NAME_1,
        EntitySetName: TABLE_ENTITY_SET_NAME_1,
        PrimaryIdAttribute: TABLE_PRIMARY_ID_1,
      }, {
        LogicalName: TABLE_LOGICAL_NAME_2,
        EntitySetName: TABLE_ENTITY_SET_NAME_2,
        PrimaryIdAttribute: TABLE_PRIMARY_ID_2,
      }];
    }
    if (/\/Attributes\?/.test(url)) {
      return [{
        LogicalName: COLUMN_NAME_1,
        SchemaName: 'Column_Name_1',
        AttributeType: 'String',
        IsValidForRead: true,
        IsValidForCreate: true,
        IsValidForUpdate: true,
      }];
    }
    return [];
  };

  const result = await schema.queryTableSchemas(
    ENVIRONMENT_URL_1,
    [TABLE_ENTITY_SET_NAME_1],
    {
      getAuthToken: () => 'token',
      odataGetAll: getAll,
    }
  );

  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].logicalName, TABLE_LOGICAL_NAME_1);
  assert.equal(result.tables[0].attributes[0].schemaName, 'Column_Name_1');
  assert.equal(calls.filter(url => /\/Attributes\?/.test(url)).length, 1);
});

test('retries transient metadata throttling sequentially', async () => {
  let attempts = 0;
  const delays = [];
  const getAll = async (url) => {
    attempts += 1;
    if (attempts === 1) throw new Error('HTTP 429 throttled');
    if (/EntityDefinitions\?/.test(url)) {
      return [{
        LogicalName: TABLE_LOGICAL_NAME_1,
        EntitySetName: TABLE_ENTITY_SET_NAME_1,
        PrimaryIdAttribute: TABLE_PRIMARY_ID_1,
      }];
    }
    return [];
  };

  const result = await schema.queryTableSchemas(
    ENVIRONMENT_URL_1,
    [TABLE_LOGICAL_NAME_1],
    {
      getAuthToken: () => 'token',
      odataGetAll: getAll,
      sleep: async delay => delays.push(delay),
    }
  );

  assert.equal(result.tables.length, 1);
  assert.deepEqual(delays, [1000]);
});

test('query-table-schema answers --help before parsing arguments', () => {
  const scriptPath = require.resolve(
    '../../skills/migrate-webapi-selectall/scripts/query-table-schema'
  );
  const result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout);
});
