'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readColumnOptions, columnOptionFields, primaryColumnOptionFields } = require('../lib/download-column-options.js');
const { readStatusOptions, statusReasonsFromOptions, alternateKeysFromMetadata, alternateKeyMatches } = require('../lib/table-schema-metadata.js');
const { iconWebResources, labelFromDataverse, entityFromMetadata } = require('../download-model-app.js');
const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');

const label = (text, lcid = 1033) => ({ LocalizedLabels: [{ Label: text, LanguageCode: lcid }] });
const attr = (name, type, extra = {}) => ({ logicalName: name, attributeType: type, isCustomAttribute: true, ...extra });

test('a primary AutoNumber keeps both its independently authored length and its number mask', () => {
  assert.deepEqual(primaryColumnOptionFields({
    MaxLength: 120, FormatName: { Value: 'Text' }, AutoNumberFormat: 'I-{SEQNUM:6}',
  }), { maxLength: 120, autoNumberFormat: 'I-{SEQNUM:6}' });
});

test('typed detail reads scale by declared type, not by columns, and ignore synthetic and system attributes', async () => {
  const calls = [];
  const attrs = [
    attr('contoso_a', 'String'), attr('contoso_b', 'String'),
    attr('contoso_shadow', 'Integer', { AttributeOf: 'contoso_parent' }),
    attr('createdon', 'DateTime', { isCustomAttribute: false }),
    attr('contoso_logical', 'Memo', { IsLogical: true }),
  ];
  const got = await readColumnOptions({ dataverse: { get: async (url) => {
    calls.push(url);
    return { status: 200, body: { value: ['contoso_a', 'contoso_b'].map((LogicalName) => ({
      LogicalName, MaxLength: 100, FormatName: { Value: 'Text' }, AutoNumberFormat: null,
    })) } };
  } } }, "contoso_o'brien", attrs, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /LogicalName='contoso_o''brien'/);
  assert.match(calls[0], /StringAttributeMetadata/);
  assert.equal(got.rows.size, 2);
  assert.deepEqual(got.failures, []);
});

test('an absent row and a malformed selected property are named, never represented as known defaults', async () => {
  const sdk = { dataverse: { get: async () => ({ status: 200, body: { value: [
    { LogicalName: 'contoso_a', MaxLength: '160', FormatName: { Value: 'Email' }, AutoNumberFormat: null },
  ] } }) } };
  const got = await readColumnOptions(sdk, 'contoso_item', [attr('contoso_a', 'String'), attr('contoso_b', 'String')], 2);
  assert.ok(got.failures.some((f) => /contoso_a.*maxLength/i.test(f)), JSON.stringify(got.failures));
  assert.ok(got.failures.some((f) => /contoso_b.*missing/i.test(f)));
  assert.deepEqual(columnOptionFields(got.rows.get('contoso_a'), 'Text'), { format: 'Email' });
});

test('a missing selected property and an unsupported Whole Number format are reported without making the spec invalid', async () => {
  const sdk = { dataverse: { get: async () => ({ status: 200, body: { value: [
    { LogicalName: 'contoso_count', MinValue: 0, Format: 'NotAnSdkFormat' },
  ] } }) } };
  const got = await readColumnOptions(sdk, 'contoso_item', [attr('contoso_count', 'Integer')], 2);
  assert.ok(got.failures.some((f) => /maxValue/.test(f)), JSON.stringify(got.failures));
  assert.ok(got.failures.some((f) => /integerFormat/.test(f)), JSON.stringify(got.failures));
  assert.deepEqual(columnOptionFields(got.rows.get('contoso_count'), 'Integer'), { minValue: 0 });
});

test('fractional precision and a non-array Boolean projection cannot invent options or abort a download', () => {
  assert.deepEqual(columnOptionFields({ MinValue: 0, MaxValue: 500, Precision: 0.25 }, 'Decimal'), { minValue: 0, maxValue: 500 });
  assert.deepEqual(columnOptionFields({ choices: {} }, 'Boolean'), {});
});

test('currency-controlled Money keeps numeric precision metadata, including zero, and canonical defaults', () => {
  for (const precision of [0, 2, 3]) {
    const omitted = [];
    assert.deepEqual(columnOptionFields({ MinValue: 0, MaxValue: 1e9, Precision: precision, PrecisionSource: 2 }, 'Money', omitted),
      precision === 2 ? {} : { precision });
    assert.deepEqual(omitted, []);
  }
});

