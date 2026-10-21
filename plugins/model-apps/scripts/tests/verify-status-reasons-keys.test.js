'use strict';
// Verify checks a table's STATUS REASONS and ALTERNATE KEYS (`entities[].statusReasons[]`, `entities[].alternateKeys[]`).
//
// Before, neither was checked: a status reason the build skipped because its value was already another reason's, one a maker renamed
// or deleted, and an alternate key that was never made or was made over other columns all verified PASS. Now each declared one is a
// check of its own, reported like the others — missing, or there but different — by name:
//   status-reason  <table>.<label>       present when one of the table's status reasons carries the label under the declared state
//                                        (Active unless the spec says Inactive), with the declared value when the spec pins one
//   alternate-key  <table>.<schemaName>  present when the table has a key of that name over exactly the declared columns
// One read each, for a table that declares any, and none for a table that declares neither (the request pins below).
const { test } = require('node:test');
const assert = require('node:assert');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { readChoiceAttributes } = require('../lib/view-filter-labels.js');
const { statusReasonTargets } = require('../lib/entity-provision.js');
const { instrument } = require('./helpers/read-probe.js');

// A status option as the reader answers it: { value, state, labels, shown }.
const option = (value, state, ...labels) => ({ value, state, labels, shown: labels[0] });
const statusAnswer = (...options) => ({ state: 'ok', options });
const key = (schemaName, columns) => ({ logicalName: schemaName.toLowerCase(), schemaName, columns });
const keysAnswer = (...keys) => ({ state: 'ok', keys });

// The two status reasons every table is made with: Active (1, state 0) and Inactive (2, state 1).
const STOCK = [option(1, 0, 'Active'), option(2, 1, 'Inactive')];

function reader({ statusReasons, alternateKeys, tables = ['new_o'] } = {}) {
  return {
    findTable: async (logical) => (tables.includes(logical) ? { logicalName: logical } : null),
    findColumns: async () => [{ logicalName: 'new_email' }],
    queryRecords: async () => [],
    sitemapXml: async () => '',
    ...(statusReasons ? { statusReasons } : {}),
    ...(alternateKeys ? { alternateKeys } : {}),
  };
}
const specOf = (entity) => ({ entities: [{ schemaName: 'new_o', columns: [], ...entity }], appShell: { areas: [] } });
const checksOf = (r, kind) => r.checks.filter((c) => c.kind === kind).map((c) => [c.name, c.present, c.detail]);

test('a status reason is present when the table holds its label under the declared state, and named when it does not', async () => {
  const spec = specOf({
    statusReasons: [
      { label: 'In Review', state: 'Active' },
      { label: 'Closed Won', state: 'Inactive' },
      { label: 'Escalated' },
      { label: 'Parked', state: 'Inactive' },
    ],
  });
  const r = await verifySpec(spec, reader({
    statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'In Review'), option(100000001, 0, 'Closed Won'), option(100000003, 1, 'Parked')),
  }));
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [
    ['new_o.In Review', true, ''],
    ['new_o.Closed Won', false, 'a status reason of the Active state; the spec declares it under Inactive'],
    ['new_o.Escalated', false, ''],
    ['new_o.Parked', true, ''],
  ]);
  assert.strictEqual(r.ok, false);
});

test('an omitted or unknown authored status state defaults to Active, as the build makes it', async () => {
  const spec = specOf({ statusReasons: [{ label: 'Escalated' }, { label: 'Odd', state: 'Pending' }] });
  const r = await verifySpec(spec, reader({ statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'Escalated'), option(100000001, 0, 'Odd')) }));
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.Escalated', true, ''], ['new_o.Odd', true, '']]);
  assert.strictEqual(r.ok, true);
});

test('a pinned status reason value is held to: the label at another value is named with both', async () => {
  const spec = specOf({ statusReasons: [{ label: 'On Hold', state: 'Active', value: 100000007 }, { label: 'Queued', value: 100000009 }] });
  const r = await verifySpec(spec, reader({ statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'On Hold'), option(100000009, 0, 'Queued')) }));
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [
    ['new_o.On Hold', false, 'its value is 100000000; the spec pins 100000007'],
    ['new_o.Queued', true, ''],
  ]);
});

