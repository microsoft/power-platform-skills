'use strict';
// ADO 6691114 — view-filter option LABELS must resolve against the option metadata the ENVIRONMENT holds
// whenever the spec alone cannot prove the value, and a label that matches nothing must stop the build BEFORE
// it writes anything.
//
// The gap, reproduced live against the released build: a view on an EXISTING table the spec declares no column
// of — `{ "schemaName": "account", "existing": true }` with the filter `{ "attr": "industrycode", "op": "eq",
// "value": "Accounting" }` — passes lint, and then `resolveFilterValue` (sdk-build.js) sends the label raw: it
// resolves only through `choiceValueMap` (app-spec.js), which knows the options a SPEC column declares, numbered
// 100000000 + index. Dataverse rejects the saved view (HTTP 400, an invalid-fetch error naming the integer the
// column expects) MID-BUILD, after the tables and columns were written. `industrycode` is a LOCAL option set; a
// column bound to a SYSTEM global choice is the same case.
//   1. a filter on a LOCAL option set of an existing table the spec does not declare (the reproduced failure);
//   2. the same, on a column bound to a SYSTEM global choice;
//   3. a declared global choice that already existed with other values — the SDK's createGlobalOptionSet REUSES
//      an existing set unchanged, so 100000000 + index was never what the filter needed.
// (A column bound to a global choice the spec does not declare is a lint ERROR, so that never reaches the build.)
// A label that matches nothing halts naming the view, the column and the valid labels — before any view is
// written, and, where the environment already shows it, before the build writes anything at all; a dry run
// reports it; verify expects the value the build wrote.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  labelUses,
  hasLabelUses,
  resolveViewFilterLabels,
  checkViewFilterLabelsBeforeBuild,
  describeProblems,
  readChoiceAttributes,
  readGlobalChoiceOptions,
  makeChoiceReader,
  makeGlobalChoiceReader,
} = require('../lib/view-filter-labels.js');
const { runSdkBuild, viewDef, annotateLivePlan, planFor, BuildHalt } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { isTransientHalt, buildModelApp } = require('../build-model-app.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const lbl = (...pairs) => ({
  LocalizedLabels: pairs.map(([LanguageCode, Label]) => ({ Label, LanguageCode })),
  UserLocalizedLabel: { Label: pairs[0][1], LanguageCode: pairs[0][0] },
});

// The Dataverse option rows a cast read answers with: Options: [{ Value, Label }].
const opts = (...rows) => rows.map(([Value, ...labels]) => ({ Value, Label: lbl(...labels) }));

// `byTable`: { table: { Picklist: { column: rows }, MultiSelectPicklist: {…}, State: {…}, Status: {…} } }.
// A table the map does not name answers 404 on every cast, as a table the environment lacks does.
// `globalSets`: { name: rows } — the global option sets the environment holds; any other name answers 404.
function choiceClient(byTable, { failCast, status = 503, globalSets, failGlobal } = {}) {
  const paths = [];
  return {
    paths,
    get: async (p) => {
      paths.push(p);
      // The table-existence probe the dry run makes before it judges anything on the table.
      const exists = /EntityDefinitions\(LogicalName='([^']+)'\)\?\$select=LogicalName,EntitySetName/.exec(p);
      if (exists) {
        return byTable[exists[1]]
          ? { status: 200, headers: {}, body: { LogicalName: exists[1], EntitySetName: `${exists[1]}s` } }
          : { status: 404, headers: {}, body: { error: { message: 'not found' } } };
      }
      const set = /GlobalOptionSetDefinitions\(Name='([^']+)'\)/.exec(p);
      if (set) {
        if (failGlobal) return { status, headers: {}, body: {} };
        return globalSets && globalSets[set[1]]
          ? { status: 200, headers: {}, body: { Name: set[1], IsGlobal: true, Options: globalSets[set[1]] } }
          : { status: 404, headers: {}, body: { error: { message: 'not found' } } };
      }
      const m = /LogicalName='([^']+)'\)\/Attributes\/Microsoft\.Dynamics\.CRM\.(\w+)AttributeMetadata\?/.exec(p);
      if (!m) return { status: 200, headers: {}, body: { value: [] } };
      const [, table, cast] = m;
      if (failCast === cast) return { status, headers: {}, body: {} };
      if (!byTable[table]) return { status: 404, headers: {}, body: { error: { message: 'not found' } } };
      const columns = byTable[table][cast] || {};
      return { status: 200, headers: {}, body: { value: Object.entries(columns).map(([LogicalName, Options]) => ({ LogicalName, OptionSet: { Options } })) } };
    },
  };
}

const TIER = opts([227350000, [1033, 'Silver'], [3082, 'Plata']], [227350001, [1033, 'Gold'], [3082, 'Oro']], [227350002, [1033, 'Bronze']]);

// The global choice every spec here declares, so a column bound to it is a VALID spec (an undeclared one is a
// lint error). Its numbering is the spec's 100000000 + index; TIER above is what an environment that already
// had the set under other values holds.
const TIER_SET = { name: 'new_tierset', options: ['Silver', 'Gold', 'Bronze'] };

const customer = (columns, extra) => ({ schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name' }, columns, ...extra });
const specOf = (entities, views, extra) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'A' },
  entities,
  views,
  globalChoices: [TIER_SET],
  ...extra,
});
const view = (entity, filters, name = 'Gold customers') => ({ entity, name, columns: ['new_name'], activeOnly: false, filters });
const eq = (attr, value) => ({ attr, op: 'eq', value });

const GLOBAL_TIER_COLUMN = { schemaName: 'new_tier', type: 'Choice', globalChoice: 'new_tierset' };

// A table the spec reuses without declaring any column of it, and the local option set the reproduced failure was on.
const ACCOUNT = { schemaName: 'account', displayName: 'Account', existing: true, primaryAttribute: { schemaName: 'name' }, columns: [] };
const INDUSTRY = opts([1, [1033, 'Accounting']], [6, [1033, 'Retail']], [23, [1033, 'Consulting']]);

const resolveAll = (spec, client) => resolveViewFilterLabels(spec, spec.views, { read: client ? makeChoiceReader({ client }) : null });

// ── 1. what counts as a label use ─────────────────────────────────────────────────────────────────

test('ADO 6691114: only a non-integer string in a value-taking filter is a label use', () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [
    eq('new_tier', 'Gold'),
    eq('new_tier', '227350001'),
    eq('new_tier', '227350001,227350002'),
    { attr: 'new_tier', op: 'eq', value: 227350001 },
    { attr: 'new_tier', op: 'in', values: ['Gold', 'Silver', '100000000'] },
    { attr: 'ownerid', op: 'eq-userid' },
    { attr: 'createdon', op: 'this-week' },
  ])]);
  assert.deepStrictEqual(labelUses(spec, spec.views[0]).map((u) => [u.attr, u.label]), [['new_tier', 'Gold'], ['new_tier', 'Gold'], ['new_tier', 'Silver']]);
  assert.strictEqual(hasLabelUses(spec, spec.views[0]), true);
  assert.strictEqual(hasLabelUses(spec, view('new_customer', [{ attr: 'ownerid', op: 'eq-userid' }, eq('new_tier', '2')])), false);
});

test('ADO 6691114: a declared column that is not a Choice is never a label use', () => {
  const spec = specOf([customer([{ schemaName: 'new_code', type: 'Text' }, { schemaName: 'new_flag', type: 'Boolean' }])],
    [view('new_customer', [eq('new_code', 'ABC'), { attr: 'new_flag', op: 'eq', value: 'true' }])]);
  assert.deepStrictEqual(labelUses(spec, spec.views[0]), []);
});

test('ADO 6691114: an id or a date on a column the spec does not declare is no label use — but is on a declared Choice column', () => {
  const GUID_VALUE = '11111111-2222-3333-4444-555555555555';
  const undeclared = specOf([{ schemaName: 'account', displayName: 'Account', existing: true, primaryAttribute: { schemaName: 'name' }, columns: [] }], [
    view('account', [eq('parentaccountid', GUID_VALUE), eq('createdon', '2024-01-31'), eq('createdon', '2024-01-31T10:00:00Z'), eq('industrycode', 'Retail')], 'Accounts'),
  ]);
  assert.deepStrictEqual(labelUses(undeclared, undeclared.views[0]).map((u) => u.label), ['Retail']);
  // A Choice column the spec DOES declare keeps every string a label, so a stray id there is reported, not passed through.
  const declared = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', GUID_VALUE)])]);
  assert.deepStrictEqual(labelUses(declared, declared.views[0]).map((u) => u.label), [GUID_VALUE]);
});

test('ADO 6691114: a half-typed spec is no crash — an entity with no schemaName is validation\'s finding, not a TypeError', () => {
  const spec = { solution: { uniqueName: 'S', publisherPrefix: 'new' }, entities: [{}, customer([])], views: [view('new_customer', [eq('industrycode', 'Retail')])] };
  assert.deepStrictEqual(labelUses(spec, spec.views[0]).map((u) => u.attr), ['industrycode']);
  assert.deepStrictEqual(labelUses(spec, view('new_unknown', [eq('industrycode', 'Retail')])).map((u) => u.attr), ['industrycode']);
});

// ── 2. the three gaps, and every other way a label resolves ───────────────────────────────────────

test('ADO 6691114 gap 1: a filter on a LOCAL option set of an existing table the spec does not declare resolves from the environment', async () => {
  // The reproduced failure: `Accounting` on account.industrycode went to Dataverse as the text "Accounting".
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const r = await resolveAll(spec, choiceClient({ account: { Picklist: { industrycode: INDUSTRY } } }));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('account', 'industrycode', 'Accounting'), 1);
});

test('ADO 6691114 gap 2: the same on a column bound to a SYSTEM global choice resolves from the environment', async () => {
  // A global-bound column carries the shared set through `OptionSet` exactly as a local one does.
  const spec = specOf([{ ...ACCOUNT, schemaName: 'incident', displayName: 'Case' }], [view('incident', [eq('caseorigincode', 'Web')], 'Web cases')]);
  const r = await resolveAll(spec, choiceClient({ incident: { Picklist: { caseorigincode: opts([1, [1033, 'Phone']], [3, [1033, 'Web']]) } } }));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('incident', 'caseorigincode', 'Web'), 3);
});

test('ADO 6691114 gap 3: a declared global choice that already existed with other values resolves to the live value', async () => {
  const spec = specOf([customer([{ schemaName: 'new_status', type: 'Choice', globalChoice: 'new_statusset' }])],
    [view('new_customer', [eq('new_status', 'Closed')])], { globalChoices: [{ name: 'new_statusset', displayName: 'Status', options: ['Open', 'Closed'] }] });
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_status: opts([227350010, [1033, 'Open']], [227350011, [1033, 'Closed']]) } } }));
  assert.strictEqual(r.value('new_customer', 'new_status', 'Closed'), 227350011, 'createGlobalOptionSet reuses an existing set unchanged, so 100000001 was never right');
});

test('ADO 6691114: the environment wins over the spec for a column the spec declares inline too', async () => {
  // A maker adds an option in the portal and the platform assigns its own value; the spec's
  // 100000000 + index is no longer what the column holds.
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 227350001);
});

test('ADO 6691114: a label in ANY language matches, and an ambiguous alias is refused rather than tie-broken', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Oro')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Oro'), 227350001);

  // "Abierto" is option 0 in Spanish and option 1 in English — one string cannot select two values.
  const clash = opts([1, [1033, 'Open'], [3082, 'Abierto']], [2, [1033, 'Abierto'], [3082, 'Cerrado']]);
  const spec2 = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Abierto')], 'Open ones')]);
  const r2 = await resolveAll(spec2, choiceClient({ new_customer: { Picklist: { new_tier: clash } } }));
  assert.strictEqual(r2.value('new_customer', 'new_tier', 'Abierto'), undefined);
  assert.strictEqual(r2.problems.length, 1);
  assert.strictEqual(r2.problems[0].reason, 'ambiguous');
  assert.match(describeProblems(r2.problems), /"Abierto" names more than one option \(1, 2\)/);
});

test('ADO 6691114: a label that matches no option is a problem naming the view, the column and the valid labels', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }));
  assert.strictEqual(r.problems.length, 1);
  const text = describeProblems(r.problems);
  assert.match(text, /view "Top customers"/);
  assert.match(text, /new_customer\.new_tier/);
  assert.match(text, /"Platinum"/);
  assert.match(text, /Silver, Gold, Bronze/);
  assert.match(text, /integer/i, 'tells the author the raw value is the way out');
});

test('ADO 6691114: a long option list is cut off, saying how many were left out', async () => {
  const many = opts(...Array.from({ length: 40 }, (_, i) => [i, [1033, `Option ${i}`]]));
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Nope')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_tier: many } } }));
  assert.match(describeProblems(r.problems), /Option 0, .*Option 24 … and 15 more/);
});

test('ADO 6691114: a raw integer passes through untouched, with no read of the environment', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', '227350001'), { attr: 'new_tier', op: 'in', values: ['227350000', 227350002] }])]);
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const r = await resolveAll(spec, client);
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(client.paths, [], 'nothing needed resolving, so nothing was read');
  assert.strictEqual(r.value('new_customer', 'new_tier', '227350001'), undefined, 'and nothing is rewritten');
});

test('ADO 6691114: a string that is not an option of a column the environment says is not a choice stays as written', async () => {
  // `new_legalname` is not declared, so only the environment can say it is not a choice.
  const spec = specOf([customer([])], [view('new_customer', [eq('new_legalname', 'Contoso Ltd'), eq('new_name', 'Contoso'), { attr: 'createdon', op: 'on', value: '2024-01-01' }])]);
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const r = await resolveAll(spec, client);
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.value('new_customer', 'new_legalname', 'Contoso Ltd'), undefined);
  assert.strictEqual(client.paths.length, 4, 'read once to learn it is not a choice');
});

test('ADO 6691114: the status and state columns resolve by label too', async () => {
  const spec = specOf([customer([])], [view('new_customer', [eq('statuscode', 'Escalated'), eq('statecode', 'Inactive')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {
    Status: { statuscode: opts([1, [1033, 'Active']], [100000000, [1033, 'Escalated']]) },
    State: { statecode: opts([0, [1033, 'Active']], [1, [1033, 'Inactive']]) },
  } }));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'statuscode', 'Escalated'), 100000000);
  assert.strictEqual(r.value('new_customer', 'statecode', 'Inactive'), 1);
});

test('ADO 6691114: a multi-select column resolves too', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tags', type: 'MultiChoice', globalChoice: 'new_tierset' }])], [{ entity: 'new_customer', name: 'Tagged', columns: ['new_name'], filters: [{ attr: 'new_tags', op: 'contain-values', value: 'Gold' }] }]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { MultiSelectPicklist: { new_tags: TIER } } }));
  assert.strictEqual(r.value('new_customer', 'new_tags', 'Gold'), 227350001);
});

test('ADO 6691114: each table is read once however many filters and views use it', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Gold'), eq('new_tier', 'Silver'), eq('new_name', 'Contoso')], 'One'),
    view('new_customer', [eq('new_tier', 'Bronze')], 'Two'),
  ]);
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  await resolveAll(spec, client);
  assert.strictEqual(client.paths.length, 4, 'one read per choice kind, for the one table');
  assert.ok(client.paths.every((p) => /LogicalName='new_customer'/.test(p)));
});

// ── 3. what the spec alone can prove, and what a failed read does ──────────────────────────────────

test('ADO 6691114: with no environment to read, the spec\'s own options still resolve (the old behaviour)', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, null);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.deepStrictEqual(r.problems, []);
});

test('ADO 6691114: a table the environment does not have yet resolves from the spec — the build is about to create it', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, choiceClient({}));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
});

test('ADO 6691114: a failed read falls back to what the spec declares', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {} }, { failCast: 'Picklist' }));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.deepStrictEqual(r.problems, []);
});

test('ADO 6691114: a label the spec does not declare and a failed read cannot confirm is a problem, never a raw value', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503 }));
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.problems[0].reason, 'unreadable');
  assert.match(describeProblems(r.problems), /could not read.*new_customer.*503/s);
});

test('ADO 6691114: a failed read leaves a label the spec DOES declare resolved from the spec', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503 }));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
});

test('ADO 6691114: a column the spec does not declare, on a table that could not be read, is left as written — with a warning', async () => {
  const spec = specOf([customer([])], [view('new_customer', [eq('industrycode', 'Retail')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {} }, { failCast: 'State', status: 503 }));
  assert.deepStrictEqual(r.problems, []);
  assert.ok(r.warnings.some((w) => /industrycode/.test(w) && /Retail/.test(w) && /503/.test(w)), JSON.stringify(r.warnings));
});

test('ADO 6691114: a declared choice column the environment lacks resolves from the spec (the build creates it)', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_other: TIER } } }));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
});

// ── 3b. before the build writes anything ──────────────────────────────────────────────────────────
//
// Before the build runs, the environment cannot hold what the build is about to create, so a label is judged by
// whichever side is AUTHORITATIVE for it, and only a definite answer is a problem. Anything else is left to the
// views phase, which asks again once the build has run.

const preflight = (spec, client, extra = {}) => checkViewFilterLabelsBeforeBuild(spec, spec.views, {
  read: client ? makeChoiceReader({ client }) : null,
  readGlobalChoice: client ? makeGlobalChoiceReader({ client }) : null,
  ...extra,
});

