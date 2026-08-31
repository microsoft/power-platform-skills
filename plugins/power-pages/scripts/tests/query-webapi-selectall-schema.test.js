'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const schema = require(
  '../../skills/migrate-webapi-selectall/scripts/query-table-schema'
);

const SKILL_ROOT = path.join(
  __dirname,
  '../../skills/migrate-webapi-selectall'
);
const ASSETS_ROOT = path.join(SKILL_ROOT, 'assets');

const ENVIRONMENT_URL_1 = 'https://placeholder.crm.dynamics.com';
const TABLE_LOGICAL_NAME_1 = 'table_1';
const TABLE_ENTITY_SET_NAME_1 = 'table_1_set';
const TABLE_PRIMARY_ID_1 = 'column_name_1_id';
const TABLE_LOGICAL_NAME_2 = 'table_2';
const TABLE_ENTITY_SET_NAME_2 = 'table_2_set';
const TABLE_PRIMARY_ID_2 = 'column_name_2_id';
const COLUMN_NAME_1 = 'column_name_1';
const LOOKUP_COLUMN_NAME_1 = 'lookup_column_name_1';
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

test('rejects output through an escaping junction', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webapi-schema-link-'));
  const projectRoot = path.join(workspace, 'project');
  const outside = path.join(workspace, 'outside');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, 'tables.txt'),
    `${TABLE_LOGICAL_NAME_1}\n`,
    'utf8'
  );
  fs.symlinkSync(outside, path.join(projectRoot, 'linked'), 'junction');

  try {
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
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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

test('keeps the HTML report responsive and accessible', () => {
  const template = fs.readFileSync(
    path.join(ASSETS_ROOT, 'migration-report-template.html'),
    'utf8'
  );
  const requiredTokens = [
    'REPORT_STATUS',
    'GENERATED_AT',
    'WILDCARD_FOUND_COUNT',
    'WILDCARD_FIXED_COUNT',
    'WILDCARD_REMAINING_COUNT',
    'EXPLICIT_SETTING_COUNT',
    'SCOPE_NOTE',
    'WILDCARD_ROWS',
    'EXPLICIT_ROWS',
  ];

  assert.match(template, /class="skip-link"/);
  assert.match(template, /<main class="content" id="main-content"/);
  assert.equal(template.match(/class="table-region"/g)?.length, 2);
  assert.equal(
    template.match(/role="region"[^>]+aria-labelledby="[^"]+"[^>]+tabindex="0"/g)
      ?.length,
    2
  );
  assert.equal(template.match(/<caption/g)?.length, 2);
  assert.ok((template.match(/<th scope="col">/g)?.length ?? 0) > 5);
  assert.match(template, /@media \(max-width: 900px\)/);
  assert.match(template, /@media \(max-width: 560px\)/);
  assert.match(template, /@media \(max-width: 360px\)/);
  assert.match(template, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(template, /@media \(forced-colors: active\)/);
  assert.match(template, /@media print/);
  assert.match(template, /"Segoe UI Web \(West European\)"/);
  assert.match(template, /--accent: #0078d4/);
  assert.doesNotMatch(template, /<script\b/i);
  assert.doesNotMatch(template, /<link\b/i);
  assert.doesNotMatch(template, /https?:\/\//i);
  assert.doesNotMatch(template, /\{\{[A-Z_]+\}\}/);

  for (const token of requiredTokens) {
    const pattern = new RegExp(`__${token}__`, 'g');
    assert.equal(
      template.match(pattern)?.length,
      1,
      `${token} must occur exactly once`
    );
  }
});

test('bundles only the report template asset', () => {
  assert.deepEqual(fs.readdirSync(ASSETS_ROOT), [
    'migration-report-template.html',
  ]);
});

test('limits SPA review to authoritative editable source', () => {
  const sourceContract = [
    fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8'),
    fs.readFileSync(
      path.join(SKILL_ROOT, 'references', 'column-analysis.md'),
      'utf8'
    ),
  ].join('\n');

  assert.match(
    sourceContract,
    /Analyze only authoritative, editable source files/
  );
  assert.match(sourceContract, /compiledPath/);
  assert.match(sourceContract, /\.powerpages-site\/web-files\//);
  assert.match(sourceContract, /content-hashed assets/);
  assert.match(sourceContract, /missing-source/);
  assert.match(sourceContract, /Do not infer columns from that output/);
  assert.match(
    sourceContract,
    /Do not exclude an authored traditional\s+web\s+file/
  );
});

test('keeps only the report after the migration completes', () => {
  const skill = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');
  const reporting = fs.readFileSync(
    path.join(SKILL_ROOT, 'references', 'configuration-and-reporting.md'),
    'utf8'
  );

  assert.match(skill, /Leave only the HTML report in the migration output/);
  assert.match(skill, /Delete every working file created during the migration/);
  assert.match(skill, /table-identifiers-pass-<N>\.txt/);
  assert.match(skill, /table-schema\.pass-<N>\.json/);
  assert.match(skill, /Delete only files this migration created/);
  assert.match(
    reporting,
    /only `migration-report\.html` remains in the migration output/
  );
});
