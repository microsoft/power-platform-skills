'use strict';
// The offline contract of commandStates (lib/command-state-contract.js): what a spec may say, the one form the build uses, and the exact
// approvals that let a build change a row or publish its table.

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/command-state-contract.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const ROW = '11111111-1111-4111-8111-111111111111';
const ROW2 = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://contoso.crm.dynamics.com';
const APP = '33333333-3333-4333-8333-333333333333';
const TABLE = '44444444-4444-4444-8444-444444444444';

const spec = (states, extra = {}) => ({
  minimumPluginVersion: '2.24.0',
  app: { uniqueName: 'new_app', displayName: 'App' },
  entities: [{ schemaName: 'new_Ticket', displayName: 'Ticket' }],
  commandStates: states,
  ...extra,
});
const entry = (extra = {}) => ({ entity: 'new_ticket', location: 'MainTab', scope: 'table', rowId: ROW, hidden: true, ...extra });
const findings = (s) => C.validateCommandStates(s).findings.map((f) => [f.code, f.subreason, f.path]);

test('a well-formed entry has no findings; absent or empty commandStates is not checked at all', () => {
  assert.deepStrictEqual(findings(spec([entry()])), []);
  assert.deepStrictEqual(findings(spec([entry({ hidden: undefined, disabled: false })].map(({ hidden, ...e }) => e))), []);
  assert.deepStrictEqual(findings({ app: {} }), []);
  assert.deepStrictEqual(findings({ commandStates: [] }), [], 'an empty list asks for nothing and needs no version floor');
  assert.strictEqual(C.usesCommandStates(spec([])), false);
  assert.strictEqual(C.usesCommandStates(spec([entry()])), true);
});

test('every field is closed and exact: unknown keys, bars, scopes, booleans and row ids are refused with a stable code', () => {
  const s = spec([
    entry({ isdisabled: true, label: 'x' }),
    entry({ rowId: ROW2, location: 'maintab' }),
    entry({ rowId: `{${ROW2}}` }),
    entry({ rowId: '00000000-0000-0000-0000-000000000000', hidden: 'yes' }),
    entry({ rowId: ROW.toUpperCase(), scope: 'Table' }),
    { entity: 'new_other', location: 'Grid', scope: 'table', rowId: '55555555-5555-4555-8555-555555555555' },
    'x',
  ]);
  assert.deepStrictEqual(findings(s), [
    ['command-state-spec-invalid', 'unknown-field', 'commandStates[0].isdisabled'],
    ['command-state-spec-invalid', 'unknown-field', 'commandStates[0].label'],
    ['command-state-spec-invalid', 'location-invalid', 'commandStates[1].location'],
    ['command-state-spec-invalid', 'row-id-invalid', 'commandStates[2].rowId'],
    ['command-state-spec-invalid', 'row-id-invalid', 'commandStates[3].rowId'],
    ['command-state-spec-invalid', 'boolean-required', 'commandStates[3].hidden'],
    ['command-state-spec-invalid', 'scope-invalid', 'commandStates[4].scope'],
    ['command-state-spec-invalid', 'row-id-duplicate', 'commandStates[4].rowId'],
    ['command-state-spec-invalid', 'entity-undeclared', 'commandStates[5].entity'],
    ['command-state-spec-invalid', 'location-invalid', 'commandStates[5].location'],
    ['command-state-spec-invalid', 'flags-required', 'commandStates[5]'],
    ['command-state-spec-invalid', 'object-required', 'commandStates[6]'],
  ]);
  assert.match(C.validateCommandStates(s).errors[0], /^command-state-spec-invalid: commandStates\[0\]\.isdisabled \(unknown-field\): .*use disabled/);
  assert.deepStrictEqual(findings(spec('x')), [['command-state-spec-invalid', 'array-required', 'commandStates']]);
});

test('scope "app" is refused as unverified in this version, not as a typo', () => {
  assert.deepStrictEqual(findings(spec([entry({ scope: 'app' })])), [['command-state-app-scope-unverified', null, 'commandStates[0].scope']]);
});

test('the spec must name its app and require 2.24.0 or newer, so an older plugin refuses it instead of ignoring it', () => {
  assert.deepStrictEqual(findings(spec([entry()], { minimumPluginVersion: '2.23.9', app: {} })), [
    ['command-state-spec-invalid', 'app-unique-name-required', 'app.uniqueName'],
    ['command-state-spec-invalid', 'version-floor-required', 'minimumPluginVersion'],
  ]);
  assert.deepStrictEqual(findings(spec([entry()], { minimumPluginVersion: '2.25.0' })), []);
  assert.deepStrictEqual(findings(spec([entry()], { minimumPluginVersion: undefined })).map((f) => f[1]), ['version-floor-required']);
});