test('ADO 6691114 pre-flight: the reproduced failure — a typo on a local option set of an existing table — is a problem before anything is written', async () => {
  const client = choiceClient({ account: { Picklist: { industrycode: INDUSTRY } } });
  const bad = await preflight(specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Accounts')]), client);
  assert.strictEqual(bad.problems.length, 1);
  assert.match(describeProblems(bad.problems), /view "Accounts" \(account\): filter on industrycode — "Accountig" is not an option of account\.industrycode\. Valid labels: Accounting, Retail, Consulting\./);
  const good = await preflight(specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]), client);
  assert.deepStrictEqual(good.problems, []);
  assert.strictEqual(good.resolved.get('account|industrycode|Accounting'), 1, 'what a column the environment already has says is final, and handed on');
});

test('ADO 6691114 pre-flight: only what the environment already held is handed on as resolved — what the build creates is not', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  assert.strictEqual((await preflight(spec, choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }))).resolved.size, 1, 'the column is there');
  assert.strictEqual((await preflight(spec, choiceClient({ new_customer: { Picklist: { new_other: TIER } } }))).resolved.size, 0, 'the build is about to create the column');
  assert.strictEqual((await preflight(spec, choiceClient({}))).resolved.size, 0, 'and the table');
});

test('ADO 6691114: the final resolution takes what the pre-flight resolved and does not read those tables again', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const r = await resolveViewFilterLabels(spec, spec.views, { read: makeChoiceReader({ client }), prior: new Map([['new_customer|new_tier|Gold', 227350001]]) });
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 227350001);
  assert.deepStrictEqual(client.paths, []);
});

test('ADO 6691114 pre-flight: a column of an existing table bound to a system global choice is judged the same way', async () => {
  const incident = { ...ACCOUNT, schemaName: 'incident', displayName: 'Case' };
  const client = choiceClient({ incident: { Picklist: { caseorigincode: opts([1, [1033, 'Phone']], [3, [1033, 'Web']]) } } });
  assert.deepStrictEqual((await preflight(specOf([incident], [view('incident', [eq('caseorigincode', 'Web')])]), client)).problems, []);
  const bad = await preflight(specOf([incident], [view('incident', [eq('caseorigincode', 'Fax')])]), client);
  assert.match(describeProblems(bad.problems), /"Fax" is not an option of incident\.caseorigincode\. Valid labels: Phone, Web\./);
});

test('ADO 6691114 pre-flight: a column the spec declares and the environment lacks is the spec\'s to decide, on an existing table or a new one', async () => {
  const declared = [customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])];
  for (const byTable of [{ new_customer: { Picklist: { new_other: TIER } } }, {}]) {
    const client = choiceClient(byTable);
    assert.deepStrictEqual((await preflight(specOf(declared, [view('new_customer', [eq('new_tier', 'Gold')])]), client)).problems, []);
    const bad = await preflight(specOf(declared, [view('new_customer', [eq('new_tier', 'Platinum')], 'Top')]), client);
    assert.match(describeProblems(bad.problems), /"Platinum" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold\./);
  }
});

test('ADO 6691114 pre-flight: a column the environment already has keeps the options it has, whatever the spec lists', async () => {
  // The build creates what is missing and leaves an existing column alone, so the environment is final.
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold', 'Platinum'] }])], [view('new_customer', [eq('new_tier', 'Platinum')])]);
  const bad = await preflight(spec, choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }));
  assert.match(describeProblems(bad.problems), /"Platinum" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold, Bronze\./);
});

test('ADO 6691114 pre-flight: a column bound to a declared global choice follows the set — the environment\'s when it already exists, the spec\'s when it does not', async () => {
  const tableWithoutColumn = { new_customer: { Picklist: { new_other: TIER } } };
  const spec = (label) => specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', label)])]);
  // No such set yet: the build creates it from the spec, so the spec decides.
  const fresh = choiceClient(tableWithoutColumn);
  assert.deepStrictEqual((await preflight(spec('Gold'), fresh)).problems, []);
  assert.match(describeProblems((await preflight(spec('Platinum'), fresh)).problems), /Valid labels: Silver, Gold, Bronze\./);
  // The set already exists with other options: createGlobalOptionSet reuses it unchanged, so it decides. A label
  // only the live set has is NOT a problem — halting on the spec's list there would stop a good build.
  const live = choiceClient(tableWithoutColumn, { globalSets: { new_tierset: opts([1, [1033, 'Platinum']], [2, [1033, 'Gold']]) } });
  assert.deepStrictEqual((await preflight(spec('Platinum'), live)).problems, []);
  assert.match(describeProblems((await preflight(spec('Silver'), live)).problems), /"Silver" is not an option of new_customer\.new_tier\. Valid labels: Platinum, Gold\./);
});

test('ADO 6691114 pre-flight: what cannot be known yet is not a problem — the views phase asks again after the build', async () => {
  const declaredSet = (label) => specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', label)])]);
  const onTable = { new_customer: { Picklist: { new_other: TIER } } };
  // The global set could not be read.
  assert.deepStrictEqual((await preflight(declaredSet('Platinum'), choiceClient(onTable, { failGlobal: true }))).problems, []);
  // The table could not be read (or not completely), so a column might be there.
  const inline = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver'] }])], [view('new_customer', [eq('new_tier', 'Platinum')])]);
  assert.deepStrictEqual((await preflight(inline, choiceClient(onTable, { failCast: 'Status' }))).problems, []);
  assert.deepStrictEqual((await preflight(inline, choiceClient({}, { failCast: 'Status' }))).problems, [], 'one cast failing makes the answer incomplete');
  // A column the spec does not declare, on a table that is not there yet: a system column of a table the build creates.
  assert.deepStrictEqual((await preflight(specOf([customer([])], [view('new_customer', [eq('statuscode', 'Escalated')])]), choiceClient({}))).problems, []);
  // …and on a table that is, where it is not a choice column at all: a plain value.
  assert.deepStrictEqual((await preflight(specOf([customer([])], [view('new_customer', [eq('new_legalname', 'Contoso Ltd')])]), choiceClient(onTable))).problems, []);
  // With no environment to ask there is nothing to check ahead of the build.
  assert.deepStrictEqual((await preflight(inline, null)).problems, []);
});

test('ADO 6691114 pre-flight: a status reason the build inserts itself is not a problem, a typo of it is', async () => {
  // statusReasons[] are inserted into the table's statuscode by the data-model phase, so before it runs the environment lists none.
  const withReason = { ...ACCOUNT, statusReasons: [{ label: 'Passed QA', state: 'Active' }] };
  const client = choiceClient({ account: { Status: { statuscode: opts([1, [1033, 'Active']], [2, [1033, 'Inactive']]) } } });
  assert.deepStrictEqual((await preflight(specOf([withReason], [view('account', [eq('statuscode', 'Passed QA')])]), client)).problems, []);
  assert.deepStrictEqual((await preflight(specOf([withReason], [view('account', [eq('statuscode', 'Active')])]), client)).problems, []);
  const typo = await preflight(specOf([withReason], [view('account', [eq('statuscode', 'Passed Q')], 'QA')]), client);
  assert.match(describeProblems(typo.problems), /"Passed Q" is not an option of account\.statuscode\. Valid labels: Active, Inactive\./);
});

test('ADO 6691114 pre-flight: an ambiguous alias in the environment is a problem, and every problem of every view is reported', async () => {
  const clash = opts([1, [1033, 'Open'], [3082, 'Abierto']], [2, [1033, 'Abierto'], [3082, 'Cerrado']]);
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Abierto')], 'First'),
    view('new_customer', [eq('new_tier', 'Diamond')], 'Second'),
  ]);
  const r = await preflight(spec, choiceClient({ new_customer: { Picklist: { new_tier: clash } } }));
  assert.deepStrictEqual(r.problems.map((p) => [p.view, p.reason]), [['First', 'ambiguous'], ['Second', 'unknown']]);
});

// ── 4. the reader itself ──────────────────────────────────────────────────────────────────────────

test('ADO 6691114: the reader asks one narrow cast read per choice kind and keeps every language of every option', async () => {
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const got = await readChoiceAttributes(client, 'new_customer');
  assert.strictEqual(got.state, 'ok');
  assert.deepStrictEqual(client.paths.map((p) => /Microsoft\.Dynamics\.CRM\.(\w+)AttributeMetadata/.exec(p)[1]).sort(), ['MultiSelectPicklist', 'Picklist', 'State', 'Status']);
  assert.ok(client.paths.every((p) => p.endsWith('?$select=LogicalName&$expand=OptionSet($select=Options)')), JSON.stringify(client.paths));
  const tier = got.attributes.get('new_tier');
  assert.strictEqual(tier.kind, 'Picklist');
  assert.deepStrictEqual(tier.options.map((o) => [o.value, o.labels]), [[227350000, ['Silver', 'Plata']], [227350001, ['Gold', 'Oro']], [227350002, ['Bronze']]]);
});

test('ADO 6691114: a table every cast answers 404 for is absent, and one failing cast makes the answer incomplete', async () => {
  assert.deepStrictEqual(await readChoiceAttributes(choiceClient({}), 'new_customer'), { state: 'absent' });
  const part = await readChoiceAttributes(choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }, { failCast: 'Status' }), 'new_customer');
  assert.strictEqual(part.state, 'ok');
  assert.strictEqual(part.complete, false, 'an attribute that is missing from an incomplete read is unknown, not "not a choice"');
  assert.ok(part.attributes.has('new_tier'), 'but what the other casts returned is still usable');
});

test('ADO 6691114: a transport failure on any cast is an error, never an empty answer', async () => {
  const client = { get: async () => { throw new Error('socket hang up'); } };
  const got = await readChoiceAttributes(client, 'new_customer');
  assert.strictEqual(got.state, 'error');
  assert.match(got.why, /socket hang up/);
});

test('ADO 6691114: the memoizing reader reads a table once, however it is asked', async () => {
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const read = makeChoiceReader({ client });
  await Promise.all([read('new_customer'), read('NEW_CUSTOMER'), read('new_customer')]);
  assert.strictEqual(client.paths.length, 4);
  assert.strictEqual(makeChoiceReader({ client: null }), null, 'no client, no reader');
  assert.strictEqual(makeChoiceReader({ client: {} }), null);
});

test('ADO 6691114: the global choice reader reads the set by its lower-cased name and keeps every language of every option', async () => {
  const client = choiceClient({}, { globalSets: { new_tierset: TIER } });
  const got = await readGlobalChoiceOptions(client, 'NEW_TierSet');
  assert.deepStrictEqual(client.paths, ["/GlobalOptionSetDefinitions(Name='new_tierset')"]);
  assert.strictEqual(got.state, 'ok');
  assert.deepStrictEqual(got.options.map((o) => [o.value, o.labels]), [[227350000, ['Silver', 'Plata']], [227350001, ['Gold', 'Oro']], [227350002, ['Bronze']]]);
});

test('ADO 6691114: a global choice that is not there is absent, and one that could not be read is an error — never an empty set', async () => {
  assert.deepStrictEqual(await readGlobalChoiceOptions(choiceClient({}), 'new_tierset'), { state: 'absent' });
  const failed = await readGlobalChoiceOptions(choiceClient({}, { failGlobal: true, status: 503 }), 'new_tierset');
  assert.strictEqual(failed.state, 'error');
  assert.match(failed.why, /503/);
  const thrown = await readGlobalChoiceOptions({ get: async () => { throw new Error('socket hang up'); } }, 'new_tierset');
  assert.strictEqual(thrown.state, 'error');
  assert.match(thrown.why, /socket hang up/);
  const shapeless = await readGlobalChoiceOptions({ get: async () => ({ status: 200, headers: {}, body: { Name: 'new_tierset' } }) }, 'new_tierset');
  assert.strictEqual(shapeless.state, 'error', 'a 200 that carries no Options is not an empty set');
});

test('ADO 6691114: the memoizing global choice reader reads a set once, however it is asked', async () => {
  const client = choiceClient({}, { globalSets: { new_tierset: TIER } });
  const read = makeGlobalChoiceReader({ client });
  await Promise.all([read('new_tierset'), read('NEW_TIERSET'), read('new_tierset')]);
  assert.strictEqual(client.paths.length, 1);
  assert.strictEqual(makeGlobalChoiceReader({ client: null }), null);
});

// ── 5. REAL bundle: the reader through the SDK's own client ───────────────────────────────────────

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function realClient(routes) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-labels-'));
  dirs.push(dir);
  const reads = [];
  const httpClient = {
    get: async (url) => {
      const u = decodeURIComponent(url);
      reads.push(u);
      for (const [re, answer] of routes) if (re.test(u)) return answer;
      return { status: 404, headers: {}, body: {} };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  return { sdk, reads };
}

test('REAL BUNDLE (ADO 6691114): the SDK client carries the cast read and returns the option set a global choice shares', async () => {
  const { sdk, reads } = await realClient([
    [/Attributes\/Microsoft\.Dynamics\.CRM\.PicklistAttributeMetadata/, { status: 200, headers: {}, body: { value: [{
      LogicalName: 'new_tier',
      MetadataId: '11111111-1111-1111-1111-111111111111',
      // A column bound to a global choice carries the shared set in OptionSet, as an inline one does.
      OptionSet: { Name: 'new_tierset', IsGlobal: true, Options: TIER },
    }] } }],
    [/Attributes\/Microsoft\.Dynamics\.CRM\.(MultiSelectPicklist|State|Status)AttributeMetadata/, { status: 200, headers: {}, body: { value: [] } }],
  ]);
  const got = await readChoiceAttributes(sdk.dataverse, 'new_customer');
  assert.strictEqual(got.state, 'ok');
  assert.strictEqual(got.complete, true);
  assert.deepStrictEqual(got.attributes.get('new_tier').options.map((o) => o.value), [227350000, 227350001, 227350002]);
  assert.strictEqual(reads.length, 4);
  assert.ok(reads.every((r) => /EntityDefinitions\(LogicalName='new_customer'\)\/Attributes\/Microsoft\.Dynamics\.CRM\.\w+AttributeMetadata\?\$select=LogicalName&\$expand=OptionSet\(\$select=Options\)$/.test(r)), JSON.stringify(reads));
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Oro')])]);
  const r = await resolveViewFilterLabels(spec, spec.views, { read: makeChoiceReader({ client: sdk.dataverse }) });
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Oro'), 227350001);
});

test('REAL BUNDLE (ADO 6691114): the SDK client carries the global option set read, by name, and returns its options', async () => {
  const { sdk, reads } = await realClient([
    [/GlobalOptionSetDefinitions\(Name='new_tierset'\)$/, { status: 200, headers: {}, body: { MetadataId: '11111111-1111-1111-1111-111111111111', Name: 'new_tierset', IsGlobal: true, Options: TIER } }],
  ]);
  const got = await readGlobalChoiceOptions(sdk.dataverse, 'new_tierset');
  assert.strictEqual(reads.length, 1);
  assert.match(reads[0], /\/GlobalOptionSetDefinitions\(Name='new_tierset'\)$/);
  assert.strictEqual(got.state, 'ok');
  assert.deepStrictEqual(got.options.map((o) => o.value), [227350000, 227350001, 227350002]);
  assert.strictEqual((await readGlobalChoiceOptions(sdk.dataverse, 'new_missing')).state, 'absent');
});

test('REAL BUNDLE (ADO 6691114): a renamed option of a declared global choice, read through the SDK\'s own client, keeps the spec\'s number — a set numbered otherwise does not', async () => {
  const route = (rows) => [
    [/Attributes\/Microsoft\.Dynamics\.CRM\.PicklistAttributeMetadata/, { status: 200, headers: {}, body: { value: [{
      LogicalName: 'new_tier',
      MetadataId: '11111111-1111-1111-1111-111111111111',
      OptionSet: { Name: 'new_tierset', IsGlobal: true, Options: rows },
    }] } }],
    [/Attributes\/Microsoft\.Dynamics\.CRM\.(MultiSelectPicklist|State|Status)AttributeMetadata/, { status: 200, headers: {}, body: { value: [] } }],
  ];
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const resolveWith = async (rows) => {
    const { sdk } = await realClient(route(rows));
    return resolveViewFilterLabels(spec, spec.views, { read: makeChoiceReader({ client: sdk.dataverse }) });
  };
  const renamed = await resolveWith(opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']]));
  assert.deepStrictEqual(renamed.problems, []);
  assert.strictEqual(renamed.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.strictEqual(renamed.warnings.length, 1);
  assert.match(renamed.warnings[0], /on the assumption that it is the same option under another label/);
  const otherOrder = await resolveWith(opts([100000000, [1033, 'Bronze']], [100000001, [1033, 'Silver']], [100000002, [1033, 'Gold Tier']]));
  assert.strictEqual(otherOrder.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.strictEqual(otherOrder.problems.length, 1);
  assert.deepStrictEqual(otherOrder.warnings, []);
});

// ── 6. the views phase: resolve before ANY view is written ─────────────────────────────────────────

// `record: true` wraps the SDK so every method the build calls is noted by name (`names`): "nothing was written"
// is then asserted by what was NOT called, not by a list of the writes someone remembered.
function viewsEngine({ byTable, existingViews = [], failCast, status, globalSets, failGlobal, record = false } = {}) {
  const { sdk, calls } = makeSimpleMockSdk();
  const defs = [];
  const createArtifact = sdk.createArtifact;
  sdk.createArtifact = (type, def) => { defs.push([type, def]); return createArtifact(type, def); };
  const pushed = [];
  const push = sdk.pushArtifact;
  sdk.pushArtifact = async (type, id) => { pushed.push([type, id]); return push(type, id); };
  sdk.findArtifact = async (kind, identity) => (kind === 'view' && existingViews.includes(identity.name) ? `existing-${identity.name}` : null);
  const client = byTable ? choiceClient(byTable, { failCast, globalSets, failGlobal, ...(status ? { status } : {}) }) : null;
  if (client) sdk.dataverse = client;
  const names = [];
  // The raw reads join the SDK calls in ONE ordered trace, so "this read came before that write" can be asserted.
  if (client && record) { const get = client.get; client.get = async (p) => { names.push(`GET ${p}`); return get(p); }; }
  const used = record
    ? new Proxy(sdk, { get: (target, key) => (typeof target[key] === 'function' ? (...args) => { names.push(String(key)); return target[key](...args); } : target[key]) })
    : sdk;
  const run = (spec, extra = {}) => {
    const warnings = [];
    return runSdkBuild(spec, { sdk: used, apply: true, phases: ['views'], preResolvedLanguageCode: 1033, warn: (w) => warnings.push(w), ...extra }).then(
      (result) => ({ result, warnings }),
      (error) => ({ error, warnings }),
    );
  };
  return { sdk, calls, defs, pushed, client, names, run };
}

// What counts as writing: a create, an insert, an update, a push… — never a find, a query, a get or a fetch.
const WRITE_CALL = /^(create|insert|update|add|remove|set|push|publish|seed|delete|enrich|configure)/;
const writesOf = (names) => names.filter((n) => WRITE_CALL.test(n));

const viewCondition = (defs, name, attribute) => {
  const def = defs.find(([type, d]) => type === 'view' && d.name === name)[1];
  const all = [...def.filters.conditions, ...def.filters.groups.flatMap((g) => g.conditions)];
  return all.filter((c) => c.attribute === attribute).map((c) => c.value);
};

test('ADO 6691114 build: a filter on a local option set of an existing table the spec does not declare reaches the FetchXML as its value (gap 1)', async () => {
  // The reproduced failure: the label used to go to Dataverse as text, and the saved view was rejected.
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } } });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Accounts', 'industrycode'), ['1']);
});

