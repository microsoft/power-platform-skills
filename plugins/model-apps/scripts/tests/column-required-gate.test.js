'use strict';

// `required` on a column, or on the primary name column, is `true`, `false` or "recommended" — and the spec gate says so before anything is built.
//
// Every other value (`"ApplicationRequired"`, `"true"`, `"required"`, `"Recommended"`, `1`, `null` ...) was read by the build as "not required": a new
// column came out not required, and on an EXISTING column — which the build reconciles whenever the spec states a `required` — it wrote None where the level
// differed, demoting a column a maker had made Business Required. The rule lives in lib/app-spec.js (requiredValueProblem) and is applied by BOTH gates a
// build can come through: validateAppSpec (/app-builder) and the provision-entities input validator (/genpage and /app-builder). Teardown validates under the
// structural profile and must keep accepting a spec an earlier release built from such a value, so that profile does not apply it.
//
// What else reads a column's `required` is held to the same set: the build (REQUIRED, lib/entity-provision.js), the plan document, the forms and the schema facts.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { provisionEntities } = require('../provision-entities.js');
const { makeRunner, provisionDataModel } = require('../lib/entity-provision.js');
const { entityFromMetadata } = require('../download-model-app.js');
const { renderAppSpecDoc } = require('../lib/app-spec-doc.js');
const { BUILDING_PROFILES, column, nameColumn, appSpec, provisionInput, tail, watchedDeps } = require('./helpers/column-gate-specs.js');

const FORMAT_HINT = 'give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column';
const formatError = (state, name) => `entity new_ticket: column ${name} is an AutoNumber column but its autoNumberFormat is ${state} — ${FORMAT_HINT}`;
const OMIT_HINT = "omit the key to leave an existing column's level as it is";
const GENERIC_HINT = 'true makes a column required, "recommended" makes it recommended and false makes it not required';
const requiredError = (value, hint, subject = 'column new_status required') => `entity new_ticket: ${subject} must be true, false or "recommended" (got ${JSON.stringify(value)}) — ${hint}; ${OMIT_HINT}`;

// --- required is true, false or "recommended" ---------------------------------------------------------------------------------------

test('required is accepted as true, false or "recommended", or left out, on a column and on the primary name column, under every profile', () => {
  for (const profile of [...BUILDING_PROFILES, 'structural']) {
    for (const required of [true, false, 'recommended', undefined]) {
      const stated = required === undefined ? {} : { required };
      const result = validateAppSpec(appSpec({ columns: [column({ schemaName: 'new_status', type: 'Text', ...stated })], primaryAttribute: nameColumn(stated) }), { profile });
      assert.deepStrictEqual(result.errors, [], `${profile} ${JSON.stringify(required)}`);
    }
  }
  // An own property that holds `undefined` states nothing, as in any optional field of the spec (JSON cannot carry one).
  assert.deepStrictEqual(validateAppSpec(appSpec({ columns: [column({ schemaName: 'new_status', type: 'Text', required: undefined })], primaryAttribute: nameColumn({ required: undefined }) }), { profile: 'deploy' }).errors, []);
});

test('required refuses every other value, naming the table, the column, the value and the accepted values', () => {
  const slips = [
    'ApplicationRequired', 'applicationrequired', 'true', 'false', 'required', 'Required', 'Recommended', 'RECOMMENDED', 'None', 'SystemRequired', 'yes', '',
    1, 0, 2, null, {}, [], ['recommended'], [true],
  ];
  for (const profile of BUILDING_PROFILES) {
    for (const value of slips) {
      const onColumn = validateAppSpec(appSpec({ columns: [column({ schemaName: 'new_status', type: 'Text', required: value })] }), { profile });
      assert.strictEqual(onColumn.ok, false, `${profile} column ${JSON.stringify(value)} must be refused`);
      assert.strictEqual(onColumn.errors.length, 1, `${profile} column ${JSON.stringify(value)}: ${JSON.stringify(onColumn.errors)}`);
      assert.ok(onColumn.errors[0].startsWith(`entity new_ticket: column new_status required must be true, false or "recommended" (got ${JSON.stringify(value)}) — `), onColumn.errors[0]);
      assert.ok(onColumn.errors[0].endsWith(`; ${OMIT_HINT}`), onColumn.errors[0]);

      const onPrimary = validateAppSpec(appSpec({ primaryAttribute: nameColumn({ required: value }) }), { profile });
      assert.strictEqual(onPrimary.ok, false, `${profile} primaryAttribute ${JSON.stringify(value)} must be refused`);
      assert.strictEqual(onPrimary.errors.length, 1, `${profile} primaryAttribute ${JSON.stringify(value)}: ${JSON.stringify(onPrimary.errors)}`);
      assert.ok(onPrimary.errors[0].startsWith(`entity new_ticket: primaryAttribute.required must be true, false or "recommended" (got ${JSON.stringify(value)}) — `), onPrimary.errors[0]);
    }
  }
});

