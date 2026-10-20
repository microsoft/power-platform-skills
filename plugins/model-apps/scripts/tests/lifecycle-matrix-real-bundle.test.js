'use strict';
// The CROSS-FEATURE REGRESSION MATRIX: one kitchen-sink App Spec — every feature the fake environment can model faithfully — driven
// through the whole lifecycle a maker runs, over the REAL vendored SDK, the plugin's own az-token HTTP client and a stateful fake
// Dataverse (helpers/fake-lifecycle-org.js):
//
//   build          buildModelApp, as the CLI wires it (--apply --publish --sample-data --verify)
//   NOOP rebuild   the same spec again, unchanged: what it still writes and publishes is pinned, request by request
//   download       download-model-app.js main(), as the CLI runs it: the spec it writes must equal the authored one, except for the
//                  differences the round trip is documented to have (the difference table at THE ROUND TRIP, below)
//   verify         verifySpec over the CLI's reader, in a throwaway workspace: every check passes, and the checks it makes are pinned
//   teardown       teardownModelApp --apply --allow-destructive: the environment ends exactly as it started, but for what teardown is
//                  documented to keep
//
// Another maker's work is in the environment from the start, and every stage is held to leaving it — and every row and definition the
// environment had — as it found it, compared by CONTENT (saved and published layers, whole definitions, page files: org.contents),
// not only by identity; the two read-only stages (download, verify) to changing nothing at all.
//
// Each phase also has a REQUEST BUDGET: its writes are pinned exactly (`METHOD resource` -> count) and its reads are held under a
// ceiling, so a regression that adds a write — or turns one read into one per row — fails here even when every artifact still ends up
// right. Every pinned number lives in ONE table per phase below; when a change moves one on purpose, update that line and say why in
// the commit. The tables say which behaviour each entry depends on, so a reader can tell an intended change from a regression.
//
// What the fake models, and what it does NOT (those features are left out of this spec on purpose — an assertion about them here would
// be an assertion about the fake, not about the plugin):
//   - business rules: the bound member the SDK writes them through is a preview most environments do not expose, and its success path
//     is not modelled. The fake answers as an environment without it (404), which the build turns into a skip and a warning — pinned
//     by business-rules tests, not here.
//   - business process flows: activating one makes the platform create the flow's backing table, whose shape is not modelled.
//   - AI features: admin-gated settings and row summaries whose platform behaviour is not modelled.
//   - localized labels in a second language, connector/Custom API page bindings, and pages whose source holds navigation tokens.
// Everything else the App Spec offers is in the spec: new tables with every column type, a Customer column, a global choice, status
// reasons, an alternate key, 1:N, self-referencing 1:N and N:N relationships, views (sorted, filtered, my-records), a chart, Main /
// Quick Create / Quick View forms with a sub-grid, a quick view, form events and security roles, a dashboard of chart, list and iframe
// tiles, web resources (script and table icon), commands (a button and a flyout), a generative page, navigation with table, dashboard,
// URL and page entries, app settings (new look, header refresh), app.tables membership, sample data with a parent and a status reason,
// a persona with its role, and a grant on an existing role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, deployedFeatures, publishesOf, diffContents, appUniqueName, PAGE_SOURCE } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// ------------------------------------------------------------------------------------------------------------------------------------
// The lifecycle, run ONCE for the file (every test below reads its stage of it), in the order a maker runs it. A stage that throws is
// recorded, and every later stage still runs against what is there, so one regression fails its own test and not the whole matrix.
let lifecycleP;
const lifecycle = () => lifecycleP || (lifecycleP = runLifecycle());