test('missing Money detail and incomplete Boolean labels are reported even though neither needs a new cast', async () => {
  const got = await readColumnOptions({ dataverse: { get: async () => { throw new Error('must not query'); } } }, 'contoso_item', [
    attr('contoso_cost', 'Money'),
    attr('contoso_cost_base', 'Money', { IsBaseCurrency: true }),
    attr('contoso_flag', 'Boolean', { choices: [{ value: 1, label: 'Chargeable' }] }),
  ], 2);
  assert.ok(got.failures.some((f) => /Money contoso_cost/.test(f)), JSON.stringify(got.failures));
  assert.ok(got.failures.some((f) => /Boolean contoso_flag.*falseLabel/.test(f)), JSON.stringify(got.failures));
  assert.ok(got.failures.every((f) => !f.includes('contoso_cost_base')));
});

for (const [name, answer] of [
  ['HTTP failure', async () => ({ status: 403, body: {} })],
  ['transport failure', async () => { throw new Error('connection closed'); }],
  ['malformed collection', async () => ({ status: 200, body: { value: {} } })],
]) {
  test(`a column ${name} is unknown, not an empty successful snapshot`, async () => {
    const got = await readColumnOptions({ dataverse: { get: answer } }, 'contoso_item', [attr('contoso_text', 'String')], 2);
    assert.equal(got.rows.size, 0);
    assert.equal(got.failures.length, 1);
    assert.match(got.failures[0], /^Text:/);
  });
}

for (const [name, body] of [
  ['missing statuscode', { value: [] }],
  ['missing options', { value: [{ LogicalName: 'statuscode', OptionSet: {} }] }],
  ['malformed options', { value: [{ LogicalName: 'statuscode', OptionSet: { Options: {} } }] }],
]) {
  test(`status reasons with ${name} are unknown, not proof of absence`, async () => {
    const got = await readStatusOptions({ get: async () => ({ status: 200, body }) }, 'contoso_item');
    assert.equal(got.options, undefined);
    assert.match(got.failed, /no statuscode options/);
  });
}

test('status hydration excludes stock and managed reasons, keeps explicit values and reports unexpressible states', () => {
  const omitted = [];
  const got = statusReasonsFromOptions([
    { Value: 1, State: 0, Label: label('Active') },
    { Value: 2, State: 1, Label: label('Inactive') },
    { Value: 100000000, State: 0, Label: label('Review') },
    { Value: 100000042, State: 1, Label: label('Archived'), Color: '#336699' },
    { Value: 100000010, State: 0, Label: label('From a managed solution'), IsManaged: true },
    { Value: 100000011, State: 3, Label: label('Cannot express this state') },
  ], { omitted, languageCode: 1033 });
  assert.deepEqual(got, [
    { label: 'Review', state: 'Active' },
    { label: 'Archived', state: 'Inactive', value: 100000042, color: '#336699' },
  ]);
  assert.equal(omitted.length, 1);
  assert.match(omitted[0], /100000011.*state/);
  assert.deepEqual(statusReasonsFromOptions([{ Value: 5, State: 0, Label: label('A stock reason') }], { customTable: false }), []);
});

test('status hydration with an unresolved language or user-only label cannot claim authoring-language fidelity', () => {
  for (const [languageCode, Label, expected] of [
    [undefined, label('Review'), /\(unresolved\)/],
    [1033, { UserLocalizedLabel: { Label: 'Review', LanguageCode: 1033 } }, /1033/],
  ]) {
    const omitted = [];
    assert.deepEqual(statusReasonsFromOptions([{ Value: 100000042, State: 0, Label }], { languageCode, omitted }), []);
    assert.equal(omitted.length, 1);
    assert.match(omitted[0], expected);
  }
});

test('non-array alternate-key collections recover no keys without throwing or reading a label', () => {
  for (const keys of [{}, 7, null, undefined, 'not an array']) {
    assert.deepEqual(alternateKeysFromMetadata(keys, () => assert.fail('no key label is read')), []);
  }
});

