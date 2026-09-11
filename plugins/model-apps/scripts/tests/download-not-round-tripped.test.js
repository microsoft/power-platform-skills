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
  assert.deepStrictEqual(s.entities[0], { entity: 'contoso_project', forms: ['Project'], views: ['Active Projects'], charts: ['By Status'], businessRules: [] });
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
  assert.deepStrictEqual(s.entities, [{ entity: 'unknown', forms: ['Orphan'], views: [], charts: [], businessRules: [] }]);
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
