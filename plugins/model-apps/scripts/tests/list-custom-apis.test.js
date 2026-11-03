'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const scriptPath = path.join(__dirname, '..', 'list-custom-apis.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

// --- Source-shape guards (cheap contract checks) ---------------------------

test('queries customapi with request parameters expanded inline (no OR-of-ids param query)', () => {
  assert.match(scriptSrc, /customapis\?\$select=customapiid,uniquename,name,displayname,isfunction,bindingtype,boundentitylogicalname/);
  // Parameters are pulled inline via $expand of the CustomAPIRequestParameters navigation property...
  assert.match(scriptSrc, /CustomAPIRequestParameters\(\$select=uniquename,type,isoptional,logicalentityname\)/);
  assert.match(scriptSrc, /CustomAPIResponseProperties\(\$select=type\)/);
  // ...NOT via a second query that ORs every matched API id into one $filter. That pattern overran the
  // server's URL-length limit (HTTP 414) in real environments with hundreds of Global Custom APIs.
  assert.doesNotMatch(scriptSrc, /_customapiid_value eq/);
});

// Custom API support has no feature flag any more: the script reads no gate, so nothing it does depends on GENPAGE_ENABLE_CUSTOM_API.
test('reads no feature gate: discovery is always available', () => {
  assert.doesNotMatch(scriptSrc, /feature-flags|exitIfCustomApiDisabled|isCustomApiEnabled/);
});

// --- Arg validation (spawned CLI) ---------------------------------------------

test('missing args exits 1 with usage, whatever GENPAGE_ENABLE_CUSTOM_API says', () => {
  for (const value of [undefined, '0', '1']) {
    const env = { ...process.env };
    delete env.GENPAGE_ENABLE_CUSTOM_API;
    if (value !== undefined) env.GENPAGE_ENABLE_CUSTOM_API = value;
    const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env });
    assert.equal(res.status, 1, String(value));
    assert.match(res.stderr, /Usage:/);
  }
});

// --- Unit tests for the pure helpers (require.main guard keeps main() from running) ---
const {
  bindingTypeLabel,
  mapParameterKind,
  buildCustomApiFilter,
  parameterKindsFromRows,
  toCustomApiEntry,
} = require(scriptPath);

test('mapParameterKind maps primitive request types and never declares structural kinds', () => {
  assert.equal(mapParameterKind(10), 'String');
  assert.equal(mapParameterKind(7), 'Integer');
  assert.equal(mapParameterKind(2), 'Decimal');
  assert.equal(mapParameterKind(12), 'Guid');
  assert.equal(mapParameterKind(11), 'StringArray');
  assert.equal(mapParameterKind(3), undefined);
  assert.equal(mapParameterKind(4), undefined);
  assert.equal(mapParameterKind(5), undefined);
  // Unknown/absent types are dropped (undefined), never guessed.
  assert.equal(mapParameterKind(999), undefined);
  assert.equal(mapParameterKind(undefined), undefined);
});

test('bindingTypeLabel maps the option set and defaults to Global', () => {
  assert.equal(bindingTypeLabel(0), 'Global');
  assert.equal(bindingTypeLabel(1), 'Entity');
  assert.equal(bindingTypeLabel(2), 'EntityCollection');
  assert.equal(bindingTypeLabel(undefined), 'Global');
});

test('buildCustomApiFilter includes Global plus the page tables, escaping quotes', () => {
  // No tables → Global only (bindingtype 0), NOT every entity-bound API.
  const none = buildCustomApiFilter([]);
  assert.match(none, /bindingtype eq 0/);
  assert.doesNotMatch(none, /bindingtype ne 0/);
  assert.doesNotMatch(none, /boundentitylogicalname/);

  const scoped = buildCustomApiFilter(['account', 'contact']);
  assert.match(scoped, /bindingtype eq 0/);
  assert.match(scoped, /boundentitylogicalname eq 'account'/);
  assert.match(scoped, /boundentitylogicalname eq 'contact'/);

  // A single quote in a table name is doubled per OData string-literal escaping.
  const escaped = buildCustomApiFilter(["o'brien"]);
  assert.match(escaped, /boundentitylogicalname eq 'o''brien'/);
});

