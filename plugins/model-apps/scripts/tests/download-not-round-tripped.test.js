'use strict';
// AB#6686423 — download-model-app reported an app as fully downloaded while emitting empty
// `forms[]`, `views[]` and `charts[]`, "with nothing reporting the loss".
//
// Four of the five reported defects (missing columns, missing relationships, guessed
// `contoso_name` primary attributes, absent entity metadata) turned out to be one upstream cause —
// an Azure CLI token from the wrong tenant, whose 401 every best-effort read swallowed — and are
// fixed by the AB#6686427 preflight on this same branch. What genuinely remains is the artifact
// classes hydrateSpec deliberately does not reconstruct, and the fact that nothing said so.
//
// These tests pin the REPORT, not a reconstruction. Reconstructing forms was reconsidered and
// rejected: the App Spec form shape cannot express everything a deployed `formxml` carries, and a
// lossy form DECLARED in the spec is worse than an absent one, because a rebuild into a fresh
// environment would recreate it having silently lost controls while reporting success.
const { test } = require('node:test');
const assert = require('node:assert');
const { notRoundTrippedSummary, notRoundTrippedWarning } = require('../download-model-app.js');

const inventory = (over = {}) => ({
  forms: [{ id: 'f1', name: 'Project', entity: 'contoso_project' }, { id: 'f2', name: 'Baseline', entity: 'contoso_projectbaseline' }],
  views: [{ id: 'v1', name: 'Active Projects', entity: 'contoso_project' }],
  charts: [{ id: 'c1', name: 'By Status', entity: 'contoso_project' }],
  businessRules: [],
  globalChoices: [],
  roleRestrictedForms: [],
  ...over,
});

test('notRoundTrippedSummary counts every omitted class and groups by table', () => {
  const s = notRoundTrippedSummary(inventory());
  assert.strictEqual(s.total, 4);
  assert.deepStrictEqual(s.classes.map((c) => [c.kind, c.count]), [['forms', 2], ['views', 1], ['charts', 1]]);
  // Sorted by table so two runs against the same app produce the same report.
  assert.deepStrictEqual(s.entities.map((e) => e.entity), ['contoso_project', 'contoso_projectbaseline']);
  assert.deepStrictEqual(s.entities[0], { entity: 'contoso_project', forms: ['Project'], views: ['Active Projects'], charts: ['By Status'], commands: [], businessRules: [] });
});

test('notRoundTrippedSummary returns null when there is nothing to report', () => {
  // A note that fires when there is nothing to say is a note nobody reads. An app with no forms,
  // views or charts is unusual but legal (a pages-only app).
  assert.strictEqual(notRoundTrippedSummary({ forms: [], views: [], charts: [] }), null);
  assert.strictEqual(notRoundTrippedSummary({}), null);
  assert.strictEqual(notRoundTrippedSummary(null), null);
});

test('notRoundTrippedSummary omits a class that has no rows rather than reporting a zero', () => {
  const s = notRoundTrippedSummary(inventory({ charts: [], views: [] }));
  assert.deepStrictEqual(s.classes.map((c) => c.kind), ['forms']);
  assert.strictEqual(s.total, 2);
});

test('notRoundTrippedSummary skips nameless rows instead of printing blanks', () => {
  // A row with no `name` came back from a partial read; naming it "" in the report would be noise
  // that reads like a real artifact called nothing.
  const s = notRoundTrippedSummary(inventory({ forms: [{ id: 'f1', entity: 'contoso_project' }, { id: 'f2', name: 'Real', entity: 'contoso_project' }] }));
  assert.deepStrictEqual(s.entities.find((e) => e.entity === 'contoso_project').forms, ['Real']);
});

test('notRoundTrippedSummary buckets a row with no table under "unknown" rather than dropping it', () => {
  const s = notRoundTrippedSummary({ forms: [{ id: 'f1', name: 'Orphan' }] });
  assert.deepStrictEqual(s.entities, [{ entity: 'unknown', forms: ['Orphan'], views: [], charts: [], commands: [], businessRules: [] }]);
});

// --- the classes actually reported ---------------------------------------------------------------
// `hydrateSpec` reconstructs neither BUSINESS RULES nor GLOBAL CHOICES, and both are inventoried, so
// both belong in a report whose whole purpose is naming what did not round-trip. Leaving them out
// made the report quietly incomplete about a real cross-environment loss.

