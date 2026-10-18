'use strict';

// An `AutoNumber` column needs a usable `autoNumberFormat`, and the spec gate says so before anything is built.
//
// The SDK refuses to create an `autonumber` column without a format, before any request, where the SDK it replaced created a plain text column. A spec
// with an AutoNumber column and no format therefore used to build (as text) and now halts the data-model phase at that column, after the solution and
// the tables exist. The rule lives in lib/app-spec.js (autoNumberFormatProblem) and is applied by BOTH gates a build can come through: validateAppSpec
// (/app-builder) and the provision-entities input validator (/genpage and /app-builder). Teardown validates under the structural profile and must keep
// accepting a spec an earlier release built from such a column, so that profile does not apply it.
//
// What the SDK itself does — the refusal, the halt a spec that got past the gate causes, and a rebuild that finds the column already there — is pinned
// against the real bundle in table-columns-in-create.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateAppSpec } = require('../lib/app-spec.js');
const { validateProvisionInput } = require('../lib/provision-input.js');
const { provisionEntities } = require('../provision-entities.js');
const { entityFromMetadata } = require('../download-model-app.js');
const { BUILDING_PROFILES, column, nameColumn, appSpec, provisionInput, tail, watchedDeps } = require('./helpers/column-gate-specs.js');

const FORMAT_HINT = 'give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column';
const formatError = (state, name = 'new_ref') => `entity new_ticket: column ${name} is an AutoNumber column but its autoNumberFormat is ${state} — ${FORMAT_HINT}`;

test('an AutoNumber column with no autoNumberFormat is refused before anything is built, naming the table, the column and both ways out', () => {
  for (const profile of BUILDING_PROFILES) {
    for (const spelled of [{}, { autoNumberFormat: undefined }, { autoNumberFormat: null }]) {
      const result = validateAppSpec(appSpec({ columns: [column({ type: 'AutoNumber', ...spelled })] }), { profile });
      assert.strictEqual(result.ok, false, `${profile} ${JSON.stringify(spelled)} must be refused`);
      assert.deepStrictEqual(result.errors, [formatError('missing')], `${profile} ${JSON.stringify(spelled)}`);
    }
  }
});

test('an AutoNumber column whose autoNumberFormat is blank or not a string is refused the same way, saying what was found', () => {
  const found = [
    ['', 'blank'], ['   ', 'blank'], ['\t\n', 'blank'],
    [5, 'not a string (got 5)'], [0, 'not a string (got 0)'], [false, 'not a string (got false)'], [true, 'not a string (got true)'],
    [{}, 'not a string (got {})'], [['C-{SEQNUM:5}'], 'not a string (got ["C-{SEQNUM:5}"])'],
  ];
  for (const [format, state] of found) {
    const result = validateAppSpec(appSpec({ columns: [column({ type: 'AutoNumber', autoNumberFormat: format })] }), { profile: 'deploy' });
    assert.strictEqual(result.ok, false, `${JSON.stringify(format)} must be refused`);
    assert.deepStrictEqual(result.errors, [formatError(state)], JSON.stringify(format));
  }
});

test('every AutoNumber column that lacks a format is named, in whichever position it stands', () => {
  const columns = [
    column({ schemaName: 'new_a', type: 'Text' }),
    column({ schemaName: 'new_b', type: 'AutoNumber', autoNumberFormat: 'B-{SEQNUM:4}' }),
    column({ schemaName: 'new_c', type: 'AutoNumber' }),
    column({ schemaName: 'new_d', type: 'Integer' }),
    column({ schemaName: 'new_e', type: 'AutoNumber', autoNumberFormat: ' ' }),
  ];
  const result = validateAppSpec(appSpec({ columns }), { profile: 'deploy' });
  assert.deepStrictEqual(result.errors, [formatError('missing', 'new_c'), formatError('blank', 'new_e')]);
});

test('a usable autoNumberFormat is accepted, and a format on a column that is not AutoNumber is left to the build as before', () => {
  for (const format of ['C-{SEQNUM:5}', 'ABC', '{SEQNUM:3}-{RANDSTRING:4}', ' WO-{SEQNUM:5} ']) {
    const result = validateAppSpec(appSpec({ columns: [column({ type: 'AutoNumber', autoNumberFormat: format })] }), { profile: 'deploy' });
    assert.deepStrictEqual(result.errors, [], JSON.stringify(format));
  }
  const others = [column({ schemaName: 'new_t', type: 'Text' }), column({ schemaName: 'new_u', type: 'Text', autoNumberFormat: '' }), column({ schemaName: 'new_i', type: 'Integer' }), column({ schemaName: 'new_n' })];
  assert.deepStrictEqual(validateAppSpec(appSpec({ columns: others }), { profile: 'deploy' }).errors, []);
});

test('the primary name column is judged as before: with no autoNumberFormat, a blank one or a format, the spec is accepted', () => {
  for (const autoNumberFormat of [undefined, '', null, 'WO-{SEQNUM:5}']) {
    const primaryAttribute = nameColumn(autoNumberFormat === undefined ? {} : { autoNumberFormat });
    assert.deepStrictEqual(validateAppSpec(appSpec({ primaryAttribute }), { profile: 'deploy' }).errors, [], JSON.stringify(autoNumberFormat));
    assert.deepStrictEqual(validateProvisionInput(provisionInput({ primaryAttribute })).errors, [], `${JSON.stringify(autoNumberFormat)} through the provision-entities gate`);
  }
});