test('the refusal of a required value says what to write for the usual slips, and that leaving the key out keeps an existing column as it is', () => {
  const errorFor = (value) => validateAppSpec(appSpec({ columns: [column({ schemaName: 'new_status', type: 'Text', required: value })] }), { profile: 'deploy' }).errors;
  for (const value of ['ApplicationRequired', 'true', 'required', 'Required', 'yes', 1]) {
    assert.deepStrictEqual(errorFor(value), [requiredError(value, 'write true for a required column')], JSON.stringify(value));
  }
  for (const value of ['Recommended', 'RECOMMENDED', ' recommended']) {
    assert.deepStrictEqual(errorFor(value), [requiredError(value, 'write "recommended" for a recommended column')], JSON.stringify(value));
  }
  for (const value of ['None', 'false', 'no', 'optional', 0]) {
    assert.deepStrictEqual(errorFor(value), [requiredError(value, 'write false for a column that is not required')], JSON.stringify(value));
  }
  for (const value of ['SystemRequired', null, {}, [], '']) {
    assert.deepStrictEqual(errorFor(value), [requiredError(value, GENERIC_HINT)], JSON.stringify(value));
  }
});

test('a column with both problems gets both errors, and a spec with several bad columns names each one', () => {
  const columns = [
    column({ schemaName: 'new_a', type: 'AutoNumber', required: 'true' }),
    column({ schemaName: 'new_b', type: 'Text', required: true }),
    column({ schemaName: 'new_c', type: 'Choice', options: ['A'], required: 'Recommended' }),
  ];
  const result = validateAppSpec(appSpec({ columns, primaryAttribute: nameColumn({ required: 'ApplicationRequired' }) }), { profile: 'deploy' });
  assert.deepStrictEqual(result.errors, [
    requiredError('ApplicationRequired', 'write true for a required column', 'primaryAttribute.required'),
    formatError('missing', 'new_a'),
    requiredError('true', 'write true for a required column', 'column new_a required'),
    requiredError('Recommended', 'write "recommended" for a recommended column', 'column new_c required'),
  ]);
});

test('structural validation, which teardown runs, still accepts a spec an earlier release built with required values the build could not use', () => {
  const spec = appSpec({
    columns: [column({ schemaName: 'new_status', type: 'Text', required: 'ApplicationRequired' }), column({ schemaName: 'new_other', type: 'Text', required: null })],
    primaryAttribute: nameColumn({ required: 'true' }),
  });
  assert.deepStrictEqual(validateAppSpec(spec, { profile: 'structural' }).errors, []);
  for (const profile of BUILDING_PROFILES) assert.strictEqual(validateAppSpec(spec, { profile }).ok, false, `${profile} refuses it`);
});

// --- the provision-entities input gate applies the same rule ----------------------------------------------------------------------
// It is the only gate between an input file and the first write of /genpage and /app-builder: the publisher and the solution are made before the first
// table, so a value the build cannot use has to stop here.

test('the provision-entities input gate refuses the required values the spec gate refuses, on a column and on the primary name column, with the same wording', () => {
  for (const value of [true, false, 'recommended', undefined, 'ApplicationRequired', 'true', 'required', 'Recommended', 'None', 1, 0, null, {}, []]) {
    const stated = value === undefined ? {} : { required: value };
    const columns = [column({ schemaName: 'new_status', type: 'Text', ...stated })];
    const primaryAttribute = nameColumn(stated);
    const spec = validateAppSpec(appSpec({ columns, primaryAttribute }), { profile: 'deploy' });
    const input = validateProvisionInput(provisionInput({ columns, primaryAttribute }));
    const label = JSON.stringify(value);
    assert.strictEqual(input.ok, [true, false, 'recommended', undefined].includes(value), `${label}: only true, false, "recommended" or no value passes`);
    assert.strictEqual(input.ok, spec.ok, label);
    assert.deepStrictEqual(input.errors.map((e) => tail(e, 'required must be')), spec.errors.map((e) => tail(e, 'required must be')), `${label}: the same verdict and wording from both gates`);
    for (const message of input.errors) assert.ok(/^entity 'new_ticket': (primaryAttribute\.required|column 'new_status' required) must be /.test(message), message);
  }
});