test('alternate keys keep all read languages, exclude managed keys and name malformed ones', () => {
  const omitted = [];
  const got = alternateKeysFromMetadata([
    { SchemaName: 'contoso_email', KeyAttributes: ['contoso_email'], DisplayName: { LocalizedLabels: [
      { Label: 'Email', LanguageCode: 1033 }, { Label: 'Courriel', LanguageCode: 1036 },
    ] } },
    { SchemaName: 'contoso_managed', KeyAttributes: ['contoso_name'], IsManaged: true },
    { SchemaName: 'contoso_broken', KeyAttributes: [] },
  ], labelFromDataverse, omitted);
  assert.deepEqual(got, [{ schemaName: 'contoso_email', displayName: { 1033: 'Email', 1036: 'Courriel' }, columns: ['contoso_email'] }]);
  assert.equal(omitted.length, 1);
  assert.match(omitted[0], /contoso_broken/);
});

test('an alternate key with only a UserLocalizedLabel keeps its deployed display name', () => {
  const entity = entityFromMetadata({
    schemaName: 'contoso_item', attributes: [],
    Keys: [{
      SchemaName: 'contoso_email', KeyAttributes: ['contoso_email'],
      DisplayName: { UserLocalizedLabel: { Label: 'Email', LanguageCode: 1033 } },
    }],
  }, 'contoso_item');
  assert.deepEqual(entity.alternateKeys, [{
    schemaName: 'contoso_email', columns: ['contoso_email'], displayName: 'Email',
  }]);
});

test('only a conclusive alternate-key identity skips its write, ignoring case and column order', () => {
  const key = { schemaName: 'contoso_nameemail', columns: ['contoso_name', 'contoso_email'] };
  assert.equal(alternateKeyMatches([{ SchemaName: 'Contoso_NameEmail', KeyAttributes: ['CONTOSO_EMAIL', 'contoso_name'] }], key), true);
  for (const keys of [undefined, [], [{ SchemaName: key.schemaName }], [{ SchemaName: 'contoso_other', KeyAttributes: key.columns }],
    [{ SchemaName: key.schemaName, KeyAttributes: ['contoso_name'] }]]) {
    assert.equal(alternateKeyMatches(keys, key), false);
  }
});

for (const [name, row, queried] of [
  ['another publisher', { name: 'fabrikam_icon.svg', webresourcetype: 11, content: 'c3Zn', ismanaged: false }, false],
  ['a managed SVG', { name: 'contoso_icon.svg', webresourcetype: 11, content: 'c3Zn', ismanaged: true }, true],
  ['unknown management', { name: 'contoso_icon.svg', webresourcetype: 11, content: 'c3Zn' }, true],
  ['a non-SVG resource', { name: 'contoso_icon.svg', webresourcetype: 5, content: 'cG5n', ismanaged: false }, true],
  ['missing content', { name: 'contoso_icon.svg', webresourcetype: 11, ismanaged: false }, true],
]) {
  test(`a table vector icon does not capture ${name}`, async () => {
    const calls = [];
    const sdk = { queryRecords: async (...args) => { calls.push(args); return [row]; } };
    const got = await iconWebResources(sdk, [], [], 'contoso', true, [], [row.name]);
    assert.deepEqual(got.webResources, []);
    assert.equal(calls.length, queried ? 1 : 0);
  });
}

test('a table icon shared by navigation is captured once, with teardown protection and no type broadening', async () => {
  const calls = [];
  const sdk = { queryRecords: async (...args) => {
    calls.push(args);
    return [{ name: 'contoso_icon.svg', displayname: 'Item Icon', webresourcetype: 11, content: 'c3Zn', ismanaged: false }];
  } };
  const got = await iconWebResources(sdk, [], ['contoso_icon.svg'], 'contoso', true, [], ['contoso_icon.svg']);
  assert.deepEqual(got.webResources, [{ name: 'contoso_icon.svg', displayName: 'Item Icon', type: 'svg', contentBase64: 'c3Zn', external: true }]);
  assert.equal(calls.length, 1);
});

test('a table icon also named as a bare nav icon cannot bypass the unmanaged SVG gates', async () => {
  const sdk = { queryRecords: async () => [
    { name: 'contoso_icon.svg', webresourcetype: 11, content: 'c3Zn', ismanaged: true },
  ] };
  const got = await iconWebResources(sdk, ['contoso_icon.svg'], [], 'contoso', true, [], ['contoso_icon.svg']);
  assert.deepEqual(got.webResources, []);
});