test('ADO 6691114 build: the same on a column bound to a system global choice (gap 2)', async () => {
  const incident = { ...ACCOUNT, schemaName: 'incident', displayName: 'Case' };
  const e = viewsEngine({ byTable: { incident: { Picklist: { caseorigincode: opts([1, [1033, 'Phone']], [3, [1033, 'Web']]) } } } });
  const spec = specOf([incident], [view('incident', [eq('caseorigincode', 'Web')], 'Web cases')]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Web cases', 'caseorigincode'), ['3']);
});

test('ADO 6691114 build: a declared global choice that already existed with other values filters on the live value (gap 3)', async () => {
  // The spec numbers Silver/Gold/Bronze from 100000000; createGlobalOptionSet REUSES an existing set unchanged,
  // so on this environment Gold is 227350001 and the spec's number would select nothing.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['227350001']);
});

test('ADO 6691114 build: in / not-in values resolve through the same rule', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [{ attr: 'new_tier', op: 'not-in', values: ['Gold', 'Oro', '227350002'] }])]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['227350001', '227350001', '227350002']);
});

test('ADO 6691114 build: an unknown label halts BEFORE any view is written, naming the view, the column and the valid labels', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Gold')], 'Fine view'),
    view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers'),
  ]);
  const { error, result } = await e.run(spec);
  assert.strictEqual(result, undefined, 'the build did not complete');
  assert.ok(error instanceof BuildHalt, String(error && error.stack));
  assert.strictEqual(error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'views');
  assert.match(error.message, /view "Top customers"/);
  assert.match(error.message, /new_customer\.new_tier/);
  assert.match(error.message, /Silver, Gold, Bronze/);
  assert.match(error.message, /no view was written/i);
  assert.strictEqual(error.transient, false);
  // The CLI retries a halt it judges transient; this one quotes a metadata read's own words, which can look like one.
  assert.strictEqual(isTransientHalt(error), false, 'a rerun cannot change the answer, so the build must not auto-retry it');
  assert.deepStrictEqual(e.defs.filter(([type]) => type === 'view'), [], 'not even the VALID view before it was created');
  assert.deepStrictEqual(e.pushed, []);
});

// A label an unanswered option read left undecided is not wrong — the read may answer next time — so that halt keeps the
// read's HTTP status for the CLI's retry check: a throttled or unavailable read is run again, anything else is final.
const PRIORITY = { schemaName: 'new_priority', type: 'Choice', options: ['Low', 'High'] };

test('ADO 6691114 build: a halt that only an unanswered option read left undecided is run again on a 503 or a 429, not on a 400', async () => {
  for (const [status, again] of [[503, true], [429, true], [400, false]]) {
    const e = viewsEngine({ byTable: { new_customer: {} }, failCast: 'Picklist', status });
    const spec = specOf([customer([PRIORITY])], [view('new_customer', [eq('new_priority', 'Medium')], 'Medium customers')]);
    const { error } = await e.run(spec);
    assert.ok(error instanceof BuildHalt, String(error && error.stack));
    assert.strictEqual(error.code, 'view-filter-label-unresolved');
    assert.match(error.message, new RegExp(`could not read the options of new_customer\\.new_priority \\(HTTP ${status}`));
    assert.strictEqual(isTransientHalt(error), again, `HTTP ${status}`);
    assert.deepStrictEqual(e.defs.filter(([type]) => type === 'view'), [], 'no view was written');
  }
  // The message quotes the filter label itself, so a label that reads like a transient error must not make a final
  // read look like one: only the read's own status (429, 503) can.
  const e = viewsEngine({ byTable: { new_customer: {} }, failCast: 'Picklist', status: 403 });
  const { error } = await e.run(specOf([customer([PRIORITY])], [view('new_customer', [eq('new_priority', 'SQL Timeout')], 'Odd label')]));
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved', String(error && error.stack));
  assert.match(error.message, /"SQL Timeout"/);
  assert.strictEqual(isTransientHalt(error), false, 'a 403 is final, whatever the label says');
});

test('ADO 6691114 build: a halt that also names a label the environment shows to be wrong is never run again', async () => {
  const e = viewsEngine({ byTable: { new_customer: {} }, failCast: 'Picklist', status: 503, globalSets: { new_tierset: TIER } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN, PRIORITY])], [
    view('new_customer', [eq('new_priority', 'Medium')], 'Medium customers'),
    view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers'),
  ]);
  const { error } = await e.run(spec);
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved', String(error && error.stack));
  assert.match(error.message, /"Platinum" is not an option of new_customer\.new_tier/);
  assert.match(error.message, /could not read the options of new_customer\.new_priority \(HTTP 503/);
  assert.strictEqual(error.transient, false);
  assert.strictEqual(isTransientHalt(error), false, 'a re-run cannot fix the wrong label, whatever the other read answers next time');
});

test('ADO 6691114 build: every bad label in every view is reported at once', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Platinum')], 'First'),
    view('new_customer', [eq('new_tier', 'Diamond')], 'Second'),
  ]);
  const { error } = await e.run(spec);
  assert.match(error.message, /view "First"[\s\S]*"Platinum"/);
  assert.match(error.message, /view "Second"[\s\S]*"Diamond"/);
});

test('ADO 6691114 build: an EXISTING view\'s filters are never reapplied, so a label it cannot resolve does not halt the build', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } }, existingViews: ['Top customers'] });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const { error, result } = await e.run(spec);
  assert.ifError(error);
  assert.ok(result && result.ok);
});

test('ADO 6691114 build: a bad label on an existing view does not hide one on a view the build creates', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } }, existingViews: ['Old view'] });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Platinum')], 'Old view'),
    view('new_customer', [eq('new_tier', 'Diamond')], 'New view'),
  ]);
  const { error } = await e.run(spec);
  assert.match(error.message, /view "New view"/);
  assert.doesNotMatch(error.message, /Old view/);
});

test('ADO 6691114 build: a view with no label in its filters costs no read of the environment', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [{ attr: 'ownerid', op: 'eq-userid' }, eq('new_tier', '227350001')])]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(e.client.paths, []);
});

test('ADO 6691114 build: a filter on an id or a date, on a column the spec does not declare, costs no read of the environment', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: {} } } });
  const spec = specOf([{ schemaName: 'account', displayName: 'Account', existing: true, primaryAttribute: { schemaName: 'name' }, columns: [] }], [
    view('account', [eq('parentaccountid', '11111111-2222-3333-4444-555555555555'), eq('createdon', '2024-01-31')], 'Accounts'),
  ]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(e.client.paths, []);
  assert.deepStrictEqual(viewCondition(e.defs, 'Accounts', 'parentaccountid'), ['11111111-2222-3333-4444-555555555555']);
});

test('ADO 6691114 build: when no view names a label, every other string value reaches the FetchXML exactly as written', async () => {
  // No label use anywhere, so no resolution exists — which must leave a pattern, a date and a raw option value alone.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [
    { attr: 'new_name', op: 'like', value: 'A%' },
    { attr: 'createdon', op: 'on', value: '2024-01-31' },
    eq('new_tier', '227350001'),
  ])]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_name'), ['A%']);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'createdon'), ['2024-01-31']);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['227350001']);
  assert.deepStrictEqual(e.client.paths, []);
});

test('ADO 6691114 build: each table is read once for the whole phase, however many views name it', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Gold')], 'One'),
    view('new_customer', [eq('new_tier', 'Silver')], 'Two'),
    view('new_customer', [eq('new_tier', 'Bronze')], 'Three'),
  ]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.strictEqual(e.client.paths.length, 4);
});

// ── 6b. the build's pre-flight: a label the environment already shows to be wrong stops the build first ──
//
// The reproduced failure left a half-built app: the tables and columns were written and THEN Dataverse rejected the
// view. So the labels are checked before the first write; the views phase checks again, once the build has run.

const FULL = ['solution', 'data-model', 'views'];

test('ADO 6691114 pre-flight: a typo on a local option set of an existing table stops the build before ANYTHING is written', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } }, record: true });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Accounts')]);
  const { error, result } = await e.run(spec, { phases: FULL });
  assert.strictEqual(result, undefined, 'the build did not complete');
  assert.ok(error instanceof BuildHalt, String(error && error.stack));
  assert.strictEqual(error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'preflight', 'tagged like the CLI\'s own pre-flight halts: the views phase has not started');
  assert.strictEqual(error.recoverable, false);
  assert.strictEqual(error.transient, false);
  assert.strictEqual(isTransientHalt(error), false);
  assert.match(error.message, /before writing anything/i);
  assert.match(error.message, /view "Accounts" \(account\): filter on industrycode — "Accountig" is not an option of account\.industrycode\. Valid labels: Accounting, Retail, Consulting\./);
  assert.deepStrictEqual(writesOf(e.names), [], `a half-built app is what this prevents: ${JSON.stringify(e.names)}`);
});

test('ADO 6691114 pre-flight: the reproduced scenario with the RIGHT label builds, and the view carries the option value', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } }, record: true });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const { error } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.ok(writesOf(e.names).length > 0, 'the build went on to write');
  assert.deepStrictEqual(viewCondition(e.defs, 'Accounts', 'industrycode'), ['1']);
});

test('ADO 6691114 pre-flight: it runs for the data stage too, so the staged flow fails before it writes the data model', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } }, record: true });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Accounts')]);
  const { error } = await e.run(spec, { phases: ['solution', 'data-model', 'sample-data'] });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.deepStrictEqual(writesOf(e.names), []);
});

test('ADO 6691114 pre-flight: a typo on a column the build is about to create is the spec\'s to catch, before the table is created', async () => {
  const e = viewsEngine({ byTable: {}, record: true });
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const { error } = await e.run(spec, { phases: FULL });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.match(error.message, /"Platinum" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold\./);
  assert.deepStrictEqual(writesOf(e.names), []);
});

test('ADO 6691114 pre-flight: a label only the environment\'s copy of a declared global choice has does not stop a good build', async () => {
  // The set already exists with Platinum, which the spec does not list. The environment decides, so this builds,
  // and the views phase — after the data model — writes the live value.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: opts([5, [1033, 'Platinum']], [6, [1033, 'Gold']]) } } }, globalSets: { new_tierset: opts([5, [1033, 'Platinum']], [6, [1033, 'Gold']]) }, record: true });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const { error } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Top customers', 'new_tier'), ['5']);
});

test('ADO 6691114 pre-flight: a status reason the build inserts is resolved by the views phase, after the data model has added it', async () => {
  // Before the build the environment lists no "Passed QA"; the data-model phase inserts it; the views phase reads it back.
  const byTable = { account: { Status: { statuscode: opts([1, [1033, 'Active']], [2, [1033, 'Inactive']]) } } };
  const e = viewsEngine({ byTable, record: true });
  e.sdk.insertStatusValue = async (logical, o) => { byTable.account.Status.statuscode.push({ Value: 100000000, Label: lbl([1033, o.label]) }); return 100000000; };
  const spec = specOf([{ ...ACCOUNT, statusReasons: [{ label: 'Passed QA', state: 'Active' }] }], [view('account', [eq('statuscode', 'Passed QA')], 'Passed accounts')]);
  const { error } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Passed accounts', 'statuscode'), ['100000000']);
});

test('ADO 6691114 pre-flight: what the environment already held is final and not asked again; what the build creates is asked about after it', async () => {
  const castReads = (e) => e.client.paths.filter((p) => /AttributeMetadata\?/.test(p)).length;
  // The column exists, so the pre-flight's answer stands: four cast reads in all, and the view carries that value.
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const had = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  assert.ifError((await had.run(spec, { phases: FULL })).error);
  assert.strictEqual(castReads(had), 4, 'read once, before the build; the views phase took that answer');
  assert.deepStrictEqual(viewCondition(had.defs, 'Gold customers', 'new_tier'), ['227350001']);
  // A status reason the build inserts is not there to read until it has run, so the views phase asks again: eight.
  const byTable = { account: { Status: { statuscode: opts([1, [1033, 'Active']], [2, [1033, 'Inactive']]) } } };
  const made = viewsEngine({ byTable });
  made.sdk.insertStatusValue = async (logical, o) => { byTable.account.Status.statuscode.push({ Value: 100000000, Label: lbl([1033, o.label]) }); return 100000000; };
  const withReason = specOf([{ ...ACCOUNT, statusReasons: [{ label: 'Passed QA', state: 'Active' }] }], [view('account', [eq('statuscode', 'Passed QA')], 'Passed accounts')]);
  assert.ifError((await made.run(withReason, { phases: FULL })).error);
  assert.strictEqual(castReads(made), 8, 'four cast reads before the build, four after it');
  // A run with nothing written before the views phase has no pre-flight, so its own check is the only one.
  const only = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  assert.ifError((await only.run(spec, { phases: ['views'] })).error);
  assert.strictEqual(castReads(only), 4);
});

test('ADO 6691114 pre-flight: an existing view is not judged, in the pre-flight any more than in the views phase — and is said once', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } }, existingViews: ['Accounts'], record: true });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Accounts')]);
  const { error, warnings } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.strictEqual(warnings.filter((w) => /view "Accounts" \(account\) already exists/.test(w)).length, 1, JSON.stringify(warnings));
});

test('ADO 6691114 pre-flight: a read that fails does not stop the build there — what cannot be known is the views phase\'s to say', async () => {
  const e = viewsEngine({ byTable: { account: { Picklist: { industrycode: INDUSTRY } } }, failCast: 'Picklist', record: true });
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const { error, warnings } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.ok(warnings.some((w) => /could not be read completely/.test(w) && /industrycode/.test(w) && /503/.test(w)), JSON.stringify(warnings));
});

test('ADO 6691114 pre-flight: with no metadata client there is nothing to check ahead of the build', async () => {
  const e = viewsEngine({ record: true });
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver'] }])], [view('new_customer', [eq('new_tier', 'Platinum')])]);
  const { error } = await e.run(spec, { phases: ['solution', 'data-model'] });
  assert.ifError(error);
  assert.ok(writesOf(e.names).length > 0);
});

test('ADO 6691114 build: with no metadata client the spec\'s own options still resolve, exactly as before', async () => {
  const e = viewsEngine({});
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const { error } = await e.run(spec);
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
});

test('ADO 6691114: viewDef without a resolution is the old spec-only rule, unchanged', () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold'), eq('industrycode', 'Retail')])]);
  const def = viewDef(spec, spec.views[0]);
  assert.deepStrictEqual(def.filters.conditions.map((c) => [c.attribute, c.value]), [['new_tier', '100000001'], ['industrycode', 'Retail']]);
});

// ── 6c. a spec with a LOCALIZED label: no label-bearing read before the data model is written ───────
//
// The pre-flight reads option labels (every language of every option) and whole global choices. The plugin's own
// measurement (AB#6686428) is that a label-bearing metadata read made ahead of a create leaves Dataverse with only
// the base-language label of a multi-language one — silently. Nothing says those reads are exempt, so a build that
// may CREATE a localized label does not run them before the data-model writes. The views phase runs after every
// create, so the check still happens before any view is written; the dry run creates nothing and keeps its report.

const isLabelRead = (name) => /^GET .*(AttributeMetadata\?|GlobalOptionSetDefinitions)/.test(name);
const isDataModelWrite = (name) => /^(createTable|createColumn|createCustomerColumn|createGlobalOptionSet|createRelationship|createAlternateKey|insertStatusValue)$/.test(name);
const indexesOf = (names, test) => names.map((n, i) => (test(n) ? i : -1)).filter((i) => i >= 0);
const NOTE = { 1033: 'Note', 3082: 'Nota' };

