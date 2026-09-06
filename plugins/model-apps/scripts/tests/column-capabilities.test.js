'use strict';
// Guards https://github.com/microsoft/power-platform-skills/issues/495 — the SDK could author
// neither a Boolean default, nor a whole-number Duration format, nor per-column IsValidFor* flags,
// so a maker had to finish every column by hand after a build. (AB#6648523, AB#6648522, AB#6651276)
// `entities[].columns[]` — three column capabilities the vendored SDK gained in the same bundle
// refresh (provenance commit 15bd1b16), one App Spec field each:
//   AB#6648523 — defaultValue        (Boolean columns: the SDK used to hardcode DefaultValue:false)
//   AB#6648522 — integerFormat       (Integer columns: the SDK used to hardcode Format:'None')
//   AB#6651276 — isValidForCreate / isValidForUpdate / isValidForRead (per-verb write/read access)
//
// All three share the SAME hazard: each is a boolean-or-enum a maker can set to an EXPLICIT
// falsy/negative value on purpose (`defaultValue:false`, `isValidForUpdate:false` — the whole point
// of "make this column read-only after creation"). A naive `if (c.field)` truthy guard anywhere in
// the chain — validation, the create mapper, or the update reconciler — silently drops exactly that
// value and nothing else, which is why every wiring test below asserts the explicit-false case
// SEPARATELY from the omitted case, not just "some value round-trips".
//
// Four layers, same reasons column-visualization.test.js gives:
//   1. VALIDATION — reject the wrong shape at the spec gate, not mid-build.
//   2. BUILD (create) — the mapper must pass an explicit value through, and only an explicit value.
//   3. BUILD (reconcile) — a rebuild must converge an EXISTING column too (AB#6651276 says so
//      explicitly), via a SEPARATE reconcile block from the pre-existing `required` one (different
//      convergence strategy — see the comment on capabilityTargets in entity-provision.js).
//   4. REAL BUNDLE — the measured wire shape, pinned so a future SDK bump that changes the key names
//      or the "omitted vs explicit" behaviour is caught here instead of downstream.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { validateAppSpec, INTEGER_FORMATS } = require('../lib/app-spec.js');
const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