async function runLifecycle() {
  const spec = kitchenSinkSpec();
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, makeTempDir('lifecycle-matrix-'));
  // Another maker's work is there first: everything the lifecycle does must leave it as it was.
  await seedForeignWork(org);
  // What it holds then, by identity (inventory) and by content (contents, after every stage too): the proofs that a stage made and
  // deleted only its own, and left everything else — another maker's work, the system's rows and definitions — exactly as it was.
  const out = { spec, org, seed: org.inventory(), seedContents: org.contents(), contents: {}, stages: {}, timings: {} };
  const stage = async (name, fn) => {
    out.stages[name] = await harness.measure(fn);
    out.timings[name] = out.stages[name].ms;
    out.contents[name] = org.contents();
  };
  await stage('build', () => harness.build(spec));
  out.afterBuild = org.inventory();
  // The one row a teardown leaves behind on purpose: the publisher the build made for the prefix (see the teardown test).
  out.builtPublisher = out.afterBuild.rows.publishers.filter((p) => !out.seed.rows.publishers.includes(p));
  out.built = deployedFeatures(org);
  // The ids the round trip writes back, read from what the environment holds once the app is built (teardown removes them).
  const one = (set, predicate) => { const rows = org.find(set, predicate); return rows.length === 1 ? rows[0] : null; };
  out.ids = {
    dashboard: (one('systemforms', (f) => f.type === 0 && f.name === 'Kitchen Overview') || {}).formid,
    openProjects: (one('savedqueries', (v) => v.returnedtypecode === 'contoso_project' && v.name === 'Open Projects') || {}).savedqueryid,
    chart: (one('savedqueryvisualizations', (c) => c.name === 'Projects by Priority') || {}).savedqueryvisualizationid,
    page: ([...org.pageServer.state.projects.values()].find((p) => p.name === 'Kitchen Page') || {}).id,
  };
  await stage('rebuild', () => harness.build(spec));
  out.afterRebuild = org.inventory();
  await stage('download', () => harness.download(appUniqueName(spec), path.join(harness.appDir, '..', 'download')));
  await stage('verify', () => harness.verify(spec));
  await stage('teardown', () => harness.teardown(spec));
  out.afterTeardown = org.inventory();
  return out;
}


// A stage that threw fails its own test with the cause.
function stageOf(run, name) {
  const s = run.stages[name];
  assert.ok(s, `the ${name} stage ran`);
  if (s.error) throw s.error;
  assert.deepEqual(s.unexpected, [], `every request the ${name} stage sent is one the fake models`);
  return s;
}

// ====================================================================================================================================
// THE PINNED NUMBERS — one table per phase. Writes are counted per operation (a `$batch` change set counts each request it carries),
// named `METHOD resource` with keys and query left out. A table entry that moves on purpose is a one-line change here.

// The first build. Each entry is a write the build makes for the spec above; the comment names the step that makes it.
const BUILD_WRITES = {
  'POST publishers': 1, // solution: the publisher for the prefix, which no environment has yet
  'POST solutions': 1, // solution: ContosoKitchen
  'POST GlobalOptionSetDefinitions': 1, // data model: the global choice
  'POST EntityDefinitions': 3, // data model: each table, with its primary name column only
  'POST EntityDefinitions/Attributes': 17, // data model: the ordinary columns in one change set per table (12 + 2), and the global choice's, the File and the Image column in a request each
  'POST InsertStatusValue': 1, // data model: the status reason, at its pinned value
  'POST EntityDefinitions/Keys': 1, // data model: the alternate key
  'POST CreateCustomerRelationships': 1, // data model: the Customer column and its two relationships
  'POST RelationshipDefinitions': 3, // data model: 1:N, self 1:N and N:N
  'PUT EntityDefinitions': 2, // data model: quick create on the Quick Create form's table; web resources: the table icon
  'POST contoso_projects/Microsoft.Dynamics.CRM.CreateMultiple': 1, // sample data: the parent row first
  'POST contoso_tasks/Microsoft.Dynamics.CRM.CreateMultiple': 1, // sample data: then the child that binds it
  'POST webresourceset': 4, // the script, the table icon, the generated app icon, the page manifest
  'POST savedqueries': 3, // views
  'PATCH savedqueries': 4, // the default-view enrichment of the two tables with columns to show (Active and Inactive each)
  'POST savedqueryvisualizations': 1, // chart
  'POST systemforms': 5, // four forms and the dashboard
  'PATCH systemforms': 6, // the Project form's sub-grid, each table's Main form made the default (2), the Task form's order and its quick view, the Project form's security roles
  'POST appactions': 4, // commands: the button, the flyout, the group the adapter puts under it, and its child
  'POST appmodules': 1,
  'POST sitemaps': 1,
  'PATCH sitemaps': 1, // the pages phase writes the page's navigation entry into the sitemap once the page exists
  'POST AddAppComponents': 3, // the app's create, the app.tables member pinned after it, the sitemap finalize
  'POST appmodules/appmoduleroles_association/$ref': 2, // System Administrator (the SDK's create) and the persona's role
  'POST appsettings': 1, // the header refresh setting the SDK writes with a new app
  'PATCH appsettings': 1, // ...set to the spec's false
  'POST SaveSettingValue': 1, // the new look setting
  'POST uxagentprojects': 1, // the generative page...
  'PATCH uxagentprojects': 1,
  'POST uxagentprojectfiles': 4, // ...its four rows
  'PATCH uxagentprojectfiles/filecontent': 4, // ...and their content
  'POST agentconversationmessages': 2, // ...and the conversation the maker sees
  'POST roles': 1, // the persona's role
  'POST roles/Microsoft.Dynamics.CRM.ReplacePrivilegesRole': 1, // its privileges, converged
  'POST roles/Microsoft.Dynamics.CRM.AddPrivilegesRole': 1, // the grant on Basic User, added
  'POST AddSolutionComponent': 16, // each component the build creates or reuses that the solution does not already hold
  'POST PublishXml': 11, // see BUILD_PUBLISHES
};
// What each publish of the first build names, in order (an app or a page id is `app` / `page`, a web resource `webresource`).
const BUILD_PUBLISHES = [
  'webresource', 'webresource', // the script and the table icon, each published before anything points at it
  'contoso_project', // the table whose icon was just set
  'webresource', // the generated app icon
  'contoso_project contoso_tag contoso_task', // the tables before the app's first publish, so their saved labels go live
  'app', // the app's create
  'app', // the app again after the app.tables member is pinned
  'page', // the generative page
  'webresource', // the page manifest
  'app', // the app after the sitemap finalize put the page in its navigation
  'contoso_project contoso_task app', // the publish phase: the tables of the spec's forms, views and charts, with the app
];