test('a status reason renamed in the environment is named with the label its value carries — a build does not rename one', async () => {
  // The build gives the first declared reason 100000000 and the second 100000001 (entity-provision.js), and inserts it again on a rebuild,
  // which the platform refuses as "already exists" while another label holds the value — so the rename is never undone.
  const spec = specOf({ statusReasons: [{ label: 'In Review' }, { label: 'Approved' }] });
  const r = await verifySpec(spec, reader({ statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'Under Review')) }));
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [
    ['new_o.In Review', false, "its value, 100000000, is the status reason 'Under Review' in the environment, and a build does not rename one"],
    ['new_o.Approved', false, ''],
  ]);
});

test('a status reason is found by its label in any language it is written in', async () => {
  const spec = specOf({ statusReasons: [{ label: { 1033: 'In Review', 3082: 'En revisión' } }, { label: 'Abierto' }] });
  const r = await verifySpec(spec, reader({ statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'In Review', 'En revisión'), option(100000001, 0, 'Open', 'Abierto')) }));
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.In Review', true, ''], ['new_o.Abierto', true, '']]);
});

test('an alternate key is present when the table has a key of that name over exactly the declared columns, and named when not', async () => {
  const spec = specOf({
    alternateKeys: [
      { schemaName: 'new_EmailKey', columns: ['new_Email'] },
      { schemaName: 'new_codekey', columns: ['new_code', 'new_region'] },
      { schemaName: 'new_pairkey', columns: ['new_a', 'new_b'] },
      { schemaName: 'new_gonekey', columns: ['new_x'] },
      { schemaName: 'new_twinkey', columns: ['new_y'] },
    ],
  });
  const r = await verifySpec(spec, reader({
    alternateKeys: async () => keysAnswer(
      key('new_EmailKey', ['new_email']),
      key('new_codekey', ['new_region']),
      // The platform answers a key's columns in an order of its own (live: a key made over name, code read back as code, name).
      key('new_pairkey', ['new_b', 'new_a']),
      key('new_OtherKey', ['new_y']),
    ),
  }));
  assert.deepStrictEqual(checksOf(r, 'alternate-key'), [
    ['new_o.new_EmailKey', true, ''],
    ['new_o.new_codekey', false, 'its columns are new_region; the spec declares new_code, new_region'],
    ['new_o.new_pairkey', true, ''],
    ['new_o.new_gonekey', false, ''],
    ['new_o.new_twinkey', false, "a key over the same columns is there as 'new_OtherKey'"],
  ]);
  assert.strictEqual(r.ok, false);
});

test('a read that fails is a failed check with the reason — never a pass, and never the end of the run', async () => {
  const spec = specOf({ statusReasons: [{ label: 'In Review' }], alternateKeys: [{ schemaName: 'new_emailkey', columns: ['new_email'] }] });
  const answered = await verifySpec(spec, reader({
    statusReasons: async () => ({ state: 'error', why: 'HTTP 503: Service Unavailable' }),
    alternateKeys: async () => ({ state: 'error', why: 'HTTP 429: Too many requests' }),
  }));
  assert.deepStrictEqual([...checksOf(answered, 'status-reason'), ...checksOf(answered, 'alternate-key')], [
    ['new_o.In Review', false, 'could not be read: HTTP 503: Service Unavailable'],
    ['new_o.new_emailkey', false, 'could not be read: HTTP 429: Too many requests'],
  ]);
  // A reader that throws, or answers nothing it can use, is the same failure.
  const thrown = await verifySpec(spec, reader({
    statusReasons: async () => { throw new Error('socket hang up'); },
    alternateKeys: async () => null,
  }));
  assert.deepStrictEqual([...checksOf(thrown, 'status-reason'), ...checksOf(thrown, 'alternate-key')], [
    ['new_o.In Review', false, 'could not be read: socket hang up'],
    ['new_o.new_emailkey', false, 'could not be read: no answer'],
  ]);
  assert.ok(thrown.checks.some((c) => c.kind === 'entity' && c.present), 'the rest of the pass ran');
});