function specWith(columns) {
  return {
    solution: { uniqueName: 'CC', displayName: 'CC', publisherPrefix: 'new' },
    app: { name: 'CC App', description: '' },
    entities: [{
      schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
      primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns,
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
  };
}

const VIP = { schemaName: 'new_isvip', displayName: 'VIP', type: 'Boolean' };
const MINUTES = { schemaName: 'new_minutes', displayName: 'Minutes', type: 'Integer' };
const SSN = { schemaName: 'new_ssn', displayName: 'SSN', type: 'Text' };

// ---------------------------------------------------------------- 1. validation

test('defaultValue: true and defaultValue: false both validate cleanly on a Boolean column', () => {
  for (const v of [true, false]) {
    const res = validateAppSpec(specWith([Object.assign({}, VIP, { defaultValue: v })]));
    assert.strictEqual(res.errors.filter((e) => /defaultValue/.test(e)).length, 0, `defaultValue:${v} should validate`);
  }
});

test('omitting defaultValue is valid', () => {
  const res = validateAppSpec(specWith([VIP]));
  assert.strictEqual(res.errors.filter((e) => /defaultValue/.test(e)).length, 0);
});

test('a non-boolean defaultValue is rejected and names the column and the bad value', () => {
  const res = validateAppSpec(specWith([Object.assign({}, VIP, { defaultValue: 'true' })]));
  const err = res.errors.find((e) => /defaultValue/.test(e));
  assert.ok(err, 'expected a validation error');
  assert.match(err, /new_isvip/);
  assert.match(err, /must be a boolean/);
  assert.match(err, /"true"/); // JSON.stringify('true') => "true", distinguishing it from the boolean true
});

test('defaultValue on a non-Boolean column is rejected and names the column and its actual type', () => {
  const res = validateAppSpec(specWith([Object.assign({}, SSN, { defaultValue: true })]));
  const err = res.errors.find((e) => /defaultValue/.test(e));
  assert.ok(err, 'expected a validation error');
  assert.match(err, /new_ssn/);
  assert.match(err, /Boolean column/);
  assert.match(err, /'Text'/);
});

test('every integerFormat literal validates cleanly on an Integer column', () => {
  for (const f of INTEGER_FORMATS) {
    const res = validateAppSpec(specWith([Object.assign({}, MINUTES, { integerFormat: f })]));
    assert.strictEqual(res.errors.filter((e) => /integerFormat/.test(e)).length, 0, `${f} should validate`);
  }
});

test('omitting integerFormat is valid', () => {
  const res = validateAppSpec(specWith([MINUTES]));
  assert.strictEqual(res.errors.filter((e) => /integerFormat/.test(e)).length, 0);
});

test('an unknown integerFormat is rejected and names the column, the bad value, and the allowed list', () => {
  const res = validateAppSpec(specWith([Object.assign({}, MINUTES, { integerFormat: 'Fortnight' })]));
  const err = res.errors.find((e) => /integerFormat/.test(e));
  assert.ok(err, 'expected a validation error');
  assert.match(err, /new_minutes/);
  assert.match(err, /Fortnight/);
  assert.match(err, /None\|Duration\|TimeZone\|Language\|Locale/);
});

test('integerFormat on a non-Integer numeric column (Decimal) is rejected and names the actual type', () => {
  const decimalCol = { schemaName: 'new_amount', displayName: 'Amount', type: 'Decimal' };
  const res = validateAppSpec(specWith([Object.assign({}, decimalCol, { integerFormat: 'Duration' })]));
  const err = res.errors.find((e) => /integerFormat/.test(e));
  assert.ok(err, 'expected a validation error — Format is Integer-only even though Decimal shares the min/max/precision switch case');
  assert.match(err, /new_amount/);
  assert.match(err, /'Decimal'/);
});

test('isValidForCreate / isValidForUpdate / isValidForRead each validate cleanly at true AND at false', () => {
  for (const flag of ['isValidForCreate', 'isValidForUpdate', 'isValidForRead']) {
    for (const v of [true, false]) {
      const res = validateAppSpec(specWith([Object.assign({}, SSN, { [flag]: v })]));
      assert.strictEqual(res.errors.filter((e) => e.includes(flag)).length, 0, `${flag}:${v} should validate`);
    }
  }
});

test('omitting all three isValidFor* flags is valid', () => {
  const res = validateAppSpec(specWith([SSN]));
  assert.strictEqual(res.errors.filter((e) => /isValidFor/.test(e)).length, 0);
});

test('a non-boolean isValidForUpdate is rejected and names the column, the flag, and the bad value', () => {
  const res = validateAppSpec(specWith([Object.assign({}, SSN, { isValidForUpdate: 'false' })]));
  const err = res.errors.find((e) => /isValidForUpdate/.test(e));
  assert.ok(err, 'expected a validation error — the string "false" is truthy in JS and must not be coerced');
  assert.match(err, /new_ssn/);
  assert.match(err, /must be a boolean/);
  assert.match(err, /"false"/);
});

test('isValidForUpdate:false on a Customer column WARNS (does not error) — createCustomerColumn cannot carry it', () => {
  const customerCol = { schemaName: 'new_owner', displayName: 'Owner', type: 'Customer' };
  const res = validateAppSpec(specWith([Object.assign({}, customerCol, { isValidForUpdate: false })]));
  assert.strictEqual(res.errors.filter((e) => /isValidFor/.test(e)).length, 0, 'still a valid spec');
  const warn = res.warnings.find((w) => /isValidFor/.test(w));
  assert.ok(warn, 'expected a warning');
  assert.match(warn, /new_owner/);
  assert.match(warn, /Customer column/);
  assert.match(warn, /will NOT be written/);
});

// ---------------------------------------------------------------- 2. build (create path)

// Captures the FULL options object handed to createColumn/createCustomerColumn/updateColumn (not
// just the schemaName, unlike entity-provision.test.js's own mockSdk) — these tests exist
// specifically to inspect which keys are present, so the harness must not throw that away.
function mockSdk(existingTables = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
      updateTable: async () => ({}),
      createColumn: async (l, o) => { calls.push(['createColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
      createCustomerColumn: async (l, o) => { calls.push(['createCustomerColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      createRelationship: async (o) => ({ schemaName: o.schemaName, metadataId: `rel-${o.schemaName}` }),
      createGlobalOptionSet: async (o) => ({ metadataId: `gc-${o.name}` }),
      insertStatusValue: async () => 100000000,
      createAlternateKey: async () => ({}),
    },
    provision: {
      findTables: async (s) => (existingTables[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => existingTables.__columns || [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    },
  };
}

function specForProvision(columns) {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'new_name' }, columns }],
    relationships: [],
  };
}

async function runProvision(m, columns, warn) {
  const runner = makeRunner({ emit: () => {}, total: 50 });
  return provisionDataModel({ sdk: m.sdk, provision: m.provision, runner, spec: specForProvision(columns), apply: true, preResolvedLanguageCode: 1033, warn });
}

test('CREATE: an explicit defaultValue:true reaches createColumn', async () => {
  const m = mockSdk();
  await runProvision(m, [Object.assign({}, VIP, { defaultValue: true })]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].defaultValue, true);
});

test('CREATE: an explicit defaultValue:false is PRESENT on the createColumn call, not dropped', async () => {
  // The critical truthiness-bug case: `false` must appear in the options object passed to the SDK,
  // not be indistinguishable from "the spec never mentioned it".
  const m = mockSdk();
  await runProvision(m, [Object.assign({}, VIP, { defaultValue: false })]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].defaultValue, false);
  assert.ok(Object.prototype.hasOwnProperty.call(call[2], 'defaultValue'), 'the key itself must be present, not merely falsy');
});

test('CREATE: an omitted defaultValue sends no defaultValue key at all', async () => {
  const m = mockSdk();
  await runProvision(m, [VIP]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].defaultValue, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'defaultValue'), 'omitted in the spec must stay omitted for the SDK too — its own default applies');
});

test('CREATE: an explicit integerFormat reaches createColumn', async () => {
  const m = mockSdk();
  await runProvision(m, [Object.assign({}, MINUTES, { integerFormat: 'Duration' })]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].integerFormat, 'Duration');
});