// A table the build creates, beside a view on a column of the EXISTING account table — the label the pre-flight
// would read the environment for. `localize` puts a localized label somewhere in the data model.
const localizedSpec = (filterLabel, localize) => {
  const created = customer([{ schemaName: 'new_note', type: 'Text', displayName: 'Note' }]);
  const spec = specOf([ACCOUNT, created], [view('account', [eq('industrycode', filterLabel)], 'Accounts')]);
  return localize ? localize(spec) : spec;
};
const onCustomer = (change) => (spec) => ({ ...spec, entities: spec.entities.map((e) => (e.schemaName === 'new_customer' ? change(e) : e)) });
const PLACEMENTS = {
  'a table\'s name': onCustomer((e) => ({ ...e, displayName: NOTE, pluralName: { 1033: 'Customers', 3082: 'Clientes' } })),
  'a primary column\'s name': onCustomer((e) => ({ ...e, primaryAttribute: { schemaName: 'new_name', displayName: NOTE } })),
  'a column\'s name': onCustomer((e) => ({ ...e, columns: [{ schemaName: 'new_note', type: 'Text', displayName: NOTE }] })),
  'an inline choice option': onCustomer((e) => ({ ...e, columns: [{ schemaName: 'new_tier', type: 'Choice', options: [NOTE, 'Other'] }] })),
  'an alternate key\'s name': onCustomer((e) => ({ ...e, alternateKeys: [{ schemaName: 'new_key', displayName: NOTE, columns: ['new_name'] }] })),
  'a relationship lookup\'s name': (spec) => ({
    ...spec,
    entities: [...spec.entities, { ...customer([]), schemaName: 'new_order', displayName: 'Order' }],
    relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_order', lookup: { schemaName: 'new_CustomerId', displayName: NOTE } }],
  }),
};
const ACCOUNT_TABLES = () => ({ account: { Picklist: { industrycode: INDUSTRY } } });

for (const [where, localize] of Object.entries(PLACEMENTS)) {
  test(`ADO 6691114 localized: with a localized label on ${where}, no label-bearing read precedes the data-model writes — the views phase checks after them`, async () => {
    const e = viewsEngine({ byTable: ACCOUNT_TABLES(), record: true });
    const { error } = await e.run(localizedSpec('Accounting', localize), { phases: FULL });
    assert.ifError(error);
    const reads = indexesOf(e.names, isLabelRead);
    const creates = indexesOf(e.names, isDataModelWrite);
    assert.ok(creates.length > 0, `the build created the data model: ${JSON.stringify(e.names)}`);
    assert.ok(reads.length > 0, 'the label was still resolved, by the views phase');
    assert.ok(Math.min(...reads) > Math.max(...creates), `a label-bearing read ran ahead of a create: ${JSON.stringify(e.names)}`);
    assert.deepStrictEqual(viewCondition(e.defs, 'Accounts', 'industrycode'), ['1']);
  });
}

test('ADO 6691114 localized: a typo still stops the build before any VIEW is written — after the data model, since nothing was read ahead of it', async () => {
  const e = viewsEngine({ byTable: ACCOUNT_TABLES(), record: true });
  const { error, result } = await e.run(localizedSpec('Accountig', PLACEMENTS['a column\'s name']), { phases: FULL });
  assert.strictEqual(result, undefined);
  assert.ok(error instanceof BuildHalt, String(error && error.stack));
  assert.strictEqual(error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'views');
  assert.match(error.message, /No view was written/);
  assert.match(error.message, /"Accountig" is not an option of account\.industrycode\. Valid labels: Accounting, Retail, Consulting\./);
  assert.ok(e.names.includes('createTable'), 'the data model went first');
  assert.deepStrictEqual(e.defs.filter(([type]) => type === 'view'), []);
  assert.deepStrictEqual(e.pushed, []);
});

test('ADO 6691114 localized: a spec with NO localized label keeps the pre-flight — its reads come before the first write', async () => {
  const e = viewsEngine({ byTable: ACCOUNT_TABLES(), record: true });
  const { error } = await e.run(localizedSpec('Accounting'), { phases: FULL });
  assert.ifError(error);
  const reads = indexesOf(e.names, isLabelRead);
  const writes = indexesOf(e.names, (n) => WRITE_CALL.test(n));
  assert.ok(reads.length > 0 && writes.length > 0);
  assert.ok(Math.min(...reads) < Math.min(...writes), JSON.stringify(e.names));
});

test('ADO 6691114 localized: a localized label with no label in any view filter costs no label read at all', async () => {
  const e = viewsEngine({ byTable: ACCOUNT_TABLES(), record: true });
  const spec = localizedSpec('Accounting', PLACEMENTS['a column\'s name']);
  spec.views = [view('account', [{ attr: 'ownerid', op: 'eq-userid' }], 'Mine')];
  const { error } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(indexesOf(e.names, isLabelRead), []);
});

// ── 6d. what the pre-flight resolved is not lost when the views phase's own read fails ───────────────

// Reads of option metadata fail from the moment the build has created a column — the views phase's own.
function failOptionReadsAfterTheDataModel(e) {
  let written = false;
  const createColumn = e.sdk.createColumn;
  e.sdk.createColumn = async (...args) => { written = true; return createColumn(...args); };
  const get = e.client.get;
  e.client.get = async (p) => (written && /AttributeMetadata\?/.test(p) ? { status: 503, headers: {}, body: {} } : get(p));
}

test('ADO 6691114 pre-flight: an existing global choice\'s real value is handed on, so a later failed read cannot fall back to 100000000 + index', async () => {
  // The set already exists with Gold = 227350001 (the spec numbers it 100000001). The pre-flight read it;
  // when the views phase's own read then fails, the view must still carry what the set holds.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_other: TIER } } }, globalSets: { new_tierset: TIER }, record: true });
  failOptionReadsAfterTheDataModel(e);
  const { error } = await e.run(specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['227350001']);
});

test('ADO 6691114 pre-flight: the value of a label on a column bound to an EXISTING global choice is among what it resolved', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const client = choiceClient({ new_customer: { Picklist: { new_other: TIER } } }, { globalSets: { new_tierset: opts([1, [1033, 'Platinum']], [2, [1033, 'Gold']]) } });
  const { problems, resolved } = await preflight(spec, client);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(resolved.get('new_customer|new_tier|Gold'), 2, 'the set is reused unchanged, so its number is the column\'s');
  // A set the environment lacks is created from the spec, so there is nothing final to hand on.
  const fresh = await preflight(spec, choiceClient({ new_customer: { Picklist: { new_other: TIER } } }));
  assert.strictEqual(fresh.resolved.size, 0);
});

test('ADO 6691114 build: when a read fails and the spec\'s own numbering is used, the build says so', async () => {
  // No pre-flight value exists for a column the build creates from inline options, so the views phase's fallback
  // is the only answer — right only for an option set this build created, which is what the warning says.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_other: TIER } } }, record: true });
  failOptionReadsAfterTheDataModel(e);
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const { error, warnings } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  const warned = warnings.filter((w) => /spec's own numbering/.test(w));
  assert.strictEqual(warned.length, 1, JSON.stringify(warnings));
  assert.match(warned[0], /new_customer/);
  assert.match(warned[0], /"Gold" on 'new_tier'/);
  assert.match(warned[0], /\(100000001\)/);
  assert.match(warned[0], /503/);
});

test('ADO 6691114 build: no fallback warning when the environment answered, or when there was no environment to ask', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const answered = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold']]) } } } });
  assert.deepStrictEqual((await answered.run(spec)).warnings, []);
  const blind = viewsEngine({});
  assert.deepStrictEqual((await blind.run(spec)).warnings, []);
});

test('ADO 6691114: resolveViewFilterLabels lists what a failed or partial read left open, with the value the build falls back to', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold'), eq('industrycode', 'Retail')])]);
  const r = await resolveAll(spec, choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503 }));
  assert.deepStrictEqual(r.inconclusive.map((p) => [p.attr, p.label, p.assumed, p.reason, p.why]), [
    ['new_tier', 'Gold', 100000001, 'unreadable', 'HTTP 503'],
    ['industrycode', 'Retail', 'Retail', 'unreadable', 'HTTP 503'],
  ]);
  const whole = await resolveAll(spec, choiceClient({ new_customer: { Picklist: { new_tier: opts([5, [1033, 'Gold']]) } } }));
  assert.deepStrictEqual(whole.inconclusive, [], 'an answered read leaves nothing open');
});

// ── 6e. a column whose options the spec numbers keeps the spec's number — where the environment has that option ──
//
// A maker renames an option ("Gold" -> "Gold Tier"), or a translation never reached the environment. The option's
// VALUE did not change, so a view filtered on the spec's label still has a well-defined meaning — and builds before
// labels were resolved against the environment built it, with the spec's number. Halting those builds would be a
// regression, so the spec's number stands where the environment still has that option, and the build says so.
// (Section 6g is the other half: the spec's number is NOT used where the environment shows another numbering.)

const INLINE_TIER = { schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] };
const RENAMED = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']]);
const LOCALIZED_TIER = { schemaName: 'new_tier', type: 'Choice', options: [{ 1033: 'Silver', 3082: 'Plata' }, { 1033: 'Gold', 3082: 'Oro' }] };
const BASE_LANGUAGE_ONLY = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold']]);
const inlineSpec = (label = 'Gold', column = INLINE_TIER) => specOf([customer([column])], [view('new_customer', [eq('new_tier', label)])]);
const inlineEnv = (rows) => choiceClient({ new_customer: { Picklist: { new_tier: rows } } });

test('ADO 6691114 inline: an option a maker RENAMED still resolves to the spec\'s own number — with a warning — instead of halting', async () => {
  const r = await resolveAll(inlineSpec('Gold'), inlineEnv(RENAMED));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
});

test('ADO 6691114 inline: the warning says what was ASSUMED — it does not claim the option on that number is the label\'s own', async () => {
  // The environment shows only that SOME option carries the number; that it is the option the label named is the
  // build's assumption, so the warning must say so, and say how to take the choice out of the build's hands.
  const [warning] = (await resolveAll(inlineSpec('Gold'), inlineEnv(RENAMED))).warnings;
  assert.match(warning, /The spec numbers "Gold" 100000001/);
  assert.match(warning, /option with that number, labelled "Gold Tier"/);
  assert.match(warning, /on the assumption that it is the same option under another label/);
  assert.match(warning, /use the integer value of the option you mean/);
  assert.doesNotMatch(warning, /the spec's own number for it — is there/, 'that wording stated the identity as a fact');
});

test('ADO 6691114 inline: a LOCALIZED option whose translation the environment lacks resolves to the spec\'s number, in the language it has', async () => {
  const r = await resolveAll(inlineSpec('Oro', LOCALIZED_TIER), inlineEnv(BASE_LANGUAGE_ONLY));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Oro'), 100000001);
  assert.match(r.warnings[0], /"Oro"/);
  // The language the environment DOES hold resolves on its own, with nothing to say.
  const known = await resolveAll(inlineSpec('Gold', LOCALIZED_TIER), inlineEnv(BASE_LANGUAGE_ONLY));
  assert.strictEqual(known.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.deepStrictEqual(known.warnings, []);
});

test('ADO 6691114 inline: it still halts when nothing vouches for the spec\'s number', async () => {
  // The environment no longer has option 100000001 at all: "Gold" names nothing there.
  const gone = await resolveAll(inlineSpec('Gold'), inlineEnv(opts([100000000, [1033, 'Silver']], [5, [1033, 'Gold Tier']])));
  assert.strictEqual(gone.problems.length, 1);
  assert.strictEqual(gone.problems[0].reason, 'unknown');
  assert.match(describeProblems(gone.problems), /"Gold" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold Tier\./);
  assert.strictEqual(gone.value('new_customer', 'new_tier', 'Gold'), undefined);
  // A label the spec does not have is a typo, whatever the environment holds.
  const typo = await resolveAll(inlineSpec('Platinum'), inlineEnv(RENAMED));
  assert.strictEqual(typo.problems.length, 1);
  assert.deepStrictEqual(typo.warnings, []);
});

test('ADO 6691114 global: a column bound to a global choice the spec DECLARES keeps the spec\'s numbering as an inline one does — a renamed option still resolves, with a warning', async () => {
  // 2.13.0 numbered a declared global choice 100000000 + index and built the view with that, so an app it built
  // must not stop on the rename of an option in the set. The numbering of a set that is another app's is a
  // different matter — see 6g: nothing is bound where the environment shows it.
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const r = await resolveAll(spec, inlineEnv(opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']])));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.strictEqual(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
});

test('ADO 6691114 global: a global choice the spec does NOT declare has no numbering to fall back on', async () => {
  // Lint rejects such a column; were it to reach the build, the spec has no number for the label at all.
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])], { globalChoices: [] });
  const r = await resolveAll(spec, inlineEnv(RENAMED));
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
});

test('ADO 6691114 inline: with two options carrying the label, the spec\'s number settles it only where it is one of them', async () => {
  const settled = await resolveAll(inlineSpec('Gold'), inlineEnv(opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold']], [227350001, [1033, 'Gold']])));
  assert.deepStrictEqual(settled.problems, []);
  assert.strictEqual(settled.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.match(settled.warnings[0], /lists more than one option labelled "Gold"/);
  assert.match(settled.warnings[0], /the spec numbers "Gold" 100000001, which is one of them/);
  const unsettled = await resolveAll(inlineSpec('Gold'), inlineEnv(opts([5, [1033, 'Gold']], [6, [1033, 'Gold']])));
  assert.strictEqual(unsettled.problems.length, 1);
  assert.strictEqual(unsettled.problems[0].reason, 'ambiguous');
});

test('ADO 6691114 inline: two options carry the label and the spec\'s number is NOT one of them — it is not used, though the environment has an option on it', async () => {
  // The only thing that stops this is the check that the spec's number is among the options carrying the label:
  // option 100000001 EXISTS (as "Gold Tier"), so "no such option" cannot be what rejects it.
  const rows = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [5, [1033, 'Gold']], [6, [1033, 'Gold']]);
  const r = await resolveAll(inlineSpec('Gold'), inlineEnv(rows));
  assert.deepStrictEqual(r.problems.map((p) => [p.reason, p.values]), [['ambiguous', [5, 6]]]);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.deepStrictEqual(r.warnings, []);
  const pre = await preflight(inlineSpec('Gold'), inlineEnv(rows));
  assert.deepStrictEqual(pre.problems.map((p) => p.reason), ['ambiguous']);
});

test('ADO 6691114 inline pre-flight: a renamed option is no problem — and is left to the views phase to resolve and warn about', async () => {
  const spec = inlineSpec('Gold');
  const renamed = await preflight(spec, inlineEnv(RENAMED));
  assert.deepStrictEqual(renamed.problems, []);
  assert.strictEqual(renamed.resolved.size, 0, 'not handed on as final: the warning is the views phase\'s to give');
  const gone = await preflight(spec, inlineEnv(opts([100000000, [1033, 'Silver']], [5, [1033, 'Gold Tier']])));
  assert.strictEqual(gone.problems.length, 1);
});

test('ADO 6691114 inline build: a spec that built before — an option renamed in the environment — still builds, with the spec\'s number and a warning', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: RENAMED } } }, record: true });
  const { error, warnings } = await e.run(inlineSpec('Gold'), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  assert.strictEqual(warnings.filter((w) => /lists no option labelled "Gold"/.test(w)).length, 1, JSON.stringify(warnings));
});

test('ADO 6691114 inline build: a localized option the environment holds in one language only still builds, filtered on the other', async () => {
  // A localized spec has no pre-flight, so this is the views phase alone.
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: BASE_LANGUAGE_ONLY } } }, record: true });
  const { error, warnings } = await e.run(inlineSpec('Oro', LOCALIZED_TIER), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  assert.ok(warnings.some((w) => /"Oro"/.test(w) && /100000001/.test(w)), JSON.stringify(warnings));
});

test('ADO 6691114 inline build: with nothing vouching for the spec\'s number it halts, before anything is written', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: opts([100000000, [1033, 'Silver']], [5, [1033, 'Gold Tier']]) } } }, record: true });
  const { error } = await e.run(inlineSpec('Gold'), { phases: FULL });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'preflight');
  assert.match(error.message, /"Gold" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold Tier\./);
  assert.deepStrictEqual(writesOf(e.names), []);
});

test('ADO 6691114 inline dry run: a renamed option leaves the view as create — the build would not stop on it', async () => {
  const { plan } = await dryRun(inlineSpec('Gold'), { new_customer: { Picklist: { new_tier: RENAMED } } });
  const item = plan.find((p) => /^view "Gold customers"/.test(p.label));
  assert.strictEqual(item.state, 'create');
  assert.strictEqual(item.wouldHalt, undefined);
});

test('ADO 6691114 inline verify: a view built with the spec\'s number for a renamed option verifies', async () => {
  const spec = inlineSpec('Gold');
  const read = makeChoiceReader({ client: inlineEnv(RENAMED) });
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: read }), { phases: ['views'] }));
  assert.strictEqual(check.present, true, JSON.stringify(check));
});

// ── 6g. …but never a number the environment shows belongs to ANOTHER option ──────────────────────────
//
// The spec's 100000000 + index is the environment's numbering only for an option set the build created from this
// very list. A rebuild never changes an existing column's options and does not create a column it finds, so options
// the author inserted or reordered since — or a column another app made, in another order — leave the two
// numberings apart, and the spec's number then names ANOTHER option. 2.13.0 bound it blindly. The sign is a label
// of the spec that the environment carries only on a different number (or the option on the spec's number going by
// another label of the spec): then the spec's number is not used, the label is simply an option the environment
// does not have, and the build says so before it writes anything.

