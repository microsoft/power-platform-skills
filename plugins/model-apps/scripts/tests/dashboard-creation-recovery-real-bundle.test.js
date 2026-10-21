'use strict';
// A dashboard the build CREATES joins the app's solution in a second request (AddSolutionComponent, component type 60), and the solution is
// the only later proof that the dashboard is the app's: a name is neither unique nor compared exactly. When the run stops between the two —
// the process is killed, the answer to the create is lost, or the membership add and the undo of the create both fail — the row is left
// outside the solution. Nothing durable remembered it: the next build looked the dashboard up by name, and a dashboard that was created and
// never published is in no plain read, so it made a SECOND one (or, once someone had published the first, reused it as a lone namesake
// without adding it); teardown then kept the first, and a solution export left it out.
//
// The bundled SDK sends the workspace's own id as `systemform.formid` on the create, so the build knows the id before the request. It records
// it in the workspace (lib/dashboard-creation-records.js) before the push, and clears it once the row is in the solution or the build's own
// undo removed it. A later build reads that exact id in the SAVED layer before it looks anything up by name, and adds that row to the
// solution — never another row, never on a name alone — and deletes nothing on the record's word.
//
// Over the REAL vendored SDK, the plugin's own HTTP client and the strict stateful fake of helpers/fake-lifecycle-org.js: a row created and
// never published is in no plain collection read, RetrieveUnpublished answers it, and a missing id answers 404 0x80040217 (the SDK's
// readSystemFormType records the last two as measured). A failure is provoked in front of the fake, for this test's own requests only, so the
// environment holds what it would after a real one. A process that dies is a build whose request never answers, left unsettled — nothing of
// it runs after that moment — and the next build is a new SDK on the same workspace, as a new process is.
//
//   1. the record itself (lib/dashboard-creation-records.js)
//   2. a build stopped between the create and the membership add — killed, stranded, its create lost before or after it committed, the id
//      reported back changed — and the next build
//   3. what the record never does: adopt a namesake, add a row that is no longer the one it recorded, delete anything, decide a teardown
//   4. a record the build cannot read or write: the build is the one it was before there was a record, and says so once
//   5. what is unchanged: an ordinary first build and an unchanged rebuild send exactly what they sent before
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { isTransientHalt } = require('../build-model-app.js');
const { sha256 } = require('../lib/hash.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');

// Loaded where it is used, so that every test below fails on its own assertion when the module is not there.
const records = () => require('../lib/dashboard-creation-records.js');

const ENV = 'https://contoso.crm.dynamics.com';
const ID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOARD = 'Ops Overview';
const SOLUTION = 'ContosoBoards';
const APP = 'contoso_boards';