test('an input with a required value that is not true, false or "recommended" is refused before anything is called, on a column and on the primary name column', async () => {
  for (const value of ['ApplicationRequired', 'true', 'required', 'Recommended', 1, null]) {
    for (const where of ['column', 'primary']) {
      const d = watchedDeps();
      const input = where === 'column'
        ? provisionInput({ columns: [column({ schemaName: 'new_status', type: 'Text', required: value })] })
        : provisionInput({ primaryAttribute: nameColumn({ required: value }) });
      const result = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
      assert.strictEqual(result.ok, false, `${where} ${JSON.stringify(value)} must be refused`);
      assert.strictEqual(result.errors.length, 1, JSON.stringify(result.errors));
      assert.deepStrictEqual(d.touched, [], `${where} ${JSON.stringify(value)}: nothing was called`);
    }
  }
  // The dry run refuses it too, rather than planning a build that cannot run.
  const dry = await provisionEntities(provisionInput({ columns: [column({ schemaName: 'new_status', type: 'Text', required: 'ApplicationRequired' })] }), { apply: false }, watchedDeps());
  assert.strictEqual(dry.ok, false);
});

test('an input that states required validly is provisioned as before', async () => {
  const d = watchedDeps();
  const input = provisionInput({
    columns: [column({ schemaName: 'new_status', type: 'Text', required: true }), column({ schemaName: 'new_other', type: 'Text', required: 'recommended' }), column({ schemaName: 'new_third', type: 'Text', required: false })],
    primaryAttribute: nameColumn({ required: false }),
  });
  const result = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(d.touched.includes('createTable'), 'the table was created');
});

// --- what the build asks of the platform for each value the gate accepts --------------------------------------------------------------
// The gate's accepted set and the build's reading of a required value are one contract: each accepted value is a level, and the build asks for it.