test('CREATE: an omitted integerFormat sends no integerFormat key at all', async () => {
  const m = mockSdk();
  await runProvision(m, [MINUTES]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'integerFormat'));
});

test('CREATE: integerFormat is NOT applied to a sibling numeric type sharing the switch case', async () => {
  // Decimal/Double/BigInt/Money share columnOptions()'s min/max/precision case with Integer, but the
  // SDK's Format option is Integer-only — confirms the gate stayed narrow after refactor.
  const m = mockSdk();
  const decimalCol = { schemaName: 'new_amount', displayName: 'Amount', type: 'Decimal', integerFormat: 'Duration' };
  await runProvision(m, [decimalCol]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'integerFormat'), 'integerFormat must not leak onto a Decimal column');
});

test('CREATE: isValidForCreate:true, isValidForUpdate:false, isValidForRead:true all reach createColumn — false included', async () => {
  const m = mockSdk();
  await runProvision(m, [Object.assign({}, SSN, { isValidForCreate: true, isValidForUpdate: false, isValidForRead: true })]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].isValidForCreate, true);
  assert.strictEqual(call[2].isValidForUpdate, false);
  assert.strictEqual(call[2].isValidForRead, true);
});

test('CREATE: setting only isValidForUpdate:false sends ONLY that key, not the other two', async () => {
  const m = mockSdk();
  await runProvision(m, [Object.assign({}, SSN, { isValidForUpdate: false })]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  assert.strictEqual(call[2].isValidForUpdate, false);
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'isValidForCreate'));
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'isValidForRead'));
});