const PENDING_COLUMN = { schemaName: 'new_tier', type: 'Choice', options: ['Pending', 'Open', 'Closed'] };
// The column as it was built, before "Pending" was put at the top of the spec's list.
const BUILT_WITHOUT_PENDING = opts([100000000, [1033, 'Open']], [100000001, [1033, 'Closed']]);

test('ADO 6691114 numbering: an option the spec gained at the top AFTER the column was built is not bound to the option now on its number', async () => {
  const spec = inlineSpec('Pending', PENDING_COLUMN);
  const r = await resolveAll(spec, inlineEnv(BUILT_WITHOUT_PENDING));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Pending'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.problems[0].reason, 'unknown');
  assert.match(describeProblems(r.problems), /"Pending" is not an option of new_customer\.new_tier\. Valid labels: Open, Closed\./);
  assert.deepStrictEqual(r.warnings, [], 'nothing was bound, so there is nothing to warn of');
  // The pre-flight finds it too, before anything is written…
  const pre = await preflight(spec, inlineEnv(BUILT_WITHOUT_PENDING));
  assert.strictEqual(pre.problems.length, 1);
  assert.deepStrictEqual(pre.notes, []);
  // …and a label the environment DOES carry is the environment's: Open is 100000000 there, not the spec's 100000001.
  const open = await resolveAll(inlineSpec('Open', PENDING_COLUMN), inlineEnv(BUILT_WITHOUT_PENDING));
  assert.strictEqual(open.value('new_customer', 'new_tier', 'Open'), 100000000);
  assert.deepStrictEqual(open.warnings, []);
});

test('ADO 6691114 numbering: another label of the spec on a different number refuses the spec\'s number, even when the option on it goes by a name the spec never had', async () => {
  // The spec lists [Pending, Open, Closed], so Pending is 100000000 and Closed 100000002. The environment was built from
  // [Open, Closed] and Open has since been renamed "Opened": nothing the environment calls 100000000 is a label of the
  // spec — but Closed is on 100000001, where the spec has Open, so the two numberings are not the same.
  const rows = opts([100000000, [1033, 'Opened']], [100000001, [1033, 'Closed']]);
  const r = await resolveAll(inlineSpec('Pending', PENDING_COLUMN), inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Pending'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual((await preflight(inlineSpec('Pending', PENDING_COLUMN), inlineEnv(rows))).problems.length, 1);
});

test('ADO 6691114 numbering: options reordered in the spec and one renamed in the environment — the renamed label is not bound to its neighbour', async () => {
  // Built from [Silver, Gold, Bronze]. The spec now lists [Bronze, Silver, Gold], which numbers Gold 100000002 — the
  // number the environment's column gives Bronze — and a maker has renamed Gold there to "Gold Tier".
  const reordered = (label) => inlineSpec(label, { schemaName: 'new_tier', type: 'Choice', options: ['Bronze', 'Silver', 'Gold'] });
  const env = () => inlineEnv(opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']]));
  const gold = await resolveAll(reordered('Gold'), env());
  assert.strictEqual(gold.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.strictEqual(gold.problems.length, 1);
  assert.match(describeProblems(gold.problems), /"Gold" is not an option of new_customer\.new_tier\. Valid labels: Silver, Gold Tier, Bronze\./);
  assert.deepStrictEqual(gold.warnings, []);
  assert.strictEqual((await preflight(reordered('Gold'), env())).problems.length, 1);
  const bronze = await resolveAll(reordered('Bronze'), env());
  assert.strictEqual(bronze.value('new_customer', 'new_tier', 'Bronze'), 100000002, 'what the environment names, it names');
});

test('ADO 6691114 numbering: a localized label the environment lacks is not bound to a number the environment gives another option', async () => {
  // The environment's column was built in the other order, in the base language only: its 100000001 is Silver,
  // which the spec numbers 100000000. "Oro" is Gold's Spanish label, so it must not become Silver.
  const swapped = opts([100000000, [1033, 'Gold']], [100000001, [1033, 'Silver']]);
  const r = await resolveAll(inlineSpec('Oro', LOCALIZED_TIER), inlineEnv(swapped));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Oro'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.match(describeProblems(r.problems), /"Oro" is not an option of new_customer\.new_tier\. Valid labels: Gold, Silver\./);
  assert.deepStrictEqual(r.warnings, []);
});

test('ADO 6691114 numbering: a label of the spec the environment carries in ANOTHER language of an option on a different number counts as carried there', async () => {
  // "Plata" (Silver's Spanish label, 100000000 in the spec) is on 100000001 in the environment, as that option's second
  // language — so the numberings differ, whichever language the label is read in.
  const column = { schemaName: 'new_tier', type: 'Choice', options: [{ 1033: 'Silver', 3082: 'Plata' }, { 1033: 'Gold', 3082: 'Oro' }, { 1033: 'Bronze', 3082: 'Bronce' }] };
  const rows = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier'], [3082, 'Plata']], [100000002, [1033, 'Bronze']]);
  const r = await resolveAll(inlineSpec('Bronce', column), inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Bronce'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.deepStrictEqual(r.warnings, []);
});

test('ADO 6691114 numbering: an inline column of a table the build did not create, numbered otherwise there, is not bound by the spec\'s numbers', async () => {
  const priority = { schemaName: 'new_priority', type: 'Choice', options: ['Low', 'Medium', 'High', 'Critical'] };
  const spec = (label) => specOf([customer([priority], { existing: true })], [view('new_customer', [eq('new_priority', label)])]);
  // The column came from elsewhere, in another order, and has no "Critical": its 100000003 is Medium.
  const there = () => choiceClient({ new_customer: { Picklist: { new_priority: opts([100000000, [1033, 'Low']], [100000001, [1033, 'High']], [100000002, [1033, 'Urgent']], [100000003, [1033, 'Medium']]) } } });
  const r = await resolveAll(spec('Critical'), there());
  assert.strictEqual(r.value('new_customer', 'new_priority', 'Critical'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual((await preflight(spec('Critical'), there())).problems.length, 1);
});

test('ADO 6691114 numbering: the option on the spec\'s number must not go by the name of another option of the spec — even one that is also on its own number', async () => {
  const tiers = { schemaName: 'new_tier', type: 'Choice', options: ['Gold', 'Silver', 'Bronze'] };
  // Silver is on 100000001 as the spec says, but ALSO on 100000000 — the number the spec gives Gold. Every label of the
  // spec the environment carries is on its own number, so only the name the option on 100000000 goes by gives it away.
  const rows = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Silver']], [100000002, [1033, 'Bronze']]);
  const r = await resolveAll(inlineSpec('Gold', tiers), inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.deepStrictEqual(r.warnings, []);
});

test('ADO 6691114 numbering: a multi-select column is judged the same way — a renamed option keeps the spec\'s number, a shifted numbering halts', async () => {
  const tags = { schemaName: 'new_tags', type: 'MultiChoice', options: ['Silver', 'Gold'] };
  const spec = (label) => specOf([customer([tags])], [{ entity: 'new_customer', name: 'Tagged', columns: ['new_name'], filters: [{ attr: 'new_tags', op: 'contain-values', value: label }] }]);
  const env = (rows) => choiceClient({ new_customer: { MultiSelectPicklist: { new_tags: rows } } });
  const renamed = await resolveAll(spec('Gold'), env(RENAMED));
  assert.deepStrictEqual(renamed.problems, []);
  assert.strictEqual(renamed.value('new_customer', 'new_tags', 'Gold'), 100000001);
  assert.strictEqual(renamed.warnings.length, 1);
  const shifted = await resolveAll(spec('Gold'), env(opts([100000000, [1033, 'Gold Tier']], [100000001, [1033, 'Silver']])));
  assert.strictEqual(shifted.value('new_customer', 'new_tags', 'Gold'), undefined);
  assert.strictEqual(shifted.problems.length, 1);
});

test('ADO 6691114 numbering pre-flight: a renamed option is a NOTE — for the dry run to say — and still no problem', async () => {
  const pre = await preflight(inlineSpec('Gold'), inlineEnv(RENAMED));
  assert.deepStrictEqual(pre.problems, []);
  assert.strictEqual(pre.notes.length, 1);
  assert.match(pre.notes[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
  assert.match(pre.notes[0], /100000001/);
  const named = await preflight(inlineSpec('Silver'), inlineEnv(RENAMED));
  assert.deepStrictEqual(named.notes, [], 'a label the environment names has nothing to note');
});

test('ADO 6691114 numbering build: options inserted in the spec after the column was built halt before anything is written', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: BUILT_WITHOUT_PENDING } } }, record: true });
  const { error, warnings } = await e.run(inlineSpec('Pending', PENDING_COLUMN), { phases: FULL });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'preflight');
  assert.match(error.message, /"Pending" is not an option of new_customer\.new_tier\. Valid labels: Open, Closed\./);
  assert.deepStrictEqual(writesOf(e.names), []);
  assert.deepStrictEqual(warnings, []);
});

test('ADO 6691114 numbering build: a localized spec has no pre-flight, so the views phase halts — still before any view is written', async () => {
  const swapped = opts([100000000, [1033, 'Gold']], [100000001, [1033, 'Silver']]);
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: swapped } } }, record: true });
  const { error } = await e.run(inlineSpec('Oro', LOCALIZED_TIER), { phases: FULL });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'views');
  assert.match(error.message, /"Oro" is not an option of new_customer\.new_tier\. Valid labels: Gold, Silver\./);
  assert.deepStrictEqual(e.defs.filter(([type]) => type === 'view'), []);
  assert.deepStrictEqual(e.pushed, []);
});

test('ADO 6691114 numbering dry run: a label the build would stop on is unknown — one it would bind is create, and the note is said', async () => {
  const warned = [];
  const stop = await dryRun(inlineSpec('Pending', PENDING_COLUMN), { new_customer: { Picklist: { new_tier: BUILT_WITHOUT_PENDING } } }, [], { warn: (m) => warned.push(m) });
  const item = stop.plan.find((p) => /^view "Gold customers"/.test(p.label));
  assert.strictEqual(item.state, 'unknown');
  assert.strictEqual(item.wouldHalt, true);
  assert.match(item.stateWhy, /"Pending" is not an option of new_customer\.new_tier\. Valid labels: Open, Closed\./);
  assert.deepStrictEqual(warned, []);
  const bound = await dryRun(inlineSpec('Gold'), { new_customer: { Picklist: { new_tier: RENAMED } } }, [], { warn: (m) => warned.push(m) });
  assert.strictEqual(bound.plan.find((p) => /^view "Gold customers"/.test(p.label)).state, 'create');
  assert.strictEqual(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
  assert.match(warned[0], /100000001/);
});

test('ADO 6691114 numbering dry run: a note several views would give is said once', async () => {
  const warned = [];
  const spec = specOf([customer([INLINE_TIER])], [view('new_customer', [eq('new_tier', 'Gold')], 'One'), view('new_customer', [eq('new_tier', 'Gold')], 'Two')]);
  const { plan } = await dryRun(spec, { new_customer: { Picklist: { new_tier: RENAMED } } }, [], { warn: (m) => warned.push(m) });
  assert.deepStrictEqual(plan.filter((p) => /^view /.test(p.label)).map((p) => p.state), ['create', 'create']);
  assert.strictEqual(warned.length, 1, JSON.stringify(warned));
});

test('ADO 6691114 numbering verify: the spec\'s number is not what verify expects where the environment shows another numbering', async () => {
  const spec = inlineSpec('Pending', PENDING_COLUMN);
  const read = makeChoiceReader({ client: inlineEnv(BUILT_WITHOUT_PENDING) });
  // 100000000 is what 2.13.0 would have deployed for "Pending" — and is Open in this environment.
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000000'), choiceAttributes: read }), { phases: ['views'] }));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /"Pending" is not an option of new_customer\.new_tier\. Valid labels: Open, Closed\./);
});

// ── 6f. a column bound to a global choice, whose own options could not be read ───────────────────────

test('ADO 6691114 global: when a column\'s own options cannot be read, the global choice is read itself — not guessed at from the spec\'s numbering', async () => {
  const spec = (label) => specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', label)])]);
  const resolve = (label, options) => {
    const client = choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503, ...options });
    return resolveViewFilterLabels(spec(label), spec(label).views, { read: makeChoiceReader({ client }), readGlobalChoice: makeGlobalChoiceReader({ client }) });
  };
  // The set exists with Gold = 227350001; the spec numbers it 100000001.
  const r = await resolve('Gold', { globalSets: { new_tierset: TIER } });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 227350001);
  assert.deepStrictEqual(r.warnings, [], 'nothing was guessed, so nothing to warn of');
  assert.deepStrictEqual(r.inconclusive, []);
  // A label the set does not have is the set's problem, naming its labels.
  const typo = await resolve('Platinum', { globalSets: { new_tierset: TIER } });
  assert.strictEqual(typo.problems.length, 1);
  assert.match(describeProblems(typo.problems), /Valid labels: Silver, Gold, Bronze\./);
  // With no set to read either, the spec's numbering is the fallback it always was — with its warning.
  const none = await resolve('Gold', { failGlobal: true });
  assert.strictEqual(none.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.match(none.warnings[0], /spec's own numbering \(100000001\)/);
});

