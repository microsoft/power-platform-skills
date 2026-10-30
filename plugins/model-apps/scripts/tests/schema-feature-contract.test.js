'use strict';
// The schema-feature contract (lib/schema-feature-contract.js): the option-value normalizer every choice consumer shares, the
// validation of the new data-model fields, the column-type comparison a verify uses, and the table-flag plan/apply/verify.
const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../lib/schema-feature-contract.js');

function spec(extra = {}) {
  return Object.assign({
    entities: [{ schemaName: 'new_case', columns: [] }],
  }, extra);
}
const errorsOf = (s) => c.validateSchemaFeatures(s).errors;
const warningsOf = (s) => c.validateSchemaFeatures(s).warnings;

// ------------------------------------------------------------------------------------------------ option values

test('normalizeChoiceOptions keeps the positional default numbering for strings and localized maps', () => {
  const opts = ['Open', { 1033: 'Closed', 3082: 'Cerrado' }];
  assert.deepEqual(c.normalizeChoiceOptions(opts), [
    { value: 100000000, label: 'Open', explicit: false },
    { value: 100000001, label: { 1033: 'Closed', 3082: 'Cerrado' }, explicit: false },
  ]);
  assert.deepEqual(c.choiceOptionsForSdk(opts), [{ value: 100000000, label: 'Open' }, { value: 100000001, label: { 1033: 'Closed', 3082: 'Cerrado' } }]);
});

test('normalizeChoiceOptions takes an explicit { value, label } as written, and mixes with positional entries', () => {
  const opts = [{ value: 1, label: 'Low' }, 'Medium', { value: 7, label: { 1033: 'High', 1036: 'Haut' } }];
  assert.deepEqual(c.choiceOptionsForSdk(opts), [
    { value: 1, label: 'Low' }, { value: 100000001, label: 'Medium' }, { value: 7, label: { 1033: 'High', 1036: 'Haut' } },
  ]);
  assert.deepEqual(c.choiceOptionLabels(opts), ['Low', 'Medium', { 1033: 'High', 1036: 'Haut' }]);
  assert.equal(c.hasExplicitChoiceValues(opts), true);
  assert.equal(c.hasExplicitChoiceValues(['A', { 1033: 'B' }]), false);
});

test('an LCID map is never mistaken for the explicit form, and a partial wrapper is', () => {
  assert.equal(c.isChoiceOptionObject({ 1033: 'Open' }), false);
  assert.equal(c.isChoiceOptionObject({ label: 'Open' }), true);
  assert.equal(c.isChoiceOptionObject({ value: 3 }), true);
});

test('a list that is not an array throws as the build\'s option mapping always did; labels of one are empty', () => {
  assert.throws(() => c.choiceOptionsForSdk('not a list'), /is not a function/);
  assert.deepEqual(c.choiceOptionsForSdk(undefined), []);
  assert.deepEqual(c.choiceOptionLabels('not a list'), []);
  assert.deepEqual([...c.choiceLabelIndex('not a list')], []);
});

test('choiceOptionErrors rejects partial wrappers, extra keys, out-of-range values and colliding resolved values', () => {
  assert.deepEqual(c.choiceOptionErrors(['A', { 1033: 'B' }, { value: 0, label: 'C' }], 'o'), []);
  assert.match(c.choiceOptionErrors([{ label: 'A' }], 'o')[0], /o\[0\] must have exactly 'value' and 'label' \(missing value\)/);
  assert.match(c.choiceOptionErrors([{ value: 1, label: 'A', color: 'red' }], 'o')[0], /unknown color/);
  assert.match(c.choiceOptionErrors([{ value: -1, label: 'A' }], 'o')[0], /whole number from 0 to 2147483647/);
  assert.match(c.choiceOptionErrors([{ value: 2147483648, label: 'A' }], 'o')[0], /whole number/);
  assert.match(c.choiceOptionErrors([{ value: 1.5, label: 'A' }], 'o')[0], /whole number/);
  assert.match(c.choiceOptionErrors([{ value: '1', label: 'A' }], 'o')[0], /whole number/);
  // 'B' at index 1 resolves to 100000001, the value the first entry states.
  assert.match(c.choiceOptionErrors([{ value: 100000001, label: 'A' }, 'B'], 'o')[0], /o\[1\] has value 100000001, which option 0 already uses/);
  assert.match(c.choiceOptionErrors([{ value: 4, label: 'A' }, { value: 4, label: 'B' }], 'o')[0], /must be unique/);
  assert.match(c.choiceOptionErrors([{ value: 4, label: 7 }], 'o')[0], /label must be a label/);
});