function recordingSdk(existing = {}) {
  const calls = [];
  return {
    calls,
    sdk: {
      createTable: async (o) => { calls.push(['createTable', o]); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}`, ...(o.primaryColumnRequired && o.primaryColumnRequired !== 'None' ? { primaryColumnRequired: o.primaryColumnRequired } : {}) }; },
      updateTable: async () => ({}),
      createColumn: async (l, o) => { calls.push(['createColumn', l, o]); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
      updateColumn: async (l, c, o) => { calls.push(['updateColumn', l, c, o]); return {}; },
    },
    provision: {
      findTables: async (s) => (existing[s.toLowerCase()] ? [{ logicalName: s.toLowerCase(), entitySetName: `${s.toLowerCase()}s` }] : []),
      findColumns: async () => [],
      fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    },
  };
}

async function provision(spec, m) {
  const events = [];
  const warnings = [];
  await provisionDataModel({ sdk: m.sdk, provision: m.provision, runner: makeRunner({ emit: (e) => events.push(e), total: 99 }), spec, apply: true, preResolvedLanguageCode: 1033, warn: (w) => warnings.push(w) });
  return { events, warnings };
}

const oneTableSpec = (primaryAttribute, columns) => ({ solution: { uniqueName: 'S', publisherPrefix: 'new' }, relationships: [], entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', primaryAttribute, columns }] });

test('each required value the gate accepts is asked for as the level the schema reference names: true is ApplicationRequired, "recommended" is Recommended, false and no value are None', async () => {
  const m = recordingSdk();
  await provision(oneTableSpec({ schemaName: 'new_name', required: 'recommended' }, [
    { schemaName: 'new_a', type: 'Text', required: true }, { schemaName: 'new_b', type: 'Text', required: 'recommended' },
    { schemaName: 'new_c', type: 'Text', required: false }, { schemaName: 'new_d', type: 'Text' },
  ]), m);
  const levels = Object.fromEntries(m.calls.filter((c) => c[0] === 'createColumn').map((c) => [c[2].schemaName, c[2].required]));
  assert.deepStrictEqual(levels, { new_a: 'ApplicationRequired', new_b: 'Recommended', new_c: 'None', new_d: 'None' });
  assert.strictEqual(m.calls.find((c) => c[0] === 'createTable')[1].primaryColumnRequired, 'Recommended');

  const primaryLevels = [];
  for (const required of [true, false, undefined]) {
    const each = recordingSdk();
    await provision(oneTableSpec({ schemaName: 'new_name', ...(required === undefined ? {} : { required }) }, []), each);
    primaryLevels.push(each.calls.find((c) => c[0] === 'createTable')[1].primaryColumnRequired);
  }
  assert.deepStrictEqual(primaryLevels, ['ApplicationRequired', 'None', undefined], 'an omitted required asks the create for no level at all');
});

test('on an existing column an explicit required converges and a missing one leaves it alone — including an own property that holds undefined, which states nothing', async () => {
  const live = () => [{ logicalName: 'new_status', schemaName: 'new_status', RequiredLevel: { Value: 'ApplicationRequired' } }, { logicalName: 'new_name', schemaName: 'new_name', RequiredLevel: { Value: 'ApplicationRequired' } }];
  const run = async (required, primaryRequired) => {
    const m = recordingSdk({ new_ticket: true });
    m.provision.findColumns = async () => live();
    const stated = (value) => (value === 'absent' ? {} : { required: value });
    const result = await provision(oneTableSpec({ schemaName: 'new_name', ...stated(primaryRequired) }, [{ schemaName: 'new_status', type: 'Text', ...stated(required) }]), m);
    return { writes: m.calls.filter((c) => c[0] === 'updateColumn').map((c) => `${c[2]}:${c[3].required}`), steps: result.events.filter((e) => e.status !== 'start' && /^required /.test(e.label)).map((e) => `${e.status}: ${e.label}`) };
  };
  assert.deepStrictEqual((await run(false, false)).writes, ['new_name:None', 'new_status:None'], 'an explicit false converges: the columns are made not required, the name column first');
  assert.deepStrictEqual((await run('recommended', 'recommended')).writes, ['new_name:Recommended', 'new_status:Recommended']);
  assert.deepStrictEqual((await run(true, true)).writes, [], 'the level the spec states is the level there is');
  assert.deepStrictEqual(await run('absent', 'absent'), { writes: [], steps: [] }, 'a column the spec says nothing about is never written');
  assert.deepStrictEqual(await run(undefined, undefined), { writes: [], steps: [] }, 'and neither is one whose required holds undefined');
});

test('a new table whose primary name column holds required: undefined asks its create for no level, as when the key is left out', async () => {
  const m = recordingSdk();
  const result = await provision(oneTableSpec({ schemaName: 'new_name', required: undefined }, []), m);
  assert.strictEqual('primaryColumnRequired' in m.calls.find((c) => c[0] === 'createTable')[1], false);
  assert.deepStrictEqual(result.events.filter((e) => /^required /.test(e.label)), []);
});

// --- the other readers of a column's required: the plan document ------------------------------------------------------------------------
// The forms and the schema facts read `required === true` and nothing else (a recommended column is not a Business Required form field).

test('the plan document says "recommended" for a recommended column, "required" for a required one, and nothing for the rest', () => {
  const spec = appSpec({ columns: [
    column({ schemaName: 'new_a', displayName: 'Alpha', type: 'Text', required: true }),
    column({ schemaName: 'new_b', displayName: 'Beta', type: 'Text', required: 'recommended' }),
    column({ schemaName: 'new_c', displayName: 'Gamma', type: 'Text', required: false }),
    column({ schemaName: 'new_d', displayName: 'Delta', type: 'Text' }),
  ] });
  const rows = renderAppSpecDoc(spec).split('\n').filter((line) => /^\| (Alpha|Beta|Gamma|Delta) \|/.test(line));
  assert.deepStrictEqual(rows, ['| Alpha | Text | required |', '| Beta | Text | recommended |', '| Gamma | Text | — |', '| Delta | Text | — |']);
});

// --- a downloaded spec passes the gate ---------------------------------------------------------------------------------------------------
// The download carries no RequiredLevel at all, so what it writes passes the rule whatever level the live columns hold.

test('a downloaded table never states a required level, so the spec it makes passes the gate for every level a column can hold', () => {
  const levels = ['None', 'Recommended', 'ApplicationRequired', 'SystemRequired'];
  const attribute = (logicalName, extra) => ({ logicalName, displayName: logicalName, attributeType: 'String', isCustomAttribute: true, ...extra });
  const meta = {
    logicalName: 'new_ticket', schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name',
    attributes: [
      attribute('new_name', { RequiredLevel: { Value: 'ApplicationRequired' }, requiredLevel: 'ApplicationRequired' }),
      ...levels.map((level, i) => attribute(`new_level${i}`, { RequiredLevel: { Value: level }, requiredLevel: level })),
      attribute('new_amount', { attributeType: 'Money', RequiredLevel: { Value: 'ApplicationRequired' } }),
    ],
  };
  const entity = entityFromMetadata(meta, 'new_ticket');
  assert.deepStrictEqual(entity.columns.map((c) => c.schemaName), ['new_level0', 'new_level1', 'new_level2', 'new_level3', 'new_amount']);
  for (const c of entity.columns) assert.ok(!('required' in c), `${c.schemaName} states no required level`);
  assert.ok(!('required' in entity.primaryAttribute), 'and neither does the name column');
  for (const profile of ['plan', 'deploy']) {
    const result = validateAppSpec({ schemaVersion: 2, solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [entity], appShell: { areas: [] } }, { profile });
    assert.deepStrictEqual(result.errors, [], profile);
  }
});