test('ADO 6691114 global build: in a spec with a localized label — so no pre-flight, nothing handed on — a failed views-phase read resolves from the global choice', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_other: TIER } } }, globalSets: { new_tierset: TIER }, record: true });
  failOptionReadsAfterTheDataModel(e);
  const spec = specOf([customer([GLOBAL_TIER_COLUMN, { schemaName: 'new_note', type: 'Text', displayName: NOTE }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const { error, warnings } = await e.run(spec, { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['227350001']);
  assert.deepStrictEqual(warnings.filter((w) => /numbering/.test(w)), []);
});

// ── 6h. a renamed option in a global choice the spec DECLARES ────────────────────────────────────────
//
// 2.13.0 numbered a declared global choice 100000000 + index and built the view with that, with no read — so an app
// it built, whose maker later renamed an option of the set, built and verified. Halting it now would be a regression
// the maker could not see coming (nobody touched the spec), and `build --apply --verify` would fail on every run.
// What protects against a set that is ANOTHER app's is what protects an inline column: the check of the environment
// (6g) — a set numbered in another order or from another publisher's range is not bound.

const GLOBAL_RENAMED = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']]);
// The set as another app made it: another order, so the environment's 100000001 is Silver — and, separately, from
// another publisher's range, where nothing sits on the spec's numbers at all.
const GLOBAL_OTHER_ORDER = opts([100000000, [1033, 'Bronze']], [100000001, [1033, 'Silver']], [100000002, [1033, 'Gold Tier']]);
const GLOBAL_OTHER_RANGE = opts([727000000, [1033, 'Silver']], [727000001, [1033, 'Gold Tier']], [727000002, [1033, 'Bronze']]);
const globalSpec = (label = 'Gold', extra) => specOf([customer([GLOBAL_TIER_COLUMN, ...(extra || [])])], [view('new_customer', [eq('new_tier', label)])]);
const withTierColumn = (rows) => ({ new_customer: { Picklist: { new_tier: rows } } });
const withoutTierColumn = { new_customer: { Picklist: { new_other: TIER } } };

test('ADO 6691114 global: a renamed option of a declared global choice is no problem in the pre-flight — a note, handed on to the views phase to resolve', async () => {
  // The column is there: its own options say it.
  const there = await preflight(globalSpec('Gold'), choiceClient(withTierColumn(GLOBAL_RENAMED)));
  assert.deepStrictEqual(there.problems, []);
  assert.strictEqual(there.resolved.size, 0, 'the warning is the views phase\'s to give');
  assert.strictEqual(there.notes.length, 1);
  // The column is not: the build creates it against the set that exists, so the SET is what says.
  const creating = await preflight(globalSpec('Gold'), choiceClient(withoutTierColumn, { globalSets: { new_tierset: GLOBAL_RENAMED } }));
  assert.deepStrictEqual(creating.problems, []);
  assert.strictEqual(creating.resolved.size, 0);
  assert.strictEqual(creating.notes.length, 1);
  assert.match(creating.notes[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
  // A label the set does name is final, as it was.
  const named = await preflight(globalSpec('Silver'), choiceClient(withoutTierColumn, { globalSets: { new_tierset: GLOBAL_RENAMED } }));
  assert.strictEqual(named.resolved.get('new_customer|new_tier|Silver'), 100000000);
  assert.deepStrictEqual(named.notes, []);
});

test('ADO 6691114 global: a set another app numbered otherwise is not bound by the spec\'s numbers — in another order or another range, column there or not', async () => {
  for (const rows of [GLOBAL_OTHER_ORDER, GLOBAL_OTHER_RANGE]) {
    const label = JSON.stringify(rows.map((r) => r.Value));
    const resolved = await resolveAll(globalSpec('Gold'), choiceClient(withTierColumn(rows)));
    assert.strictEqual(resolved.value('new_customer', 'new_tier', 'Gold'), undefined, label);
    assert.strictEqual(resolved.problems.length, 1, label);
    assert.deepStrictEqual(resolved.warnings, [], label);
    const column = await preflight(globalSpec('Gold'), choiceClient(withTierColumn(rows)));
    assert.strictEqual(column.problems.length, 1, label);
    const set = await preflight(globalSpec('Gold'), choiceClient(withoutTierColumn, { globalSets: { new_tierset: rows } }));
    assert.strictEqual(set.problems.length, 1, label);
    assert.deepStrictEqual(set.notes, [], label);
  }
});

test('ADO 6691114 global: when the column\'s own options cannot be read, the set read for the views phase follows the same rule', async () => {
  const resolve = (label, rows) => {
    const client = choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503, globalSets: { new_tierset: rows } });
    const spec = globalSpec(label);
    return resolveViewFilterLabels(spec, spec.views, { read: makeChoiceReader({ client }), readGlobalChoice: makeGlobalChoiceReader({ client }) });
  };
  const renamed = await resolve('Gold', GLOBAL_RENAMED);
  assert.deepStrictEqual(renamed.problems, []);
  assert.strictEqual(renamed.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.strictEqual(renamed.warnings.length, 1, JSON.stringify(renamed.warnings));
  assert.match(renamed.warnings[0], /lists no option labelled "Gold" on 'new_customer'\.'new_tier'/);
  for (const rows of [GLOBAL_OTHER_ORDER, GLOBAL_OTHER_RANGE]) {
    const other = await resolve('Gold', rows);
    assert.strictEqual(other.value('new_customer', 'new_tier', 'Gold'), undefined);
    assert.strictEqual(other.problems.length, 1);
  }
});

test('ADO 6691114 global build: an app 2.13.0 built, a maker having renamed an option of the set since, still builds — the spec\'s number and a warning', async () => {
  const e = viewsEngine({ byTable: withTierColumn(GLOBAL_RENAMED), globalSets: { new_tierset: GLOBAL_RENAMED }, record: true });
  const { error, warnings } = await e.run(globalSpec('Gold'), { phases: FULL });
  assert.ifError(error);
  assert.ok(writesOf(e.names).length > 0, 'the build went on to write');
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  assert.strictEqual(warnings.filter((w) => /lists no option labelled "Gold"/.test(w)).length, 1, JSON.stringify(warnings));
});

test('ADO 6691114 global build: a column the build creates against an existing set whose option was renamed builds too', async () => {
  // Nothing in the environment carries the column yet, so the pre-flight reads the set — and the views phase, whose
  // column read finds nothing in this stub environment either, reads it again.
  const e = viewsEngine({ byTable: withoutTierColumn, globalSets: { new_tierset: GLOBAL_RENAMED }, record: true });
  const { error, warnings } = await e.run(globalSpec('Gold'), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  assert.strictEqual(warnings.filter((w) => /lists no option labelled "Gold"/.test(w)).length, 1, JSON.stringify(warnings));
});

test('ADO 6691114 global build: a spec with a localized label — no pre-flight — builds the same way, instead of halting after the data model', async () => {
  const e = viewsEngine({ byTable: withTierColumn(GLOBAL_RENAMED), globalSets: { new_tierset: GLOBAL_RENAMED }, record: true });
  const { error, warnings } = await e.run(globalSpec('Gold', [{ schemaName: 'new_note', type: 'Text', displayName: NOTE }]), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), ['100000001']);
  assert.strictEqual(warnings.filter((w) => /lists no option labelled "Gold"/.test(w)).length, 1, JSON.stringify(warnings));
});

test('ADO 6691114 global build: a set another app numbered otherwise halts before anything is written', async () => {
  const e = viewsEngine({ byTable: withTierColumn(GLOBAL_OTHER_ORDER), globalSets: { new_tierset: GLOBAL_OTHER_ORDER }, record: true });
  const { error, warnings } = await e.run(globalSpec('Gold'), { phases: FULL });
  assert.strictEqual(error && error.code, 'view-filter-label-unresolved');
  assert.strictEqual(error.phase, 'preflight');
  assert.match(error.message, /"Gold" is not an option of new_customer\.new_tier\. Valid labels: Bronze, Silver, Gold Tier\./);
  assert.deepStrictEqual(writesOf(e.names), []);
  assert.deepStrictEqual(warnings, []);
});

test('ADO 6691114 global build: a view that already exists, over a set whose option was renamed, neither says verify will fail nor halts', async () => {
  const e = viewsEngine({ byTable: withTierColumn(GLOBAL_RENAMED), globalSets: { new_tierset: GLOBAL_RENAMED }, existingViews: ['Gold customers'], record: true });
  const { error, warnings } = await e.run(globalSpec('Gold'), { phases: FULL });
  assert.ifError(error);
  assert.deepStrictEqual(warnings.filter((w) => /verify will report/.test(w)), []);
});

test('ADO 6691114 global verify: a view built with the spec\'s number over a renamed option of a declared global choice verifies — as under 2.13.0', async () => {
  const spec = globalSpec('Gold');
  const read = () => makeChoiceReader({ client: choiceClient(withTierColumn(GLOBAL_RENAMED)) });
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: read() }), { phases: ['views'] }));
  assert.strictEqual(check.present, true, JSON.stringify(check));
  // A set numbered otherwise is still what verify reports against, with the valid labels.
  const foreign = () => makeChoiceReader({ client: choiceClient(withTierColumn(GLOBAL_OTHER_ORDER)) });
  const bad = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: foreign() }), { phases: ['views'] }));
  assert.strictEqual(bad.present, false);
  assert.match(bad.detail, /"Gold" is not an option of new_customer\.new_tier\. Valid labels: Bronze, Silver, Gold Tier\./);
});

test('ADO 6691114 global dry run: a renamed option of the set leaves the view as create, with the note said; another app\'s numbering is unknown', async () => {
  const warned = [];
  const bound = await dryRun(globalSpec('Gold'), withoutTierColumn, [], { globalSets: { new_tierset: GLOBAL_RENAMED }, warn: (m) => warned.push(m) });
  const item = bound.plan.find((p) => /^view "Gold customers"/.test(p.label));
  assert.strictEqual(item.state, 'create');
  assert.strictEqual(item.wouldHalt, undefined);
  assert.strictEqual(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /lists no option labelled "Gold"/);
  const stop = await dryRun(globalSpec('Gold'), withoutTierColumn, [], { globalSets: { new_tierset: GLOBAL_OTHER_RANGE } });
  const refused = stop.plan.find((p) => /^view "Gold customers"/.test(p.label));
  assert.strictEqual(refused.state, 'unknown');
  assert.strictEqual(refused.wouldHalt, true);
});

// ── 6i. a maker's OWN edits are not another numbering — and every refusal says why ───────────────────
//
// 6g refuses the spec's number when the environment shows the numbering MOVED. A maker's own edits do not move it:
// an option added in the Default solution takes another publisher's range, and one deleted and re-created takes the
// next free number, so every number the spec has stays where it was. A spec that 2.13.0 built right after such edits
// plus a rename of the filtered option must still build — with the warning — instead of stopping on an option the spec
// merely did not know about. A refusal, where there still is one, says why the spec's number was not used.

const THREE_TIERS = { schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold', 'Bronze'] };
const FOUR_TIERS = { schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold', 'Bronze', 'Platinum'] };
// What 2.13.0 sent for the spec's filter: its own number, with no look at the environment.
const sentBy213 = (spec) => String(viewDef(spec, spec.views[0]).filters.conditions.find((c) => c.attribute === 'new_tier').value);
// [shape, the spec's column, what the environment holds] — "Gold" was renamed "Gold Tier" in each.
const MAKER_EDITS = [
  ['an option added in another publisher\'s range', FOUR_TIERS, opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']], [797700000, [1033, 'Platinum']])],
  ['an option deleted and re-created at the next free number', THREE_TIERS, opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000003, [1033, 'Bronze']])],
  ['an option re-created in another publisher\'s range', THREE_TIERS, opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [797700000, [1033, 'Bronze']])],
];

test('ADO 6691114 maker edits: an option a maker added or re-made elsewhere, and another renamed, still resolve to the spec\'s number — what 2.13.0 sent — with a warning', async () => {
  for (const [shape, column, rows] of MAKER_EDITS) {
    const spec = inlineSpec('Gold', column);
    const r = await resolveAll(spec, inlineEnv(rows));
    assert.deepStrictEqual(r.problems, [], shape);
    assert.strictEqual(String(r.value('new_customer', 'new_tier', 'Gold')), sentBy213(spec), shape);
    assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001, shape);
    assert.strictEqual(r.warnings.length, 1, `${shape}: ${JSON.stringify(r.warnings)}`);
    assert.match(r.warnings[0], /labelled "Gold Tier"/, shape);
    const pre = await preflight(spec, inlineEnv(rows));
    assert.deepStrictEqual(pre.problems, [], shape);
    assert.strictEqual(pre.notes.length, 1, shape);
  }
});

test('ADO 6691114 maker edits build: it goes on, writes the spec\'s number and warns once — for a new view and for one that already exists', async () => {
  for (const [shape, column, rows] of MAKER_EDITS) {
    const spec = inlineSpec('Gold', column);
    for (const existingViews of [[], ['Gold customers']]) {
      const what = `${shape}${existingViews.length ? ', the view exists' : ''}`;
      const e = viewsEngine({ byTable: withTierColumn(rows), existingViews, record: true });
      const { error, warnings } = await e.run(spec, { phases: FULL });
      assert.ok(!error, `${what}: ${error && error.message}`);
      assert.ok(writesOf(e.names).length > 0, `${what}: the build went on to write`);
      if (!existingViews.length) assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), [sentBy213(spec)], what);
      assert.strictEqual(warnings.filter((w) => /lists no option labelled "Gold"/.test(w)).length, 1, `${what}: ${JSON.stringify(warnings)}`);
      assert.deepStrictEqual(warnings.filter((w) => /verify will report/.test(w)), [], what);
    }
  }
});

test('ADO 6691114 maker edits verify and dry run: a view built that way verifies, and the dry run leaves a new one as create — with the assumption said', async () => {
  for (const [shape, column, rows] of MAKER_EDITS) {
    const spec = inlineSpec('Gold', column);
    const read = makeChoiceReader({ client: inlineEnv(rows) });
    const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', sentBy213(spec)), choiceAttributes: read }), { phases: ['views'] }));
    assert.strictEqual(check.present, true, `${shape}: ${JSON.stringify(check)}`);
    const warned = [];
    const { plan } = await dryRun(spec, withTierColumn(rows), [], { warn: (m) => warned.push(m) });
    const item = plan.find((p) => /^view "Gold customers"/.test(p.label));
    assert.strictEqual(item.state, 'create', shape);
    assert.strictEqual(item.wouldHalt, undefined, shape);
    assert.strictEqual(warned.length, 1, `${shape}: ${JSON.stringify(warned)}`);
  }
});

test('ADO 6691114 maker edits: the filtered option\'s OWN label found on another number is still a sign the numbering moved — in whatever range that number is', async () => {
  // "Oro" is Gold's Spanish label and the spec numbers Gold 100000000. The environment carries "Oro" on an option in another
  // publisher's range, so the option the spec calls Gold is THERE: 100000000, which is called "Gold Tier", is not it.
  const column = { schemaName: 'new_tier', type: 'Choice', options: [{ 1033: 'Gold', 3082: 'Oro' }, { 1033: 'Silver', 3082: 'Plata' }] };
  const rows = opts([100000000, [1033, 'Gold Tier']], [100000001, [1033, 'Silver'], [3082, 'Plata']], [797700000, [3082, 'Oro']]);
  const spec = inlineSpec('Gold', column);
  const r = await resolveAll(spec, inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.match(describeProblems(r.problems), /\("Oro" is numbered 797700000 there, 100000000 in the spec\), so that number is not used\./);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual((await preflight(spec, inlineEnv(rows))).problems.length, 1);
});

test('ADO 6691114 maker edits: the price of the rule — a column made elsewhere with an extra option, whose filtered option was renamed, binds the spec\'s number as 2.13.0 did, and never silently', async () => {
  // The spec lists [Silver, Gold]. The environment's column was made elsewhere — [Gold Tier, Platinum, Silver] — so its
  // 100000001, the spec's number for Gold, is "Platinum". Silver is on 100000002, a number the spec does not use: that reads
  // as an option added elsewhere, not as a shift, so nothing contradicts the spec's number (nor confirms it). The value is
  // the one 2.13.0 sent, and every place that binds it says what it landed on.
  const spec = inlineSpec('Gold');
  const rows = opts([100000000, [1033, 'Gold Tier']], [100000001, [1033, 'Platinum']], [100000002, [1033, 'Silver']]);
  const r = await resolveAll(spec, inlineEnv(rows));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(String(r.value('new_customer', 'new_tier', 'Gold')), sentBy213(spec), 'never a different value than 2.13.0 sent');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /option with that number, labelled "Platinum"/);
  assert.match(r.warnings[0], /on the assumption that it is the same option under another label/);
  for (const existingViews of [[], ['Gold customers']]) {
    const e = viewsEngine({ byTable: withTierColumn(rows), existingViews, record: true });
    const { error, warnings } = await e.run(spec, { phases: FULL });
    assert.ok(!error, error && error.message);
    assert.strictEqual(warnings.filter((w) => /labelled "Platinum"/.test(w)).length, 1, `${existingViews.length ? 'view exists' : 'new view'}: ${JSON.stringify(warnings)}`);
    if (!existingViews.length) assert.deepStrictEqual(viewCondition(e.defs, 'Gold customers', 'new_tier'), [sentBy213(spec)]);
    const said = [];
    await dryRun(spec, withTierColumn(rows), existingViews, { warn: (m) => said.push(m) });
    assert.strictEqual(said.filter((w) => /labelled "Platinum"/.test(w)).length, 1, `dry run, ${existingViews.length ? 'view exists' : 'new view'}: ${JSON.stringify(said)}`);
  }
});

test('ADO 6691114 refusal: every refusal of the spec\'s number says why — and a label the spec never numbered does not pretend to have had one', async () => {
  const oroColumn = { schemaName: 'new_tier', type: 'Choice', options: [{ 1033: 'Gold', 3082: 'Oro' }, { 1033: 'Silver', 3082: 'Plata' }] };
  const cases = [
    ['no option on the number', inlineSpec('Gold'), opts([100000000, [1033, 'Silver']], [5, [1033, 'Gold Tier']]),
      /The spec numbers "Gold" 100000001, but the environment has no option numbered 100000001, so that number is not used\./],
    ['the option on the number goes by another option of the spec', inlineSpec('Pending', PENDING_COLUMN), BUILT_WITHOUT_PENDING,
      /The spec numbers "Pending" 100000000, but the environment shows another numbering \(the option numbered 100000000 there is labelled "Open", which the spec numbers 100000001\), so that number is not used\./],
    ['a label of the spec moved to a number the spec gives another option', inlineSpec('Pending', PENDING_COLUMN), opts([100000000, [1033, 'Opened']], [100000001, [1033, 'Closed']]),
      /but the environment shows another numbering \("Closed" is numbered 100000001 there, 100000002 in the spec\), so that number is not used\./],
    ['the filtered option\'s own alias moved', inlineSpec('Gold', oroColumn), opts([100000000, [1033, 'Gold Tier']], [100000001, [1033, 'Silver'], [3082, 'Plata']], [797700000, [3082, 'Oro']]),
      /but the environment shows another numbering \("Oro" is numbered 797700000 there, 100000000 in the spec\), so that number is not used\./],
    ['two options carry the label and neither is on the spec\'s number', inlineSpec('Gold'), opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [5, [1033, 'Gold']], [6, [1033, 'Gold']]),
      /names more than one option \(5, 6\), so it cannot choose between them\. The spec numbers "Gold" 100000001, but the environment shows another numbering \("Gold" is numbered 5 and 6 there, 100000001 in the spec\), so that number is not used\. Use the integer value of the one you mean\./],
  ];
  for (const [shape, spec, rows, said] of cases) {
    const r = await resolveAll(spec, inlineEnv(rows));
    assert.strictEqual(r.problems.length, 1, shape);
    assert.match(describeProblems(r.problems), said, shape);
    const pre = await preflight(spec, inlineEnv(rows));
    assert.match(describeProblems(pre.problems), said, `${shape}: the pre-flight says it too`);
  }
  // A typo has no number to refuse; neither does a column the spec does not number at all.
  const typo = await resolveAll(inlineSpec('Platinum'), inlineEnv(RENAMED));
  assert.strictEqual(typo.problems.length, 1);
  assert.doesNotMatch(describeProblems(typo.problems), /The spec numbers/);
  const industry = await resolveAll(specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Accounts')]), choiceClient({ account: { Picklist: { industrycode: INDUSTRY } } }));
  assert.strictEqual(industry.problems.length, 1);
  assert.doesNotMatch(describeProblems(industry.problems), /The spec numbers/);
});

test('ADO 6691114 refusal: the reason reaches every place the problem is reported — both halts, the dry run, verify, and the line for a view that already exists', async () => {
  const REASON = /The spec numbers "Pending" 100000000, but the environment shows another numbering \(the option numbered 100000000 there is labelled "Open", which the spec numbers 100000001\), so that number is not used\./;
  const spec = inlineSpec('Pending', PENDING_COLUMN);
  const byTable = withTierColumn(BUILT_WITHOUT_PENDING);
  const preflightHalt = await viewsEngine({ byTable, record: true }).run(spec, { phases: FULL });
  assert.strictEqual(preflightHalt.error && preflightHalt.error.phase, 'preflight');
  assert.match(preflightHalt.error.message, REASON);
  const viewsHalt = await viewsEngine({ byTable }).run(spec, { phases: ['views'] });
  assert.strictEqual(viewsHalt.error && viewsHalt.error.phase, 'views');
  assert.match(viewsHalt.error.message, REASON);
  const { plan } = await dryRun(spec, byTable);
  assert.match(plan.find((p) => /^view "Gold customers"/.test(p.label)).stateWhy, REASON);
  const read = makeChoiceReader({ client: inlineEnv(BUILT_WITHOUT_PENDING) });
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000000'), choiceAttributes: read }), { phases: ['views'] }));
  assert.match(check.detail, REASON);
  // A view that exists is not stopped on, so the line that says verify will report it carries the reason too.
  const existing = await viewsEngine({ byTable, existingViews: ['Gold customers'], record: true }).run(spec, { phases: FULL });
  assert.ok(!existing.error, existing.error && existing.error.message);
  const line = existing.warnings.find((w) => /already exists/.test(w));
  assert.match(line, /verify will report that\. The spec numbers "Pending" 100000000, but the environment shows another numbering/);
  assert.match(line, REASON);
});