// The rebuild of the UNCHANGED spec. It is not free: each line is a write the current build still sends when nothing changed, and
// what it depends on. A line that disappears is progress (lower it here); a line that appears is a regression.
const REBUILD_WRITES = {
  'POST InsertStatusValue': 1, // re-sent at its pinned value; the platform's "already exists" is the skip (entity-provision.js)
  'POST EntityDefinitions/Keys': 1, // the SDK has no key lister: re-sent, "already exists" is the skip (entity-provision.js)
  'PUT EntityDefinitions': 2, // the quick-create flag and the table icon are re-asserted on every build (entity-provision.js, sdk-build.js 3c)
  'PATCH savedqueries': 4, // the SDK's default-view enrichment saves both generated views of each table on every build (rebuild-writes-real-bundle.test.js)
  'PATCH systemforms': 3, // isdefault is set again on each table's chosen Main form (promoteDefaultForm reads nothing first), and the form's security roles are rewritten byte for byte
  'PATCH sitemaps': 1, // the sitemap of an existing app is rewritten by the pages finalize, byte for byte
  'POST AddAppComponents': 1, // ...and the push re-adds the app's components
  'POST SaveSettingValue': 1, // the new look setting is saved again
  'POST roles/Microsoft.Dynamics.CRM.ReplacePrivilegesRole': 1, // a persona role converges with replace semantics on every build
  'POST appmodules/appmoduleroles_association/$ref': 1, // re-associated; the platform refuses the duplicate and the build reads that as "already linked"
  'POST roles/Microsoft.Dynamics.CRM.AddPrivilegesRole': 1, // a role grant is additive and re-sent
  'POST PublishXml': 4, // see REBUILD_PUBLISHES
};
const REBUILD_PUBLISHES = [
  'contoso_project', // the table icon set again
  'contoso_project contoso_tag contoso_task', // the tables before the app's publish
  'app', // the app after the sitemap finalize
  'contoso_project contoso_task app', // the publish phase
];

// The teardown: every component the build made is deleted, in dependency order.
const TEARDOWN_WRITES = {
  'DELETE appmodules': 1, // the app and its sitemap, in one change set
  'DELETE sitemaps': 1,
  'DELETE uxagentprojects': 1, // the page this app's navigation proved it owns...
  'DELETE agentconversationmessages': 2, // ...and its conversation, which a project delete does not cascade
  'DELETE systemforms': 5, // the dashboard and the four forms
  'DELETE appactions': 4,
  'PATCH systemforms': 2, // the stock Main forms made the default again before the build's Main forms go
  'DELETE roles': 1, // the persona's role (the grant on Basic User is one-way: references/app-spec-schema-advanced.md)
  'DELETE savedqueryvisualizations': 1,
  'DELETE savedqueries': 3,
  'PATCH savedqueries': 4, // the enriched default views reset to lookup-free columns, so the relationships can go...
  'POST PublishXml': 1, // ...published once
  'DELETE RelationshipDefinitions': 2, // the self-referencing 1:N goes with its table
  'DELETE EntityDefinitions': 3,
  'DELETE webresourceset': 4,
  'DELETE GlobalOptionSetDefinitions': 1,
  'DELETE solutions': 1,
};