test('a table that is not there has no status reason or key checks, as it has no column checks — and nothing is read for them', async () => {
  const spec = specOf({ statusReasons: [{ label: 'In Review' }], alternateKeys: [{ schemaName: 'new_emailkey', columns: ['new_email'] }] });
  const probe = instrument(reader({ tables: [], statusReasons: async () => statusAnswer(...STOCK), alternateKeys: async () => keysAnswer() }), { latency: () => 0 });
  const r = await verifySpec(spec, probe.read);
  assert.ok(r.missing.some((m) => m.kind === 'entity'));
  assert.deepStrictEqual([...checksOf(r, 'status-reason'), ...checksOf(r, 'alternate-key')], []);
  assert.deepStrictEqual(probe.stats.calls.filter((c) => c.name === 'statusReasons' || c.name === 'alternateKeys'), []);
});

test('a reader without the two reads makes neither check — an existence-only reader is unaffected', async () => {
  const spec = specOf({ statusReasons: [{ label: 'In Review' }], alternateKeys: [{ schemaName: 'new_emailkey', columns: ['new_email'] }] });
  const r = await verifySpec(spec, reader());
  assert.deepStrictEqual([...checksOf(r, 'status-reason'), ...checksOf(r, 'alternate-key')], []);
  assert.strictEqual(r.ok, true);
});

test('REQUESTS: one read of each per table that declares any, however many it declares — none for a table that declares neither', async () => {
  const spec = {
    entities: [
      { schemaName: 'new_o', columns: [], statusReasons: [{ label: 'In Review' }, { label: 'Done', state: 'Inactive' }], alternateKeys: [{ schemaName: 'new_k1', columns: ['new_email'] }, { schemaName: 'new_k2', columns: ['new_email', 'new_name'] }] },
      { schemaName: 'new_p', columns: [], statusReasons: [{ label: 'Open' }] },
      { schemaName: 'new_q', columns: [], alternateKeys: [{ schemaName: 'new_k3', columns: ['new_email'] }] },
      { schemaName: 'new_r', columns: [] },
    ],
    appShell: { areas: [] },
  };
  const probe = instrument(reader({
    tables: ['new_o', 'new_p', 'new_q', 'new_r'],
    statusReasons: async () => statusAnswer(...STOCK),
    alternateKeys: async () => keysAnswer(),
  }), { latency: () => 0 });
  await verifySpec(spec, probe.read);
  const reads = (name) => probe.stats.calls.filter((c) => c.name === name).map((c) => c.args[0]).sort();
  assert.deepStrictEqual(reads('statusReasons'), ['new_o', 'new_p']);
  assert.deepStrictEqual(reads('alternateKeys'), ['new_o', 'new_q']);
  // A spec that declares neither reads exactly what it read before: the table and its columns, nothing more.
  const plain = instrument(reader({ statusReasons: async () => statusAnswer(...STOCK), alternateKeys: async () => keysAnswer() }), { latency: () => 0 });
  await verifySpec(specOf({ columns: [{ schemaName: 'new_email' }] }), plain.read);
  assert.deepStrictEqual(plain.stats.calls.map((c) => c.name).sort(), ['findColumns', 'findTable', 'sitemapXml']);
});

// ---- the reader (verify-model-app.js readerFor) ----------------------------------------------------------------------------------

// The SDK's raw client: `dataverse.get` RESOLVES on a non-2xx with { status, body } and throws only on a transport failure.
function recordingSdk(answer) {
  const paths = [];
  return {
    paths,
    sdk: {
      findTables: async () => [], findColumns: async () => [], queryRecords: async () => [],
      dataverse: { get: async (p) => { paths.push(p); return answer(p); } },
    },
  };
}
const label = (...pairs) => ({ LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })), UserLocalizedLabel: { Label: pairs[0][1], LanguageCode: pairs[0][0] } });