// The kind and lookup maps are null-prototype objects (a defence, lib/own-keys.js — Dataverse requires a parameter's name to begin with a
// letter, so none is called `__proto__`), so the assertions below compare their entries: `{ ...map }`.
test('parameterKindsFromRows maps one API\'s expanded params and drops unknown types', () => {
  // Rows arrive inline via $expand — each element has uniquename + type, but no parent id.
  const kinds = parameterKindsFromRows([
    { uniquename: 'Comment', type: 10 },
    { uniquename: 'Amount', type: 2 },
    { uniquename: 'Mystery', type: 999 }, // unknown → dropped
    { uniquename: null, type: 10 },       // no name → dropped
  ]);
  assert.deepEqual({ ...kinds }, { Comment: 'String', Amount: 'Decimal' });
});

test('parameterKindsFromRows tolerates missing/empty input', () => {
  assert.deepEqual({ ...parameterKindsFromRows(undefined) }, {});
  assert.deepEqual({ ...parameterKindsFromRows([]) }, {});
});

test('lookup request parameters remain absent from the declared primitive kind map', () => {
  assert.deepEqual({ ...parameterKindsFromRows([
    { uniquename: 'Ref', type: 5 },
    { uniquename: 'Note', type: 10 },
  ]) }, { Note: 'String' });
});

test('every emitted declared kind belongs to the ten supported primitive kinds', () => {
  const rows = Array.from({ length: 13 }, (_, type) => ({ uniquename: `Parameter${type}`, type }));
  assert.deepEqual({ ...parameterKindsFromRows(rows) }, {
    Parameter0: 'Boolean',
    Parameter1: 'DateTime',
    Parameter2: 'Decimal',
    Parameter6: 'Float',
    Parameter7: 'Integer',
    Parameter8: 'Money',
    Parameter9: 'Picklist',
    Parameter10: 'String',
    Parameter11: 'StringArray',
    Parameter12: 'Guid',
  });
});

test('toCustomApiEntry omits boundEntityLogicalName for a Global API', () => {
  const entry = toCustomApiEntry(
    { uniquename: 'new_NoOp', isfunction: false, bindingtype: 0 },
    {}
  );
  assert.equal(entry.name, 'new_NoOp');
  assert.equal(entry.displayName, 'new_NoOp'); // falls back to uniquename
  assert.equal(entry.isFunction, false);
  assert.equal(entry.bindingType, 'Global');
  assert.deepEqual(entry.parameterKinds, {});
  assert.equal('boundEntityLogicalName' in entry, false);
});

test('toCustomApiEntry sets boundEntityLogicalName for an entity-bound Function and coerces isFunction', () => {
  const entry = toCustomApiEntry(
    { uniquename: 'new_GetOrderSummary', displayname: 'Get Order Summary', isfunction: true, bindingtype: 1, boundentitylogicalname: 'salesorder' },
    { OrderId: 'Guid' }
  );
  assert.equal(entry.isFunction, true);
  assert.equal(entry.bindingType, 'Entity');
  assert.equal(entry.boundEntityLogicalName, 'salesorder');
  assert.equal(entry.displayName, 'Get Order Summary');
  assert.deepEqual(entry.parameterKinds, { OrderId: 'Guid' });
});

test('toCustomApiEntry retains lookup names, optionalness and table hints outside parameterKinds', () => {
  const rows = [
    { uniquename: 'Ref', type: 5, isoptional: false, logicalentityname: 'account' },
    { uniquename: 'Fallback', type: 5, isoptional: true, logicalentityname: null },
    { uniquename: 'Note', type: 10, isoptional: true, logicalentityname: null },
  ];
  const entry = toCustomApiEntry({
    uniquename: 'new_ResolveReference',
    bindingtype: 0,
    CustomAPIRequestParameters: rows,
  }, parameterKindsFromRows(rows));
  assert.deepEqual({ ...entry.lookupParameters }, {
    Ref: { isOptional: false, logicalEntityName: 'account' },
    Fallback: { isOptional: true },
  });
  assert.deepEqual({ ...entry.parameterKinds }, { Note: 'String' });
});