test('validateAppSpec reports the findings as errors, and as warnings for the structural profile', () => {
  const bad = spec([entry({ scope: 'app' })]);
  const strict = validateAppSpec(bad);
  assert.ok(strict.errors.some((e) => e.startsWith('command-state-app-scope-unverified: commandStates[0].scope')), strict.errors.join('\n'));
  const structural = validateAppSpec(bad, { profile: 'structural' });
  assert.ok(!structural.errors.some((e) => e.startsWith('command-state-')));
  assert.ok(structural.warnings.some((e) => e.startsWith('command-state-app-scope-unverified')));
});

test('normalize lower-cases names and ids, maps the bar to its location, and keeps only the flags the entry sets, by column name', () => {
  const s = spec([entry({ entity: 'New_Ticket', rowId: ROW.toUpperCase().replace('-4111', '-4111'), disabled: false }), entry({ rowId: ROW2, location: 'ContextualTab', hidden: undefined })]);
  delete s.commandStates[1].hidden;
  s.commandStates[1].disabled = true;
  assert.deepStrictEqual(C.normalizeCommandStates(s), [
    { entity: 'new_ticket', bar: 'MainTab', location: 0, scope: 'table', rowId: ROW, desired: { hidden: true, isdisabled: false } },
    { entity: 'new_ticket', bar: 'ContextualTab', location: 2, scope: 'table', rowId: ROW2, desired: { isdisabled: true } },
  ]);
  assert.deepStrictEqual(C.normalizeCommandStates(spec([])), []);
  assert.deepStrictEqual(C.diffCommandFlags({ hidden: false, isdisabled: true }, { hidden: true, isdisabled: true }), { hidden: false }, 'false is an instruction, an equal flag is not sent');
  assert.deepStrictEqual(C.diffCommandFlags({}, { hidden: true, isdisabled: true }), {});
});

test('a row approval names one version of one row under one intent in one environment; a table approval names the table only', () => {
  const base = { origin: ORIGIN, appId: APP, tableId: TABLE, entity: 'new_ticket', location: 0, rowId: ROW, ifMatch: 'W/"1001"', desired: { hidden: true } };
  const key = C.commandStateApprovalKey(base);
  assert.match(key, new RegExp(`^overwrite:command-state:new_ticket/MainTab/${ROW}/[0-9a-f]{64}$`));
  assert.strictEqual(C.commandStateApprovalKey({ ...base, origin: 'HTTPS://CONTOSO.crm.dynamics.com/main.aspx', entity: 'NEW_TICKET', appId: APP.toUpperCase() }), key, 'the same row and intent spelled differently is the same approval');
  for (const change of [{ ifMatch: 'W/"1002"' }, { origin: 'https://fabrikam.crm.dynamics.com' }, { desired: { hidden: false } }, { desired: { hidden: true, isdisabled: false } }, { appId: ROW2 }, { tableId: ROW2 }, { location: 1 }]) {
    assert.notStrictEqual(C.commandStateApprovalKey({ ...base, ...change }), key, JSON.stringify(change));
  }
  const table = C.commandTablePublishApprovalKey(base);
  assert.match(table, /^publish:command-state-table:new_ticket\/[0-9a-f]{64}$/);
  assert.strictEqual(C.commandTablePublishApprovalKey({ ...base, ifMatch: 'W/"9"', rowId: ROW2 }), table, 'publishing is per table, whatever row changed');
  assert.notStrictEqual(C.commandTablePublishApprovalKey({ ...base, tableId: ROW2 }), table);
});

test('authorization keys: both token families are claimed; a malformed or undeclared one is a problem, never passed on as another feature\u2019s', () => {
  const s = spec([entry()]);
  const row = C.commandStateApprovalKey({ origin: ORIGIN, appId: APP, tableId: TABLE, entity: 'new_ticket', location: 0, rowId: ROW, ifMatch: 'W/"1"', desired: { hidden: true } });
  const table = C.commandTablePublishApprovalKey({ origin: ORIGIN, appId: APP, tableId: TABLE, entity: 'new_ticket' });
  const otherRow = row.replace(ROW, ROW2);
  const otherTable = table.replace('new_ticket', 'new_other');
  const r = C.commandStateAuthorizationKeys([row, table, 'overwrite:view:new_ticket/x', otherRow, otherTable, 'OVERWRITE:command-state:new_ticket/MainTab/*', `${table}0`], s);
  assert.deepStrictEqual([...r.rows], [row]);
  assert.deepStrictEqual([...r.tables], [table]);
  assert.deepStrictEqual(r.rest, ['overwrite:view:new_ticket/x']);
  assert.strictEqual(r.problems.length, 4, r.problems.join('\n'));
  assert.match(r.problems[0], /no commandStates entry declares/);
  assert.match(r.problems[1], /no commandStates entry declares/);
  assert.match(r.problems[2], /exactly as the build prints it/);
  // A spec with no (valid) command states claims the tokens and accepts none of them.
  const none = C.commandStateAuthorizationKeys([row, table, 'x'], { commandStates: [{}] });
  assert.deepStrictEqual([none.rows.size, none.tables.size, none.rest, none.problems.length], [0, 0, ['x'], 2]);
});