test('choiceLabelIndex names every value an alias reaches, so an ambiguous alias is visible', () => {
  const idx = c.choiceLabelIndex([{ value: 1, label: { 1033: 'Open', 3082: 'Abierto' } }, { value: 2, label: { 1033: 'Abierto' } }]);
  assert.deepEqual(idx.get('abierto'), [1, 2]);
  assert.deepEqual(idx.get('open'), [1]);
});

// ------------------------------------------------------------------------------------------------ validation

test('validateSchemaFeatures: an ordinary spec has no errors, no warnings', () => {
  const s = spec({ entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_a', type: 'Choice', options: ['A', 'B'] }] }] });
  assert.deepEqual(c.validateSchemaFeatures(s), { errors: [], warnings: [] });
  assert.equal(c.usesSchemaFeatures(s), false);
});

test('validateSchemaFeatures: isSecured must be boolean and is refused on a Customer column', () => {
  assert.match(errorsOf(spec({ entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_a', isSecured: 'yes' }] }] }))[0], /isSecured must be a boolean/);
  assert.match(errorsOf(spec({ entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_c', type: 'Customer', isSecured: true }] }] }))[0], /not supported on a Customer column/);
  assert.deepEqual(errorsOf(spec({ entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_a', isSecured: false }] }] })), []);
});

test('validateSchemaFeatures: dateTimeBehavior is DateTime-only, from the closed set, and DateOnly refuses a DateAndTime format', () => {
  const col = (x) => spec({ entities: [{ schemaName: 'new_case', columns: [Object.assign({ schemaName: 'new_d', type: 'DateTime' }, x)] }] });
  for (const b of c.DATE_TIME_BEHAVIORS) assert.deepEqual(errorsOf(col({ dateTimeBehavior: b })), [], b);
  assert.match(errorsOf(col({ dateTimeBehavior: 'Local' }))[0], /UserLocal\|DateOnly\|TimeZoneIndependent/);
  assert.match(errorsOf(col({ type: 'Text', dateTimeBehavior: 'DateOnly' }))[0], /only to a DateTime column, not 'Text'/);
  assert.match(errorsOf(col({ dateTimeBehavior: 'DateOnly', dateFormat: 'DateAndTime' }))[0], /cannot have dateFormat 'DateAndTime'/);
  assert.deepEqual(errorsOf(col({ dateTimeBehavior: 'DateOnly', dateFormat: 'DateOnly' })), []);
});

test('validateSchemaFeatures: table flags — changeTrackingEnabled only true, search true needs explicit tracking', () => {
  const ent = (x) => spec({ entities: [Object.assign({ schemaName: 'new_case', columns: [] }, x)] });
  assert.match(errorsOf(ent({ changeTrackingEnabled: false }))[0], /can only be true/);
  assert.match(errorsOf(ent({ searchEnabled: true }))[0], /set changeTrackingEnabled: true to confirm/);
  assert.deepEqual(errorsOf(ent({ searchEnabled: true, changeTrackingEnabled: true })), []);
  assert.deepEqual(errorsOf(ent({ searchEnabled: false, duplicateDetectionEnabled: false })), []);
  assert.match(errorsOf(ent({ duplicateDetectionEnabled: 'on' }))[0], /duplicateDetectionEnabled must be a boolean/);
});

test('validateSchemaFeatures: option errors reach both column and global choices', () => {
  const s = spec({
    entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_p', type: 'Choice', options: [{ label: 'A' }] }] }],
    globalChoices: [{ name: 'new_g', options: [{ value: 1, label: 'A' }, { value: 1, label: 'B' }] }],
  });
  const errs = errorsOf(s);
  assert.ok(errs.some((e) => /columns\[0\] \(new_p\)\.options\[0\]/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /globalChoices\[0\] \(new_g\)\.options\[1\]/.test(e)), errs.join('\n'));
});

function fsp(profile, columns = [{ schemaName: 'new_salary', isSecured: true }]) {
  return spec({ entities: [{ schemaName: 'new_employee', columns }], fieldSecurityProfiles: [profile] });
}
const PERM = { table: 'new_employee', column: 'new_salary', read: true };

test('fieldSecurityProfiles: a well-formed profile validates; its keys are closed', () => {
  assert.deepEqual(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM], assignTo: { teams: ['0f8fad5b-d9cb-469f-a165-70867728950e'] } })), []);
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM], role: 'x' }))[0], /unknown property 'role'/);
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM], assignTo: { roles: [] } }))[0], /assignTo: unknown property 'roles'/);
});