test('CREATE: omitting all three isValidFor* flags sends none of the three keys', async () => {
  const m = mockSdk();
  await runProvision(m, [SSN]);
  const call = m.calls.find((c) => c[0] === 'createColumn');
  for (const flag of ['isValidForCreate', 'isValidForUpdate', 'isValidForRead']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(call[2], flag));
  }
});

test('CREATE: a Customer column routes through createCustomerColumn, which never receives the new fields', async () => {
  // Customer columns are structurally incompatible: createCustomerColumn's options have no
  // defaultValue/integerFormat/isValidFor* fields at all (measured against the vendored SDK).
  const m = mockSdk();
  const customerCol = { schemaName: 'new_owner', displayName: 'Owner', type: 'Customer', isValidForUpdate: false };
  await runProvision(m, [customerCol]);
  assert.ok(!m.calls.some((c) => c[0] === 'createColumn'), 'Customer must not go through createColumn');
  const call = m.calls.find((c) => c[0] === 'createCustomerColumn');
  assert.ok(call, 'createCustomerColumn must have been called');
  assert.ok(!Object.prototype.hasOwnProperty.call(call[2], 'isValidForUpdate'), 'the field has nowhere to go on this call and must not be invented');
});

// ---------------------------------------------------------------- 3. build (reconcile / update path)

test('RECONCILE: an existing Boolean column with explicit defaultValue:false calls updateColumn', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_isvip', schemaName: 'new_isvip' }] });
  await runProvision(m, [Object.assign({}, VIP, { defaultValue: false })]);
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_isvip', { defaultValue: false }]);
});

test('RECONCILE: an existing Integer column with explicit integerFormat calls updateColumn', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_minutes', schemaName: 'new_minutes' }] });
  await runProvision(m, [Object.assign({}, MINUTES, { integerFormat: 'Duration' })]);
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_minutes', { integerFormat: 'Duration' }]);
});

test('RECONCILE: an existing column with only isValidForUpdate:false set sends ONLY that key to updateColumn', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_ssn', schemaName: 'new_ssn' }] });
  await runProvision(m, [Object.assign({}, SSN, { isValidForUpdate: false })]);
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_ssn', { isValidForUpdate: false }]);
});

test('RECONCILE: an existing column with all three isValidFor* flags sends all three, false included', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_ssn', schemaName: 'new_ssn' }] });
  await runProvision(m, [Object.assign({}, SSN, { isValidForCreate: false, isValidForUpdate: false, isValidForRead: false })]);
  assert.deepStrictEqual(
    m.calls.find((c) => c[0] === 'updateColumn'),
    ['updateColumn', 'new_ticket', 'new_ssn', { isValidForCreate: false, isValidForUpdate: false, isValidForRead: false }]);
});

test('RECONCILE: an existing column with none of the three capabilities set never calls updateColumn for them', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_ssn', schemaName: 'new_ssn' }] });
  await runProvision(m, [SSN]);
  assert.ok(!m.calls.some((c) => c[0] === 'updateColumn'), 'nothing to reconcile — must not spam updateColumn on every existing column');
});

test('RECONCILE: an existing Customer column is excluded even when isValidFor* is set — updateColumn refuses the type entirely', async () => {
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_owner', schemaName: 'new_owner' }] });
  const customerCol = { schemaName: 'new_owner', displayName: 'Owner', type: 'Customer', isValidForUpdate: false };
  await runProvision(m, [customerCol]);
  assert.ok(!m.calls.some((c) => c[0] === 'updateColumn'), 'Customer columns have no update path at all (measured — the SDK throws "type not supported")');
});