// Reads per phase: a ceiling about a tenth above what each phase reads today, so a read that starts being made once per row fails
// here. HTTP requests (reads, writes and change sets) likewise.
const BUDGET = {
  build: { reads: 335, requests: 430 }, // today 302 / 392
  rebuild: { reads: 295, requests: 320 }, // today 268 / 289
  download: { reads: 130, requests: 130 }, // today 117 / 117 (the File and the Image column's sizes are one read each, of the one table that has them)
  verify: { reads: 85, requests: 85 }, // today 74 / 74
  teardown: { reads: 95, requests: 135 }, // today 86 / 122
};

// What verify checks, by kind: a kind that stops being checked (or is checked fewer times) fails here even though verify still passes.
const VERIFY_CHECKS = {
  entity: 3, column: 18, relationship: 3,
  view: 3, 'view-columns': 3, 'view-filters': 3, 'view-sort': 1, chart: 1,
  form: 4, 'form-identities': 4, 'form-default': 2, 'form-order': 1, 'form-order-served': 1, 'form-timeline': 1,
  dashboard: 1, command: 1,
  subarea: 4, 'subarea-dashboard-launcher': 1, 'app-table-component': 4, page: 1, 'page-subarea': 1,
  role: 1, 'app-role': 1, 'role-privileges': 1, 'role-grant': 1, 'role-grant-privileges': 1,
};



// What the environment holds once the build is done — every feature of the spec, read from the environment's own state.
const BUILT = {
  tables: {
    contoso_project: {
      plural: 'Projects', icon: 'contoso_projecticon.svg', quickCreate: false,
      columns: {
        contoso_billable: 'BooleanType None Yes/No',
        contoso_budget: 'MoneyType None 0..1000000000 precision 2', // the SDK's defaults for a Money column
        contoso_bytes: 'BigIntType None',
        contoso_contract: 'FileType None 1024 KB',
        contoso_due: 'DateTimeType None DateOnly',
        contoso_email: 'StringType None Email max 200',
        contoso_headcount: 'IntegerType None None 0..500',
        contoso_labels: 'MultiSelectPicklistType None Red|Green|Blue',
        contoso_logo: 'ImageType None 10240 KB', // the SDK's default size
        contoso_name: 'StringType None max 100', // the primary name column: the length the build asks for when the spec gives none
        contoso_notes: 'MemoType None TextArea',
        contoso_parentprojectid: 'LookupType None contoso_project', // the self-referencing relationship's lookup
        contoso_priority: 'PicklistType None Low|Medium|High',
        contoso_rate: 'DecimalType None -100000000000..100000000000 precision 2',
        contoso_ref: 'StringType None max 100 P-{SEQNUM:5}',
        contoso_score: 'DoubleType None -100000000000..100000000000 precision 2',
        contoso_stage: 'PicklistType None global Planned|Active|Done',
      },
      keys: ['contoso_emailkey(contoso_email)'],
      statusReasons: ['1 Active state 0', '2 Inactive state 1', '100000000 In Review state 0'],
    },
    contoso_task: {
      plural: 'Task Items', icon: null, quickCreate: true, // the Quick Create form turns quick create on
      columns: {
        contoso_customer: 'CustomerType None account|contact',
        contoso_done: 'BooleanType None Yes/No',
        contoso_hours: 'IntegerType None None -2147483648..2147483647',
        contoso_projectid: 'LookupType None contoso_project',
        contoso_title: 'StringType None max 100',
      },
      keys: [],
      statusReasons: ['1 Active state 0', '2 Inactive state 1'],
    },
    contoso_tag: { plural: 'Tag Catalog', icon: null, quickCreate: false, columns: { contoso_label: 'StringType None max 100' }, keys: [], statusReasons: ['1 Active state 0', '2 Inactive state 1'] },
    // The N:N's intersect table, which the platform makes with the relationship.
    contoso_tag_contoso_task: { plural: 'contoso_tag_contoso_task', icon: null, quickCreate: false, intersect: true, columns: {}, keys: [], statusReasons: ['1 Active state 0', '2 Inactive state 1'] },
  },
  relationships: [
    'contoso_contoso_task_account 1:N account->contoso_task.contoso_customer',
    'contoso_contoso_task_contact 1:N contact->contoso_task.contoso_customer',
    'contoso_project_contoso_project 1:N contoso_project->contoso_project.contoso_parentprojectid',
    'contoso_project_contoso_task 1:N contoso_project->contoso_task.contoso_projectid',
    'contoso_tag_contoso_task N:N contoso_task-contoso_tag',
  ],
  optionSets: { contoso_stage: ['100000000 Planned', '100000001 Active', '100000002 Done'] },
  views: ['contoso_project: Open Projects', 'contoso_task: My Open Tasks', 'contoso_task: Open Tasks'],
  // The chart as it draws: its type, and what it counts by what (the chart's datadescription and presentationdescription).
  charts: ['contoso_project: Projects by Priority (Pie: count(contoso_projectid) by contoso_priority)'],
  // Each table's chosen Main form is its default (the platform keeps one), next to the stock form the platform made.
  forms: [
    'contoso_project: Information (type 2)', 'contoso_project: Project (type 2, default)', 'contoso_project: Project Card (type 6)',
    'contoso_tag: Information (type 2, default)',
    'contoso_task: Information (type 2)', 'contoso_task: Task (type 2, default)', 'contoso_task: Task Quick Create (type 7)',
  ],
  dashboards: ['Kitchen Overview'],
  commands: ['contoso_project', 'contoso_project', 'contoso_project', 'contoso_project'],
  webResources: ['contoso_kitchensink_icon', 'contoso_kitchensink_pagemanifest', 'contoso_project.js', 'contoso_projecticon.svg'],
  app: { uniquename: 'contoso_kitchensink', published: true, tables: ['contact', 'contoso_project', 'contoso_tag', 'contoso_task'], components: [1, 26, 59, 60, 62] },
  navigation: 6,
  // The new look on; the header refresh written OFF, in the SDK's tri-state encoding (references/app-spec-schema.md, headerNavigationRefresh).
  settings: { NewLookAlwaysOn: 'true', HeaderAndNavigationRefresh: '1' },
  page: { name: 'Kitchen Page', published: true },
  // The persona's jobs, unioned: businessUnit is Local (2), user Basic (1), and the app's read (Global, 8) for appAccess.
  personaRole: ['prvCreatecontoso_project 2', 'prvReadappmodule 8', 'prvReadcontoso_project 2', 'prvReadcontoso_task 1', 'prvWritecontoso_project 2'],
  basicUserGrants: ['prvReadcontoso_tag 8'],
  records: { projects: ['Apollo status 100000000'], tasks: ['Kickoff -> Apollo'] },
  unpublished: [],
};