test('ADO 6691114 refusal: a declared global choice says why too — from the column\'s own read, and from the set itself', async () => {
  const noOption = /but the environment has no option numbered 100000001, so that number is not used\./;
  const otherOrder = /\(the option numbered 100000001 there is labelled "Silver", which the spec numbers 100000000\), so that number is not used\./;
  for (const [rows, said] of [[GLOBAL_OTHER_RANGE, noOption], [GLOBAL_OTHER_ORDER, otherOrder]]) {
    const spec = globalSpec('Gold');
    const column = await resolveAll(spec, choiceClient(withTierColumn(rows)));
    assert.match(describeProblems(column.problems), said, 'the views phase, the column read');
    const set = await preflight(spec, choiceClient(withoutTierColumn, { globalSets: { new_tierset: rows } }));
    assert.match(describeProblems(set.problems), said, 'the pre-flight, the set read');
    const failing = choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503, globalSets: { new_tierset: rows } });
    const viaSet = await resolveViewFilterLabels(spec, spec.views, { read: makeChoiceReader({ client: failing }), readGlobalChoice: makeGlobalChoiceReader({ client: failing }) });
    assert.match(describeProblems(viaSet.problems), said, 'the views phase, the set read');
  }
});

test('ADO 6691114 numbering: the option on the spec\'s number is read in EVERY language — the second-language label of another option gives it away', async () => {
  // 100000000 is "Gold Tier" in English and "Silver" in Spanish — the spec's Silver, which is 100000001 — and Silver itself IS on
  // 100000001. Every label of the spec the environment carries is on its own number, so only the other language of the option on
  // Gold's number shows that it is another option's.
  const tiers = { schemaName: 'new_tier', type: 'Choice', options: ['Gold', 'Silver', 'Bronze'] };
  const rows = opts([100000000, [1033, 'Gold Tier'], [3082, 'Silver']], [100000001, [1033, 'Silver']], [100000002, [1033, 'Bronze']]);
  const spec = inlineSpec('Gold', tiers);
  const r = await resolveAll(spec, inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.strictEqual(r.problems.length, 1);
  assert.match(describeProblems(r.problems), /labelled "Silver", which the spec numbers 100000001/);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual((await preflight(spec, inlineEnv(rows))).problems.length, 1);
});

// The case of a label is the environment's to change: "Open" -> "open" renumbers nothing, and an environment that differs
// from the spec only in case must not hide that its numbering differs. Comparing without regard to case is the guard's
// alone — a label still RESOLVES by its exact text — and refusing more is the safe direction: the integer value works.

const CASED = { schemaName: 'new_tier', type: 'Choice', options: ['Pending', 'Open', 'Closed'] };

test('ADO 6691114 case: an environment whose labels differ from the spec\'s only in case does not hide that its numbering differs', async () => {
  // Built from ['open', 'closed'] (in whatever case the environment holds them); the spec has since been re-cased and
  // gained "Pending" at the top.
  for (const [open, closed] of [['open', 'closed'], ['OPEN', 'CLOSED'], ['oPeN', 'cLoSeD']]) {
    const rows = opts([100000000, [1033, open]], [100000001, [1033, closed]]);
    for (const label of ['Pending', 'Open']) {
      const what = `${label} over ${open}/${closed}`;
      const spec = inlineSpec(label, CASED);
      const r = await resolveAll(spec, inlineEnv(rows));
      assert.strictEqual(r.value('new_customer', 'new_tier', label), undefined, what);
      assert.strictEqual(r.problems.length, 1, what);
      assert.match(describeProblems(r.problems), new RegExp(`Valid labels: ${open}, ${closed}\\.`), what);
      assert.deepStrictEqual(r.warnings, [], what);
      const e = viewsEngine({ byTable: withTierColumn(rows), record: true });
      const { error } = await e.run(spec, { phases: FULL });
      assert.strictEqual(error && error.code, 'view-filter-label-unresolved', what);
      assert.strictEqual(error.phase, 'preflight', what);
      assert.deepStrictEqual(writesOf(e.names), [], what);
    }
    const asked = await resolveAll(inlineSpec('Open', CASED), inlineEnv(rows));
    assert.match(describeProblems(asked.problems), new RegExp(`labelled "${closed}", which the spec numbers 100000002`));
  }
});

test('ADO 6691114 case: a label of the spec carried on another number in another case is carried there', async () => {
  // "Open" was renamed "Opened", and "Closed" is now "closed" on 100000001 — the number the spec gives Open. The refusal quotes the
  // environment's spelling beside the spec's; where the environment spells it the spec's way it says nothing more.
  for (const closed of ['closed', 'CLOSED', 'Closed']) {
    const rows = opts([100000000, [1033, 'Opened']], [100000001, [1033, closed]]);
    const r = await resolveAll(inlineSpec('Pending', CASED), inlineEnv(rows));
    assert.strictEqual(r.value('new_customer', 'new_tier', 'Pending'), undefined, closed);
    assert.strictEqual(r.problems.length, 1, closed);
    assert.match(describeProblems(r.problems), closed === 'Closed'
      ? /\("Closed" is numbered 100000001 there, 100000002 in the spec\)/
      : new RegExp(`\\("Closed" \\(as "${closed}"\\) is numbered 100000001 there, 100000002 in the spec\\)`), closed);
  }
});

test('ADO 6691114 case: a refusal found through case folding quotes the environment\'s spelling beside the spec\'s — the environment has no "Gold", it has "GOLD"', async () => {
  // Spec [Silver, Gold]: Gold is 100000001. The environment's Gold is "GOLD", on 100000002, and it has no option on Gold's number
  // that goes by another name of the spec's, so it is the folded label that shows the numbering moved.
  const rows = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Bronze']], [100000002, [1033, 'GOLD']]);
  const r = await resolveAll(inlineSpec('Gold'), inlineEnv(rows));
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), undefined);
  assert.match(describeProblems(r.problems), /\("Gold" \(as "GOLD"\) is numbered 100000002 there, 100000001 in the spec\)/);
  // Two spellings are both shown, with every number they sit on.
  const twins = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Bronze']], [100000002, [1033, 'GOLD']], [100000003, [1033, 'gold']]);
  const both = await resolveAll(inlineSpec('Gold'), inlineEnv(twins));
  assert.match(describeProblems(both.problems), /\("Gold" \(as "GOLD" and "gold"\) is numbered 100000002 and 100000003 there, 100000001 in the spec\)/);
});

test('ADO 6691114 case: a rename that only changes case keeps the spec\'s number — and a label still resolves by its exact text alone', async () => {
  const rows = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'GOLD']], [100000002, [1033, 'Bronze']]);
  const r = await resolveAll(inlineSpec('Gold', THREE_TIERS), inlineEnv(rows));
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.value('new_customer', 'new_tier', 'Gold'), 100000001);
  assert.strictEqual(r.warnings.length, 1, 'not matched by name — matching stays exact — so the build says it used the spec\'s number');
  assert.match(r.warnings[0], /labelled "GOLD"/);
  // A spec written in another case over a renamed option keeps its number too.
  const lower = { schemaName: 'new_tier', type: 'Choice', options: ['silver', 'gold', 'bronze'] };
  const renamed = opts([100000000, [1033, 'Silver']], [100000001, [1033, 'Gold Tier']], [100000002, [1033, 'Bronze']]);
  const kept = await resolveAll(inlineSpec('gold', lower), inlineEnv(renamed));
  assert.deepStrictEqual(kept.problems, []);
  assert.strictEqual(kept.value('new_customer', 'new_tier', 'gold'), 100000001);
});

test('ADO 6691114 dry run, a view that already exists: it stays reuse, and the dry run says the assumption the apply will warn of — once', async () => {
  const spec = specOf([customer([INLINE_TIER])], [view('new_customer', [eq('new_tier', 'Gold')], 'Old'), view('new_customer', [eq('new_tier', 'Gold')], 'New')]);
  const warned = [];
  const { plan } = await dryRun(spec, withTierColumn(RENAMED), ['Old'], { warn: (m) => warned.push(m) });
  assert.strictEqual(plan.find((p) => /^view "Old"/.test(p.label)).state, 'reuse');
  assert.strictEqual(plan.find((p) => /^view "New"/.test(p.label)).state, 'create');
  assert.strictEqual(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /on the assumption that it is the same option under another label/);
  // Said for the existing view alone, too — the apply warns whether or not the view is there.
  const alone = [];
  await dryRun(inlineSpec('Gold'), withTierColumn(RENAMED), ['Gold customers'], { warn: (m) => alone.push(m) });
  assert.strictEqual(alone.length, 1, JSON.stringify(alone));
  // A view whose labels resolve cleanly has nothing to say.
  const clean = [];
  await dryRun(inlineSpec('Silver'), withTierColumn(RENAMED), ['Gold customers'], { warn: (m) => clean.push(m) });
  assert.deepStrictEqual(clean, []);
});

test('ADO 6691114 dry run, a view that already exists: a label no option answers to is said — verify will report it — and does not stop the build', async () => {
  const spec = inlineSpec('Pending', PENDING_COLUMN);
  const warned = [];
  const { plan } = await dryRun(spec, withTierColumn(BUILT_WITHOUT_PENDING), ['Gold customers'], { warn: (m) => warned.push(m) });
  const item = plan.find((p) => /^view "Gold customers"/.test(p.label));
  assert.strictEqual(item.state, 'reuse', 'the apply leaves the view as it is, so it is not a view the dry run says would stop');
  assert.strictEqual(item.wouldHalt, undefined);
  assert.strictEqual(warned.length, 1, JSON.stringify(warned));
  assert.match(warned[0], /view "Gold customers" \(new_customer\) already exists, so its filters are left as they are — but "Pending" is not an option of new_customer\.new_tier, and verify will report that\. The spec numbers "Pending" 100000000, but/);
});

test('ADO 6691114 dry run, a view that already exists: the dry run and the apply say the same words', async () => {
  for (const [shape, spec, rows] of [['the assumption', inlineSpec('Gold'), RENAMED], ['verify will report', inlineSpec('Pending', PENDING_COLUMN), BUILT_WITHOUT_PENDING]]) {
    const applied = await viewsEngine({ byTable: withTierColumn(rows), existingViews: ['Gold customers'], record: true }).run(spec, { phases: FULL });
    assert.ok(!applied.error, shape);
    const dry = [];
    await dryRun(spec, withTierColumn(rows), ['Gold customers'], { warn: (m) => dry.push(m) });
    const aboutTheLabel = (list) => list.filter((w) => /"Gold"|"Pending"/.test(w));
    assert.strictEqual(aboutTheLabel(dry).length, 1, `${shape}: ${JSON.stringify(dry)}`);
    assert.deepStrictEqual(aboutTheLabel(dry), aboutTheLabel(applied.warnings), shape);
  }
});

test('ADO 6691114 dry run, a view that already exists: a label that names more than one option is said as that, not as "is not an option" — in the dry run and in the apply', async () => {
  // Two options labelled "Gold", and the environment has no option on the number the spec gives Gold (100000001): the label is ambiguous, and the
  // reason that follows it is that the spec's number is not used — a first sentence that said Gold is not an option would contradict both.
  const rows = opts([100000000, [1033, 'Silver']], [100000003, [1033, 'Gold']], [100000004, [1033, 'Gold']]);
  const spec = inlineSpec('Gold');
  const said = /^view "Gold customers" \(new_customer\) already exists, so its filters are left as they are — but "Gold" names more than one option of new_customer\.new_tier \(100000003, 100000004\), and verify will report that\. The spec numbers "Gold" 100000001, but the environment has no option numbered 100000001, so that number is not used\.$/;
  const dry = [];
  await dryRun(spec, withTierColumn(rows), ['Gold customers'], { warn: (m) => dry.push(m) });
  const aboutGold = (list) => list.filter((w) => /"Gold"/.test(w));
  assert.strictEqual(aboutGold(dry).length, 1, JSON.stringify(dry));
  assert.match(aboutGold(dry)[0], said);
  const applied = await viewsEngine({ byTable: withTierColumn(rows), existingViews: ['Gold customers'], record: true }).run(spec, { phases: FULL });
  assert.ok(!applied.error);
  assert.deepStrictEqual(aboutGold(applied.warnings), aboutGold(dry));
  // A label that names no option keeps its words.
  const none = [];
  await dryRun(inlineSpec('Platinum'), withTierColumn(rows), ['Gold customers'], { warn: (m) => none.push(m) });
  assert.match(none.find((w) => /"Platinum"/.test(w)), /but "Platinum" is not an option of new_customer\.new_tier, and verify will report that\./);
});

// ── 7. the dry run ────────────────────────────────────────────────────────────────────────────────

async function dryRun(spec, byTable, existingViews = [], { warn, globalSets } = {}) {
  const client = choiceClient(byTable, { globalSets });
  const provision = {
    dataverse: client,
    queryRecords: async () => [],
    findArtifact: async (kind, identity) => (kind === 'view' && existingViews.includes(identity.name) ? 'existing' : null),
  };
  const plan = planFor(spec, { phases: ['views'] });
  await annotateLivePlan(plan, { spec, provision, warn });
  return { plan, client };
}

test('ADO 6691114 dry run: an unresolvable label on a view the build would create is reported as unknown, with the reason', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const { plan } = await dryRun(spec, { new_customer: { Picklist: { new_tier: TIER } } });
  const item = plan.find((p) => /^view "Top customers"/.test(p.label));
  assert.strictEqual(item.state, 'unknown');
  assert.match(item.stateWhy, /"Platinum"/);
  assert.match(item.stateWhy, /new_customer\.new_tier/);
  assert.match(item.stateWhy, /Silver, Gold, Bronze/);
});

test('ADO 6691114 dry run: a label that resolves leaves the view as create', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')], 'Gold customers')]);
  const { plan } = await dryRun(spec, { new_customer: { Picklist: { new_tier: TIER } } });
  assert.strictEqual(plan.find((p) => /^view "Gold customers"/.test(p.label)).state, 'create');
});

test('ADO 6691114 dry run: a view that already exists stays reuse whatever its labels — its filters are never reapplied (what the dry run says of it is tested with the numbering)', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const { plan } = await dryRun(spec, { new_customer: { Picklist: { new_tier: TIER } } }, ['Top customers']);
  assert.strictEqual(plan.find((p) => /^view "Top customers"/.test(p.label)).state, 'reuse');
});

test('ADO 6691114 dry run: a table that does not exist yet is judged by what the spec declares', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [
    view('new_customer', [eq('new_tier', 'Gold')], 'Good'),
    view('new_customer', [eq('new_tier', 'Platinum')], 'Bad'),
  ]);
  const { plan } = await dryRun(spec, {});
  assert.strictEqual(plan.find((p) => /^view "Good"/.test(p.label)).state, 'create');
  const bad = plan.find((p) => /^view "Bad"/.test(p.label));
  assert.strictEqual(bad.state, 'unknown');
  assert.match(bad.stateWhy, /Silver, Gold/);
});

test('ADO 6691114 dry run: the reproduced failure is reported as unknown, and the right label is not', async () => {
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accountig')], 'Typo'), view('account', [eq('industrycode', 'Accounting')], 'Right')]);
  const { plan } = await dryRun(spec, { account: { Picklist: { industrycode: INDUSTRY } } });
  const typo = plan.find((p) => /^view "Typo"/.test(p.label));
  assert.strictEqual(typo.state, 'unknown');
  assert.match(typo.stateWhy, /"Accountig" is not an option of account\.industrycode\. Valid labels: Accounting, Retail, Consulting\./);
  assert.strictEqual(plan.find((p) => /^view "Right"/.test(p.label)).state, 'create');
});

test('ADO 6691114 dry run: the dry run judges what the build would, so a status reason the build inserts is not unknown', async () => {
  const spec = specOf([{ ...ACCOUNT, statusReasons: [{ label: 'Passed QA', state: 'Active' }] }], [view('account', [eq('statuscode', 'Passed QA')], 'Passed')]);
  const { plan } = await dryRun(spec, { account: { Status: { statuscode: opts([1, [1033, 'Active']], [2, [1033, 'Inactive']]) } } });
  assert.strictEqual(plan.find((p) => /^view "Passed"/.test(p.label)).state, 'create');
});

test('ADO 6691114 dry run: a declared global choice that already exists with other options is judged by those, not by the spec', async () => {
  const spec = (label) => specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', label)], 'Tier')]);
  const onTable = { new_customer: { Picklist: { new_other: TIER } } };
  const live = opts([1, [1033, 'Platinum']], [2, [1033, 'Gold']]);
  const run = async (label) => {
    const client = choiceClient(onTable, { globalSets: { new_tierset: live } });
    const provision = { dataverse: client, queryRecords: async () => [], findArtifact: async () => null };
    const plan = planFor(spec(label), { phases: ['views'] });
    await annotateLivePlan(plan, { spec: spec(label), provision });
    return plan.find((p) => /^view "Tier"/.test(p.label));
  };
  assert.strictEqual((await run('Platinum')).state, 'create');
  assert.strictEqual((await run('Silver')).state, 'unknown');
});

// ── 8. verify expects the value the build wrote ───────────────────────────────────────────────────