test('RECONCILE: a failure updating column capabilities warns and continues rather than halting the build', async () => {
  const warnings = [];
  const m = mockSdk({ new_ticket: true, __columns: [{ logicalName: 'new_isvip', schemaName: 'new_isvip' }] });
  m.sdk.updateColumn = async (l, c, o) => {
    m.calls.push(['updateColumn', l, c, o]);
    const err = new Error('metadata lock busy');
    err.statusCode = 429;
    throw err;
  };
  await runProvision(m, [Object.assign({}, VIP, { defaultValue: false })], (msg) => warnings.push(msg));
  assert.ok(m.calls.some((c) => c[0] === 'updateColumn'), 'the reconcile was attempted');
  assert.ok(warnings.some((w) => /could not update column capabilities for new_ticket\.new_isvip/.test(w)));
});

test('RECONCILE: the new capability block and the pre-existing required block coexist as SEPARATE updateColumn calls', async () => {
  // Guards against accidentally folding the new block INTO the required block (or vice versa) —
  // they converge by different strategies (diff-then-skip vs always-reassert) and must stay
  // independent calls, not merged into one options object that could silently drop a field.
  const m = mockSdk({
    new_ticket: true,
    __columns: [{ logicalName: 'new_isvip', schemaName: 'new_isvip', RequiredLevel: { Value: 'None' } }],
  });
  await runProvision(m, [Object.assign({}, VIP, { required: true, defaultValue: false })]);
  const updateCalls = m.calls.filter((c) => c[0] === 'updateColumn');
  assert.strictEqual(updateCalls.length, 2, 'one call for required, one call for the new capabilities');
  assert.ok(updateCalls.some((c) => c[3].required === 'ApplicationRequired'));
  assert.ok(updateCalls.some((c) => c[3].defaultValue === false));
});

// ---------------------------------------------------------------- 4. real bundle (measured wire evidence)