test('a business rule is reported, grouped by its table like any other artifact', () => {
  const s = notRoundTrippedSummary(inventory({ businessRules: [{ id: 'br1', name: 'Require close reason', entity: 'contoso_project' }] }));
  assert.ok(s.classes.some((c) => c.kind === 'businessRules' && c.count === 1), JSON.stringify(s.classes));
  assert.deepStrictEqual(s.entities.find((e) => e.entity === 'contoso_project').businessRules, ['Require close reason']);
  assert.match(notRoundTrippedWarning(s), /businessRules: Require close reason/);
});

test('a global choice is reported WITHOUT a table, because it does not belong to one', () => {
  // Filing an org-wide option set under a table would assert a relationship Dataverse does not have.
  const s = notRoundTrippedSummary(inventory({ globalChoices: [{ id: 'gc1', name: 'contoso_status' }] }));
  assert.ok(s.classes.some((c) => c.kind === 'globalChoices' && c.count === 1));
  assert.deepStrictEqual(s.orgScoped, [{ kind: 'globalChoices', label: 'global choice', names: ['contoso_status'] }]);
  assert.ok(!s.entities.some((e) => e.entity === 'unknown'), 'it must not be bucketed under a fake table');
  assert.match(notRoundTrippedWarning(s), /\(environment-wide\) globalChoices: contoso_status/);
});

test('a command-bar button is reported, grouped by its table like any other artifact, and the remedy names commands[]', () => {
  // A download does not reconstruct commands[]: a rebuild in another environment makes the app without them. They were named nowhere.
  const s = notRoundTrippedSummary(inventory({ commands: [{ id: 'a1', name: 'Escalate', entity: 'contoso_project' }, { id: 'a2', name: 'Approve', entity: 'contoso_project' }] }));
  assert.deepStrictEqual(s.classes.map((c) => [c.kind, c.count]), [['forms', 2], ['views', 1], ['charts', 1], ['commands', 2]]);
  assert.strictEqual(s.total, 6);
  assert.deepStrictEqual(s.entities.find((e) => e.entity === 'contoso_project').commands, ['Approve', 'Escalate']);
  const w = notRoundTrippedWarning(s);
  assert.match(w, /does not reconstruct forms\[\], views\[\], charts\[\], commands\[\] — 2 forms, 1 view, 1 chart, 2 commands on 2 table\(s\)/);
  assert.match(w, /contoso_project — forms: Project; views: Active Projects; charts: By Status; commands: Approve, Escalate/);
  assert.match(w, /re-declare the ones you need in forms\[\], views\[\], charts\[\], commands\[\]/);
});

// --- the wording, which is the whole point of the fix -------------------------------------------

test('the warning distinguishes "absent from the spec" from "deleted from the app"', () => {
  // THE correction this fix makes. The reporter concluded the download had LOST the artifacts. It
  // had not — they are on the deployed app and in `descriptionInventory` — so a message that said
  // "dropped" would trade one wrong belief for another. Both halves must be stated.
  const w = notRoundTrippedWarning(notRoundTrippedSummary(inventory()));
  assert.match(w, /NOT lost/);
  assert.match(w, /descriptionInventory/, 'must point at where they ARE recorded');
  assert.match(w, /THIS environment leaves them untouched/, 'must say a same-environment rebuild is safe');
  assert.match(w, /DIFFERENT environment will NOT recreate them/, 'must say where the loss is real');
});

test('the warning names the counts, the tables and the artifacts', () => {
  const w = notRoundTrippedWarning(notRoundTrippedSummary(inventory()));
  assert.match(w, /2 forms, 1 view, 1 chart/, 'counts must be singularised correctly');
  assert.match(w, /on 2 table\(s\)/);
  assert.match(w, /contoso_project — forms: Project; views: Active Projects; charts: By Status/);
  assert.match(w, /contoso_projectbaseline — forms: Baseline/);
});

test('the warning says what to DO about it', () => {
  // A report with no remedy just relocates the problem.
  const w = notRoundTrippedWarning(notRoundTrippedSummary(inventory()));
  assert.match(w, /re-declare the ones you need in forms\[\], views\[\], charts\[\]/);
  assert.match(w, /solution export/);
});