test('readerFor.statusReasons sends ONE narrow read of the table\'s status column and answers each reason with its value, state and every label', async () => {
  const { sdk, paths } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{ LogicalName: 'statuscode', MetadataId: '00000000-0000-4000-8000-000000000001', OptionSet: { Options: [
    { Value: 1, State: 0, Label: label([1033, 'Active']) },
    { Value: 2, State: 1, Label: label([1033, 'Inactive']) },
    { Value: 100000000, State: 0, Label: label([1033, 'In Review'], [3082, 'En revisión']) },
  ] } }] } }));
  const got = await readerFor(sdk, 'contoso_app', {}).statusReasons('NEW_O');
  assert.deepStrictEqual(paths, ["/EntityDefinitions(LogicalName='new_o')/Attributes/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)"]);
  assert.strictEqual(got.state, 'ok');
  assert.deepStrictEqual(got.options.map((o) => [o.value, o.state, o.labels]), [[1, 0, ['Active']], [2, 1, ['Inactive']], [100000000, 0, ['In Review', 'En revisión']]]);
});

for (const [description, fields] of [
  ['omitted', {}], ['null', { State: null }], ['a string', { State: '1' }],
  ['fractional', { State: 1.5 }], ['a boolean', { State: true }], ['an object', { State: {} }],
]) {
  test(`readerFor.statusReasons: State that is ${description} cannot prove the declared state`, async () => {
    for (const state of ['Inactive', 'Active']) {
      for (const pinned of [true, false]) {
        const { sdk, paths } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{
          LogicalName: 'statuscode',
          OptionSet: { Options: [{ Value: 100000000, Label: label([1033, 'Closed']), ...fields }] },
        }] } }));
        const read = readerFor(sdk, 'contoso_app', {});
        const spec = specOf({ statusReasons: [{ label: 'Closed', state, ...(pinned ? { value: 100000000 } : {}) }] });
        const r = await verifySpec(spec, { ...reader(), statusReasons: read.statusReasons });
        assert.strictEqual(checksOf(r, 'status-reason')[0][1], false);
        assert.deepStrictEqual(checksOf(r, 'status-reason'), [
          ['new_o.Closed', false, `its state could not be read; the spec declares it under ${state}`],
        ]);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(paths.length, 1);
      }
    }
  });
}

test('readerFor.statusReasons: known raw State values still prove a correct state or name the wrong state', async () => {
  for (const [State, present, detail] of [
    [0, false, 'a status reason of the Active state; the spec declares it under Inactive'],
    [1, true, ''],
    [2, false, 'a status reason of the state 2 state; the spec declares it under Inactive'],
  ]) {
    const { sdk, paths } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{
      LogicalName: 'statuscode', OptionSet: { Options: [{ Value: 100000000, State, Label: label([1033, 'Closed']) }] },
    }] } }));
    const read = readerFor(sdk, 'contoso_app', {});
    const r = await verifySpec(specOf({ statusReasons: [{ label: 'Closed', state: 'Inactive', value: 100000000 }] }), { ...reader(), statusReasons: read.statusReasons });
    assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.Closed', present, detail]]);
    assert.strictEqual(r.ok, present);
    assert.strictEqual(paths.length, 1);
  }
});

test('readerFor.statusReasons: an unreadable state at another value still reports the pinned-value difference', async () => {
  const { sdk } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{
    LogicalName: 'statuscode', OptionSet: { Options: [{ Value: 100000000, Label: label([1033, 'Closed']) }] },
  }] } }));
  const read = readerFor(sdk, 'contoso_app', {});
  const r = await verifySpec(specOf({ statusReasons: [{ label: 'Closed', state: 'Inactive', value: 100000007 }] }), { ...reader(), statusReasons: read.statusReasons });
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.Closed', false, 'its value is 100000000; the spec pins 100000007']]);
});

test('readerFor.statusReasons: a readable matching option still proves the state when another same-label option omits it', async () => {
  const { sdk } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{
    LogicalName: 'statuscode', OptionSet: { Options: [
      { Value: 100000000, Label: label([1033, 'Closed']) },
      { Value: 100000001, State: 1, Label: label([1033, 'Closed']) },
    ] },
  }] } }));
  const read = readerFor(sdk, 'contoso_app', {});
  const r = await verifySpec(specOf({ statusReasons: [{ label: 'Closed', state: 'Inactive' }] }), { ...reader(), statusReasons: read.statusReasons });
  assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.Closed', true, '']]);
  assert.strictEqual(r.ok, true);
});