// The smallest app that holds a dashboard the way a maker's does: built by the build, in its solution, in its navigation.
const spec = () => ({
  schemaVersion: 2,
  solution: { uniqueName: SOLUTION, displayName: 'Contoso Boards', publisherPrefix: 'contoso' },
  app: { name: 'Boards', uniqueName: APP },
  entities: [{ schemaName: 'contact', displayName: 'Contact', existing: true, primaryAttribute: { schemaName: 'fullname', displayName: 'Full Name' }, columns: [] }],
  dashboards: [{ name: BOARD, tiles: [{ type: 'iframe', url: 'https://contoso.example/status', name: 'Status' }] }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Boards', subAreas: [{ dashboard: BOARD, title: 'Overview' }] }] }] },
});

// --- 1. the record -----------------------------------------------------------------------------------------------------------------------------------------

const scratch = (prefix = 'dash-record-') => makeTempDir(prefix);
const open = (dir, extra = {}) => records().openDashboardCreations({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOLUTION, ...extra });

test('the record: an id noted before the push is read back under any spelling Dataverse treats as the same name, by the next run too; a reported id is kept beside it; cleared, the file goes with its last entry', () => {
  const dir = scratch();
  const run = open(dir);
  assert.equal(run.idsOf(BOARD), undefined, 'nothing recorded yet, and no file');
  assert.equal(run.note(BOARD, ID_A.toUpperCase()), true, 'on disk');
  assert.deepEqual(run.idsOf('OPS OVERVIEW '), [ID_A], 'a name is compared as Dataverse compares dashboard names; the id is kept in lower case');
  assert.equal(run.observe(BOARD, ID_B), true, 'the id the push reported, when it is another one');
  assert.deepEqual(open(dir).idsOf(BOARD), [ID_A, ID_B], 'the next run reads both observations, the one the build sent first');
  const file = records().dashboardCreationRecordPath(dir, ENV, APP, SOLUTION);
  assert.match(path.basename(file), /^dashboard-creation\.[0-9a-f]{64}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dashboards, { [BOARD]: { id: ID_A, reportedId: ID_B } });
  assert.equal(run.clear(BOARD), true);
  assert.equal(open(dir).idsOf(BOARD), undefined);
  assert.equal(fs.existsSync(file), false, 'an empty record is no file');
});

test('the record is one file per environment, app and solution: another app, solution or environment in the same folder does not see it, the same origin written another way does', () => {
  const dir = scratch();
  open(dir).note(BOARD, ID_A);
  assert.equal(open(dir, { appUniqueName: 'contoso_other' }).idsOf(BOARD), undefined, 'another app');
  assert.equal(open(dir, { solutionUniqueName: 'ContosoOther' }).idsOf(BOARD), undefined, 'another solution');
  assert.equal(open(dir, { environment: 'https://fabrikam.crm.dynamics.com' }).idsOf(BOARD), undefined, 'another environment');
  assert.deepEqual(open(dir, { environment: `${ENV}/`, appUniqueName: APP.toUpperCase(), solutionUniqueName: SOLUTION.toLowerCase() }).idsOf(BOARD), [ID_A], 'the same origin, app and solution, spelt another way');
});

test('the record is the same bytes for the same dashboards, whatever order they were noted in', () => {
  const [one, two] = [scratch(), scratch()];
  const a = open(one);
  a.note('Zeta', ID_A); a.note('alpha', ID_B);
  const b = open(two);
  b.note('alpha', ID_B); b.note('Zeta', ID_A);
  const bytes = (dir) => fs.readFileSync(records().dashboardCreationRecordPath(dir, ENV, APP, SOLUTION));
  assert.deepEqual(bytes(one), bytes(two));
  assert.deepEqual(Object.keys(JSON.parse(bytes(one)).dashboards), ['alpha', 'Zeta'], 'sorted as Dataverse compares names');
});

test('the record never stops a build: one it cannot read is "nothing recorded", said once, and is left exactly as it was — never overwritten; with no workspace or environment, or an id that is no id, nothing is recorded', () => {
  const dir = scratch();
  const file = records().dashboardCreationRecordPath(dir, ENV, APP, SOLUTION);
  fs.writeFileSync(file, '{ not json');
  const warnings = [];
  const run = open(dir, { warn: (w) => warnings.push(w) });
  assert.equal(run.idsOf(BOARD), undefined);
  assert.equal(run.note(BOARD, ID_A), false, 'a file this build cannot read is not replaced by one that would lose what it held');
  assert.equal(run.clear(BOARD), false);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /could not be read .*so this build finds dashboards by name, as before, and records none of its own/);
  assert.ok(warnings[0].includes(file), 'the warning names the file');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'left exactly as it was');
  for (const options of [{ workspaceDir: undefined }, { environment: undefined }, { solutionUniqueName: undefined }]) {
    const none = open(dir, options);
    assert.equal(none.note(BOARD, ID_A), false, JSON.stringify(options));
    assert.equal(none.idsOf(BOARD), undefined);
  }
  assert.equal(open(scratch()).note(BOARD, 'not-a-guid'), false, 'an id that is no id is not recorded');
});

// --- the environment ---------------------------------------------------------------------------------------------------------------------------------------

// A fake environment, and a seam in front of its transport that answers what a test's faults name instead of the fake. A refused request
// never reaches the fake, so the environment holds what it would after a real refusal. A Dataverse refusal is an OData error:
//   { "error": { "code": "0x80040216", "message": "An unexpected error occurred." } }
// See: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors#parse-errors-from-the-response
function environment() {
  const org = createLifecycleOrg();
  const faults = [];
  const request = async (req) => {
    const url = new URL(req.url);
    const where = decodeURIComponent(url.pathname + url.search).replace(/^\/api\/data\/v9\.\d/, '');
    let body = {};
    try { body = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : {}; } catch { /* a $batch or bytes: no JSON to match on */ }
    const fault = faults.find((f) => f.method === req.method && f.matches(where, body));
    if (!fault) return org.request(req);
    fault.hits += 1;
    return fault.answer(req, body);
  };
  const add = (method, matches, answer) => {
    const fault = { method, matches, answer, hits: 0 };
    faults.push(fault);
    return { lift: () => { faults.splice(faults.indexOf(fault), 1); return fault.hits; } };
  };
  const harness = createLifecycleHarness({ ...org, request }, makeTempDir('dash-recovery-'));
  return { org, harness, add };
}

const refusedWith = (statusCode, code, message) => () => ({ statusCode, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code, message } }) });
// What lib/dataverse-auth.js makeRequest answers when the connection is reset before an answer arrives.
const resetConnection = () => ({ error: 'read ECONNRESET', code: 'ECONNRESET' });

const isDashboardMembership = (where, body) => where === '/AddSolutionComponent' && Number(body.ComponentType) === 60;
const isDashboardCreate = (where, body) => /^\/systemforms(\?|$)/.test(where) && String(body.type) === '0';
// GET /systemforms(<id>)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,type — the build's read of a recorded id.
const isRecordRead = (id) => (where) => where === `/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formid,name,type`;