// The publishes of a stage (helpers/lifecycle-harness.js publishesOf).
const publishesOfStage = (run, name) => publishesOf(run.org, run.stages[name]);

function withinBudget(s, name) {
  const requests = s.end - s.mark;
  assert.ok(s.reads <= BUDGET[name].reads, `${name} reads ${s.reads}, its budget is ${BUDGET[name].reads}`);
  assert.ok(requests <= BUDGET[name].requests, `${name} sends ${requests} requests, its budget is ${BUDGET[name].requests}`);
}

test('lifecycle matrix: the build makes every feature of the kitchen-sink spec, publishes all of it, and its own verify passes', async (t) => {
  const run = await lifecycle();
  const s = stageOf(run, 'build');
  t.diagnostic(`build ${run.timings.build} ms, ${s.end - s.mark} requests (${s.reads} reads)`);
  const { result, warnings } = s.value;
  assert.equal(result.ok, true, JSON.stringify(result.errors || result.error));
  assert.deepEqual(result.verify && { ok: result.verify.ok, missing: result.verify.missing }, { ok: true, missing: [] }, 'the build\'s --verify finds every artifact');
  assert.deepEqual(warnings, [], 'the build of this spec warns about nothing');
  assert.deepEqual(run.built, BUILT, 'the environment holds every feature as the spec declares it');
  assert.deepEqual(diffContents(run.seedContents, run.contents.build, { added: false }), [], 'every artifact the environment held before the build — another maker\'s, the system\'s — holds exactly what it held');
  assert.deepEqual(s.writes, BUILD_WRITES);
  assert.deepEqual(publishesOfStage(run, 'build'), BUILD_PUBLISHES);
  assert.deepEqual(s.unpublished, [], 'nothing is left saved but not published');
  withinBudget(s, 'build');
});