// Fake httpClient that records every request. Mirrors lcid-real-bundle.test.js's pattern: drive the
// REAL vendored bundle (not a mock of it) so a future SDK bump that changes a key name or the
// omitted-vs-explicit behaviour breaks THIS test, not a downstream build.
function realSdk({ get } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-'));
  const requests = [];
  const rec = (verb) => async (url, body) => {
    requests.push({ verb, url, body });
    if (verb === 'post') return { status: 204, headers: {}, body: { MetadataId: '11111111-1111-1111-1111-111111111111' } };
    return { status: 204, headers: {}, body: {} };
  };
  const sdk = require(BUNDLE).createMakerSdk({
    workspacePath: dir,
    instanceUrl: 'https://contoso.crm.dynamics.com',
    httpClient: {
      get: get || (async (url) => { requests.push({ verb: 'get', url }); return { status: 200, headers: {}, body: { value: [] } }; }),
      post: rec('post'),
      patch: rec('patch'),
      put: rec('put'),
      delete: rec('delete'),
    },
  });
  return { sdk, requests, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// updateColumn does two GETs before its PUT: (1) $select=MetadataId,AttributeType, (2) the full
// typed attribute. Position, not URL text, distinguishes them (measured against the real bundle).
function updateGetSequence(attributeType, currentBody) {
  let n = 0;
  return async (url) => {
    n += 1;
    if (n === 1) return { status: 200, headers: {}, body: { MetadataId: '22222222-2222-2222-2222-222222222222', AttributeType: attributeType } };
    return { status: 200, headers: {}, body: currentBody };
  };
}

test('REAL BUNDLE: createColumn sends DefaultValue:false on the wire for an EXPLICIT false (not omitted)', async () => {
  // `await`, not a returned promise inside try/finally: `finally` fires when the `return` is
  // EVALUATED, so `r.cleanup()` (an fs.rmSync of the workspace dir) would run before the SDK call
  // settled. Harmless while the assertions only read `r.requests`, and an intermittent ENOENT the
  // moment anything touches the workspace. Every sibling REAL BUNDLE test here awaits.
  const r = realSdk();
  try {
    await r.sdk.createColumn('new_ticket', { schemaName: 'new_isvip', displayName: 'VIP', type: 'boolean', defaultValue: false });
    const post = r.requests.find((x) => x.verb === 'post');
    assert.strictEqual(post.body.DefaultValue, false);
    assert.ok(Object.prototype.hasOwnProperty.call(post.body, 'DefaultValue'));
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: createColumn sends Format for an explicit integerFormat', async () => {
  const r = realSdk();
  try {
    await r.sdk.createColumn('new_ticket', { schemaName: 'new_minutes', displayName: 'Minutes', type: 'integer', integerFormat: 'Duration' });
    const post = r.requests.find((x) => x.verb === 'post');
    assert.strictEqual(post.body.Format, 'Duration');
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: createColumn sends ONLY the isValidFor* keys explicitly set, nothing implied', async () => {
  const r = realSdk();
  try {
    await r.sdk.createColumn('new_ticket', { schemaName: 'new_ssn', displayName: 'SSN', type: 'string', isValidForUpdate: false });
    const post = r.requests.find((x) => x.verb === 'post');
    assert.strictEqual(post.body.IsValidForUpdate, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(post.body, 'IsValidForCreate'));
    assert.ok(!Object.prototype.hasOwnProperty.call(post.body, 'IsValidForRead'));
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: createColumn throws for defaultValue on a non-boolean column (spec-gate mirrors an SDK-side guard)', async () => {
  const r = realSdk();
  try {
    await assert.rejects(
      () => r.sdk.createColumn('new_ticket', { schemaName: 'new_name', displayName: 'Name', type: 'string', defaultValue: true }),
      /defaultValue.*boolean columns/);
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: updateColumn PUTs an explicit defaultValue:false, changing a previously-true value', async () => {
  const current = {
    '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
    SchemaName: 'new_isvip',
    DefaultValue: true,
    OptionSet: { '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata', TrueOption: { Value: 1 }, FalseOption: { Value: 0 } },
  };
  const r = realSdk({ get: updateGetSequence('Boolean', current) });
  try {
    await r.sdk.updateColumn('new_ticket', 'new_isvip', { defaultValue: false });
    const put = r.requests.find((x) => x.verb === 'put');
    assert.strictEqual(put.body.DefaultValue, false);
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: updateColumn PUTs explicit isValidFor* flags, false included, alongside the untouched fields it read', async () => {
  const current = {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'new_ssn',
    MaxLength: 100,
    IsValidForCreate: true,
    IsValidForUpdate: true,
    IsValidForRead: true,
  };
  const r = realSdk({ get: updateGetSequence('String', current) });
  try {
    await r.sdk.updateColumn('new_ticket', 'new_ssn', { isValidForUpdate: false });
    const put = r.requests.find((x) => x.verb === 'put');
    assert.strictEqual(put.body.IsValidForUpdate, false);
    // The GET-mutate-PUT round trip forwards whatever it read for the untouched flags — confirms
    // the reconcile in entity-provision.js only needs to send the ONE flag it wants to change.
    assert.strictEqual(put.body.IsValidForCreate, true);
    assert.strictEqual(put.body.IsValidForRead, true);
  } finally {
    r.cleanup();
  }
});

test('REAL BUNDLE: updateColumn refuses a Customer column outright (no update path exists for it)', async () => {
  const r = realSdk({ get: updateGetSequence('Customer', {}) });
  try {
    await assert.rejects(() => r.sdk.updateColumn('new_ticket', 'new_owner', { isValidForUpdate: false }), /Customer/);
  } finally {
    r.cleanup();
  }
});