test('fieldSecurityProfiles: readUnmasked, the platform profile name, duplicate keys/names and long names are refused', () => {
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [Object.assign({ readUnmasked: true }, PERM)] })).join('\n'), /readUnmasked is not supported/);
  assert.equal(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [Object.assign({ readUnmasked: true }, PERM)] })).filter((e) => /unknown property/.test(e)).length, 0);
  assert.match(errorsOf(fsp({ key: 'hr', name: 'system administrator', permissions: [] }))[0], /platform's own profile/);
  assert.match(errorsOf(fsp({ key: 'hr', name: 'x'.repeat(101), permissions: [] }))[0], /at most 100/);
  const two = spec({ entities: [], fieldSecurityProfiles: [{ key: 'a', name: 'Same', permissions: [] }, { key: 'a', name: 'same', permissions: [] }] });
  const errs = errorsOf(two);
  assert.ok(errs.some((e) => /key 'a' is used by another profile/.test(e)));
  assert.ok(errs.some((e) => /name 'same' is used by another profile/.test(e)));
});

test('fieldSecurityProfiles: a permission on a declared unsecured column is an error; on an undeclared column a warning', () => {
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM] }, [{ schemaName: 'new_salary' }]))[0], /new_employee\.new_salary is not secured/);
  const w = warningsOf(fsp({ key: 'hr', name: 'HR', permissions: [{ table: 'account', column: 'new_tax', read: true }] }));
  assert.ok(w.some((x) => /account\.new_tax is not declared in this spec/.test(x)), w.join('\n'));
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM, Object.assign({}, PERM, { read: false })] }))[0], /has another permission/);
});

test('fieldSecurityProfiles: assignTo ids must be canonical GUIDs and unique', () => {
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM], assignTo: { users: ['{0f8fad5b-d9cb-469f-a165-70867728950e}'] } }))[0], /must be a GUID/);
  assert.match(errorsOf(fsp({ key: 'hr', name: 'HR', permissions: [PERM], assignTo: { users: ['0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5b-d9cb-469f-a165-70867728950e'] } }))[0], /repeats an id/);
});

test('a spec using any new field is told to raise minimumPluginVersion; one that already does is not', () => {
  const s = spec({ entities: [{ schemaName: 'new_case', columns: [{ schemaName: 'new_d', type: 'DateTime', dateTimeBehavior: 'DateOnly' }] }] });
  assert.match(warningsOf(s).join('\n'), /minimumPluginVersion to '2\.21\.0'/);
  assert.deepEqual(warningsOf(Object.assign({}, s, { minimumPluginVersion: '2.21.0' })), []);
  const opts = spec({ globalChoices: [{ name: 'g', options: [{ value: 3, label: 'A' }] }] });
  assert.equal(c.usesSchemaFeatures(opts), true);
});