test('lifecycle matrix: rebuilding the unchanged spec creates and deletes nothing, and sends only the writes the budget lists', async (t) => {
  const run = await lifecycle();
  const s = stageOf(run, 'rebuild');
  t.diagnostic(`rebuild ${run.timings.rebuild} ms, ${s.end - s.mark} requests (${s.reads} reads)`);
  const { result, warnings } = s.value;
  assert.equal(result.ok, true, JSON.stringify(result.errors || result.error));
  assert.deepEqual(result.verify && { ok: result.verify.ok, missing: result.verify.missing }, { ok: true, missing: [] });
  assert.deepEqual(run.afterRebuild, run.afterBuild, 'the environment holds exactly what it held after the build: no component, column, row, link or page is added or removed');
  assert.deepEqual(diffContents(run.seedContents, run.contents.rebuild, { added: false }), [], 'every artifact the environment held before the build still holds exactly what it held');
  assert.deepEqual(s.writes, REBUILD_WRITES);
  assert.deepEqual(publishesOfStage(run, 'rebuild'), REBUILD_PUBLISHES);
  assert.deepEqual(s.unpublished, []);
  // Documented: a view that exists keeps its filters and sort, and the build says so (references/app-spec-schema.md, views[]).
  assert.deepEqual(warnings.slice().sort(), [
    "view 'My Open Tasks' already exists — its columns and description were updated, but authored filters/sort are NOT reapplied to an existing view. Rename the view to author a separate one, or adjust its filters in Maker.",
    "view 'Open Projects' already exists — its columns and description were updated, but authored filters/sort are NOT reapplied to an existing view. Rename the view to author a separate one, or adjust its filters in Maker.",
  ]);
  withinBudget(s, 'rebuild');
});

// ====================================================================================================================================
// THE ROUND TRIP. The spec a download writes is the authored spec, but for these differences — each one the step below makes. Where
// the round trip is documented to differ, the comment says where; the rest are what it does today and are reported as gaps.
//   documented  forms[], views[], charts[] and commands[] are not reconstructed; the download names them (notRoundTripped)
//               (docs/app-builder-capabilities.md, "Round-trip scope")
//   documented  a table, relationship and global choice read back is marked `existing: true`, so a teardown of the downloaded spec never
//               deletes it; the app's immutable `uniqueName` and each page's `pageId` are written; a page's source is stored under
//               pages/<pageId>/ and its prompt is written (references/app-spec-schema.md, app.uniqueName and pages[])
//   documented  a dashboard comes back pinned by `dashboardId`, its tiles bound to the deployed view and chart ids
//   documented  an AutoNumber column comes back as Text (download-model-app.js: "no AutoNumber column or format is ever emitted")
//   documented  a lookup label that is the referenced table's display name is left out (it is the default)
//   documented  a File or Image column comes back typed, with the size it was made with unless that is the size a build gives a column
//               that sets none (docs/app-builder-capabilities.md, "Round-trip scope")
//   documented  a table's plural comes back when it is not the display name plus "s", the one a rebuild would derive
//               (references/app-spec-schema.md, "Round-trip")
//   documented  personas[] are not carried (references/app-spec-schema.md: "a download carries none")
//   warned      a Customer column is left out: its two relationships have no relationships[] form (the download warns)
//   gap         solution.displayName, a global choice's displayName, a table's vectorIcon, statusReasons and alternateKeys, a column's
//               type options (format, length, range, precision, labels, date format), a dashboard tile's size, script and
//               table-icon web resources, roleGrants[] and sampleData are not carried
function expectedDownload(authored, ids) {
  const byName = (a, b) => (a.schemaName < b.schemaName ? -1 : a.schemaName > b.schemaName ? 1 : 0);
  const column = (c) => ({
    schemaName: c.schemaName,
    displayName: c.displayName,
    type: c.type === 'AutoNumber' ? 'Text' : c.type, // documented
    ...(c.options ? { options: c.options } : {}),
    ...(c.globalChoice ? { globalChoice: c.globalChoice } : {}),
    ...((c.type === 'File' || c.type === 'Image') && c.maxSizeKb !== undefined ? { maxSizeKb: c.maxSizeKb } : {}), // documented
  });
  const entity = (e) => ({
    schemaName: e.schemaName,
    displayName: e.displayName,
    ...(e.pluralName !== `${e.displayName}s` ? { pluralName: e.pluralName } : {}), // documented
    primaryAttribute: { schemaName: e.primaryAttribute.schemaName, displayName: e.primaryAttribute.displayName },
    columns: e.columns
      .filter((c) => c.type !== 'Customer') // warned
      .map(column).sort(byName),
    existing: true,
    description: e.description,
  });
  const tableName = new Map(authored.entities.map((e) => [e.schemaName, e.displayName]));
  const relationship = (r) => (r.type === 'ManyToMany'
    ? { type: r.type, entity1: r.entity1, entity2: r.entity2, existing: true }
    : { type: r.type, referenced: r.referenced, referencing: r.referencing, lookup: { schemaName: r.lookup.schemaName, ...(r.lookup.displayName !== tableName.get(r.referenced) ? { displayName: r.lookup.displayName } : {}) }, existing: true });
  const dashboard = authored.dashboards[0];
  const page = authored.pages[0];
  return {
    schemaVersion: authored.schemaVersion,
    minimumPluginVersion: authored.minimumPluginVersion,
    solution: { uniqueName: authored.solution.uniqueName, publisherPrefix: authored.solution.publisherPrefix, description: authored.solution.description },
    app: { ...authored.app, uniqueName: 'contoso_kitchensink' },
    entities: authored.entities.map(entity),
    relationships: authored.relationships.map(relationship),
    globalChoices: authored.globalChoices.map((g) => ({ name: g.name, options: g.options, existing: true })),
    webResources: [],
    views: [],
    charts: [],
    forms: [],
    commands: [],
    dashboards: [{
      name: dashboard.name,
      dashboardId: ids.dashboard,
      description: dashboard.description,
      tiles: [
        { type: 'chart', name: 'Projects by Priority', entity: 'contoso_project', viewId: ids.openProjects, visualizationId: ids.chart },
        { type: 'list', name: 'Open', entity: 'contoso_project', viewId: ids.openProjects },
        { type: 'iframe', name: 'Status', url: 'https://contoso.example/status' },
      ],
    }],
    pages: [{ key: page.key, name: page.name, pageId: ids.page, purpose: page.purpose, dataSources: page.dataSources, prompt: `Generative page ${page.name}`, source: { kind: 'tsx', codeFile: `pages/${ids.page}/page.tsx` } }],
    // The page's navigation entry comes back with the icon the build gave it.
    appShell: { areas: authored.appShell.areas.map((a) => ({ ...a, groups: a.groups.map((g) => ({ ...g, subAreas: g.subAreas.map((sa) => (sa.page ? { ...sa, vectorIcon: '/_imgs/TableIconsFluentV9/document_one_page_sparkle.svg' } : sa)) })) })) },
  };
}
// Relationships come back in an order the reads decide; the comparison is of the set.
const relationshipKey = (r) => `${r.type} ${r.referenced || r.entity1} ${r.referencing || r.entity2} ${r.lookup ? r.lookup.schemaName : ''}`;
const sortRelationships = (spec) => ({ ...spec, relationships: [...(spec.relationships || [])].sort((a, b) => (relationshipKey(a) < relationshipKey(b) ? -1 : 1)) });