// The child runs the real CLI, argument parser, feature gate and Dataverse request implementation.
// Only token acquisition and HTTP transport are replaced; the fake projects exactly the selected
// fields so an unrequested lookup hint or response expansion cannot accidentally pass.
const PRELOAD = path.join(__dirname, 'helpers', 'fake-custom-api-preload.js');
const ENV = 'https://contoso.crm.dynamics.com';
const PRIMITIVE_KINDS = new Set([
  'Boolean', 'DateTime', 'Decimal', 'Float', 'Integer',
  'Money', 'Picklist', 'String', 'StringArray', 'Guid',
]);

function api(name, overrides = {}) {
  return {
    customapiid: '11111111-1111-4111-8111-111111111111',
    uniquename: name,
    name,
    displayname: name,
    isfunction: false,
    bindingtype: 0,
    boundentitylogicalname: null,
    isprivate: false,
    CustomAPIRequestParameters: [],
    CustomAPIResponseProperties: [],
    ...overrides,
  };
}

// `enabled` is the value GENPAGE_ENABLE_CUSTOM_API carries into the child (null: unset). The variable no longer means anything.
function discover({ apis, entities, enabled = null, refuse, unreadable, responseBody } = {}) {
  const dir = makeTempDir('custom-api-discovery-');
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  fs.writeFileSync(fixturePath, JSON.stringify({ apis: apis || [], refuse, unreadable, responseBody }));
  const env = {
    ...process.env,
    FAKE_CUSTOM_API_FIXTURE: fixturePath,
    FAKE_CUSTOM_API_LOG: logPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1',
    POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1',
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1',
  };
  if (enabled === null) delete env.GENPAGE_ENABLE_CUSTOM_API;
  else env.GENPAGE_ENABLE_CUSTOM_API = enabled;
  const argv = ['--require', PRELOAD, scriptPath, ENV];
  if (entities) argv.push('--entities', entities);
  const result = spawnSync(process.execPath, argv, { cwd: dir, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'discovery must exit normally');
  const requests = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  return { ...result, requests, output: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

test('discovery selects privacy, lookup hints and response types in one bounded inline query', () => {
  const result = discover({ apis: [api('new_Primitive')], entities: 'account,contact' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 1, 'no per-API request-parameter queries');
  const query = new URL(result.requests[0].url).searchParams;
  assert.ok(query.get('$select').split(',').includes('isprivate'), 'privacy is part of discovery metadata');
  assert.equal(query.get('$filter'),
    "isprivate eq false and (bindingtype eq 0 or (boundentitylogicalname eq 'account' or boundentitylogicalname eq 'contact'))");
  assert.equal(query.get('$expand'),
    'CustomAPIRequestParameters($select=uniquename,type,isoptional,logicalentityname),CustomAPIResponseProperties($select=type)');
});

test('discovery excludes private, complex request/response and collection-bound APIs', () => {
  const result = discover({
    entities: 'account',
    apis: [
      api('new_ZPrimitive', { CustomAPIRequestParameters: [{ uniquename: 'Amount', type: 2, isoptional: false }] }),
      api('new_PrivateGlobal', { isprivate: true }),
      api('new_PrivateBound', { isprivate: true, bindingtype: 1, boundentitylogicalname: 'account' }),
      ...[3, 4].map((type) => api(`new_ComplexInput${type}`, {
        CustomAPIRequestParameters: [{ uniquename: 'Payload', type, isoptional: false }],
      })),
      ...[3, 4].map((type) => api(`new_ComplexOutput${type}`, { CustomAPIResponseProperties: [{ type }] })),
      api('new_Collection', { bindingtype: 2, boundentitylogicalname: 'account' }),
      api('new_Unrelated', { bindingtype: 1, boundentitylogicalname: 'contact' }),
      api('new_ABoundFunction', {
        isfunction: true,
        bindingtype: 1,
        boundentitylogicalname: 'account',
        CustomAPIRequestParameters: [{ uniquename: 'RecordId', type: 12, isoptional: false }],
        CustomAPIResponseProperties: [{ type: 10 }],
      }),
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output.customApis.map((entry) => entry.name), ['new_ABoundFunction', 'new_ZPrimitive']);
  assert.deepEqual(result.output.customApis[0], {
    name: 'new_ABoundFunction',
    displayName: 'new_ABoundFunction',
    isFunction: true,
    bindingType: 'Entity',
    boundEntityLogicalName: 'account',
    parameterKinds: { RecordId: 'Guid' },
  });
  assert.deepEqual(result.output.customApis[1].parameterKinds, { Amount: 'Decimal' });
});

test('lookup discovery retains the callable input name without emitting an unsupported kind', () => {
  const result = discover({
    apis: [api('new_ResolveReference', {
      CustomAPIRequestParameters: [
        { uniquename: 'Ref', type: 5, isoptional: false, logicalentityname: 'account' },
        { uniquename: 'OptionalRef', type: 5, isoptional: true, logicalentityname: null },
        { uniquename: 'Note', type: 10, isoptional: true, logicalentityname: null },
      ],
      CustomAPIResponseProperties: [{ type: 5 }],
    })],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.customApis.length, 1, 'lookup parameters and outputs remain eligible');
  const [entry] = result.output.customApis;
  assert.deepEqual(entry.lookupParameters, {
    Ref: { isOptional: false, logicalEntityName: 'account' },
    OptionalRef: { isOptional: true },
  });
  assert.deepEqual(entry.parameterKinds, { Note: 'String' });
  assert.ok(Object.values(entry.parameterKinds).every((kind) => PRIMITIVE_KINDS.has(kind)));
});

// GENPAGE_ENABLE_CUSTOM_API was the opt-out of the removed custom-api flag. It is ignored now: set to 0, set to 1 or unset, discovery sends the
// same one request and lists the same APIs (it once exited 3 with no request when the variable was 0).
test('GENPAGE_ENABLE_CUSTOM_API is ignored: 0, 1 and unset list exactly the same, with the same request', () => {
  const input = { apis: [api('new_Primitive'), api('new_Bound', { bindingtype: 1, boundentitylogicalname: 'account' })], entities: 'account' };
  const unset = discover(input);
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(unset.output.customApis.length, 2);
  for (const enabled of ['0', '1', 'false']) {
    const result = discover({ ...input, enabled });
    assert.equal(result.status, 0, `${enabled}: ${result.stderr}`);
    assert.equal(result.stdout, unset.stdout, enabled);
    assert.equal(result.stderr, unset.stderr, enabled);
    assert.deepEqual(result.requests, unset.requests, enabled);
  }
});

test('global-only discovery stays bounded, sorted and independent of the number of matching APIs', () => {
  const result = discover({
    apis: [
      ...Array.from({ length: 1000 }, (_, index) => api(`new_Global${String(999 - index).padStart(4, '0')}`)),
      api('new_BoundControl', { bindingtype: 1, boundentitylogicalname: 'account' }),
      api('new_CollectionControl', { bindingtype: 2, boundentitylogicalname: 'account' }),
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.customApis.length, 1000);
  assert.equal(result.output.customApis[0].name, 'new_Global0000');
  assert.equal(result.output.customApis.at(-1).name, 'new_Global0999');
  assert.equal(result.requests.length, 1);
  const query = new URL(result.requests[0].url).searchParams;
  assert.equal(query.get('$filter'), 'isprivate eq false and (bindingtype eq 0)');
  assert.doesNotMatch(result.requests[0].url, /_customapiid_value/);
  assert.ok(result.requests[0].url.length < 1000, 'the query never grows with matched API IDs');
});

test('a refused metadata read is reported as failure rather than a successful empty discovery', () => {
  const result = discover({ refuse: { status: 403, message: 'Custom API metadata read refused' } });
  assert.equal(result.status, 1);
  assert.equal(result.output, null);
  assert.match(result.stderr, /Custom API metadata read refused/);
  assert.equal(result.requests.length, 1);
});

test('unreadable required request or response metadata never becomes a callable binding', () => {
  for (const unreadable of [
    { navigation: 'CustomAPIRequestParameters', missing: true },
    { navigation: 'CustomAPIResponseProperties', missing: true },
    { navigation: 'CustomAPIResponseProperties', value: null },
  ]) {
    const result = discover({ apis: [api('new_Unreadable')], unreadable });
    assert.equal(result.status, 1, `${JSON.stringify(unreadable)} must not be treated as empty metadata`);
    assert.equal(result.output, null);
    assert.match(result.stderr, /metadata|CustomAPIRequestParameters|CustomAPIResponseProperties/i);
  }
});

test('unreadable top-level API metadata is not reported as a successful empty list', () => {
  const result = discover({ responseBody: {} });
  assert.equal(result.status, 1, 'an absent value array is an unreadable answer, not zero APIs');
  assert.equal(result.output, null);
  assert.match(result.stderr, /metadata/i);
});

test('request and response rows with unreadable types are refused before binding projection', () => {
  for (const navigation of ['CustomAPIRequestParameters', 'CustomAPIResponseProperties']) {
    const result = discover({ apis: [api('new_UnreadableType', {
      [navigation]: [{ uniquename: 'Ref', isoptional: false }],
    })] });
    assert.equal(result.status, 1, `${navigation} must supply readable type metadata`);
    assert.equal(result.output, null);
    assert.match(result.stderr, /metadata|type/i);
  }
});

test('selected API privacy metadata must be readable rather than silently treated as public', () => {
  const result = discover({
    apis: [api('new_UnreadablePrivacy')],
    unreadable: { navigation: 'isprivate', missing: true },
  });
  assert.equal(result.status, 1);
  assert.equal(result.output, null);
  assert.match(result.stderr, /metadata|private/i);
});

test('Custom API guidance separates structural lookup authoring from the ten declared wire kinds', () => {
  const plugin = path.join(__dirname, '..', '..');
  const builder = fs.readFileSync(path.join(plugin, 'agents', 'genpage-customapi-builder.md'), 'utf8');
  const reference = fs.readFileSync(path.join(plugin, 'references', 'custom-api.md'), 'utf8');
  assert.match(builder, /lookupParameters/);
  assert.match(builder, /discovery-only/);
  assert.match(builder, /never copy[\s\S]{0,120}lookupParameters[\s\S]{0,120}actions\.json/i);
  const pageBuilder = fs.readFileSync(path.join(plugin, 'agents', 'genpage-page-builder.md'), 'utf8');
  assert.match(pageBuilder, /lookup-input notes/i);
  assert.match(reference, /\{\s*entityName,\s*id\s*\}/);
  const kinds = /Values are `DataverseParameterKind`\s+strings:([\s\S]*?)\./.exec(reference);
  assert.ok(kinds, 'the declared wire kind list must be explicit');
  assert.deepEqual([...kinds[1].matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]).sort(), [...PRIMITIVE_KINDS].sort());
});

test('automatic Function invocation requires known read semantics rather than GET alone', () => {
  const plugin = path.join(__dirname, '..', '..');
  for (const relative of [
    ['agents', 'genpage-customapi-builder.md'],
    ['references', 'custom-api.md'],
    ['agents', 'genpage-page-builder.md'],
    ['references', 'rules.md'],
  ]) {
    const doc = fs.readFileSync(path.join(plugin, ...relative), 'utf8');
    assert.match(doc, /known read semantics/i);
    assert.doesNotMatch(doc, /Functions are read-only[\s\S]{0,80}safe to call on mount/i);
  }
});

test('incomplete API or expanded type metadata is reported rather than treated as complete discovery', () => {
  const root = discover({ responseBody: {
    value: [],
    '@odata.nextLink': 'https://contoso.crm.dynamics.com/api/data/v9.2/customapis?$skiptoken=next',
  } });
  assert.equal(root.status, 1, 'a continuation is not a complete API inventory');
  assert.match(root.stderr, /metadata|incomplete/i);
  for (const navigation of ['CustomAPIRequestParameters', 'CustomAPIResponseProperties']) {
    const result = discover({
      apis: [api('new_IncompleteMetadata')],
      unreadable: { navigation: `${navigation}@odata.nextLink`, value: 'https://contoso.crm.dynamics.com/api/data/v9.2/customapis?$skiptoken=next' },
    });
    assert.equal(result.status, 1, `${navigation} cannot prove eligibility while incomplete`);
    assert.match(result.stderr, /metadata|incomplete/i);
  }
});

// A single-level collection expansion has an ordinary relationship link even when all related rows
// are present. It is not a second page. The documented 5,000-related-row ceiling is a separate
// completeness boundary, so the absence of a paging token alone must not authorize a capped result.
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/join-tables#single-expand-on-collection-valued-navigation-properties
function singleLevelExpansionLinks(entry) {
  const related = `${ENV}/api/data/v9.2/customapis(${entry.customapiid})`;
  return {
    ...entry,
    'CustomAPIRequestParameters@odata.nextLink':
      `${related}/CustomAPIRequestParameters?$select=uniquename,type,isoptional,logicalentityname`,
    'CustomAPIResponseProperties@odata.nextLink':
      `${related}/CustomAPIResponseProperties?$select=type`,
  };
}

test('single-level relationship links preserve complete primitive and lookup discovery in one GET', async (t) => {
  for (const [label, row, expectedKinds, expectedLookups] of [
    ['primitive', api('new_LinkedPrimitive', {
      CustomAPIRequestParameters: [{ uniquename: 'Amount', type: 2, isoptional: false }],
      CustomAPIResponseProperties: [{ type: 10 }],
    }), { Amount: 'Decimal' }, undefined],
    ['lookup and empty response', api('new_LinkedLookup', {
      CustomAPIRequestParameters: [
        { uniquename: 'Ref', type: 5, isoptional: false, logicalentityname: 'account' },
        { uniquename: 'Note', type: 10, isoptional: true },
      ],
    }), { Note: 'String' }, { Ref: { isOptional: false, logicalEntityName: 'account' } }],
  ]) {
    await t.test(`single-level complete links: ${label}`, () => {
      const result = discover({ responseBody: { value: [singleLevelExpansionLinks(row)] } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.customApis.length, 1);
      assert.equal(result.output.customApis[0].name, row.uniquename);
      assert.deepEqual(result.output.customApis[0].parameterKinds, expectedKinds);
      assert.deepEqual(result.output.customApis[0].lookupParameters, expectedLookups);
      assert.equal(result.requests.length, 1, 'ordinary relationship links must not be followed');
      assert.equal(result.requests[0].method, 'GET');
      assert.equal(result.requests[0].body, null);
    });
  }
});

test('single-level expansion completeness distinguishes below-limit rows from the ambiguous ceiling', async (t) => {
  for (const navigation of ['CustomAPIRequestParameters', 'CustomAPIResponseProperties']) {
    for (const count of [4999, 5000]) {
      await t.test(`single-level ${navigation} with ${count} rows`, () => {
        const rows = Array.from({ length: count }, (_, index) => navigation === 'CustomAPIRequestParameters'
          ? { uniquename: `Input${index}`, type: 10, isoptional: false }
          : { type: 10 });
        const row = singleLevelExpansionLinks(api('new_ExpansionLimit', { [navigation]: rows }));
        const result = discover({ responseBody: { value: [row] } });
        assert.equal(result.status, count < 5000 ? 0 : 1,
          `${navigation} at the documented ceiling cannot prove that no rows were omitted`);
        assert.equal(result.requests.length, 1);
        if (count < 5000) assert.equal(result.output.customApis.length, 1);
        else {
          assert.equal(result.output, null);
          assert.match(result.stderr, /metadata|incomplete|limit|ambiguous/i);
        }
      });
    }
    await t.test(`single-level ${navigation} at the ceiling without a link`, () => {
      const rows = Array.from({ length: 5000 }, (_, index) => navigation === 'CustomAPIRequestParameters'
        ? { uniquename: `Input${index}`, type: 10, isoptional: false }
        : { type: 10 });
      const result = discover({ responseBody: { value: [api('new_UnannotatedLimit', { [navigation]: rows })] } });
      assert.equal(result.status, 1, 'missing annotations do not prove an expanded collection below its cap');
      assert.equal(result.output, null);
      assert.equal(result.requests.length, 1);
    });
  }
});

test('single-level links with genuine paging or ambiguous scope fail without following any URL', async (t) => {
  const row = singleLevelExpansionLinks(api('new_UncertainExpansion'));
  for (const navigation of ['CustomAPIRequestParameters', 'CustomAPIResponseProperties']) {
    const property = `${navigation}@odata.nextLink`;
    const normal = row[property];
    for (const [label, link] of [
      ['paging token', `${normal}&$skiptoken=next`],
      ['encoded paging option', `${normal}&%24skiptoken=next`],
      ['limited related query', `${normal}&$top=1`],
      ['wrong relationship', normal.replace(`/${navigation}?`, '/UnrelatedCollection?')],
      ['different origin', normal.replace(ENV, 'https://example.org')],
      ['unreadable annotation', null],
    ]) {
      await t.test(`single-level ${navigation}: ${label}`, () => {
        const result = discover({ responseBody: { value: [{ ...row, [property]: link }] } });
        assert.equal(result.status, 1);
        assert.equal(result.output, null);
        assert.match(result.stderr, /metadata|incomplete|unsupported|ambiguous/i);
        assert.equal(result.requests.length, 1, 'no continuation or arbitrary relationship URL is followed');
      });
    }
  }
});

test('malformed lookup names requiredness and supplied hints fail the whole discovery explicitly', async (t) => {
  const valid = { uniquename: 'Ref', type: 5, isoptional: false, logicalentityname: 'account' };
  for (const [label, rows, reason] of [
    ['missing name', [{ ...valid, uniquename: undefined }], /unique.?name|input name|parameter name/i],
    ['empty name', [{ ...valid, uniquename: '' }], /unique.?name|input name|parameter name/i],
    ['blank name', [{ ...valid, uniquename: '   ' }], /unique.?name|input name|parameter name/i],
    ['non-string name', [{ ...valid, uniquename: 7 }], /unique.?name|input name|parameter name/i],
    ['prototype-setter name', [{ ...valid, uniquename: '__proto__' }], /unique.?name|input name|parameter name/i],
    ['duplicate lookup name', [valid, { ...valid, isoptional: true }], /duplicate|unique.*name|name.*unique/i],
    ['lookup and primitive name collision', [valid, { uniquename: 'Ref', type: 10, isoptional: false }], /duplicate|unique.*name|name.*unique/i],
    ['missing requiredness', [{ ...valid, isoptional: undefined }], /isoptional|optional|requiredness/i],
    ['null requiredness', [{ ...valid, isoptional: null }], /isoptional|optional|requiredness/i],
    ['string requiredness', [{ ...valid, isoptional: 'false' }], /isoptional|optional|requiredness/i],
    ['numeric requiredness', [{ ...valid, isoptional: 0 }], /isoptional|optional|requiredness/i],
    ['object table hint', [{ ...valid, logicalentityname: { entityName: 'account' } }], /logicalentityname|table hint|logical entity/i],
    ['numeric table hint', [{ ...valid, logicalentityname: 7 }], /logicalentityname|table hint|logical entity/i],
    ['array table hint', [{ ...valid, logicalentityname: ['account'] }], /logicalentityname|table hint|logical entity/i],
    ['blank table hint', [{ ...valid, logicalentityname: '   ' }], /logicalentityname|table hint|logical entity/i],
  ]) {
    await t.test(`malformed lookup metadata: ${label}`, () => {
      const result = discover({ apis: [
        api('new_PrimitiveControl'),
        api('new_MetadataLookup', { CustomAPIRequestParameters: rows }),
      ] });
      assert.equal(result.status, 1, `${label} must not produce a successful partial binding`);
      assert.equal(result.output, null);
      assert.match(result.stderr, /new_MetadataLookup/);
      assert.match(result.stderr, reason);
      assert.equal(result.requests.length, 1);
    });
  }
});

test('lookup metadata keeps real boolean requiredness and legitimate absent or null hints', async (t) => {
  for (const isoptional of [false, true]) {
    for (const logicalentityname of [undefined, null]) {
      await t.test(`lookup metadata keeps optional=${isoptional}, hint=${String(logicalentityname)}`, () => {
        const result = discover({ apis: [api('new_UnrestrictedLookup', {
          CustomAPIRequestParameters: [{ uniquename: 'Ref', type: 5, isoptional, logicalentityname }],
        })] });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.output.customApis[0].lookupParameters, { Ref: { isOptional: isoptional } });
        assert.deepEqual(result.output.customApis[0].parameterKinds, {});
        assert.equal(result.requests.length, 1);
      });
    }
  }
});