// What a maker does in Maker, sent to the fake as the Web API call Maker makes — around the seam, which only the build's requests pass.
async function inMaker(org, method, where, body) {
  const res = await org.request({ url: `${org.API}${where}`, method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.statusCode < 300, `${method} ${where} answered ${res.statusCode}: ${res.body}`);
}
const publishDashboard = (org, id) => inMaker(org, 'POST', '/PublishXml', { ParameterXml: `<importexportxml><dashboards><dashboard>${id}</dashboard></dashboards></importexportxml>` });

// The dashboards named BOARD the environment holds, saved layer (published or not), and the ones the app's solution holds.
const boards = (org) => org.find('systemforms', (f) => Number(f.type) === 0 && f.name === BOARD).map((f) => String(f.formid).toLowerCase());
const allDashboards = (org) => org.find('systemforms', (f) => Number(f.type) === 0).map((f) => String(f.formid).toLowerCase());
function members(org) {
  const [solution] = org.find('solutions', (s) => s.uniquename === SOLUTION);
  if (!solution) return [];
  return org.solutionComponents().filter((c) => Number(c.componenttype) === 60 && String(c._solutionid_value).toLowerCase() === String(solution.solutionid).toLowerCase()).map((c) => String(c.objectid).toLowerCase());
}
// What a step sent, from the fake's own record of the requests that reached it.
const creates = (org, mark) => org.since(mark).filter((r) => r.method === 'POST' && isDashboardCreate(r.path, r.body || {})).map((r) => String(r.body.formid).toLowerCase());
const memberships = (org, mark, id) => org.since(mark).filter((r) => r.method === 'POST' && isDashboardMembership(r.path, r.body || {}) && (!id || String(r.body.ComponentId).toLowerCase() === id));
const formDeletes = (org, mark) => org.since(mark).filter((r) => r.method === 'DELETE' && /^\/systemforms\(/.test(r.path)).map((r) => r.path);
const recordReads = (org, mark, id) => org.since(mark).filter((r) => r.method === 'GET' && isRecordRead(id)(r.path));

// The record, as the file the build keeps for this app's dashboards in this environment:
//   dashboard-creation.<sha256 of [environment fingerprint, app unique name, solution unique name]>.json
// computed here and not by the module, so a test fails on what the build did when the module is missing.
const recordFile = (env) => path.join(env.harness.workspaceDir, `dashboard-creation.${sha256(JSON.stringify([environmentFingerprint(env.org.origin), APP, SOLUTION.toLowerCase()]))}.json`);
function recorded(env) {
  try { return JSON.parse(fs.readFileSync(recordFile(env), 'utf8')).dashboards; } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const recordFiles = (env) => fs.readdirSync(env.harness.workspaceDir).filter((name) => name.startsWith('dashboard-creation.'));

// A measured step ran: it did not throw, and every request it sent is one the fake models.
function ran(step, label) {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
}

// The build is killed the moment it sends the new dashboard's membership add: that request never answers, and nothing of the run happens after
// it — no undo, no record cleared, no app. Answers the id the add named, which is the row the create committed.
async function dieAtMembership(env) {
  let named;
  const reached = new Promise((resolve) => { named = resolve; });
  const fault = env.add('POST', isDashboardMembership, (req, body) => { named(String(body.ComponentId).toLowerCase()); return new Promise(() => {}); });
  let settled = false;
  env.harness.build(spec()).then(() => { settled = true; }, () => { settled = true; });
  const id = await reached;
  fault.lift();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the killed build never finishes');
  return id;
}

// --- 2. a build stopped between the create and the membership add, and the next build -----------------------------------------------------------------------

// What a maker may do in Maker between the killed build and the next one: nothing, publish the dashboard (it is then in the plain reads the name lookup
// makes), or add it to the solution by hand (the add the next build makes is then a no-op: the solution never holds a component twice).
const IN_BETWEEN = [
  ['', async () => {}],
  [' (a maker published it in between)', (env, id) => publishDashboard(env.org, id)],
  [' (a maker added it to the solution in between)', (env, id) => inMaker(env.org, 'POST', '/AddSolutionComponent', { ComponentId: id, ComponentType: 60, SolutionUniqueName: SOLUTION, AddRequiredComponents: false })],
];
for (const [inBetween, makerDoes] of IN_BETWEEN) {
  test(`a build killed between creating a dashboard and adding it to the solution: the next build — a new process on the same workspace — adds that same dashboard to the solution and reuses it, creates none, and teardown then removes it${inBetween}`, async () => {
    const env = environment();
    const id = await dieAtMembership(env);
    assert.deepEqual(boards(env.org), [id], 'the create committed: one dashboard, under the id the build sent');
    assert.deepEqual(members(env.org), [], 'outside the solution');
    const left = recorded(env);
    await makerDoes(env, id);

    const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
    assert.equal(rerun.value.result.ok, true, JSON.stringify(rerun.value.result.errors));
    assert.deepEqual(creates(env.org, rerun.mark), [], 'no second dashboard is created');
    assert.equal(memberships(env.org, rerun.mark, id).length, 1, 'the dashboard the killed build created is added to the solution');
    assert.deepEqual(boards(env.org), [id], 'exactly one dashboard of that name');
    assert.deepEqual(members(env.org), [id], 'and the solution holds it');
    assert.equal(rerun.value.result.created.dashboards[BOARD], id, 'reused: the navigation points at it');
    assert.deepEqual(env.org.since(rerun.mark).filter((r) => ['PATCH', 'PUT'].includes(r.method) && r.path.startsWith(`/systemforms(${id})`)).map((r) => `${r.method} ${r.path}`), [], 'its tiles are not rewritten: it is reused as the killed build pushed it');
    assert.ok(!rerun.value.warnings.some((w) => /not in this app's solution/.test(w)), `no namesake warning: it is in the solution now. ${JSON.stringify(rerun.value.warnings)}`);

    assert.deepEqual(left, { [BOARD]: { id } }, 'the killed build had recorded the id before it pushed');
    assert.deepEqual(recordReads(env.org, rerun.mark, id).map((r) => r.status), [200], 'the next build read that id once, in the saved layer');
    assert.ok(rerun.value.log.some((line) => line.includes(`dashboard "${BOARD}" (created by an interrupted build as ${id} — added to the solution, and reused)`)), 'and says what it did');
    assert.equal(recorded(env), null, 'the record is cleared once the row is in the solution');

    const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
    assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
    assert.deepEqual(allDashboards(env.org), [], 'ALL ABSENT: teardown deletes it as a member of the solution — no orphan is left');
  });
}

test('a dashboard the build could neither add to its solution nor remove again: the halt says a run again adds it, and the next run adds that same dashboard', async () => {
  const env = environment();
  let id;
  const lifts = [
    env.add('POST', isDashboardMembership, (req, body) => { id = String(body.ComponentId).toLowerCase(); return refusedWith(400, '0x80040216', 'An unexpected error occurred.')(); }),
    env.add('DELETE', (where) => /^\/systemforms\([0-9a-f-]{36}\)$/.test(where), refusedWith(400, '0x80040216', 'The dashboard could not be deleted.')),
    // The undo's plain read of the row, which cannot be read either: the build assumes it is still there (it is).
    env.add('GET', (where) => /^\/systemforms\?\$select=formid&\$filter=formid eq [0-9a-f-]{36}&\$top=1$/.test(where), refusedWith(400, '0x80040216', 'An unexpected error occurred.')),
  ];
  const failed = await env.harness.measure(() => env.harness.build(spec()));
  for (const fault of lifts) fault.lift();
  assert.ok(failed.error, 'the build stops');
  assert.match(failed.error.message, new RegExp(`dashboard "${BOARD}" was created \\(${id}\\) but could not be added to solution '${SOLUTION}' \\(.*An unexpected error occurred.*\\), and removing it again failed \\(.*could not be deleted.*\\)`));
  assert.equal(isTransientHalt(failed.error), false, 'never run again on its own');
  assert.deepEqual(boards(env.org), [id], 'stranded: the row is there');
  const left = recorded(env);

  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(rerun.value.result.ok, true, JSON.stringify(rerun.value.result.errors));
  assert.deepEqual(creates(env.org, rerun.mark), [], 'no second dashboard is created');
  assert.equal(memberships(env.org, rerun.mark, id).length, 1, 'the stranded dashboard is added to the solution');
  assert.deepEqual(boards(env.org), [id]);
  assert.deepEqual(members(env.org), [id]);

  assert.deepEqual(left, { [BOARD]: { id } }, 'the stranded halt keeps the record');
  assert.match(failed.error.message, /— this build recorded it, so running the build again adds it to the solution and reuses it; or delete it in Maker before running it again, and it is created afresh/);
  assert.equal(recorded(env), null);
});

test('the undo fails at the row and its plain read misses the never-published row: the record is kept all the same, and the build\'s own run again adds that same dashboard', async () => {
  const env = environment();
  let id;
  let refusals = 1;
  // The customization lock refuses the membership add once — a refusal a run again rides out (lib/retry-policy.js) — and the row cannot be
  // deleted. The undo's plain read answers the PUBLISHED layer, where a dashboard nobody published is not: the build reports it removed.
  const lifts = [
    env.add('POST', (where, body) => isDashboardMembership(where, body) && refusals > 0 && (refusals -= 1, true), (req, body) => {
      id = String(body.ComponentId).toLowerCase();
      return refusedWith(400, '0x80071151', 'Cannot start the requested operation [AddSolutionComponent] because there is another [Import] running at this moment.')();
    }),
    env.add('DELETE', (where) => /^\/systemforms\([0-9a-f-]{36}\)$/.test(where), refusedWith(400, '0x80040216', 'The dashboard could not be deleted.')),
  ];
  const built = await env.harness.measure(() => env.harness.build(spec()));
  for (const fault of lifts) fault.lift();
  ran(built, 'the build and its own run again');
  assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.errors));
  assert.equal(creates(env.org, built.mark).length, 1, 'one create in both attempts: the run again made no second dashboard');
  assert.deepEqual(boards(env.org), [id]);
  assert.deepEqual(members(env.org), [id], 'the dashboard the first attempt created is in the solution');
  assert.equal(built.value.result.created.dashboards[BOARD], id);
  assert.equal(recorded(env), null);
});

test('a dashboard create that never reached the service: the record names an id no row has, and the next run reads it, clears it and creates exactly one', async () => {
  const env = environment();
  const lose = env.add('POST', isDashboardCreate, resetConnection);
  const failed = await env.harness.measure(() => env.harness.build(spec()));
  assert.ok(lose.lift() > 0, 'the create was sent');
  assert.ok(failed.error, 'the build stops');
  assert.deepEqual(allDashboards(env.org), [], 'no row was created');
  const left = recorded(env);

  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(rerun.value.result.ok, true, JSON.stringify(rerun.value.result.errors));
  assert.equal(creates(env.org, rerun.mark).length, 1, 'exactly one dashboard is created');
  const [only] = boards(env.org);
  assert.deepEqual(members(env.org), [only]);
  assert.equal(recorded(env), null);

  assert.ok(left && left[BOARD] && GUID.test(left[BOARD].id), `the create was recorded before it was sent: ${JSON.stringify(left)}`);
  assert.notEqual(only, left[BOARD].id, 'the new dashboard has an id of its own');
  assert.deepEqual(recordReads(env.org, rerun.mark, left[BOARD].id).map((r) => r.status), [404], 'the recorded id was read in the saved layer, and no row has it');
});

// Following a halt's workspace reset: everything goes but the files the advice names — read from the advice itself, so a record the
// advice forgets is deleted here as an operator would delete it.
function followResetAdvice(dir, advice) {
  assert.match(advice, /then delete everything in it except /);
  const keep = [...advice.matchAll(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9*-]+)*\.json\b/g)].map(([name]) => new RegExp(`^${name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
  for (const name of fs.readdirSync(dir)) if (!keep.some((pattern) => pattern.test(name))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

test('a dashboard create whose answer was lost after it committed: the halt asks for a workspace reset, the reset keeps the record, and the next run adds that dashboard to the solution', async () => {
  const env = environment();
  let lostOne = false;
  // The first create reaches the service and commits; its answer is lost. The client sends it again, and the service refuses the id it holds.
  const lose = env.add('POST', (where, body) => isDashboardCreate(where, body) && !lostOne, async (req) => { lostOne = true; await env.org.request(req); return resetConnection(); });
  const failed = await env.harness.measure(() => env.harness.build(spec()));
  lose.lift();
  assert.ok(failed.error, 'the build stops');
  assert.equal(failed.error.code, 'already-exists', failed.error.message);
  const [id] = boards(env.org);
  assert.deepEqual(boards(env.org), [id], 'one row: the one the lost answer was for');
  const left = recorded(env);
  followResetAdvice(env.harness.workspaceDir, failed.error.message);

  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(rerun.value.result.ok, true, JSON.stringify(rerun.value.result.errors));
  assert.deepEqual(creates(env.org, rerun.mark), [], 'no second dashboard is created');
  assert.equal(memberships(env.org, rerun.mark, id).length, 1, 'that dashboard is added to the solution');
  assert.deepEqual(boards(env.org), [id]);
  assert.deepEqual(members(env.org), [id]);

  assert.deepEqual(left, { [BOARD]: { id } }, 'the create was recorded before it was sent');
  assert.match(failed.error.message, /dashboard-creation\.\*\.json/, 'the reset advice keeps the record');
  assert.equal(recorded(env), null);
});

test('the push reports another id than the one the build sent: both are recorded, and the next run adds the one that exists — not the one it sent', async () => {
  const env = environment();
  const reported = '0d0d0d0d-0000-4000-8000-00000000000d';
  // A service that keeps another id than the client-minted one it was sent: the create's own answer (`Prefer: return=representation`) names it.
  const rekey = env.add('POST', isDashboardCreate, (req, body) => env.org.request({ ...req, body: JSON.stringify({ ...body, formid: reported }) }));
  const id = await dieAtMembership(env);
  rekey.lift();
  assert.equal(id, reported, 'the build went on with the id the service reported');
  const left = recorded(env);

  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.deepEqual(creates(env.org, rerun.mark), [], 'no second dashboard is created');
  assert.equal(memberships(env.org, rerun.mark, reported).length, 1, 'the row that exists is added');
  assert.deepEqual(boards(env.org), [reported]);
  assert.deepEqual(members(env.org), [reported]);

  assert.ok(left && left[BOARD] && GUID.test(left[BOARD].id) && left[BOARD].id !== reported, `the id the build sent is kept: ${JSON.stringify(left)}`);
  assert.equal(left[BOARD].reportedId, reported, 'beside the id the service reported');
  assert.deepEqual(recordReads(env.org, rerun.mark, left[BOARD].id).map((r) => r.status), [404], 'each was read: the one sent names no row');
  assert.deepEqual(recordReads(env.org, rerun.mark, reported).map((r) => r.status), [200]);
});

// --- 3. what the record never does ---------------------------------------------------------------------------------------------------------------------------

// Another maker's dashboard of the same name, made and published in Maker, in no solution of this app.
async function foreignDashboard(env) {
  const other = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('dash-foreign-')), instanceUrl: env.org.origin, httpClient: env.harness.client });
  await other.initWorkspace();
  const art = await other.createArtifact('dashboard', { name: BOARD });
  const pushed = await other.pushArtifact('dashboard', art.id);
  await publishDashboard(env.org, pushed.id);
  return String(pushed.id).toLowerCase();
}

test('the record names a dashboard deleted since, and another maker has made one of that name: the record is cleared, the other one is NOT added to the solution, and it is reused with the warning it always had', async () => {
  const env = environment();
  const id = await dieAtMembership(env);
  await inMaker(env.org, 'DELETE', `/systemforms(${id})`);
  const foreign = await foreignDashboard(env);
  const before = env.org.contents()[`row systemforms ${foreign}`];

  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(rerun.value.result.ok, true, JSON.stringify(rerun.value.result.errors));
  assert.deepEqual(memberships(env.org, rerun.mark, foreign), [], 'another maker\'s dashboard is never added to this app\'s solution');
  assert.deepEqual(members(env.org), []);
  assert.deepEqual(creates(env.org, rerun.mark), [], 'a lone namesake is reused, as before');
  assert.equal(rerun.value.result.created.dashboards[BOARD], foreign);
  assert.ok(rerun.value.warnings.some((w) => w.includes(`dashboard "${BOARD}": the one dashboard with this name is not in this app's solution '${SOLUTION}', so nothing proves it is this app's`)), JSON.stringify(rerun.value.warnings));
  assert.deepEqual(formDeletes(env.org, rerun.mark), [], 'nothing is deleted');
  assert.deepEqual(env.org.contents()[`row systemforms ${foreign}`].content.saved.formxml, before.content.saved.formxml, 'and the other dashboard is as it was');
  assert.equal(recorded(env), null, 'the record of a row that is gone is cleared');
});

// What a later build does when the recorded id answers, but not as the dashboard the killed build created: nothing is added or deleted, no
// second dashboard is made, the record stays, and the build stops with what a maker can do.
const DISAGREEMENTS = [
  {
    what: 'renamed in Maker since',
    change: (env, id) => inMaker(env.org, 'PATCH', `/systemforms(${id})`, { name: 'Ops Overview (old)' }),
    message: (id) => new RegExp(`dashboard "${BOARD}": an earlier build created it as ${id} and stopped before adding it to solution '${SOLUTION}', and that dashboard is now named 'Ops Overview \\(old\\)'\\. Nothing was added to the solution or deleted\\. If it is this app's, rename it back to '${BOARD}' in Maker and run the build again: it is then added to the solution and reused\\. If it is not wanted, delete it in Maker and run the build again: '${BOARD}' is then created afresh\\.`),
    restore: (env, id) => inMaker(env.org, 'PATCH', `/systemforms(${id})`, { name: BOARD }),
  },
  {
    what: 'no longer a dashboard (the id names a Main form now)',
    change: async (env, id) => {
      await inMaker(env.org, 'DELETE', `/systemforms(${id})`);
      await inMaker(env.org, 'POST', '/systemforms', { formid: id, name: BOARD, type: 2, objecttypecode: 'contact', formxml: '<form><tabs /></form>' });
    },
    message: (id) => new RegExp(`dashboard "${BOARD}": an earlier build recorded ${id} for it before it stopped, and that id now names a systemform of type 2, not a dashboard of the kind the build creates \\(type 0\\)\\. Nothing was added to the solution or deleted\\. Check the id, then remove the entry '${BOARD}' from .*dashboard-creation\\.[0-9a-f]{64}\\.json and run the build again\\.`),
  },
  {
    what: 'unreadable (the read of the id is refused)',
    change: (env, id) => { env.unreadable = env.add('GET', isRecordRead(id), refusedWith(403, '0x80040220', 'Principal user is missing prvReadSystemForm privilege.')); },
    message: (id) => new RegExp(`dashboard "${BOARD}": an earlier build created it as ${id} and stopped before adding it to solution '${SOLUTION}', and whether it still exists could not be read \\(.*prvReadSystemForm.*\\)\\. Nothing was added to the solution or deleted, and no second dashboard was created; run the build again\\.`),
    restore: (env) => env.unreadable.lift(),
  },
];

for (const { what, change, message, restore } of DISAGREEMENTS) {
  test(`the record names a dashboard ${what}: the next build adds nothing, deletes nothing, creates no second dashboard, keeps the record and stops with what to do${restore ? ' — and once that is done, it adds the dashboard' : ''}`, async () => {
    const env = environment();
    const id = await dieAtMembership(env);
    await change(env, id);
    const halted = await env.harness.measure(() => env.harness.build(spec()));
    assert.deepEqual(creates(env.org, halted.mark), [], 'no second dashboard is created');
    assert.deepEqual(memberships(env.org, halted.mark), [], 'nothing is added to the solution');
    assert.deepEqual(formDeletes(env.org, halted.mark), [], 'nothing is deleted');
    assert.ok(halted.error, 'the build stops');
    assert.match(halted.error.message, message(id));
    assert.deepEqual(recorded(env), { [BOARD]: { id } }, 'the record is kept');
    assert.deepEqual(halted.unexpected, []);
    assert.equal(isTransientHalt(halted.error), false, 'a person decides; the build does not run again on its own');
    if (!restore) return;
    await restore(env, id);
    const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the build once it is settled');
    assert.equal(memberships(env.org, rerun.mark, id).length, 1);
    assert.deepEqual(boards(env.org), [id]);
    assert.deepEqual(members(env.org), [id]);
    assert.equal(recorded(env), null);
  });
}

test('the record names a dashboard the service still answers to, but its add to the solution is refused now: the build stops, deletes nothing, keeps the record — and the next run adds it', async () => {
  const env = environment();
  const id = await dieAtMembership(env);
  const refuse = env.add('POST', isDashboardMembership, refusedWith(403, '0x80040220', 'Principal user is missing prvWriteSolution privilege.'));
  const halted = await env.harness.measure(() => env.harness.build(spec()));
  refuse.lift();
  assert.ok(halted.error, 'the build stops');
  assert.deepEqual(creates(env.org, halted.mark), [], 'no second dashboard is created');
  assert.deepEqual(formDeletes(env.org, halted.mark), [], 'nothing is deleted: not on the record\'s word');
  assert.match(halted.error.message, new RegExp(`dashboard "${BOARD}" \\(${id}\\), which an earlier build created and stopped before adding to solution '${SOLUTION}', could not be added to it now \\(.*prvWriteSolution.*\\)\\. Nothing was deleted, and the record of it is kept: run the build again to add it\\.`));
  assert.equal(isTransientHalt(halted.error), false, 'a 403 is final: the build does not run again on its own');
  assert.deepEqual(boards(env.org), [id]);
  assert.deepEqual(recorded(env), { [BOARD]: { id } });
  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(memberships(env.org, rerun.mark, id).length, 1);
  assert.deepEqual(members(env.org), [id]);
  assert.equal(recorded(env), null);
});

test('both ids the record holds answer — the one the build sent and the one the service reported: the build cannot tell which it created, adds neither, deletes neither, and stops', async () => {
  const env = environment();
  const reported = '0e0e0e0e-0000-4000-8000-00000000000e';
  const rekey = env.add('POST', isDashboardCreate, (req, body) => env.org.request({ ...req, body: JSON.stringify({ ...body, formid: reported }) }));
  await dieAtMembership(env);
  rekey.lift();
  const left = recorded(env);
  assert.ok(left && left[BOARD] && left[BOARD].reportedId === reported, JSON.stringify(left));
  const sent = left[BOARD].id;
  // A dashboard of that name under the id the build sent, made in Maker since.
  await inMaker(env.org, 'POST', '/systemforms', { formid: sent, name: BOARD, type: 0, formxml: '<form><tabs /></form>' });
  const halted = await env.harness.measure(() => env.harness.build(spec()));
  assert.ok(halted.error, 'the build stops');
  assert.deepEqual(creates(env.org, halted.mark), []);
  assert.deepEqual(memberships(env.org, halted.mark), []);
  assert.deepEqual(formDeletes(env.org, halted.mark), []);
  assert.match(halted.error.message, new RegExp(`dashboard "${BOARD}": an earlier build stopped after creating it, and each of the ids it recorded for it \\(${sent}, ${reported}\\) names a row now, so it cannot tell which is the one it created\\. Nothing was added to the solution or deleted\\. Delete the one that is not this app's in Maker, and run the build again\\.`));
  assert.equal(isTransientHalt(halted.error), false);
  assert.deepEqual(recorded(env), left, 'the record is kept');
});

test('the record is never teardown authority: a teardown while it names a dashboard outside the solution deletes only what the solution holds, and leaves the record as it was', async () => {
  const env = environment();
  const id = await dieAtMembership(env);
  const before = fs.readFileSync(recordFile(env));
  const teardown = ran(await env.harness.measure(() => env.harness.teardown(spec())), 'the teardown');
  assert.equal(teardown.value.result.ok, true, JSON.stringify(teardown.value.result.errors));
  assert.deepEqual(formDeletes(env.org, teardown.mark), [], 'the dashboard outside the solution is not deleted on the record\'s word');
  assert.deepEqual(boards(env.org), [id]);
  assert.deepEqual(fs.readFileSync(recordFile(env)), before, 'and the record is untouched');
});

// --- 4. a record the build cannot read or write ------------------------------------------------------------------------------------------------------------

// What an ordinary first build of the spec writes and reads (section 5 pins it): a build with a record it cannot use sends exactly this.
const FIRST_BUILD_WRITES = {
  'POST publishers': 1, 'POST solutions': 1,
  'POST systemforms': 1, // the dashboard
  'POST AddSolutionComponent': 4, // the dashboard, the app icon, the app and its site map
  'POST webresourceset': 1, // the generated app icon
  'POST PublishXml': 3,
  'POST appmodules': 1, 'POST sitemaps': 1, 'POST AddAppComponents': 1, 'POST appmodules/appmoduleroles_association/$ref': 1, 'POST appsettings': 1,
};
const FIRST_BUILD_READS = 41;
const UNCHANGED_REBUILD_WRITES = { 'PATCH sitemaps': 1, 'POST AddAppComponents': 1, 'POST PublishXml': 2 };
const UNCHANGED_REBUILD_READS = 92;

const BAD_RECORDS = [
  ['damaged', (file) => fs.writeFileSync(file, '{ "schemaVersion": 1, "dashboards": '), /could not be read/],
  ['a folder', (file) => fs.mkdirSync(file), /could not be read/],
  ['too large', (file) => fs.writeFileSync(file, JSON.stringify({ padding: 'x'.repeat((1 << 20) + 1) })), /could not be read/],
  ['linked from elsewhere (a hard link)', (file, env) => {
    const elsewhere = path.join(makeTempDir('dash-record-link-'), 'record.json');
    fs.writeFileSync(elsewhere, '{}');
    fs.linkSync(elsewhere, file);
  }, /could not be read/],
  ['unwritable', (file, env, t) => {
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function renameSync(from, to, ...rest) {
      if (path.resolve(String(to)) === path.resolve(file)) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' });
      return rename.call(fs, from, to, ...rest);
    });
  }, /could not be written/],
];

for (const [what, plant, said] of BAD_RECORDS) {
  test(`a record that is ${what}: an ordinary first build is the one it was before there was a record, says so once, and leaves the file as it found it`, async (t) => {
    const env = environment();
    const file = recordFile(env);
    plant(file, env, t);
    const kind = fs.existsSync(file) ? (fs.lstatSync(file).isDirectory() ? 'folder' : fs.readFileSync(file)) : null;
    const built = ran(await env.harness.measure(() => env.harness.build(spec())), 'the build');
    assert.equal(built.value.result.ok, true, JSON.stringify(built.value.result.errors));
    assert.deepEqual(built.writes, FIRST_BUILD_WRITES, 'what a first build always writes');
    assert.equal(built.reads, FIRST_BUILD_READS, 'and reads');
    const [only] = boards(env.org);
    assert.deepEqual(members(env.org), [only]);
    if (kind === 'folder') assert.ok(fs.lstatSync(file).isDirectory(), 'the folder is left where it was');
    else if (kind) assert.deepEqual(fs.readFileSync(file), kind, 'the file is left exactly as it was');
    else assert.equal(fs.existsSync(file), false, 'no record is left half-written');
    const about = built.value.warnings.filter((w) => /dashboard/i.test(w) && /record/i.test(w));
    assert.equal(about.length, 1, `one warning about the record: ${JSON.stringify(built.value.warnings)}`);
    assert.match(about[0], said);
    assert.ok(about[0].includes(file), 'it names the file');
  });
}

// --- 5. what is unchanged --------------------------------------------------------------------------------------------------------------------------------------

test('an ordinary first build and an unchanged rebuild send exactly what they sent before, read no recorded id, and leave no record behind', async () => {
  const env = environment();
  const first = ran(await env.harness.measure(() => env.harness.build(spec())), 'the first build');
  assert.equal(first.value.result.ok, true, JSON.stringify(first.value.result.errors));
  assert.deepEqual(first.writes, FIRST_BUILD_WRITES);
  assert.equal(first.reads, FIRST_BUILD_READS);
  const [id] = boards(env.org);
  assert.deepEqual(members(env.org), [id]);
  assert.deepEqual(recordFiles(env), [], 'a dashboard proven in its solution leaves no record');
  const again = ran(await env.harness.measure(() => env.harness.build(spec())), 'the rebuild');
  assert.equal(again.value.result.ok, true, JSON.stringify(again.value.result.errors));
  assert.deepEqual(again.writes, UNCHANGED_REBUILD_WRITES);
  assert.equal(again.reads, UNCHANGED_REBUILD_READS);
  assert.deepEqual(recordReads(env.org, again.mark, id), [], 'no recorded id is read');
  assert.deepEqual(recordFiles(env), []);
});

test('a dashboard the build cannot add to its solution and removes again: the halt is as it was, the record goes with the row, and the next run creates exactly one', async () => {
  const env = environment();
  let id;
  const refuse = env.add('POST', isDashboardMembership, (req, body) => { id = String(body.ComponentId).toLowerCase(); return refusedWith(400, '0x80040216', 'An unexpected error occurred.')(); });
  const failed = await env.harness.measure(() => env.harness.build(spec()));
  refuse.lift();
  assert.ok(failed.error, 'the build stops');
  assert.match(failed.error.message, new RegExp(`dashboard "${BOARD}" could not be added to solution '${SOLUTION}' \\(.*An unexpected error occurred.*\\), so it was removed again — re-run to create it afresh`));
  assert.deepEqual(formDeletes(env.org, failed.mark), [`/systemforms(${id})`], 'the undo deletes the row it created, and only that');
  assert.deepEqual(allDashboards(env.org), []);
  assert.deepEqual(recordFiles(env), [], 'proven removed by the undo: nothing to recover');
  const rerun = ran(await env.harness.measure(() => env.harness.build(spec())), 'the next build');
  assert.equal(creates(env.org, rerun.mark).length, 1);
  assert.deepEqual(recordReads(env.org, rerun.mark, id), [], 'and nothing recorded is read');
  const [only] = boards(env.org);
  assert.deepEqual(members(env.org), [only]);
});