test('lifecycle matrix: the download writes the authored spec back, but for the differences the round trip is pinned to', async (t) => {
  const run = await lifecycle();
  const s = stageOf(run, 'download');
  t.diagnostic(`download ${run.timings.download} ms, ${s.end - s.mark} requests`);
  const { emitted, stderr, spec, dir } = s.value;
  assert.equal(emitted && emitted.ok, true, JSON.stringify(emitted));
  assert.deepEqual(s.writes, {}, 'a download writes nothing to the environment');
  assert.deepEqual(diffContents(run.contents.rebuild, run.contents.download), [], 'and changes nothing in it');
  const { descriptionInventory, ...downloaded } = spec;
  assert.deepEqual(sortRelationships(downloaded), sortRelationships(expectedDownload(run.spec, run.ids)));
  // The page's source comes back byte for byte.
  assert.equal(fs.readFileSync(path.join(dir, 'pages', run.ids.page, 'page.tsx'), 'utf8'), PAGE_SOURCE);
  // What it does not carry, it names: the forms, views and charts of each table.
  assert.deepEqual(emitted.payload.notRoundTripped.classes, [{ kind: 'forms', count: 5, label: 'form' }, { kind: 'views', count: 9, label: 'view' }, { kind: 'charts', count: 1, label: 'chart' }]);
  assert.deepEqual(Object.fromEntries(Object.entries(descriptionInventory).map(([k, list]) => [k, list.map((x) => (x.entity ? `${x.entity}: ${x.name}` : x.name))])), {
    views: ['contoso_project: Active Projects', 'contoso_project: Inactive Projects', 'contoso_project: Open Projects', 'contoso_tag: Active Tag Catalog', 'contoso_tag: Inactive Tag Catalog', 'contoso_task: Active Task Items', 'contoso_task: Inactive Task Items', 'contoso_task: My Open Tasks', 'contoso_task: Open Tasks'],
    charts: ['contoso_project: Projects by Priority'],
    forms: ['contoso_project: Information', 'contoso_project: Project', 'contoso_tag: Information', 'contoso_task: Information', 'contoso_task: Task'],
    globalChoices: ['contoso_stage'],
  });
  // ...and it warns about the two losses a rebuild elsewhere would otherwise not show.
  const warningLines = stderr.split('\n').filter((l) => /^WARNING:/.test(l));
  assert.equal(warningLines.length, 2, stderr);
  assert.match(warningLines[0], /lookup 'contoso_customer' is polymorphic \(targets account, contact\)/);
  assert.match(warningLines[1], /restricted to specific security roles \(contoso_project\.Project\)/);
  // The written spec is one the build takes.
  const validation = validateAppSpec(spec, { profile: 'plan', reconstructed: true });
  assert.deepEqual(validation.errors, []);
  withinBudget(s, 'download');
});

