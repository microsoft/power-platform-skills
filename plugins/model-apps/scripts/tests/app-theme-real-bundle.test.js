'use strict';

// app.theme against the REAL vendored SDK (setAppTheme / getAppTheme) and a stateful fake of what it reads and writes
// (helpers/app-theme-server.js), layered on the app-membership fake so the SAME SDK instance also holds the app's exact
// Main-form obligation. The SDK is made over the strict theme read policy (lib/app-theme-reads.js), header-less like the
// build's, unless a test asks for the solution header. These pin, at the wire: the request budget (a set publishes its
// new version web resource and nothing else; the app is published once, through the publication port), what a set may
// claim (a property, never a created record), and what a read the policy cannot place does to the outcome.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planAppTheme, applyAppTheme, verifyAppTheme, downloadAppTheme } = require('../lib/app-theme.js');
const { createAppPublication } = require('../lib/app-publication-policy.js');
const { createPassthroughCreates } = require('../lib/creates-passthrough.js');
const { applyAppMainForms } = require('../lib/app-components.js');
const { APP, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { SITEMAP } = require('./helpers/app-pin-server.js');
const { appThemeServer, SENTINEL, SOLUTION, THEME_DEF, APPSETTING_TYPE } = require('./helpers/app-theme-server.js');

const THEME = { basePaletteColor: '#0F6CBD', appHeader: { background: '#112233', foreground: '#FFFFFF' } };
const OTHER = { basePaletteColor: '#5C2D91' };
const ENVIRONMENT_THEME = 'contoso_/environment-theme.xml';
const LOGO = 'contoso_/images/logo.svg';
const UNPUBLISHED_ROWS = 'GET /appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()';
const ENVIRONMENT_SETTING = "GET /RetrieveSetting(SettingName='CustomThemeDefinition')";
const spec = (theme) => ({ app: { theme } });
const appPublishes = (server) => server.writes().filter((line) => /<appmodule>/.test(line) || /^BATCH .*PublishXml/.test(line));
const publishXml = (server) => server.writes().filter((line) => line.startsWith('POST /PublishXml'));
const versionOf = (server) => server.theme.webResources.find((resource) => /\/apptheme\//.test(resource.name));

// The build's create port as it is today (lib/creates-passthrough.js), recording every request it was handed.
function recordingPort() {
  const inner = createPassthroughCreates();
  const port = { runs: [], run: (request, execute) => { port.runs.push(request); return inner.run(request, execute); } };
  return port;
}

async function build(t, options = {}) {
  const server = appThemeServer(t, options);
  await server.sdk.initWorkspace();
  await server.sdk.fetchArtifact('app', APP);
  const appWrite = { publish: (id) => server.sdk.publishArtifact('app', id) };
  const publication = createAppPublication({ appWrite, client: server.sdk.dataverse });
  const creates = recordingPort();
  const ctx = { sdk: server.sdk, appId: APP, publication, creates, publisherPrefix: 'contoso', ...(options.noSolution ? {} : { solution: SOLUTION }) };
  const plan = (theme) => planAppTheme(spec(theme), ctx);
  const run = async (theme) => applyAppTheme(await plan(theme), ctx);
  return { ...server, ctx, publication, creates, plan, run };
}

test('REAL BUNDLE: a first set publishes its new version web resource only, adds both records to the solution, and the app is published once, by the port', async (t) => {
  const server = await build(t);
  const result = await server.run(THEME);
  assert.deepEqual(result, { saved: ['app.theme'], unchanged: [], pendingPublish: ['app.theme'], refused: [], unknown: [], managedBindings: [] });
  assert.deepEqual(server.creates.runs, [{ kind: 'appTheme', key: 'app.theme', identity: { appId: APP, settingDefinitionId: THEME_DEF }, childKeys: [] }],
    'the port is handed the property (app + setting), no receipt, no server-assigned children');
  const written = server.writes();
  assert.match(written[0], /^POST \/webresourceset \{"name":"contoso_\/apptheme\/[0-9a-f]{16}\.xml"/);
  assert.equal(publishXml(server).length, 1, written.join('\n'));
  assert.match(publishXml(server)[0], /<webresources><webresource>[0-9a-f-]{36}<\/webresource><\/webresources>/);
  assert.ok(written.some((line) => line.startsWith('POST /appsettings')), 'the row is created as a draft');
  const adds = written.filter((line) => line.startsWith('POST /AddSolutionComponent'));
  assert.equal(adds.length, 2, 'the header-less SDK added nothing; the version and the row are added here');
  assert.ok(server.members().includes(`61:${versionOf(server).id}`));
  assert.ok(server.members().includes(`${APPSETTING_TYPE}:${server.themeRow().id}`));
  assert.deepEqual(appPublishes(server), [], 'the theme publishes no app');
  assert.equal((await verifyAppTheme(spec(THEME), server.ctx))[0].state, 'pendingPublish');

  assert.deepEqual(await server.publication.flush(), { published: [APP], withheld: [], failed: [] });
  assert.equal(appPublishes(server).length, 1);
  assert.deepEqual(await verifyAppTheme(spec(THEME), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);

  const before = server.writes().length;
  const again = await server.run({ ...THEME, basePaletteColor: '#0f6cbd' });
  assert.deepEqual(again.unchanged, ['app.theme']);
  assert.equal(server.writes().length, before, 'an equal theme sends nothing (its membership is proven read-only)');
  assert.deepEqual(server.publication.owed(), []);

  // A changed theme is the same property (the same pair at the port) and never deletes the version it supersedes.
  const changed = await server.run(OTHER);
  assert.deepEqual(changed.saved, ['app.theme']);
  assert.deepEqual(server.creates.runs.map((run) => run.identity), [{ appId: APP, settingDefinitionId: THEME_DEF }, { appId: APP, settingDefinitionId: THEME_DEF }]);
  assert.ok(!server.writes().some((line) => line.startsWith('DELETE /webresourceset')), 'no theme version is ever deleted');
  assert.equal(server.theme.webResources.filter((resource) => /\/apptheme\//.test(resource.name)).length, 2);
});

test('REAL BUNDLE: an omitted theme sends no request at all', async (t) => {
  const server = await build(t);
  const mark = server.theme.requests.length;
  assert.deepEqual(await server.plan(undefined), { operations: [], unknown: [] });
  assert.deepEqual(await applyAppTheme(await server.plan(undefined), server.ctx), { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] });
  assert.deepEqual(await verifyAppTheme({ app: {} }, server.ctx), []);
  assert.deepEqual(server.theme.requests.slice(mark), []);
});

test('REAL BUNDLE: null removes the app\'s row (its DELETE only) and the environment theme applies after the app publish', async (t) => {
  const server = await build(t, { environmentTheme: ENVIRONMENT_THEME });
  await server.run(THEME);
  await server.publication.flush();
  const before = server.writes().length;
  const result = await server.run(null);
  assert.deepEqual(result.saved, ['app.theme']);
  const sent = server.writes().slice(before);
  assert.equal(sent.length, 1, sent.join('\n'));
  assert.match(sent[0], /^DELETE \/appsettings\([0-9a-f-]{36}\)$/);
  assert.equal(server.creates.runs.length, 1, 'a removal does not go through the create port');
  assert.equal((await verifyAppTheme(spec(null), server.ctx))[0].state, 'pendingPublish');
  // Pending removal: already saved, owed only its publication — no second DELETE.
  const mark = server.writes().length;
  const pending = await server.run(null);
  assert.deepEqual([pending.unchanged, pending.pendingPublish], [['app.theme'], ['app.theme']]);
  assert.deepEqual(server.writes().slice(mark), []);
  assert.deepEqual(await server.publication.flush(), { published: [APP], withheld: [], failed: [] });
  assert.equal(server.themeRow(), undefined);
  assert.deepEqual(await verifyAppTheme(spec(null), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);
  assert.equal((await server.sdk.getAppTheme(APP)).resolved.webResourceName, ENVIRONMENT_THEME);
  // Absent: nothing to remove, no setter.
  const absent = server.writes().length;
  assert.deepEqual((await server.run(null)).unchanged, ['app.theme']);
  assert.deepEqual(server.writes().slice(absent), []);
});

test('REAL BUNDLE: null removes a published "no theme" sentinel row, which otherwise keeps the environment theme from applying', async (t) => {
  const server = await build(t, { environmentTheme: ENVIRONMENT_THEME, row: { published: SENTINEL } });
  const info = await server.sdk.getAppTheme(APP);
  assert.equal(info.row.state, 'published');
  assert.equal(info.resolved.source, 'none', 'the sentinel resolves to no theme at all');
  assert.equal((await verifyAppTheme(spec(null), server.ctx))[0].ok, false, 'not removed yet');
  assert.deepEqual(await downloadAppTheme(server.ctx), { status: 'refused', code: 'APP_THEME_UNREPRESENTABLE' }, 'the sentinel is not null');
  const result = await server.run(null);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(server.writes().filter((line) => line.startsWith('DELETE ')).length, 1);
  await server.publication.flush();
  assert.equal((await server.sdk.getAppTheme(APP)).resolved.webResourceName, ENVIRONMENT_THEME);
  assert.deepEqual(await verifyAppTheme(spec(null), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);
});

test('REAL BUNDLE: without the create port, the publication queue or the publisher prefix a set writes nothing', async (t) => {
  for (const [missing, code] of [['creates', 'APP_THEME_CREATE_PORT_UNAVAILABLE'], ['publication', 'APP_THEME_PUBLISH_BLOCKED'], ['publisherPrefix', 'APP_THEME_PREREQUISITE_UNRESOLVED']]) {
    const server = await build(t);
    delete server.ctx[missing];
    const result = await server.run(THEME);
    assert.deepEqual(result.refused, [{ key: 'app.theme', code }], missing);
    assert.deepEqual(server.writes(), [], missing);
    assert.deepEqual(server.publication.owed(), [], missing);
  }
});

test('REAL BUNDLE: the appsetting key not proven (absent, not active) is unknown before any write', async (t) => {
  for (const keys of ['absent', 'inactive']) {
    const server = await build(t, { keys });
    const mark = server.theme.requests.length;
    const result = await server.run(THEME);
    assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'APP_THEME_IDENTITY_UNPROVEN' }], keys);
    assert.deepEqual(server.writes(), [], keys);
    assert.deepEqual(server.theme.requests.slice(mark).map((line) => line.split('?')[0]), ["GET /EntityDefinitions(LogicalName='appsetting')/Keys"], `${keys}: refused before the theme is read`);
  }
});

test('REAL BUNDLE: a declared header logo must exist as an image before anything is written', async (t) => {
  const missing = await build(t);
  const refused = await missing.run({ ...THEME, logo: { webResourceName: LOGO, tooltip: 'Contoso' } });
  assert.deepEqual(refused.refused, [{ key: 'app.theme', code: 'APP_THEME_PREREQUISITE_UNRESOLVED' }]);
  assert.deepEqual(missing.writes(), []);
  const present = await build(t, { images: [LOGO] });
  const saved = await present.run({ ...THEME, logo: { webResourceName: LOGO, tooltip: 'Contoso' } });
  assert.deepEqual(saved.saved, ['app.theme']);
  assert.ok(!present.writes().some((line) => line.includes(LOGO) && /^(DELETE|PATCH)/.test(line)), 'the logo is only referenced');
});

// The required regression: the setter creates row A, and before it completes another writer replaces A with a row B of
// the SAME value. The property is met (the app's row holds the declared theme), so the set may succeed — but B is not
// this build's: it is never named as created, owned or deleted.
test('REAL BUNDLE (regression): a same-value row another writer put in place of ours is never owned, created or deleted', async (t) => {
  const server = await build(t, { solutionHeader: true });
  let replaced;
  server.afterNext('POST /appsettings', (theme) => {
    const ours = theme.rows.find((row) => row.def === THEME_DEF);
    theme.rows.splice(theme.rows.indexOf(ours), 1);
    replaced = { ours: ours.id, theirs: server.addThemeRow({ draft: ours.draft }).id };
  });
  const result = await server.run(THEME);
  assert.ok(replaced, 'the competing writer ran');
  assert.equal(server.themeRow().id, replaced.theirs);
  assert.deepEqual(result.managedBindings, [], 'neither row, nor the version, is claimed');
  assert.deepEqual(result.saved, ['app.theme'], 'the property holds the declared theme');
  assert.deepEqual(server.creates.runs, [{ kind: 'appTheme', key: 'app.theme', identity: { appId: APP, settingDefinitionId: THEME_DEF }, childKeys: [] }]);
  assert.ok(!server.writes().some((line) => line.startsWith(`DELETE /appsettings(${replaced.theirs})`)), 'their row is never deleted');
  await server.publication.flush();
  assert.deepEqual(await verifyAppTheme(spec(THEME), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);
});

// The required regression: a row with no id, of the same value, beside the real one in an answer the SDK reads — on the
// same page or on page 2. Nothing may be concluded from that answer: the operation is unknown, with no receipt.
for (const page2 of [false, true]) {
  test(`REAL BUNDLE (regression): a no-id same-value row after the set${page2 ? ', on page 2,' : ''} leaves it unknown with no receipt; the saved theme is kept`, async (t) => {
    const server = await build(t, { solutionHeader: true });
    const plan = await server.plan(THEME);
    // Armed after the setter's last read (the environment's resolved setting, read after the row write for a new
    // draft), so the next read of the row is the one that names it after the set.
    server.injectRows(UNPUBLISHED_ROWS, () => [{ appsettingid: null, value: server.themeRow().draft, componentstate: 1, _settingdefinitionid_value: THEME_DEF }], { page2, arm: ENVIRONMENT_SETTING });
    const result = await applyAppTheme(plan, server.ctx);
    assert.ok(server.writes().some((line) => line.startsWith('POST /appsettings')), 'the row was written');
    assert.equal(server.theme.requests.some((line) => line.includes('$skiptoken')), page2, 'the no-id row was served on the page asked for');
    assert.deepEqual(result.saved, ['app.theme'], JSON.stringify(result));
    assert.deepEqual(result.managedBindings, [], 'no receipt');
    assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE', afterWrite: true }]);
  });
}

test('REAL BUNDLE: a no-id row in a read before any write leaves the set unknown with zero writes', async (t) => {
  for (const page2 of [false, true]) {
    const server = await build(t);
    server.injectRows(UNPUBLISHED_ROWS, [{ appsettingid: null, value: 'contoso_/apptheme/0000000000000000.xml', componentstate: 1, _settingdefinitionid_value: THEME_DEF }], { page2 });
    const plan = await server.plan(THEME);
    assert.deepEqual(plan.unknown, [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE' }]);
    assert.deepEqual((await applyAppTheme(plan, server.ctx)).unknown, [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE' }]);
    assert.deepEqual(server.writes(), [], `page2 ${page2}`);
  }
});

test('REAL BUNDLE: a version lookup that answers an id-less row of the version\'s name is unknown before any write (the SDK would read it as absent)', async (t) => {
  const server = await build(t);
  const plan = await server.plan(THEME);
  server.injectRows("GET /webresourceset?$select=webresourceid,name,webresourcetype,content&$filter=name eq 'contoso_/apptheme/",
    (path) => [{ webresourceid: null, name: /name eq '([^']+)'/.exec(path)[1], webresourcetype: 4, content: '' }]);
  const result = await applyAppTheme(plan, server.ctx);
  assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE' }]);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(server.writes(), [], 'no version, no row');
});

test('REAL BUNDLE: an unplaceable read after the row write is unknown with partial work, and stops a later null in the same build', async (t) => {
  const server = await build(t);
  const plan = await server.plan(THEME);
  server.injectRows(UNPUBLISHED_ROWS, [{ appsettingid: '99999999-0000-4000-8000-000000000001', value: 'x', componentstate: 1, _settingdefinitionid_value: '99999999-0000-4000-8000-0000000000ff' }], { arm: 'POST /appsettings' });
  const result = await applyAppTheme(plan, server.ctx);
  assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'APP_THEME_READ_INCOMPLETE', afterWrite: true }]);
  assert.deepEqual(server.publication.owed(), []);
  const mark = server.theme.requests.length;
  const removal = await server.run(null);
  assert.deepEqual(removal.unknown, [{ key: 'app.theme', code: 'create-outcome-unknown' }]);
  assert.deepEqual(server.theme.requests.slice(mark), [], 'nothing is read or written for that app again in this build');
  assert.deepEqual(await verifyAppTheme(spec(THEME), server.ctx), [{ key: 'app.theme', ok: false, state: 'unknown', code: 'create-outcome-unknown' }]);
});

test('REAL BUNDLE: a lost answer to the row write is unknown; a later build reads the saved draft back and only queues its publication', async (t) => {
  // No solution, so the re-run's only owed work is the publication (membership repair is pinned by the next test).
  const server = await build(t, { noSolution: true });
  server.failNext('POST /appsettings', 'afterCommit');
  const lost = await server.run(THEME);
  assert.deepEqual(lost.unknown, [{ key: 'app.theme', code: 'CONNECTION_ERROR', afterWrite: true }]);
  assert.deepEqual(lost.saved, []);
  assert.deepEqual(server.publication.owed(), []);
  assert.ok(server.themeRow(), 'the row write landed');
  const sdk = server.freshSdk();
  const publication = createAppPublication({ appWrite: { publish: () => { throw new Error('not in this test'); } }, client: sdk.dataverse });
  const ctx = { ...server.ctx, sdk, publication };
  const mark = server.writes().length;
  const rerun = await applyAppTheme(await planAppTheme(spec(THEME), ctx), ctx);
  assert.deepEqual(rerun.unknown, [], JSON.stringify(rerun));
  assert.deepEqual(rerun.unchanged, ['app.theme']);
  assert.deepEqual(publication.owed().map((entry) => entry.id), [APP]);
  assert.deepEqual(server.writes().slice(mark), [], 'the saved theme is not sent again');
});

test('REAL BUNDLE: a set whose membership add fails keeps the saved theme; an equal retry refuses without writes until the explicit repair', async (t) => {
  const server = await build(t);
  server.failNext('POST /AddSolutionComponent', 500);
  const first = await server.run(THEME);
  assert.deepEqual(first.saved, ['app.theme']);
  assert.deepEqual(first.pendingPublish, ['app.theme']);
  assert.equal(first.unknown.length, 1);
  assert.equal(first.unknown[0].afterWrite, true);
  const mark = server.writes().length;
  const retry = await server.plan(THEME);
  assert.equal(retry.refused[0].code, 'APP_THEME_MEMBERSHIP_MISSING');
  assert.deepEqual(retry.refused[0].missing, ['webResource', 'appSetting']);
  assert.match(retry.refused[0].repair, /addSolutionComponent/);
  assert.deepEqual((await applyAppTheme(retry, server.ctx)).refused, [{ key: 'app.theme', code: 'APP_THEME_MEMBERSHIP_MISSING' }]);
  assert.deepEqual(server.writes().slice(mark), [], 'an equal theme never repairs silently');
  await server.sdk.addSolutionComponent({ componentId: versionOf(server).id, componentType: 61, solutionUniqueName: SOLUTION, addRequiredComponents: false });
  await server.sdk.addSolutionComponent({ componentId: server.themeRow().id, componentType: APPSETTING_TYPE, solutionUniqueName: SOLUTION, addRequiredComponents: false });
  const repaired = await server.run(THEME);
  assert.deepEqual([repaired.unchanged, repaired.refused, repaired.unknown], [['app.theme'], [], []]);
});

test('REAL BUNDLE: a queue that fails keeps the saved theme and reports unknown', async (t) => {
  const server = await build(t);
  server.ctx.publication = { queue: () => { throw Object.assign(new Error('x'), { code: 'PUBLICATION_TARGET_INVALID' }); } };
  const result = await server.run(THEME);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'PUBLICATION_TARGET_INVALID' }]);
});

test('REAL BUNDLE: a version gone after the set stops as create-completion-required, carrying the saved result', async (t) => {
  const server = await build(t);
  server.afterNext('POST /appsettings', (theme) => { theme.webResources.splice(theme.webResources.findIndex((resource) => /\/apptheme\//.test(resource.name)), 1); });
  await assert.rejects(server.run(THEME), (error) => {
    assert.equal(error.code, 'create-completion-required');
    assert.equal(error.transient, false);
    assert.deepEqual(error.detail, { missing: 'webResource' });
    assert.deepEqual(error.appTheme.saved, ['app.theme']);
    return true;
  });
});

test('REAL BUNDLE: a theme cannot publish an app whose exact Main-form membership was edited after its push: withheld, zero app publish requests', async (t) => {
  const server = await build(t, { pin: { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`] } });
  await applyAppMainForms(server.sdk, APP, { contoso_item: [FORM_A] }, { mainFormsOnUpdate: 'exact' });
  const pushed = await server.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true);
  server.publication.recordExact(APP, pushed, { name: 'Membership', mainFormsByTable: { contoso_item: [FORM_A] } });
  // Another writer puts the removed Main form back before the app is published.
  server.state.members.add(`60:${FORM_B}`);
  const result = await server.run(THEME);
  assert.deepEqual(result.pendingPublish, ['app.theme']);
  assert.equal(publishXml(server).length, 1, 'the version web resource alone');
  assert.throws(() => server.publication.assertRawPublishAllowed(APP), { code: 'APP_PUBLISH_BYPASS_REFUSED' });
  const out = await server.publication.flush();
  assert.deepEqual(out, { published: [], withheld: [{ id: APP, code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' }], failed: [] });
  assert.deepEqual(appPublishes(server), [], 'no app publish request was sent');
  assert.equal(server.publication.owed().length, 1, 'the theme stays owed');
  assert.equal(server.publication.unsettled()[0].code, 'APP_MAIN_FORMS_NOT_EXACT');
});

test('REAL BUNDLE: download captures the app\'s own exact theme, omits an inherited one and keeps a pending removal', async (t) => {
  const inherited = await build(t, { environmentTheme: ENVIRONMENT_THEME });
  assert.deepEqual(await downloadAppTheme(inherited.ctx), { status: 'omitted' }, 'the environment\'s theme is never copied into the app');
  await inherited.run(THEME);
  assert.deepEqual(await downloadAppTheme(inherited.ctx), { status: 'captured', theme: { appHeader: { background: '#112233', foreground: '#FFFFFF' }, basePaletteColor: '#0F6CBD' }, pendingPublish: true });
  await inherited.publication.flush();
  assert.equal((await downloadAppTheme(inherited.ctx)).pendingPublish, false);
  await inherited.run(null);
  assert.deepEqual(await downloadAppTheme(inherited.ctx), { status: 'captured', theme: null, pendingPublish: true });
});