test('readerFor.alternateKeys sends ONE read of the table\'s keys and answers each with its name and columns', async () => {
  const { sdk, paths } = recordingSdk(() => ({ status: 200, headers: {}, body: { value: [
    { LogicalName: 'new_emailkey', SchemaName: 'new_EmailKey', KeyAttributes: ['new_email'], MetadataId: '00000000-0000-4000-8000-000000000002' },
    { LogicalName: 'new_pairkey', SchemaName: 'new_PairKey', KeyAttributes: ['new_b', 'new_a'], MetadataId: '00000000-0000-4000-8000-000000000003' },
  ] } }));
  const got = await readerFor(sdk, 'contoso_app', {}).alternateKeys('NEW_O');
  assert.deepStrictEqual(paths, ["/EntityDefinitions(LogicalName='new_o')/Keys?$select=LogicalName,SchemaName,KeyAttributes"]);
  assert.deepStrictEqual(got, { state: 'ok', keys: [
    { logicalName: 'new_emailkey', schemaName: 'new_EmailKey', columns: ['new_email'] },
    { logicalName: 'new_pairkey', schemaName: 'new_PairKey', columns: ['new_b', 'new_a'] },
  ] });
});

test('readerFor: a read that fails, or answers no list, is an error with the reason — never an empty answer', async () => {
  for (const read of ['statusReasons', 'alternateKeys']) {
    const failed = await readerFor(recordingSdk(() => ({ status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'Service Unavailable' } } })).sdk, 'contoso_app', {})[read]('new_o');
    assert.deepStrictEqual(failed, { state: 'error', why: 'HTTP 503: Service Unavailable' }, read);
    const thrown = await readerFor(recordingSdk(() => { throw new Error('socket hang up'); }).sdk, 'contoso_app', {})[read]('new_o');
    assert.deepStrictEqual(thrown, { state: 'error', why: 'socket hang up' }, read);
    const shapeless = await readerFor(recordingSdk(() => ({ status: 200, headers: {}, body: {} })).sdk, 'contoso_app', {})[read]('new_o');
    assert.strictEqual(shapeless.state, 'error', read);
    assert.match(shapeless.why, /no list/, read);
    // A table the environment does not have answers 404: there is nothing to compare with.
    const absent = await readerFor(recordingSdk(() => ({ status: 404, headers: {}, body: { error: { message: 'not found' } } })).sdk, 'contoso_app', {})[read]('new_o');
    assert.deepStrictEqual(absent, { state: 'absent' }, read);
  }
  // A key row without its columns cannot be compared, so the answer is not used.
  const columnless = await readerFor(recordingSdk(() => ({ status: 200, headers: {}, body: { value: [{ LogicalName: 'new_emailkey', SchemaName: 'new_emailkey' }] } })).sdk, 'contoso_app', {}).alternateKeys('new_o');
  assert.deepStrictEqual(columnless, { state: 'error', why: "the key 'new_emailkey' was answered without its columns" });
});

test('a status reason is held to what the build gives it: the build\'s own state and value, from one rule', () => {
  // The data-model phase inserts each reason at statusReasonTargets' state and value (entity-provision.js), and verify compares with the
  // same — so this pins the rule both read: Active unless Inactive, and the pinned value, else 100000000 + the reason's place in the list.
  const targets = statusReasonTargets({ statusReasons: [{ label: 'A' }, { label: 'B', state: 'Inactive' }, { label: 'C', value: 7 }, { label: 'D', state: 'Pending' }] });
  assert.deepStrictEqual(targets.map((t) => [t.statusReason.label, t.stateCode, t.value]), [['A', 0, 100000000], ['B', 1, 100000001], ['C', 0, 7], ['D', 0, 100000003]]);
  assert.deepStrictEqual(statusReasonTargets({}), []);
});