async function provisionWithProof({ statusAnswer, keys, laterTable = false }) {
  const calls = [];
  const warnings = [];
  const sdk = {
    insertStatusValue: async (name, options) => { calls.push(['insert-status', name, options]); return options.value; },
    createAlternateKey: async (...args) => { calls.push(['create-key', ...args]); return {}; },
    createTable: async (options) => { calls.push(['create-table', options.schemaName]); return { logicalName: options.schemaName, entitySetName: `${options.schemaName}s` }; },
    createColumn: async (name, options) => { calls.push(['create-column', name, options.schemaName]); return { logicalName: options.schemaName }; },
  };
  const provision = { dataverse: { get: async (url) => {
    if (url.includes('StatusAttributeMetadata')) { calls.push(['read-status']); return statusAnswer; }
    if (url.includes('/Attributes?')) return { status: 200, body: { value: [{ LogicalName: 'contoso_name' }] } };
    if (url.includes("LogicalName='contoso_later'")) return { status: 404 };
    return { status: 200, body: { LogicalName: 'contoso_item', EntitySetName: 'contoso_items', Keys: keys } };
  } } };
  const entities = [{
    schemaName: 'contoso_item', primaryAttribute: { schemaName: 'contoso_name' }, columns: [],
    statusReasons: [{ label: 'Review', state: 'Active' }],
    alternateKeys: [{ schemaName: 'contoso_namekey', columns: ['contoso_name'] }],
  }];
  if (laterTable) entities.push({
    schemaName: 'contoso_later', displayName: { 1033: 'Later', 1036: 'Suivant' },
    primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_text', type: 'Text' }],
  });
  const result = await provisionDataModel({
    sdk, provision, spec: { solution: { uniqueName: 'ContosoSchema', publisherPrefix: 'contoso' }, entities },
    runner: makeRunner({ emit: () => {}, total: 20 }), apply: true, preResolvedLanguageCode: 1033,
    inlineColumns: false, warn: (m) => warnings.push(m),
  });
  return { calls, warnings, result };
}

test('unknown status and key proof keeps the existing duplicate-protected insert path', async () => {
  const { calls, warnings, result } = await provisionWithProof({ statusAnswer: { status: 403, body: {} } });
  assert.equal(calls.filter(([name]) => name === 'insert-status').length, 1);
  assert.equal(calls.filter(([name]) => name === 'create-key').length, 1);
  assert.ok(warnings.some((w) => /could not read status reasons.*HTTP 403/.test(w)));
  assert.deepEqual(result.statusReasonValues.contoso_item.Review, { value: 100000000, stateCode: 0 });
});

test('a matching status label in the wrong language is not a no-op proof', async () => {
  const { calls } = await provisionWithProof({
    statusAnswer: { status: 200, body: { value: [{ LogicalName: 'statuscode', OptionSet: { Options: [
      { Value: 100000000, State: 0, Label: label('Review', 1036) },
    ] } }] } },
    keys: [{ SchemaName: 'contoso_namekey', KeyAttributes: ['contoso_name'] }],
  });
  assert.equal(calls.filter(([name]) => name === 'insert-status').length, 1);
  assert.equal(calls.filter(([name]) => name === 'create-key').length, 0);
});

test('label-bearing status proofs run after every table and column create, preserving later localized labels', async () => {
  const { calls } = await provisionWithProof({
    statusAnswer: { status: 200, body: { value: [{ LogicalName: 'statuscode', OptionSet: { Options: [
      { Value: 100000000, State: 0, Label: label('Review') },
    ] } }] } },
    keys: [{ SchemaName: 'contoso_namekey', KeyAttributes: ['contoso_name'] }], laterTable: true,
  });
  const read = calls.findIndex(([name]) => name === 'read-status');
  for (const name of ['create-table', 'create-column']) {
    const create = calls.findIndex(([kind]) => kind === name);
    assert.ok(create >= 0 && read > create, `${name} must precede a status-label read: ${JSON.stringify(calls)}`);
  }
  assert.equal(calls.filter(([name]) => name === 'insert-status').length, 0);
});