test('lifecycle matrix: verify passes, and makes every check it made before', async (t) => {
  const run = await lifecycle();
  const s = stageOf(run, 'verify');
  t.diagnostic(`verify ${run.timings.verify} ms, ${s.end - s.mark} requests`);
  const result = s.value;
  assert.deepEqual({ ok: result.ok, missing: result.missing, unverified: result.unverified || [] }, { ok: true, missing: [], unverified: [] });
  const kinds = {};
  for (const c of result.checks) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  assert.deepEqual(kinds, VERIFY_CHECKS);
  assert.deepEqual(s.writes, {}, 'verify writes nothing');
  assert.deepEqual(diffContents(run.contents.download, run.contents.verify), [], 'and changes nothing');
  withinBudget(s, 'verify');
});

test('lifecycle matrix: teardown deletes everything the build made and nothing else', async (t) => {
  const run = await lifecycle();
  const s = stageOf(run, 'teardown');
  t.diagnostic(`teardown ${run.timings.teardown} ms, ${s.end - s.mark} requests; whole lifecycle ${Object.values(run.timings).reduce((a, b) => a + b, 0)} ms`);
  const { result } = s.value;
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual({ errors: result.errors, skipped: result.skipped }, { errors: [], skipped: [] });
  assert.deepEqual(s.writes, TEARDOWN_WRITES);
  // The environment is back to where it started, but for the publisher the build made for the prefix: teardown deletes the solution and
  // never a publisher, which other solutions may share. Only THAT row is set aside — by its identity, captured after the build — so a
  // publisher the environment had before that went missing would still fail here.
  assert.equal(run.builtPublisher.length, 1);
  assert.match(run.builtPublisher[0], / contosopublisher$/);
  const publishers = run.afterTeardown.rows.publishers;
  assert.deepEqual(publishers.filter((p) => !run.seed.rows.publishers.includes(p)), run.builtPublisher, 'the one row left that the environment did not have is the build\'s publisher');
  assert.deepEqual({ ...run.afterTeardown, rows: { ...run.afterTeardown.rows, publishers: publishers.filter((p) => !run.builtPublisher.includes(p)) } }, run.seed, 'every table, column, relationship, option set, row, solution component, link and page the build made is gone, and nothing the environment had before is missing');
  // ...and every artifact the environment had before holds exactly what it held: saved and published layers, metadata, page files.
  assert.deepEqual(diffContents(run.seedContents, run.contents.teardown, { added: false }), [], 'nothing the environment had before was touched');
  withinBudget(s, 'teardown');
});

// ====================================================================================================================================
// DEFECTS the matrix found, kept as tests that state the right behaviour. A defect found later is added the same way: skipped while it
// is open, and when it is fixed the `skip` goes, and so does its step from expectedDownload above.

// Fixed: a File or Image column reports AttributeType "Virtual", which the download's type map never matched, so both were left out of
// every download without a word. The download now types them by their AttributeTypeName (FileType / ImageType) and keeps the size.
test('lifecycle matrix: a download keeps the File and Image columns it reads', async () => {
  const run = await lifecycle();
  const project = stageOf(run, 'download').value.spec.entities.find((e) => e.schemaName === 'contoso_project');
  assert.deepEqual(project.columns.filter((c) => ['File', 'Image'].includes(c.type)).map((c) => c.schemaName), ['contoso_contract', 'contoso_logo']);
});

// Fixed: a plain plural was left out of every download as "derivable", but "Tag Catalog" is not "Tags", so a rebuild into another
// environment named the table differently. The download now leaves out only the plural the build's own derivation would write.
test('lifecycle matrix: a download keeps a plural that is not the display name plus "s"', async () => {
  const run = await lifecycle();
  const tag = stageOf(run, 'download').value.spec.entities.find((e) => e.schemaName === 'contoso_tag');
  assert.equal(tag.pluralName, 'Tag Catalog');
});