test('ADO 6691114 dry run: the plan item for a label known to be bad says the apply would stop on it — it was read, not unreadable', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers'), view('new_customer', [eq('new_tier', 'Gold')], 'Gold customers')]);
  const { plan } = await dryRun(spec, { new_customer: { Picklist: { new_tier: TIER } } });
  const bad = plan.find((p) => /^view "Top customers"/.test(p.label));
  assert.strictEqual(bad.state, 'unknown', 'still marked `? unknown`: the view will not be created as planned');
  assert.strictEqual(bad.wouldHalt, true);
  assert.deepStrictEqual(plan.filter((p) => p.wouldHalt), [bad], 'no other item carries the mark');
});

test('ADO 6691114 dry run: the engine\'s dry-run result carries the mark in planItems, for the CLI summary to count', async () => {
  const e = viewsEngine({ byTable: { new_customer: { Picklist: { new_tier: TIER } } } });
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers'), view('new_customer', [eq('new_tier', 'Gold')], 'Gold customers')]);
  const r = await runSdkBuild(spec, { sdk: e.sdk, apply: false, phases: ['views'], preResolvedLanguageCode: 1033 });
  const byLabel = (frag) => r.planItems.find((p) => p.label.includes(frag));
  assert.strictEqual(byLabel('Top customers').wouldHalt, true);
  assert.strictEqual(byLabel('Top customers').state, 'unknown');
  assert.strictEqual(byLabel('Gold customers').wouldHalt, undefined);
  assert.strictEqual(byLabel('Gold customers').state, 'create');
});

test('ADO 6691114 dry run: the CLI summary counts a label known to be bad as one that would STOP the build, not as one it could not read', async () => {
  const planItems = [
    { phase: 'views', label: 'view "Fine" for new_customer', state: 'create' },
    { phase: 'views', label: 'view "Unread" for new_customer', state: 'unknown', stateWhy: 'the table\'s attributes could not be read' },
    { phase: 'views', label: 'view "Bad" for new_customer', state: 'unknown', stateWhy: '"Platinum" is not an option of new_customer.new_tier.', wouldHalt: true },
  ];
  const logs = [];
  await buildModelApp(specOf([customer([])], []), { apply: false, env: 'https://x', profile: 'structural' }, {
    log: (m) => logs.push(m),
    runBuild: async () => ({ ok: true, dryRun: true, livePlan: true, plan: [], planItems }),
  });
  const summary = logs.find((l) => /dry run —/.test(l));
  assert.match(summary, /1 to create, 0 already present, 1 could not be read, 1 would stop the build \(3 steps\)/, summary);
  // Alone, the bad label is not "could not be read" at all.
  const alone = [];
  await buildModelApp(specOf([customer([])], []), { apply: false, env: 'https://x', profile: 'structural' }, {
    log: (m) => alone.push(m),
    runBuild: async () => ({ ok: true, dryRun: true, livePlan: true, plan: [], planItems: [planItems[2]] }),
  });
  assert.doesNotMatch(alone.find((l) => /dry run —/.test(l)), /could not be read/);
  assert.match(alone.find((l) => /dry run —/.test(l)), /1 would stop the build/);
});

test('ADO 6691114 localized: the dry run keeps its report — it creates nothing, so its reads precede no create', async () => {
  const spec = localizedSpec('Accountig', PLACEMENTS['a column\'s name']);
  const { plan } = await dryRun(spec, ACCOUNT_TABLES());
  const typo = plan.find((p) => /^view "Accounts"/.test(p.label));
  assert.strictEqual(typo.state, 'unknown');
  assert.match(typo.stateWhy, /"Accountig" is not an option of account\.industrycode/);
});

const fetchXmlWith = (attribute, value) => `<fetch><entity name="new_customer"><filter type="and"><condition attribute="${attribute}" operator="eq" value="${value}" /></filter></entity></fetch>`;

function verifyReader(spec, { fetchxml, choiceAttributes }) {
  const row = { savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/></row></grid>', fetchxml };
  return {
    findTable: async () => ({ logicalName: 'new_customer' }),
    findColumns: async () => [{ logicalName: 'new_name' }, { logicalName: 'new_tier' }],
    queryRecords: async (set) => (set === 'savedquery' ? [row] : []),
    sitemapXml: async () => '',
    ...(choiceAttributes ? { choiceAttributes } : {}),
  };
}

const verifySpecOf = () => specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])], { solution: { uniqueName: 'S', publisherPrefix: 'new' } });
const filterCheck = (result) => result.checks.find((c) => c.kind === 'view-filters');

test('ADO 6691114 verify: the deployed value the build resolved from the environment verifies, when the reader can resolve it too', async () => {
  const spec = verifySpecOf();
  const read = makeChoiceReader({ client: choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }) });
  const ok = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '227350001'), choiceAttributes: read }), { phases: ['views'] });
  const check = filterCheck(ok);
  assert.ok(check, JSON.stringify(ok.checks.map((c) => c.name || c.kind)));
  assert.strictEqual(check.present, true, JSON.stringify(check));
});

test('ADO 6691114 verify: a deployed value that is not the environment\'s fails, naming what was expected', async () => {
  const spec = verifySpecOf();
  const read = makeChoiceReader({ client: choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }) });
  const bad = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: read }), { phases: ['views'] });
  const check = filterCheck(bad);
  assert.strictEqual(check.present, false);
  assert.match(JSON.stringify(check), /227350001/);
});

test('ADO 6691114 verify: a label the environment cannot resolve is reported, not silently compared as text', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')])]);
  const read = makeChoiceReader({ client: choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }) });
  const bad = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', 'Platinum'), choiceAttributes: read }), { phases: ['views'] });
  const check = filterCheck(bad);
  assert.strictEqual(check.present, false);
  assert.match(JSON.stringify(check), /Platinum/);
  assert.match(JSON.stringify(check), /Silver, Gold, Bronze/);
});

test('ADO 6691114 verify: a reader without the capability keeps the old spec-only expectation', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const ok = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001') }), { phases: ['views'] });
  assert.strictEqual(filterCheck(ok).present, true);
});

test('ADO 6691114 verify: one read per table for the whole pass, however many views name it', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [
    view('new_customer', [eq('new_tier', 'Gold')], 'One'),
    view('new_customer', [eq('new_tier', 'Silver')], 'Two'),
  ]);
  const calls = [];
  const choiceAttributes = (entity, o) => { calls.push([entity, o]); return makeChoiceReader({ client: choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }) })(entity); };
  const result = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '227350001'), choiceAttributes }), { phases: ['views'] });
  assert.strictEqual(calls.length, 1, 'verify memoizes the reader for the pass');
  assert.deepStrictEqual(calls[0], ['new_customer', { languageCode: undefined }]);
  assert.strictEqual(result.checks.filter((c) => c.kind === 'view-filters').length, 2);
});

test('ADO 6691114 verify: a reader that throws leaves a declared option to the spec and a missing one reported, never a crash', async () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [
    view('new_customer', [eq('new_tier', 'Gold')], 'Fine'),
    view('new_customer', [eq('new_tier', 'Platinum')], 'Broken'),
  ]);
  const choiceAttributes = async () => { throw new Error('metadata is down'); };
  const result = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes }), { phases: ['views'] });
  const [fine, broken] = result.checks.filter((c) => c.kind === 'view-filters');
  assert.strictEqual(fine.present, true);
  assert.strictEqual(broken.present, false);
  assert.match(broken.detail, /Platinum/);
  assert.match(broken.detail, /metadata is down/);
});

test('ADO 6691114 verify: a failed metadata read reports the label as UNRESOLVED, with the reason — never as a missing filter', async () => {
  // account.industrycode: the deployed view holds 1 (Accounting), which is right. The read that would have said
  // so failed — and that is a fact about the read, not about the view.
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const failing = makeChoiceReader({ client: choiceClient({ account: {} }, { failCast: 'Picklist', status: 503 }) });
  const result = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('industrycode', '1'), choiceAttributes: failing }), { phases: ['views'] });
  const check = filterCheck(result);
  assert.strictEqual(check.present, false, 'it cannot be proven, so it is not reported as proven');
  assert.match(check.detail, /could not read the options of account\.industrycode \(HTTP 503\)/);
  assert.match(check.detail, /"Accounting"/);
  assert.doesNotMatch(check.detail, /missing filter/);
});

test('ADO 6691114 verify: a reader that throws leaves an undeclared column\'s label UNRESOLVED too — with the thrown reason', async () => {
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const choiceAttributes = async () => { throw new Error('metadata is down'); };
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('industrycode', '1'), choiceAttributes }), { phases: ['views'] }));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /metadata is down/);
  assert.doesNotMatch(check.detail, /missing filter/);
});

test('ADO 6691114 verify: a plain-text filter on a column the spec does not declare still verifies when the read fails — what is deployed is what was written', async () => {
  const spec = specOf([ACCOUNT], [view('account', [eq('name', 'Contoso')], 'Accounts')]);
  const failing = makeChoiceReader({ client: choiceClient({ account: {} }, { failCast: 'Picklist', status: 503 }) });
  const result = await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('name', 'Contoso'), choiceAttributes: failing }), { phases: ['views'] });
  assert.strictEqual(filterCheck(result).present, true, JSON.stringify(filterCheck(result)));
});

test('ADO 6691114 verify: a declared column\'s value that differs from the spec\'s numbering is unresolved — not missing — when the read failed', async () => {
  // The set existed with Gold = 227350001, so the view rightly holds that and not the spec's 100000001.
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const failing = () => makeChoiceReader({ client: choiceClient({ new_customer: {} }, { failCast: 'Picklist', status: 503 }) });
  const differs = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '227350001'), choiceAttributes: failing() }), { phases: ['views'] }));
  assert.strictEqual(differs.present, false);
  assert.match(differs.detail, /could not read the options of new_customer\.new_tier \(HTTP 503\)/);
  assert.doesNotMatch(differs.detail, /missing filter/);
  // Where the deployed value IS the spec's numbering, the fallback was right and the view verifies.
  const same = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: failing() }), { phases: ['views'] }));
  assert.strictEqual(same.present, true, JSON.stringify(same));
});

test('ADO 6691114 verify: a failed metadata read does not hide a filter that is missing from the view altogether', async () => {
  // The read failure explains a DIFFERENT value on a condition that is there; it explains nothing where the view has
  // no condition on that attribute (or none with that operator) — there the filter is simply not deployed.
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting')], 'Accounts')]);
  const failing = () => makeChoiceReader({ client: choiceClient({ account: {} }, { failCast: 'Picklist', status: 503 }) });
  const check = async (fetchxml) => filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml, choiceAttributes: failing() }), { phases: ['views'] }));
  const absent = await check(fetchXmlWith('name', 'Contoso'));
  assert.strictEqual(absent.present, false);
  assert.match(absent.detail, /missing filter\(s\): industrycode eq Accounting/);
  assert.doesNotMatch(absent.detail, /could not read the options/);
  const otherOperator = await check('<fetch><entity name="account"><filter type="and"><condition attribute="industrycode" operator="ne" value="1" /></filter></entity></fetch>');
  assert.match(otherOperator.detail, /missing filter\(s\): industrycode eq Accounting/);
  assert.doesNotMatch(otherOperator.detail, /could not read the options/);
  // A condition on the attribute with the same operator is the one the failed read would have named: unresolved.
  const sameOperator = await check(fetchXmlWith('industrycode', '2'));
  assert.match(sameOperator.detail, /could not read the options of account\.industrycode \(HTTP 503\)/);
  assert.doesNotMatch(sameOperator.detail, /missing filter/);
});

test('ADO 6691114 verify: with two guessed labels, only the one the view has no condition for is called missing', async () => {
  const spec = specOf([ACCOUNT], [view('account', [eq('industrycode', 'Accounting'), eq('customertypecode', 'Competitor')], 'Accounts')]);
  const failing = makeChoiceReader({ client: choiceClient({ account: {} }, { failCast: 'Picklist', status: 503 }) });
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('industrycode', '2'), choiceAttributes: failing }), { phases: ['views'] }));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /could not read the options of account\.industrycode \(HTTP 503\)/);
  assert.match(check.detail, /missing filter\(s\): customertypecode eq Competitor/);
});

test('ADO 6691114 verify: with the environment readable, a wrong deployed value is still a missing filter', async () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  const read = makeChoiceReader({ client: choiceClient({ new_customer: { Picklist: { new_tier: TIER } } }) });
  const check = filterCheck(await verifySpec(spec, verifyReader(spec, { fetchxml: fetchXmlWith('new_tier', '100000001'), choiceAttributes: read }), { phases: ['views'] }));
  assert.strictEqual(check.present, false);
  assert.match(check.detail, /missing filter\(s\): new_tier eq 227350001/);
});

test('ADO 6691114 verify: the CLI\'s own reader supplies choiceAttributes through the SDK\'s raw client, and never throws', async () => {
  const { readerFor } = require('../verify-model-app.js');
  const client = choiceClient({ new_customer: { Picklist: { new_tier: TIER } } });
  const sdk = {
    queryRecords: async (set) => (set === 'savedquery'
      ? [{ savedqueryid: 'v1', layoutxml: '<grid><row><cell name="new_name"/></row></grid>', fetchxml: fetchXmlWith('new_tier', '227350001') }]
      : []),
    findTables: async () => [{ logicalName: 'new_customer' }],
    findColumns: async () => [{ logicalName: 'new_name' }, { logicalName: 'new_tier' }],
    dataverse: client,
  };
  const reader = readerFor(sdk, 'new_app', {});
  const answer = await reader.choiceAttributes('new_customer', { languageCode: 1033 });
  assert.strictEqual(answer.state, 'ok');
  assert.deepStrictEqual(answer.attributes.get('new_tier').options.map((o) => o.shown), ['Silver', 'Gold', 'Bronze']);
  const result = await verifySpec(verifySpecOf(), reader, { phases: ['views'] });
  assert.strictEqual(filterCheck(result).present, true, JSON.stringify(filterCheck(result)));
  // No raw client at all: the capability answers `error` instead of throwing into verify.
  const blind = readerFor({ ...sdk, dataverse: undefined }, 'new_app', {});
  assert.strictEqual((await blind.choiceAttributes('new_customer')).state, 'error');
});

// ── 9. lint: offline can only check what the spec declares, and says so ────────────────────────────

const lint = (spec) => lintAppSpec(spec).warnings.filter((w) => /checked against the environment/.test(w));

test('ADO 6691114 lint: a label the spec declares is checked offline and says nothing', () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Gold')])]);
  assert.deepStrictEqual(lint(spec), []);
  // …and so is one on a column bound to a global choice the spec declares.
  assert.deepStrictEqual(lint(specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')])])), []);
});

test('ADO 6691114 lint: a column bound to a global choice the spec does not declare stays the existing lint ERROR, with no second warning', () => {
  // The build creates such a column with no options at all, so it is refused rather than resolved from the
  // environment: lint reports it once, as an error, and has nothing to add about the labels filtered on it.
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Gold')], 'Gold customers')], { globalChoices: [] });
  const result = lintAppSpec(spec);
  assert.ok(result.errors.some((e) => /Column new_customer\.new_tier references unknown globalChoice 'new_tierset'/.test(e)), JSON.stringify(result.errors));
  assert.deepStrictEqual(lint(spec), []);
});

test('ADO 6691114 lint: a label that is not among the declared options warns that the environment decides', () => {
  const spec = specOf([customer([{ schemaName: 'new_tier', type: 'Choice', options: ['Silver', 'Gold'] }])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const [w] = lint(spec);
  assert.match(w, /Top customers/);
  assert.match(w, /Platinum/);
  assert.match(w, /Silver, Gold/);
  assert.match(w, /halts/);
});

test('ADO 6691114 lint: a label that is not among a declared global choice\'s options warns the same way, naming the set\'s labels', () => {
  const spec = specOf([customer([GLOBAL_TIER_COLUMN])], [view('new_customer', [eq('new_tier', 'Platinum')], 'Top customers')]);
  const [w] = lint(spec);
  assert.match(w, /Platinum/);
  assert.match(w, /Silver, Gold, Bronze/);
});

test('ADO 6691114 lint: the reproduced failure — a label on a column of an existing table the spec does not declare — is flagged, and an integer or no-value filter is not', () => {
  // This spec passed lint silently, and the build then failed mid-way.
  const spec = specOf([ACCOUNT], [
    view('account', [eq('industrycode', 'Accounting'), eq('industrycode', '1'), { attr: 'ownerid', op: 'eq-userid' }, { attr: 'createdon', op: 'this-week' }], 'Accounts'),
  ]);
  const found = lint(spec);
  assert.strictEqual(found.length, 1, JSON.stringify(found));
  assert.match(found[0], /industrycode/);
  assert.match(found[0], /Accounting/);
  assert.match(found[0], /halts/);
});

test('ADO 6691114 lint: a value that cannot be a label (a GUID, a date, a pattern) is not flagged', () => {
  const spec = specOf([{ schemaName: 'account', displayName: 'Account', existing: true, primaryAttribute: { schemaName: 'name' }, columns: [] }], [
    view('account', [eq('parentaccountid', '11111111-2222-3333-4444-555555555555'), { attr: 'createdon', op: 'on', value: '2024-01-31' }, { attr: 'name', op: 'like', value: 'A%' }], 'Odd ones'),
  ]);
  assert.deepStrictEqual(lint(spec), []);
});

test('ADO 6691114 lint: a spec with a localized label keeps the warning — the check merely moves to the views phase', () => {
  const found = lint(localizedSpec('Accounting', PLACEMENTS['a column\'s name']));
  assert.strictEqual(found.length, 1, JSON.stringify(found));
  assert.match(found[0], /before any view is written/, 'still true: the views phase halts before it writes a view');
});