test('the class list in the wording FOLLOWS the content — it is not a fixed sentence', () => {
  // It used to read "forms[], views[] or charts[]" no matter what was reported, so a download with
  // only forms told the operator views and charts were missing too, and adding business rules to the
  // report left the sentence naming the wrong classes. The remedy line has to name the same set.
  const onlyForms = notRoundTrippedWarning(notRoundTrippedSummary(inventory({ views: [], charts: [] })));
  assert.match(onlyForms, /does not reconstruct forms\[\] —/);
  assert.doesNotMatch(onlyForms, /views\[\]/, 'must not claim views were omitted when none were found');
  assert.doesNotMatch(onlyForms, /charts\[\]/);

  const withRules = notRoundTrippedWarning(notRoundTrippedSummary(inventory({ businessRules: [{ id: 'b', name: 'R', entity: 'contoso_project' }] })));
  assert.match(withRules, /does not reconstruct forms\[\], views\[\], charts\[\], businessRules\[\] —/);
  assert.match(withRules, /re-declare the ones you need in forms\[\], views\[\], charts\[\], businessRules\[\]/);
});

test('notRoundTrippedWarning is empty for an empty summary, so nothing is printed', () => {
  assert.strictEqual(notRoundTrippedWarning(null), '');
});

test("the note's promise is TRUE: a downloaded spec plans no form/view/chart mutation", () => {
  // The note tells an operator "Rebuilding into THIS environment leaves them untouched." That is a
  // promise about the BUILD, made by the DOWNLOAD, so nothing else would catch it going stale — and
  // a wrong promise here is worse than the silence it replaced, because the operator would act on it.
  //
  // Two mechanisms could break it and both are checked: the forms phase prunes fields for a form
  // whose spec declares an EXPLICIT layout (unreachable with `forms: []`), and the views phase
  // enriches a table's stock Active/Inactive views (skipped because download flags every recovered
  // table `existing: true`).
  const { planFor, enrichesDefaultViews } = require('../lib/sdk-build.js');
  const downloaded = {
    solution: { uniqueName: 's', publisherPrefix: 'p' },
    app: { name: 'A' },
    entities: [{ schemaName: 'contoso_order', existing: true, displayName: 'Order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    views: [], charts: [], forms: [], commands: [], dashboards: [], pages: [], webResources: [],
    appShell: { areas: [] },
  };
  assert.strictEqual(enrichesDefaultViews(downloaded, downloaded.entities[0]), false,
    'download flags recovered tables existing:true precisely so the stock views are left alone');
  const labels = planFor(downloaded, {}).map((p) => p.label);
  const risky = labels.filter((l) => /\b(form|view|chart)\b|delete|prune|deactivate|enrich/i.test(l));
  assert.deepStrictEqual(risky, [], `a downloaded spec planned work against a deployed artifact: ${risky.join(' | ')}`);
});

// --- determinism -----------------------------------------------------------------------------------

test('the report is stable whatever order Dataverse returns rows in', () => {
  // The rows come from `queryRecords`, which carries no ordering guarantee. This block is written
  // into the operator's output and compared BETWEEN runs, so an unstable order reads as a change
  // that did not happen -- the opposite of the point, which is to make a real difference visible.
  // Tables were already sorted; the per-table artifact NAME lists were not, so it was half stable.
  const build = (formNames, incompleteOrder) => notRoundTrippedSummary({
    forms: formNames.map((n) => ({ entity: 'b_table', name: n })).concat([
      { entity: 'a_table', name: 'Zulu' }, { entity: 'a_table', name: 'Alpha' },
    ]),
    views: [], charts: [],
    incomplete: incompleteOrder.map((k) => ({ kind: k, reason: 'HTTP 403' })),
  });

  const one = build(['Zeta', 'Alpha', 'Mid'], ['views', 'charts']);
  const two = build(['Mid', 'Zeta', 'Alpha'], ['charts', 'views']);
  assert.deepStrictEqual(one, two, 'two orderings of the same data must produce an identical report');

  // Assert the ordering itself, not just that the two agree -- both could be equally wrong.
  assert.deepStrictEqual(one.entities.map((e) => e.entity), ['a_table', 'b_table']);
  assert.deepStrictEqual(one.entities[0].forms, ['Alpha', 'Zulu']);
  assert.deepStrictEqual(one.entities[1].forms, ['Alpha', 'Mid', 'Zeta']);
  assert.deepStrictEqual(one.incomplete.map((i) => i.kind), ['charts', 'views']);
});


// --- AB#6686428: a failed LABEL read must not degrade silently -----------------------------------
// The table-label read is the ONLY source of multi-language labels. When it fails the table is still
// recovered, so the download SUCCEEDS and the spec looks complete while carrying the SDK's flattened
// single-language `displayName` — every other language gone. That is the same silent-loss shape the
// localized-label feature exists to end, so the failure is recorded and reported.
const { readEntityWithDescriptions, entityFromMetadata } = require('../download-model-app.js');

const labelSdk = (get) => ({
  fetchEntityMetadata: async (l) => ({ logicalName: l, displayName: 'Ticket', primaryNameAttribute: 'new_name', attributes: [] }),
  // `readEntityWithDescriptions` makes TWO metadata reads — the table labels and the column labels —
  // and BOTH now record a failure. A stub that answers one response for both made the
  // success case fail on the Attributes read, so route by URL and keep the column read healthy;
  // the column read has its own tests below.
  dataverse: { get: async (url) => (/\/Attributes\?/.test(url) ? { status: 200, headers: {}, body: { value: [] } } : get(url)) },
});

test('a non-2xx label read is RECORDED, not read as "this table has no other languages"', async () => {
  const meta = await readEntityWithDescriptions(labelSdk(async () => ({ status: 403, body: {} })), 'new_t');
  assert.strictEqual(meta.labelReadFailed, 'HTTP 403');
});

test('a THROWN label read is recorded with its reason', async () => {
  const meta = await readEntityWithDescriptions(labelSdk(async () => { throw new Error('socket hang up'); }), 'new_t');
  assert.match(meta.labelReadFailed, /socket hang up/);
});

test('a SUCCESSFUL label read records no failure', async () => {
  const meta = await readEntityWithDescriptions(labelSdk(async () => ({ status: 200, body: { DisplayName: { LocalizedLabels: [{ Label: 'T', LanguageCode: 1033 }] } } })), 'new_t');
  assert.strictEqual(meta.labelReadFailed, undefined);
});

test('the failure marker never reaches the emitted spec', async () => {
  // `entityFromMetadata` builds an explicit literal, so the marker is dropped — asserted rather than
  // assumed, because a stray key here would be written into app-spec.json and fail its validation
  // (the same class as the raw Dataverse Label object that used to leak through as a column name).
  const meta = await readEntityWithDescriptions(labelSdk(async () => ({ status: 500, body: {} })), 'new_t');
  assert.ok(meta.labelReadFailed, 'precondition: the marker is set');
  assert.ok(!Object.keys(entityFromMetadata(meta, 'new_t')).includes('labelReadFailed'));
});
// The COLUMN-label read is a second source of the same loss, and was fixed one commit later than the
// table one — it is the only source of multi-language labels for every non-primary column and for the
// primary attribute, and it was still coercing a non-2xx to null and swallowing a throw.
const twoReadSdk = (tableGet, attrGet) => ({
  fetchEntityMetadata: async (l) => ({ logicalName: l, displayName: 'Ticket', primaryNameAttribute: 'new_name', attributes: [{ logicalName: 'new_name' }] }),
  dataverse: { get: async (url) => (/\/Attributes\?/.test(url) ? attrGet(url) : tableGet(url)) },
});
const OK_TABLE = async () => ({ status: 200, headers: {}, body: { DisplayName: { LocalizedLabels: [{ Label: 'T', LanguageCode: 1033 }] } } });
const OK_ATTRS = async () => ({ status: 200, headers: {}, body: { value: [{ LogicalName: 'new_name', DisplayName: { LocalizedLabels: [{ Label: 'N', LanguageCode: 1033 }] } }] } });

test('a non-2xx COLUMN-label read is recorded, not silently coerced to "no columns"', async () => {
  const meta = await readEntityWithDescriptions(twoReadSdk(OK_TABLE, async () => ({ status: 403, headers: {}, body: {} })), 'new_t');
  assert.strictEqual(meta.labelReadFailed, 'HTTP 403');
});

test('a THROWN column-label read is recorded', async () => {
  const meta = await readEntityWithDescriptions(twoReadSdk(OK_TABLE, async () => { throw new Error('socket hang up'); }), 'new_t');
  assert.match(meta.labelReadFailed, /socket hang up/);
});

test('a malformed column-label body is recorded rather than merged as nothing', async () => {
  const meta = await readEntityWithDescriptions(twoReadSdk(OK_TABLE, async () => ({ status: 200, headers: {}, body: { notValue: 1 } })), 'new_t');
  assert.match(meta.labelReadFailed, /value\[\] array/);
});

test('both reads succeeding records no failure, and the column labels are merged', async () => {
  const meta = await readEntityWithDescriptions(twoReadSdk(OK_TABLE, OK_ATTRS), 'new_t');
  assert.strictEqual(meta.labelReadFailed, undefined);
  assert.ok(meta.attributes[0].DisplayName, 'the column label must actually be merged onto the attribute');
});

test('a TABLE-level failure is not overwritten by a later column failure', async () => {
  // The first reason is the more useful one to show, and both describe the same outcome.
  const meta = await readEntityWithDescriptions(twoReadSdk(async () => ({ status: 401, headers: {}, body: {} }), async () => { throw new Error('later'); }), 'new_t');
  assert.strictEqual(meta.labelReadFailed, 'HTTP 401');
});

// --- the command-bar customisations of the app's tables -------------------------------------------------------------------------
// readDescriptionInventory reads them (readCommandInventory) when it is given the app's tables: the unmanaged `appaction` rows bound to
// those tables, 20 tables to a request, kept when table-scoped or scoped to this app, and not a Group container or an inactive row.
const { readDescriptionInventory } = require('../download-model-app.js');
const APP = '11111111-0000-4000-8000-000000000001';
const OTHER_APP = '11111111-0000-4000-8000-0000000000ff';
// No app layer to read: the forms, views and charts are reported as unknown, which these tests do not look at.
const NO_LAYER = { layer: { ok: false }, components: new Map(), componentProblems: new Map(), notes: [] };
function commandSdk(rows, { fail } = {}) {
  const queries = [];
  return {
    queries,
    queryRecords: async (set, opts) => {
      queries.push({ set, ...opts });
      if (set !== 'appaction') return [];
      if (fail) throw new Error(fail);
      // `contextvalue eq '<table>'` terms of the filter: the tables this request asks about.
      const asked = [...String(opts.filter).matchAll(/contextvalue eq '([^']+)'/g)].map((m) => m[1]);
      return rows.filter((r) => asked.includes(r.contextvalue));
    },
  };
}
const command = (over) => ({ appactionid: `a-${over.name}`, type: 0, statecode: 0, _appmoduleid_value: null, buttonlabeltext: null, ...over });

test('the command inventory keeps the app\u2019s own commands of its tables — table-scoped or this app\u2019s — and leaves every other row out', async () => {
  const sdk = commandSdk([
    command({ name: 'escalate', buttonlabeltext: 'Escalate', contextvalue: 'contoso_ticket' }),
    command({ name: 'approve', buttonlabeltext: 'Approve', contextvalue: 'contoso_ticket', _appmoduleid_value: `{${APP.toUpperCase()}}` }),
    command({ name: 'contoso_unlabelled!1a2b', contextvalue: 'contoso_ticket' }),
    command({ name: 'other', buttonlabeltext: 'Other app only', contextvalue: 'contoso_ticket', _appmoduleid_value: OTHER_APP }),
    command({ name: 'group', type: 3, contextvalue: 'contoso_ticket' }),
    command({ name: 'retired', buttonlabeltext: 'Retired', statecode: 1, contextvalue: 'contoso_ticket' }),
    command({ name: 'close', buttonlabeltext: 'Close', contextvalue: 'account' }),
  ]);
  const inv = await readDescriptionInventory(sdk, APP, null, new Set(), NO_LAYER, { tables: ['contoso_ticket', 'account', 'contoso_ticket'] });
  assert.deepStrictEqual(inv.commands.map((c) => `${c.entity}: ${c.name}`), ['account: Close', 'contoso_ticket: Approve', 'contoso_ticket: contoso_unlabelled!1a2b', 'contoso_ticket: Escalate']);
  assert.ok(!(inv.incomplete || []).some((i) => i.kind === 'commands'));
  const reads = sdk.queries.filter((q) => q.set === 'appaction');
  assert.strictEqual(reads.length, 1, 'one request for the tables, each named once');
  assert.strictEqual(reads[0].filter, "ismanaged eq false and (contextvalue eq 'account' or contextvalue eq 'contoso_ticket')");
  assert.deepStrictEqual(reads[0].select, ['appactionid', 'name', 'buttonlabeltext', 'contextvalue', 'type', 'statecode', '_appmoduleid_value']);
  assert.strictEqual(reads[0].paginate, true);
});

test('the command inventory asks about 20 tables to a request, and a name with a quote is escaped', async () => {
  const tables = Array.from({ length: 25 }, (_, i) => `contoso_t${String(i).padStart(2, '0')}`);
  const sdk = commandSdk([]);
  await readDescriptionInventory(sdk, APP, null, new Set(), NO_LAYER, { tables: [...tables, "contoso_o'neil"] });
  const asked = sdk.queries.filter((q) => q.set === 'appaction').map((q) => [...q.filter.matchAll(/contextvalue eq '((?:[^']|'')+)'/g)].length);
  assert.deepStrictEqual(asked, [20, 6]);
  assert.ok(sdk.queries.some((q) => q.set === 'appaction' && q.filter.includes("contextvalue eq 'contoso_o''neil'")));
});

test('a failed command read is reported as UNKNOWN, not as an app with no commands; no tables, or none named, read nothing', async () => {
  const failed = await readDescriptionInventory(commandSdk([], { fail: 'HTTP 403' }), APP, null, new Set(), NO_LAYER, { tables: ['contoso_ticket'] });
  assert.strictEqual(failed.commands, undefined);
  assert.deepStrictEqual(failed.incomplete.filter((i) => i.kind === 'commands'), [{ kind: 'commands', reason: 'HTTP 403' }]);
  const summary = notRoundTrippedSummary(failed);
  assert.ok(summary.incomplete.some((i) => i.kind === 'commands'));
  assert.match(notRoundTrippedWarning(summary), /commands — HTTP 403/);
  for (const opts of [{ tables: [] }, {}, undefined]) {
    const sdk = commandSdk([command({ name: 'x', buttonlabeltext: 'X', contextvalue: 'contoso_ticket' })]);
    await readDescriptionInventory(sdk, APP, null, new Set(), NO_LAYER, opts);
    assert.deepStrictEqual(sdk.queries.filter((q) => q.set === 'appaction'), [], JSON.stringify(opts));
  }
});
// --- the managed download's report seam (lib/managed-restore-report.js) ---------------------------------------------------------
const { subtractRestored, omission, REASONS } = require('../lib/managed-restore-report.js');

test('subtractRestored drops the restored rows by normalized id only, drops a class it empties, and leaves everything else as it was', () => {
  const V1 = '0a0a0a0a-0000-4000-8000-000000000001';
  const V2 = '0a0a0a0a-0000-4000-8000-000000000002';
  const C1 = '0c0c0c0c-0000-4000-8000-000000000001';
  // Two views share a name; only the id restored goes.
  const inv = inventory({ views: [{ id: V1, name: 'Active', entity: 'contoso_project' }, { id: V2, name: 'Active', entity: 'contoso_project' }], charts: [{ id: C1, name: 'By Status', entity: 'contoso_project' }] });
  const frozen = JSON.stringify(inv);
  const out = subtractRestored(inv, { views: [`{${V2.toUpperCase()}}`], charts: [C1] });
  assert.deepStrictEqual(out.views, [{ id: V1, name: 'Active', entity: 'contoso_project' }]);
  assert.strictEqual('charts' in out, false, 'an emptied class loses its key, as "the read found none" would otherwise read');
  assert.deepStrictEqual(out.forms, inv.forms);
  assert.strictEqual(JSON.stringify(inv), frozen, 'the inventory handed in is not changed');
  assert.strictEqual(notRoundTrippedSummary(out).total, 3);
  // Nothing restored, or a name instead of an id: the very same inventory.
  for (const restored of [{}, { views: [] }, { views: ['Active'] }, undefined]) assert.strictEqual(subtractRestored(inv, restored), inv, JSON.stringify(restored));
});

test('omission carries safe identity and the fixed reason of its code, never text a service gave', () => {
  const o = omission({ kind: 'view', id: '{0A0A0A0A-0000-4000-8000-000000000001}', key: 'contoso_item/Active', name: 'Active', code: 'changed', fields: ['layout', 'x\u0000y'] });
  assert.deepStrictEqual(o, { kind: 'view', id: '0a0a0a0a-0000-4000-8000-000000000001', key: 'contoso_item/Active', name: 'Active', fields: ['layout'], code: 'changed', reason: REASONS.changed });
  assert.deepStrictEqual(omission({ kind: 'chart', id: 'not a guid', name: 'a\nb', code: 'unread' }), { kind: 'chart', code: 'unread', reason: REASONS.unread }, 'an id that is not a GUID and a name with a line break are left out');
  assert.throws(() => omission({ kind: 'view', code: 'HTTP 500: <fetch>secret</fetch>' }), /unknown omission code/);
});

// --- field security profiles: reported, never declared -------------------------------------------------------------------------
// A profile is shared security policy and no binding store family proves one is this app's, so the download names the custom profiles
// it finds (in the app's solution, or holding a permission on a column the download secures) and declares none of them.
const { fieldSecurityProfileOmissions, fieldSecurityProfilesNote } = require('../download-model-app.js');
const SOL_ID = '50505050-0000-4000-8000-000000000001';
const ADMIN = '572329c1-a042-4e22-be47-367c6374ea45';
const P_HR = '70707070-0000-4000-8000-000000000001';
const P_PAY = '70707070-0000-4000-8000-000000000002';
const P_FAKE_ADMIN = '70707070-0000-4000-8000-000000000003';
const P_OTHER = '70707070-0000-4000-8000-000000000004';
function profileSdk({ components = [], permissions = [], profiles = [], fail = {} } = {}) {
  const queries = [];
  return {
    queries,
    dataverse: { get: async () => { throw new Error('no metadata read is expected'); } },
    queryRecords: async (set, opts) => {
      queries.push({ set, ...opts });
      if (fail[set]) throw new Error(fail[set]);
      if (set === 'solution') return [{ solutionid: SOL_ID }];
      if (set === 'solutioncomponent') return /componenttype eq 70\b/.test(opts.filter) ? components.map((id) => ({ objectid: id })) : [];
      if (set === 'fieldpermission') {
        // `entityname eq '<table>' and (attributelogicalname eq '<column>' or …)`
        const table = (/entityname eq '([^']+)'/.exec(opts.filter) || [])[1];
        const columns = [...String(opts.filter).matchAll(/attributelogicalname eq '([^']+)'/g)].map((m) => m[1]);
        return permissions.filter((p) => p.table === table && columns.includes(p.column)).map((p) => ({ fieldpermissionid: `fp-${p.profile}-${p.column}`, _fieldsecurityprofileid_value: p.profile }));
      }
      if (set === 'fieldsecurityprofile') {
        const ids = [...String(opts.filter).matchAll(/fieldsecurityprofileid eq ([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
        return profiles.filter((p) => ids.includes(p.fieldsecurityprofileid));
      }
      return [];
    },
  };
}
const SECURED = [{ table: 'contoso_staff', column: 'contoso_salary' }, { table: 'contoso_staff', column: 'contoso_bonus' }];
const PROFILES = [
  { fieldsecurityprofileid: ADMIN, name: 'System Administrator' },
  { fieldsecurityprofileid: P_HR, name: 'HR' },
  { fieldsecurityprofileid: P_PAY, name: 'Payroll' },
  { fieldsecurityprofileid: P_FAKE_ADMIN, name: 'System Administrator' },
  { fieldsecurityprofileid: P_OTHER, name: 'Elsewhere' },
];

test('the download names the custom field security profiles it finds by the app\u2019s solution or its secured columns, once each, and never System Administrator', async () => {
  const sdk = profileSdk({
    components: [P_HR],
    permissions: [
      { table: 'contoso_staff', column: 'contoso_salary', profile: ADMIN },
      { table: 'contoso_staff', column: 'contoso_salary', profile: P_HR },
      { table: 'contoso_staff', column: 'contoso_bonus', profile: P_PAY },
      { table: 'contoso_staff', column: 'contoso_bonus', profile: P_FAKE_ADMIN },
      { table: 'contoso_staff', column: 'contoso_notes', profile: P_OTHER },
    ],
    profiles: PROFILES,
  });
  const inv = await readDescriptionInventory(sdk, APP, 'ContosoStaff', new Set(), NO_LAYER, { securedColumns: SECURED });
  assert.deepStrictEqual(inv.fieldSecurityProfiles, [{ id: P_HR, name: 'HR' }, { id: P_PAY, name: 'Payroll' }]);
  assert.ok(!(inv.incomplete || []).some((i) => i.kind === 'fieldSecurityProfiles'));
  // Read: the profile ids a permission names and each profile's id and name. Never a permission's bits, nor who a profile is given to.
  const perms = sdk.queries.filter((q) => q.set === 'fieldpermission');
  assert.strictEqual(perms.length, 1, 'one request for the table');
  assert.deepStrictEqual(perms[0].select, ['_fieldsecurityprofileid_value']);
  assert.strictEqual(perms[0].filter, "entityname eq 'contoso_staff' and (attributelogicalname eq 'contoso_bonus' or attributelogicalname eq 'contoso_salary')");
  assert.strictEqual(perms[0].paginate, true);
  const names = sdk.queries.filter((q) => q.set === 'fieldsecurityprofile');
  assert.deepStrictEqual(names.map((q) => q.select), [['fieldsecurityprofileid', 'name']]);
  assert.doesNotMatch(names[0].filter, new RegExp(ADMIN), 'System Administrator is dropped by its id before any read');
  assert.ok(sdk.queries.every((q) => !/systemuser|team|canread|cancreate|canupdate/i.test(`${q.set} ${q.select} ${q.filter}`)));

  // Reported as omissions with the fixed reason: id and name only.
  const omitted = fieldSecurityProfileOmissions(inv);
  assert.deepStrictEqual(omitted, [
    { kind: 'fieldSecurityProfile', id: P_HR, name: 'HR', code: 'ownership-unproven', reason: REASONS['ownership-unproven'] },
    { kind: 'fieldSecurityProfile', id: P_PAY, name: 'Payroll', code: 'ownership-unproven', reason: REASONS['ownership-unproven'] },
  ]);
  const note = fieldSecurityProfilesNote(omitted);
  assert.match(note, /^NOTE: 2 field security profiles \(HR, Payroll\) are not declared in fieldSecurityProfiles\[\]/);
  assert.ok(note.endsWith('\n') && !note.includes('System Administrator'));
  assert.strictEqual(fieldSecurityProfilesNote([]), '');
  assert.deepStrictEqual(fieldSecurityProfileOmissions({}), []);
  // The class is not a not-round-tripped artifact class (it is not in descriptionInventory), so the report is unchanged by it.
  assert.deepStrictEqual(notRoundTrippedSummary({ fieldSecurityProfiles: inv.fieldSecurityProfiles }), null);
});

test('a field security profile read that fails is reported as UNKNOWN, keeping what was found; with nothing to look in, nothing is read', async () => {
  const unknown = (inv) => (inv.incomplete || []).filter((i) => i.kind === 'fieldSecurityProfiles');
  const permsFail = await readDescriptionInventory(profileSdk({ components: [P_HR], profiles: PROFILES, fail: { fieldpermission: 'HTTP 403 secret detail' } }), APP, 'ContosoStaff', new Set(), NO_LAYER, { securedColumns: SECURED });
  assert.deepStrictEqual(permsFail.fieldSecurityProfiles, [{ id: P_HR, name: 'HR' }]);
  assert.strictEqual(unknown(permsFail).length, 1);
  assert.doesNotMatch(unknown(permsFail)[0].reason, /secret detail/, 'a fixed reason, not the service\u2019s words');
  assert.match(notRoundTrippedWarning(notRoundTrippedSummary(permsFail)), /fieldSecurityProfiles — /);

  const namesFail = await readDescriptionInventory(profileSdk({ components: [P_HR], fail: { fieldsecurityprofile: 'HTTP 500' } }), APP, 'ContosoStaff', new Set(), NO_LAYER, { securedColumns: SECURED });
  assert.strictEqual(namesFail.fieldSecurityProfiles, undefined);
  assert.strictEqual(unknown(namesFail).length, 1);

  const solutionUnread = await readDescriptionInventory(profileSdk({ profiles: PROFILES }), APP, new Error('the solutions could not be read'), new Set(), NO_LAYER, { securedColumns: [] });
  assert.strictEqual(unknown(solutionUnread).length, 1, 'the solution\u2019s profiles are unknown, not none');

  const nothing = profileSdk({ components: [P_HR], profiles: PROFILES });
  const none = await readDescriptionInventory(nothing, APP, null, new Set(), NO_LAYER, {});
  assert.strictEqual(none.fieldSecurityProfiles, undefined);
  assert.deepStrictEqual(unknown(none), []);
  assert.deepStrictEqual(nothing.queries.filter((q) => /^field/.test(q.set)), [], 'no solution and no secured column: no profile read');
});