test('an absent answer is a failed check that says the table answered no such thing', async () => {
  const spec = specOf({ statusReasons: [{ label: 'In Review' }], alternateKeys: [{ schemaName: 'new_emailkey', columns: ['new_email'] }] });
  const r = await verifySpec(spec, reader({ statusReasons: async () => ({ state: 'absent' }), alternateKeys: async () => ({ state: 'absent' }) }));
  assert.deepStrictEqual([...checksOf(r, 'status-reason'), ...checksOf(r, 'alternate-key')], [
    ['new_o.In Review', false, 'could not be read: the environment answered that the table is not there'],
    ['new_o.new_emailkey', false, 'could not be read: the environment answered that the table is not there'],
  ]);
});

test('the view filter\'s choice read is unchanged: only a status reason gains its state, every other option keeps its shape', async () => {
  // readChoiceAttributes shares the option parser with the status reason read; what it answered for a choice column must not move.
  const { sdk } = recordingSdk((p) => {
    const cast = /Microsoft\.Dynamics\.CRM\.(\w+)AttributeMetadata/.exec(p)[1];
    const rows = {
      Picklist: [{ LogicalName: 'new_tier', OptionSet: { Options: [{ Value: 227350000, Label: label([1033, 'Silver']) }] } }],
      Status: [{ LogicalName: 'statuscode', OptionSet: { Options: [{ Value: 1, State: 0, Label: label([1033, 'Active']) }] } }],
    }[cast] || [];
    return { status: 200, headers: {}, body: { value: rows } };
  });
  const got = await readChoiceAttributes(sdk.dataverse, 'new_o');
  assert.deepStrictEqual(got.attributes.get('new_tier').options, [{ value: 227350000, labels: ['Silver'], shown: 'Silver' }]);
  assert.deepStrictEqual(got.attributes.get('statuscode').options, [{ value: 1, labels: ['Active'], shown: 'Active', state: 0 }]);
});

test('metadata checks preserve one command-bar presence check per table without checking individual controls', async () => {
  const spec = {
    ...specOf({
      statusReasons: [{ label: 'In Review' }],
      alternateKeys: [{ schemaName: 'new_emailkey', columns: ['new_email'] }],
    }),
    commands: [
      { entity: 'new_o', label: 'Escalate', library: 'new_o.js', function: 'O.escalate' },
      { entity: 'NEW_O', label: 'More', type: 'FlyoutAnchor', children: [{ label: 'Approve', library: 'new_o.js', function: 'O.approve' }] },
    ],
  };
  for (const result of [true, false, 'unreadable']) {
    const calls = [];
    const r = await verifySpec(spec, {
      ...reader({
        statusReasons: async () => statusAnswer(...STOCK, option(100000000, 0, 'In Review')),
        alternateKeys: async () => keysAnswer(key('new_emailkey', ['new_email'])),
      }),
      commandBar: async (entity) => {
        calls.push(entity);
        if (result === 'unreadable') throw new Error('command bar could not be resolved');
        return result;
      },
      commandButtons: async () => assert.fail('individual controls are not read'),
    });
    assert.deepStrictEqual(calls, ['new_o']);
    assert.deepStrictEqual(checksOf(r, 'command'), [['new_o command bar', result === true, '']]);
    assert.deepStrictEqual(checksOf(r, 'command-button'), []);
    assert.deepStrictEqual(checksOf(r, 'status-reason'), [['new_o.In Review', true, '']]);
    assert.deepStrictEqual(checksOf(r, 'alternate-key'), [['new_o.new_emailkey', true, '']]);
    assert.strictEqual(r.ok, result === true);
  }
});

test('readerFor retains table-level command resolution without a per-control reader', async () => {
  for (const rows of [[], [{ id: 'bar-1' }]]) {
    const calls = [];
    const { sdk } = recordingSdk(() => assert.fail('command-bar presence makes no metadata read'));
    sdk.resolveArtifact = async (...args) => { calls.push(args); return rows; };
    const read = readerFor(sdk, 'contoso_app', {});
    assert.strictEqual(Object.hasOwn(read, 'commandButtons'), false);
    assert.strictEqual(await read.commandBar('NEW_O'), rows.length !== 0);
    assert.deepStrictEqual(calls, [['command', { entity: 'new_o' }]]);
  }
});