// ------------------------------------------------------------------------------------------------ column types (L25)

test('columnTypeMismatches reports a declared type the deployed column does not have, by type NAME', () => {
  const entity = { schemaName: 'new_Case', columns: [
    { schemaName: 'new_amount', type: 'Decimal' }, { schemaName: 'new_photo', type: 'Image' },
    { schemaName: 'new_note', type: 'Text' }, { schemaName: 'new_tags', type: 'MultiChoice' }, { schemaName: 'new_gone', type: 'Text' },
  ] };
  const deployed = [
    { LogicalName: 'new_amount', AttributeType: 'Money', AttributeTypeName: { Value: 'MoneyType' } },
    { LogicalName: 'new_photo', AttributeType: 'Virtual', AttributeTypeName: { Value: 'ImageType' } },
    { LogicalName: 'new_note', AttributeType: 'Memo' },
    { LogicalName: 'new_tags', AttributeType: 'Virtual' },
  ];
  const r = c.columnTypeMismatches(entity, deployed);
  assert.deepEqual(r.mismatches, [
    { table: 'new_case', column: 'new_amount', declared: 'Decimal', deployed: 'MoneyType' },
    { table: 'new_case', column: 'new_note', declared: 'Text', deployed: 'Memo' },
  ]);
  assert.deepEqual(r.unknown, [{ table: 'new_case', column: 'new_tags', declared: 'MultiChoice' }]);
});

// ------------------------------------------------------------------------------------------------ table flags

function rawProvision(body, status = 200) {
  const gets = [];
  return { gets, provision: { dataverse: { get: async (p) => { gets.push(p); return { status, body }; } } } };
}

test('readTableFlags: one scalar read; booleans only — anything else is unknown, never false', async () => {
  const r = rawProvision({ IsDuplicateDetectionEnabled: { Value: true }, ChangeTrackingEnabled: false, SyncToExternalSearchIndex: null, CanEnableSyncToExternalSearchIndex: { Value: true } });
  const flags = await c.readTableFlags(r.provision, "new_o'case");
  assert.deepEqual(flags, { duplicateDetectionEnabled: true, changeTrackingEnabled: false, searchEnabled: undefined, canEnableSearch: true });
  assert.equal(r.gets.length, 1);
  assert.equal(r.gets[0], "/EntityDefinitions(LogicalName='new_o''case')?$select=IsDuplicateDetectionEnabled,ChangeTrackingEnabled,SyncToExternalSearchIndex,CanEnableSyncToExternalSearchIndex");
  assert.equal(await c.readTableFlags(rawProvision({}, 404).provision, 'x'), null);
  assert.equal(await c.readTableFlags({}, 'x'), null);
});

test('planTableFlags: nothing declared plans nothing; a flag already at its value is not written', () => {
  assert.deepEqual(c.planTableFlags({ schemaName: 'new_case' }, null), { operations: [], unknown: [], refused: [] });
  const p = c.planTableFlags({ schemaName: 'new_case', searchEnabled: true, changeTrackingEnabled: true, duplicateDetectionEnabled: true },
    { duplicateDetectionEnabled: true, changeTrackingEnabled: true, searchEnabled: true, canEnableSearch: true });
  assert.deepEqual(p.operations, []);
});

test('planTableFlags: search on an untracked table carries the tracking consent; search off clears only search', () => {
  const on = c.planTableFlags({ schemaName: 'new_case', searchEnabled: true, changeTrackingEnabled: true }, { changeTrackingEnabled: false, searchEnabled: false, canEnableSearch: true });
  assert.deepEqual(on.operations[0].changes, { searchEnabled: true, changeTrackingEnabled: true });
  assert.deepEqual(on.operations[0].publicationScopes, []);
  const off = c.planTableFlags({ schemaName: 'new_case', searchEnabled: false }, { changeTrackingEnabled: true, searchEnabled: true, canEnableSearch: true });
  assert.deepEqual(off.operations[0].changes, { searchEnabled: false });
});