test('structural validation, which teardown runs, still accepts a spec an earlier release built with an AutoNumber column that has no format', () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_b', type: 'AutoNumber', autoNumberFormat: '' })] });
  assert.deepStrictEqual(validateAppSpec(spec, { profile: 'structural' }).errors, []);
  for (const profile of BUILDING_PROFILES) assert.strictEqual(validateAppSpec(spec, { profile }).ok, false, `${profile} refuses it`);
});

// --- the provision-entities input gate applies the same rule --------------------------------------------------------------------
// It is the only gate between an input file and the first write of /genpage and /app-builder: the publisher and the solution are made before the
// first table, so a column the build cannot create has to stop here.

test('the provision-entities input gate refuses the AutoNumber columns the spec gate refuses, with the same wording', () => {
  for (const format of [undefined, null, '', '  ', 5, true, {}, [], 'C-{SEQNUM:5}']) {
    const columns = [column({ type: 'AutoNumber', ...(format === undefined ? {} : { autoNumberFormat: format }) })];
    const spec = validateAppSpec(appSpec({ columns }), { profile: 'deploy' });
    const input = validateProvisionInput(provisionInput({ columns }));
    const label = JSON.stringify(format);
    assert.strictEqual(input.ok, format === 'C-{SEQNUM:5}', `${label}: only a usable format passes`);
    assert.strictEqual(input.ok, spec.ok, label);
    assert.deepStrictEqual(input.errors.map((e) => tail(e, ' is an AutoNumber column')), spec.errors.map((e) => tail(e, ' is an AutoNumber column')), `${label}: the same verdict and wording from both gates`);
    for (const message of input.errors) assert.ok(message.startsWith("entity 'new_ticket': column 'new_ref' "), message);
  }
});

test('an input with an AutoNumber column that has no format is refused before anything is called — no publisher, no solution, no table', async () => {
  for (const format of [undefined, '', '  ', 5]) {
    const d = watchedDeps();
    const columns = [column({ schemaName: 'new_ref', type: 'AutoNumber', ...(format === undefined ? {} : { autoNumberFormat: format }) })];
    const result = await provisionEntities(provisionInput({ columns }), { apply: true }, { sdk: d.sdk, provision: d.provision });
    assert.strictEqual(result.ok, false, `${JSON.stringify(format)} must be refused`);
    assert.ok(result.errors.some((e) => /^entity 'new_ticket': column 'new_ref' is an AutoNumber column but its autoNumberFormat is /.test(e)), JSON.stringify(result.errors));
    assert.deepStrictEqual(d.touched, [], `${JSON.stringify(format)}: nothing was called`);
  }
  // The dry run refuses it too, rather than planning a build that cannot run.
  const dry = await provisionEntities(provisionInput({ columns: [column({ type: 'AutoNumber' })] }), { apply: false }, watchedDeps());
  assert.strictEqual(dry.ok, false);
});

test('an input whose AutoNumber column has a format is provisioned as before', async () => {
  const d = watchedDeps();
  const input = provisionInput({ columns: [column({ type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}' }), column({ schemaName: 'new_note', type: 'Text' })], primaryAttribute: nameColumn({ autoNumberFormat: 'WO-{SEQNUM:5}' }) });
  const result = await provisionEntities(input, { apply: true }, { sdk: d.sdk, provision: d.provision });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(d.touched.includes('createTable'), 'the table was created');
  assert.ok(d.touched.includes('createColumn'), 'and its columns');
});

// --- a downloaded spec passes the gate ----------------------------------------------------------------------------------------------
// An auto-number column is a String attribute (formally a text column with a format), so the download reads it as Text and states no format: the spec it
// makes never carries an AutoNumber column, with or without a format.

test('a downloaded auto-number column is declared Text with no autoNumberFormat, and the spec it makes passes the gate', () => {
  const attribute = (logicalName, extra) => ({ logicalName, displayName: logicalName, attributeType: 'String', isCustomAttribute: true, ...extra });
  const meta = {
    logicalName: 'new_ticket', schemaName: 'new_ticket', displayName: 'Ticket', primaryNameAttribute: 'new_name',
    attributes: [
      attribute('new_name', { AutoNumberFormat: 'WO-{SEQNUM:5}', autoNumberFormat: 'WO-{SEQNUM:5}' }),
      attribute('new_ref', { AutoNumberFormat: 'C-{SEQNUM:5}', autoNumberFormat: 'C-{SEQNUM:5}' }),
      attribute('new_plain', {}),
    ],
  };
  const entity = entityFromMetadata(meta, 'new_ticket');
  assert.deepStrictEqual(entity.columns.map((c) => [c.schemaName, c.type]), [['new_ref', 'Text'], ['new_plain', 'Text']]);
  for (const c of entity.columns) assert.ok(!('autoNumberFormat' in c), `${c.schemaName} states no format`);
  assert.ok(!('autoNumberFormat' in entity.primaryAttribute), 'and neither does the name column');
  for (const profile of ['plan', 'deploy']) {
    const result = validateAppSpec({ schemaVersion: 2, solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' }, entities: [entity], appShell: { areas: [] } }, { profile });
    assert.deepStrictEqual(result.errors, [], profile);
  }
});
