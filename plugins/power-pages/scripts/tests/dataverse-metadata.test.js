const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listTables,
  listTableColumns,
  listTableRelationships,
  listOptionsetValues,
  listLookupTargets,
  dataverseGet,
} = require('../lib/dataverse-metadata');

// makeStub captures the URL the helper requested so each test can both inject the
// expected response shape AND assert the helper hit the correct endpoint.
function makeStub(scriptedResponse) {
  const calls = [];
  const httpRequest = async ({ url, method, headers }) => {
    calls.push({ url, method, headers });
    const resp = typeof scriptedResponse === 'function' ? scriptedResponse(url) : scriptedResponse;
    return resp;
  };
  return { httpRequest, calls };
}

// dataverseGet ---------------------------------------------------------------

test('dataverseGet attaches OData annotation headers and a bearer token', async () => {
  const { httpRequest, calls } = makeStub({ statusCode: 200, body: JSON.stringify({ value: [] }) });
  await dataverseGet({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    apiPath: 'EntityDefinitions',
    httpRequest,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://org.crm.dynamics.com/api/data/v9.2/EntityDefinitions');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  // The annotation header is what lets callers read FormattedValue / next-link headers
  // without a second round trip; if we drop it the optionset label fallback in the
  // verify script will fall through to a less-friendly value.
  assert.match(calls[0].headers.Prefer, /odata\.include-annotations/);
});

test('dataverseGet strips a trailing slash from envUrl', async () => {
  const { httpRequest, calls } = makeStub({ statusCode: 200, body: '{"value":[]}' });
  await dataverseGet({
    envUrl: 'https://org.crm.dynamics.com////',
    token: 'tok',
    apiPath: 'EntityDefinitions',
    httpRequest,
  });
  assert.equal(calls[0].url, 'https://org.crm.dynamics.com/api/data/v9.2/EntityDefinitions');
});

test('dataverseGet maps HTTP 404 to a typed NOT_FOUND error', async () => {
  const { httpRequest } = makeStub({ statusCode: 404, body: '{}' });
  await assert.rejects(
    () =>
      dataverseGet({
        envUrl: 'https://org.crm.dynamics.com',
        token: 'tok',
        apiPath: 'EntityDefinitions(LogicalName=%27ghost%27)',
        httpRequest,
      }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('dataverseGet throws on non-200/404 status codes', async () => {
  const { httpRequest } = makeStub({ statusCode: 500, body: 'server exploded' });
  await assert.rejects(
    () =>
      dataverseGet({
        envUrl: 'https://org.crm.dynamics.com',
        token: 'tok',
        apiPath: 'EntityDefinitions',
        httpRequest,
      }),
    /Dataverse returned 500/,
  );
});

test('dataverseGet throws when the response body is not JSON', async () => {
  const { httpRequest } = makeStub({ statusCode: 200, body: 'not-json' });
  await assert.rejects(
    () =>
      dataverseGet({
        envUrl: 'https://org.crm.dynamics.com',
        token: 'tok',
        apiPath: 'EntityDefinitions',
        httpRequest,
      }),
    /unparseable JSON/,
  );
});

// listTables -----------------------------------------------------------------

test('listTables returns a normalized array of tables', async () => {
  const { httpRequest } = makeStub({
    statusCode: 200,
    body: JSON.stringify({
      value: [
        {
          LogicalName: 'faq_article',
          SchemaName: 'faq_Article',
          EntitySetName: 'faq_articles',
          IsCustomEntity: true,
        },
        {
          LogicalName: 'contact',
          SchemaName: 'Contact',
          EntitySetName: 'contacts',
          IsCustomEntity: false,
        },
      ],
    }),
  });
  const tables = await listTables({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    httpRequest,
  });
  assert.deepEqual(tables, [
    {
      logicalName: 'faq_article',
      schemaName: 'faq_Article',
      entitySetName: 'faq_articles',
      isCustom: true,
    },
    {
      logicalName: 'contact',
      schemaName: 'Contact',
      entitySetName: 'contacts',
      isCustom: false,
    },
  ]);
});

test('listTables tolerates an empty value array', async () => {
  const { httpRequest } = makeStub({ statusCode: 200, body: '{"value":[]}' });
  const tables = await listTables({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    httpRequest,
  });
  assert.deepEqual(tables, []);
});

// listTableColumns -----------------------------------------------------------

test('listTableColumns hits the per-table Attributes endpoint and normalizes the response', async () => {
  const { httpRequest, calls } = makeStub({
    statusCode: 200,
    body: JSON.stringify({
      value: [
        {
          LogicalName: 'faq_articleid',
          SchemaName: 'faq_articleid',
          AttributeType: 'Uniqueidentifier',
          IsCustomAttribute: true,
          IsValidForRead: true,
          IsValidForCreate: false,
          IsValidForUpdate: false,
          IsPrimaryId: true,
          IsLogical: false,
        },
        {
          LogicalName: 'faq_articlebody',
          SchemaName: 'faq_ArticleBody',
          AttributeType: 'Memo',
          IsCustomAttribute: true,
          IsValidForRead: true,
          IsValidForCreate: true,
          IsValidForUpdate: true,
          IsPrimaryId: false,
          IsLogical: false,
        },
        {
          LogicalName: 'createdon',
          SchemaName: 'CreatedOn',
          AttributeType: 'DateTime',
          IsCustomAttribute: false,
          IsValidForRead: true,
          IsValidForCreate: false,
          IsValidForUpdate: false,
          IsPrimaryId: false,
          IsLogical: false,
        },
      ],
    }),
  });
  const columns = await listTableColumns({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    httpRequest,
  });
  // The $select clause must include IsPrimaryId + IsLogical — the write-side code
  // generator depends on both flags to emit a correct <Table>Update shape.
  assert.match(calls[0].url, /EntityDefinitions\(LogicalName='faq_article'\)\/Attributes\?/);
  assert.match(calls[0].url, /IsPrimaryId/);
  assert.match(calls[0].url, /IsLogical/);
  assert.equal(columns.length, 3);
  // PK is flagged so /integrate-webapi can exclude it from $select on sensitive tables
  // AND from PATCH/POST bodies (write-validity flags are already false here).
  assert.equal(columns[0].logicalName, 'faq_articleid');
  assert.equal(columns[0].isPrimaryId, true);
  assert.equal(columns[0].writable, false);
  // Plain writable column carries the expected shape.
  assert.deepEqual(columns[1], {
    logicalName: 'faq_articlebody',
    schemaName: 'faq_ArticleBody',
    attributeType: 'Memo',
    isCustom: true,
    readable: true,
    creatable: true,
    writable: true,
    isPrimaryId: false,
    isLogical: false,
  });
  // System columns like createdon are read-only and not the PK.
  assert.equal(columns[2].logicalName, 'createdon');
  assert.equal(columns[2].writable, false);
  assert.equal(columns[2].isPrimaryId, false);
});

test('listTableColumns flags isLogical for computed (formula / rollup) columns so the write-side generator can skip them', async () => {
  // Computed columns return non-null on read but reject writes. /integrate-webapi
  // must exclude them from <Table>Update or PATCH bodies will 400.
  const { httpRequest } = makeStub({
    statusCode: 200,
    body: JSON.stringify({
      value: [
        {
          LogicalName: 'fullname',
          SchemaName: 'FullName',
          AttributeType: 'String',
          IsCustomAttribute: false,
          IsValidForRead: true,
          IsValidForCreate: false,
          IsValidForUpdate: false,
          IsPrimaryId: false,
          IsLogical: true,
        },
      ],
    }),
  });
  const columns = await listTableColumns({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'contact',
    httpRequest,
  });
  assert.equal(columns[0].isLogical, true);
  assert.equal(columns[0].writable, false);
});

test('listTableColumns rejects with the original error when the table is missing', async () => {
  const { httpRequest } = makeStub({ statusCode: 404, body: '{}' });
  await assert.rejects(
    () =>
      listTableColumns({
        envUrl: 'https://org.crm.dynamics.com',
        token: 'tok',
        table: 'no_such_table',
        httpRequest,
      }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('listTableColumns requires a table argument', async () => {
  await assert.rejects(
    () =>
      listTableColumns({
        envUrl: 'https://org.crm.dynamics.com',
        token: 'tok',
        httpRequest: () => ({}),
      }),
    /table is required/,
  );
});

// listTableRelationships -----------------------------------------------------

test('listTableRelationships merges OneToMany, ManyToOne, and ManyToMany endpoints', async () => {
  // Three sequential calls; route by URL so we can keep the stub small.
  const responseByUrl = (url) => {
    if (url.includes('/OneToManyRelationships')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            {
              SchemaName: 'faq_article_topic',
              ReferencedEntity: 'faq_topic',
              ReferencingEntity: 'faq_article',
              ReferencedAttribute: 'faq_topicid',
              ReferencingAttribute: 'faq_topic',
            },
          ],
        }),
      };
    }
    if (url.includes('/ManyToOneRelationships')) {
      return { statusCode: 200, body: '{"value":[]}' };
    }
    if (url.includes('/ManyToManyRelationships')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: [
            {
              SchemaName: 'faq_article_tags',
              Entity1LogicalName: 'faq_article',
              Entity2LogicalName: 'tag',
              IntersectEntityName: 'faq_article_tag',
            },
          ],
        }),
      };
    }
    return { statusCode: 500, body: 'unexpected' };
  };
  const { httpRequest, calls } = makeStub(responseByUrl);
  const rels = await listTableRelationships({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    httpRequest,
  });
  // Three sub-fetches — once per relationship kind. If any endpoint stops being called,
  // the migration will silently miss the relationship class it dropped, so this is asserted
  // explicitly.
  assert.equal(calls.length, 3);
  assert.equal(rels.oneToMany.length, 1);
  assert.equal(rels.oneToMany[0].schemaName, 'faq_article_topic');
  assert.equal(rels.manyToOne.length, 0);
  assert.equal(rels.manyToMany.length, 1);
  assert.equal(rels.manyToMany[0].intersectEntityName, 'faq_article_tag');
});

// listOptionsetValues --------------------------------------------------------

test('listOptionsetValues parses the OptionSet.Options expansion', async () => {
  const { httpRequest, calls } = makeStub({
    statusCode: 200,
    body: JSON.stringify({
      OptionSet: {
        Options: [
          {
            Value: 100000000,
            Label: { UserLocalizedLabel: { Label: 'Draft' } },
            Description: { UserLocalizedLabel: { Label: 'Article is being authored' } },
          },
          {
            Value: 100000001,
            Label: { UserLocalizedLabel: { Label: 'Published' } },
            Description: null,
          },
        ],
      },
    }),
  });
  const options = await listOptionsetValues({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    column: 'faq_publishedstatus',
    httpRequest,
  });
  assert.match(calls[0].url, /Microsoft\.Dynamics\.CRM\.PicklistAttributeMetadata/);
  assert.deepEqual(options, [
    { value: 100000000, label: 'Draft', description: 'Article is being authored' },
    { value: 100000001, label: 'Published', description: null },
  ]);
});

test('listOptionsetValues accepts a different castType for state/status/multi-select choice columns', async () => {
  const { httpRequest, calls } = makeStub({ statusCode: 200, body: '{"OptionSet":{"Options":[]}}' });
  await listOptionsetValues({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    column: 'statecode',
    castType: 'StateAttributeMetadata',
    httpRequest,
  });
  assert.match(calls[0].url, /Microsoft\.Dynamics\.CRM\.StateAttributeMetadata/);
});

test('listOptionsetValues falls back to a raw Label string when localized wrapper is missing', async () => {
  // Some self-hosted / custom-built Dataverse responses strip the localized wrapper.
  // The helper must not crash on the simpler shape.
  const { httpRequest } = makeStub({
    statusCode: 200,
    body: JSON.stringify({ OptionSet: { Options: [{ Value: 1, Label: 'Simple', Description: null }] } }),
  });
  const options = await listOptionsetValues({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    column: 'faq_status',
    httpRequest,
  });
  assert.deepEqual(options, [{ value: 1, label: 'Simple', description: null }]);
});

// listLookupTargets ----------------------------------------------------------

test('listLookupTargets returns the Targets array verbatim', async () => {
  const { httpRequest, calls } = makeStub({
    statusCode: 200,
    body: JSON.stringify({ LogicalName: 'faq_topic', Targets: ['faq_topic'] }),
  });
  const result = await listLookupTargets({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'faq_article',
    column: 'faq_topic',
    httpRequest,
  });
  assert.match(calls[0].url, /Microsoft\.Dynamics\.CRM\.LookupAttributeMetadata/);
  assert.deepEqual(result, { logicalName: 'faq_topic', targets: ['faq_topic'] });
});

test('listLookupTargets handles polymorphic lookups with multiple targets', async () => {
  // Customer / Owner / Regarding lookups can reference several entities. The verify
  // script needs all of them to know which lookups can land where.
  const { httpRequest } = makeStub({
    statusCode: 200,
    body: JSON.stringify({ LogicalName: 'regardingobjectid', Targets: ['account', 'contact', 'lead'] }),
  });
  const result = await listLookupTargets({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'task',
    column: 'regardingobjectid',
    httpRequest,
  });
  assert.deepEqual(result.targets, ['account', 'contact', 'lead']);
});

test('listLookupTargets returns an empty Targets array rather than null when Dataverse omits the field', async () => {
  const { httpRequest } = makeStub({ statusCode: 200, body: '{"LogicalName":"x"}' });
  const result = await listLookupTargets({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'tok',
    table: 'foo',
    column: 'x',
    httpRequest,
  });
  assert.deepEqual(result.targets, []);
});