test('planTableFlags: search where the table forbids it is refused before any write', () => {
  const p = c.planTableFlags({ schemaName: 'new_case', searchEnabled: true, changeTrackingEnabled: true }, { changeTrackingEnabled: true, searchEnabled: false, canEnableSearch: false });
  assert.equal(p.refused[0].code, 'TABLE_SEARCH_NOT_ALLOWED');
  assert.deepEqual(p.operations, []);
});

test('planTableFlags: duplicate detection off is destructive — refused without authority, planned with it', () => {
  const e = { schemaName: 'new_case', duplicateDetectionEnabled: false };
  const cur = { duplicateDetectionEnabled: true };
  const refused = c.planTableFlags(e, cur);
  assert.equal(refused.refused[0].code, 'DESTRUCTIVE_NOT_AUTHORIZED');
  assert.deepEqual(refused.operations, []);
  const ok = c.planTableFlags(e, cur, { authorizedDestructive: new Set(['tableFlags:new_case']) });
  assert.equal(ok.operations[0].destructive, true);
  assert.deepEqual(ok.operations[0].publicationScopes, ['table:new_case']);
  // Off already: nothing to do, nothing to authorize.
  assert.deepEqual(c.planTableFlags(e, { duplicateDetectionEnabled: false }).refused, []);
});

test('planTableFlags: an unread table writes every declared flag and says so', () => {
  const p = c.planTableFlags({ schemaName: 'new_case', changeTrackingEnabled: true, duplicateDetectionEnabled: true }, null);
  assert.deepEqual(p.operations[0].changes, { duplicateDetectionEnabled: true, changeTrackingEnabled: true });
  assert.equal(p.unknown[0].code, 'TABLE_FLAGS_UNREAD');
});

test('applyTableFlags writes once per table, queues publication only for duplicate detection, and maps a search refusal', async () => {
  const calls = [];
  const queued = [];
  const sdk = { updateTable: async (t, o) => { calls.push([t, o]); if (o.searchEnabled) { const e = new Error('no'); e.name = 'TableSearchNotAllowedError'; throw e; } } };
  const plan = {
    operations: [
      { key: 'tableFlags:a', kind: 'tableFlags', target: 'a', changes: { duplicateDetectionEnabled: true }, publicationScopes: ['table:a'] },
      { key: 'tableFlags:b', kind: 'tableFlags', target: 'b', changes: { searchEnabled: true, changeTrackingEnabled: true }, publicationScopes: [] },
    ],
    refused: [],
  };
  const r = await c.applyTableFlags(plan, { sdk, publication: { queue: (s) => queued.push(s) } });
  assert.deepEqual(calls.map((x) => x[0]), ['a', 'b']);
  assert.deepEqual(r.saved, ['tableFlags:a']);
  assert.deepEqual(r.pendingPublish, ['tableFlags:a']);
  assert.deepEqual(queued, ['table:a']);
  assert.equal(r.refused[0].code, 'TABLE_SEARCH_NOT_ALLOWED');
  // Any other failure is the runner's to turn into a halt.
  await assert.rejects(c.applyTableFlags({ operations: [plan.operations[0]] }, { sdk: { updateTable: async () => { throw new Error('boom'); } } }), /boom/);
});

test('verifyTableFlags: pass, fail and unknown are distinct', () => {
  const checks = c.verifyTableFlags({ schemaName: 'new_case', searchEnabled: true, changeTrackingEnabled: true, duplicateDetectionEnabled: false },
    { searchEnabled: true, changeTrackingEnabled: undefined, duplicateDetectionEnabled: true });
  assert.deepEqual(checks.map((x) => x.status), ['pass', 'unknown', 'fail']);
});
